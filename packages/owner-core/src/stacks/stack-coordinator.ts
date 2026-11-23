import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { ApplyHooks, RefMove, StackOperation, StackPlan, StackReceipt } from "./engine/types";

export type StackThreadRef = { backend: AppServerBackendKind; threadId: string };
export type StackParticipant = StackThreadRef & {
  branch: string;
  title: string;
  active: boolean;
  locked: boolean;
  remote: boolean;
};

export type StackNotification = {
  opId: string;
  actor: StackThreadRef;
  kind: StackOperation["kind"] | "undo";
  participants: StackParticipant[];
};

export type StackCoordinatorPort = {
  newId(): string;
  now(): number;
  plan(operation: StackOperation): Promise<StackPlan>;
  participants(moves: readonly RefMove[], catalog: StackPlan["before"]): Promise<StackParticipant[]>;
  hold(thread: StackThreadRef, opId: string): () => void;
  subscribe(listener: () => void): () => void;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  apply(plan: StackPlan, id: string, now: number, hooks: ApplyHooks, notification: StackNotification): Promise<StackReceipt>;
  undo(id: string, hooks: ApplyHooks, notification: StackNotification): Promise<StackReceipt>;
  receipt(id: string): Promise<StackReceipt>;
};

export class StackOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type StackForecast = {
  planId: string;
  steps: StackPlan["steps"];
  expectedTips: StackPlan["expectedTips"];
  affected: Array<StackParticipant & { needs: "none" | "hold" | "wait_turn" | "blocked" }>;
  blocked: StackPlan["blocked"];
  forecast: Record<string, "clean" | { conflict: NonNullable<StackPlan["steps"][number]["conflict"]> }>;
  push: [];
  forge: [];
  approval: "none" | "disabled";
};

type StackRunState = {
  opId: string;
  status: "waiting" | "running" | "paused" | "done";
  waiting?: Array<StackParticipant & { reason: "active_turn" }>;
  moved?: Array<{ branch: string; from: string | null; to: string | null }>;
  undo?: string;
  issue?: { code: string; message: string };
};

type PlanEntry = { plan: StackPlan; actor: StackThreadRef };
type StackRun = {
  actor: StackThreadRef;
  state: StackRunState;
  abort: AbortController;
  plan?: StackPlan;
  cutBefore?: string;
};

function threadKey(thread: StackThreadRef) {
  return JSON.stringify([thread.backend, thread.threadId]);
}

function participantSignature(participants: readonly StackParticipant[]) {
  return JSON.stringify(participants.map((participant) => [threadKey(participant), participant.branch]).sort());
}

function forecastSignature(plan: StackPlan) {
  return JSON.stringify({
    catalogHash: plan.catalogHash,
    expectedTips: plan.expectedTips,
    steps: plan.steps.map(({ branch, parent, proof, conflict }) => ({ branch, parent, proof, conflict })),
    moves: plan.moves.map(({ branch, old, next }) => ({ branch, create: old === null, remove: next === null })),
    blocked: plan.blocked,
  });
}

export class StackCoordinator {
  private readonly plans = new Map<string, PlanEntry>();
  private readonly runs = new Map<string, StackRun>();

  constructor(private readonly port: StackCoordinatorPort) {}

  async plan(actor: StackThreadRef, operation: StackOperation): Promise<StackForecast> {
    const plan = await this.port.plan(operation);
    const participants = await this.port.participants(plan.moves, plan.before);
    const planId = this.port.newId();
    this.plans.set(planId, { plan, actor });
    if (this.plans.size > 64) this.plans.delete(this.plans.keys().next().value!);
    return {
      planId,
      steps: plan.steps,
      expectedTips: plan.expectedTips,
      blocked: plan.blocked,
      forecast: Object.fromEntries(plan.steps.map(({ branch, conflict }) => [branch, conflict ? { conflict } : "clean"])),
      push: [], forge: [], approval: "none",
      affected: participants.map((participant) => ({
        ...participant,
        needs: participant.remote || participant.locked ? "blocked" : threadKey(participant) === threadKey(actor)
          ? "none" : participant.active ? "wait_turn" : "hold",
      })),
    };
  }

  apply(actor: StackThreadRef, planId: string): StackRunState {
    const entry = this.plans.get(planId);
    if (!entry || threadKey(entry.actor) !== threadKey(actor)) throw new StackOperationError("stale_plan", "Plan this operation in the calling thread before applying it.");
    this.assertForecast(entry.plan);
    this.plans.delete(planId);
    return this.start(actor, planId, (run) => this.runApply(run, entry.plan), entry.plan);
  }

  async undo(actor: StackThreadRef, opId: string): Promise<StackRunState> {
    const receipt = await this.port.receipt(opId);
    const moves = receipt.moves.map(({ branch, old, next }) => ({ branch, old: next, next: old }));
    return this.start(actor, this.port.newId(), async (run) => {
      await this.runHeld(run, moves, receipt.after, async (participants) => {
        await this.port.undo(opId, {
          beforeTransaction: async () => await this.assertParticipants(run, participants, moves, receipt.after),
        }, this.notification(run, participants, "undo"));
        return moves;
      });
    });
  }

  status(actor: StackThreadRef, opId: string): StackRunState {
    return this.run(actor, opId).state;
  }

  abort(actor: StackThreadRef, opId: string): StackRunState {
    const run = this.run(actor, opId);
    if (run.state.status === "waiting") run.abort.abort(new StackOperationError("aborted", "Stack operation cancelled."));
    return run.state;
  }

  releaseThread(actor: StackThreadRef, opId: string, threadId: string): StackRunState {
    const run = this.run(actor, opId);
    const waiting = run.state.waiting?.filter((participant) => participant.threadId === threadId) ?? [];
    if (run.state.status !== "waiting" || run.abort.signal.aborted || waiting.length !== 1 || run.plan?.operation.kind !== "restack") {
      throw new StackOperationError("invalid_arguments", "Release selects one waiting thread in a restack.");
    }
    run.cutBefore = waiting[0]!.branch;
    run.abort.abort(new StackOperationError("aborted", "Restart restack with fewer layers."));
    return run.state;
  }

  async continue(actor: StackThreadRef, opId: string): Promise<StackRunState> {
    const run = this.run(actor, opId);
    if (run.state.status !== "paused" || !run.plan || !["dirty_overlap", "forecast_conflict", "stale_plan"].includes(run.state.issue?.code ?? "")) {
      throw new StackOperationError("invalid_arguments", "This operation cannot be continued. Plan a new operation.");
    }
    const plan = await this.port.plan(run.plan.operation);
    this.assertForecast(plan);
    if (forecastSignature(plan) !== forecastSignature(run.plan)) throw new StackOperationError("stale_plan", "The forecast changed. Plan and approve it again.");
    return this.start(actor, opId, (next) => this.runApply(next, plan), plan);
  }

  private run(actor: StackThreadRef, opId: string) {
    const run = this.runs.get(opId);
    if (!run || threadKey(run.actor) !== threadKey(actor)) throw new StackOperationError("not_found", "Stack operation is not owned by this thread.");
    return run;
  }

  private start(actor: StackThreadRef, opId: string, work: (run: StackRun) => Promise<void>, plan?: StackPlan): StackRunState {
    if ([...this.runs.values()].some(({ state }) => state.status === "waiting" || state.status === "running")) {
      throw new StackOperationError("gh_stack_busy", "This clone already has a pending stack operation.");
    }
    const run: StackRun = { actor, state: { opId, status: "waiting" }, abort: new AbortController(), plan };
    this.runs.set(opId, run);
    if (this.runs.size > 64) this.runs.delete(this.runs.keys().next().value!);
    void work(run).catch(async (error: unknown) => {
      if (run.cutBefore && plan?.operation.kind === "restack" && error === run.abort.signal.reason) {
        try {
          const operation = plan.operation;
          const continued = await this.port.plan({ ...operation, stopBefore: run.cutBefore });
          this.assertForecast(continued);
          const stack = plan.before.stacks.find(({ branches }) => branches[0]?.branch === operation.root);
          const allowed = new Set(stack?.branches.slice(0, stack.branches.findIndex(({ branch }) => branch === run.cutBefore)).map(({ branch }) => branch));
          const prefix = { ...plan, steps: plan.steps.filter(({ branch }) => allowed.has(branch)), moves: plan.moves.filter(({ branch }) => allowed.has(branch)) };
          if (forecastSignature(continued) !== forecastSignature(prefix)) throw new StackOperationError("stale_plan", "The remaining forecast changed. Plan again.");
          run.state = { opId, status: "paused" };
          this.start(actor, opId, (next) => this.runApply(next, continued), continued);
          return;
        } catch (failure) {
          error = failure;
        }
      }
      run.state = { ...run.state, status: "paused", waiting: undefined, issue: {
        code: error instanceof StackOperationError ? error.code
          : error instanceof Error && "code" in error && (error.code === "gh_stack_busy" || error.code === "stale_plan")
            ? error.code : "stack_operation_failed",
        message: error instanceof Error ? error.message : String(error),
      } };
    });
    return run.state;
  }

  private assertForecast(plan: StackPlan): void {
    if (plan.steps.some((step) => step.conflict)) throw new StackOperationError("forecast_conflict", "Resolve the forecast conflict before applying the operation.");
    if (plan.blocked.length) {
      const files = [...new Set(plan.blocked.flatMap((item) => item.files))].map((file) => JSON.stringify(file));
      throw new StackOperationError("dirty_overlap", `Local changes overlap the files this operation would move: ${files.join(", ")}.`);
    }
  }

  private async runApply(run: StackRun, original: StackPlan): Promise<void> {
    await this.runHeld(run, original.moves, original.before, async (participants) => {
      const current = await this.port.plan(original.operation);
      this.assertForecast(current);
      if (forecastSignature(current) !== forecastSignature(original)) {
        throw new StackOperationError("stale_plan", "The stack forecast changed while waiting. Plan again.");
      }
      const receipt = await this.port.apply(current, run.state.opId, this.port.now(), {
        beforeTransaction: async () => {
          const fresh = await this.port.plan(original.operation);
          this.assertForecast(fresh);
          if (forecastSignature(fresh) !== forecastSignature(current)) {
            throw new StackOperationError("stale_plan", "The stack changed before its ref transaction. Plan again.");
          }
          await this.assertParticipants(run, participants, fresh.moves, fresh.before);
        },
      }, this.notification(run, participants, original.operation.kind));
      return receipt.moves;
    });
  }

  private async runHeld(
    run: StackRun,
    moves: readonly RefMove[],
    catalog: StackPlan["before"],
    operate: (participants: StackParticipant[]) => Promise<RefMove[]>,
  ): Promise<void> {
    const initial = await this.port.participants(moves, catalog);
    this.assertAvailable(initial);
    run.abort.signal.throwIfAborted();
    const release: Array<() => void> = [];
    let moved: RefMove[];
    try {
      const unique = new Map(initial.map((thread) => [threadKey(thread), thread]));
      for (const thread of unique.values()) release.push(this.port.hold(thread, run.state.opId));
      await this.waitForTurns(run, initial, moves, catalog);
      run.abort.signal.throwIfAborted();
      run.state = { opId: run.state.opId, status: "running" };
      moved = await this.port.exclusive(async () => await operate(initial));
    } finally {
      for (const unlock of release.reverse()) unlock();
    }
    const opId = run.state.opId;
    run.state = {
      opId, status: "done", moved: moved.map(({ branch, old, next }) => ({ branch, from: old, to: next })),
      ...(run.plan ? { undo: `refs/pwragent/undo/${opId}` } : {}),
    };
  }

  private async assertParticipants(run: StackRun, original: StackParticipant[], moves: readonly RefMove[], catalog: StackPlan["before"]) {
    const current = await this.port.participants(moves, catalog);
    this.assertAvailable(current);
    if (participantSignature(original) !== participantSignature(current)
      || current.some((thread) => thread.active && threadKey(thread) !== threadKey(run.actor))) {
      throw new StackOperationError("stale_plan", "A layer's checkout owner or turn changed. Plan again.");
    }
  }

  private assertAvailable(participants: StackParticipant[]): void {
    const inaccessible = participants.find((participant) => participant.locked || participant.remote);
    if (inaccessible) {
      throw new StackOperationError(inaccessible.remote ? "layer_remote" : "thread_locked", `The layer ${inaccessible.branch} is owned by ${inaccessible.title} and is unavailable.`);
    }
  }

  private async waitForTurns(run: StackRun, original: StackParticipant[], moves: readonly RefMove[], catalog: StackPlan["before"]) {
    let wake: (() => void) | undefined;
    let changed = false;
    const signal = run.abort.signal;
    const invalidate = () => { changed = true; wake?.(); };
    const unsubscribe = this.port.subscribe(invalidate);
    signal.addEventListener("abort", invalidate);
    try {
      for (;;) {
        changed = false;
        signal.throwIfAborted();
        const current = await this.port.participants(moves, catalog);
        this.assertAvailable(current);
        if (participantSignature(current) !== participantSignature(original)) {
          throw new StackOperationError("stale_plan", "Layer ownership changed while waiting. Plan again.");
        }
        const waiting = current.filter((thread) => thread.active && threadKey(thread) !== threadKey(run.actor))
          .map((thread) => ({ ...thread, reason: "active_turn" as const }));
        run.state = { opId: run.state.opId, status: "waiting", waiting };
        if (!waiting.length) return;
        if (!changed) await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    } finally {
      signal.removeEventListener("abort", invalidate);
      unsubscribe();
    }
  }

  private notification(run: StackRun, participants: StackParticipant[], kind: StackNotification["kind"]): StackNotification {
    return { opId: run.state.opId, actor: run.actor, kind, participants: participants.filter((participant) => threadKey(participant) !== threadKey(run.actor)) };
  }
}
