import type { AppServerBackendKind, ThreadWorkspaceHandoffStashSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { ApplyHooks, RefMove, StackOperation, StackPlan, StackReceipt } from "./engine/types";

export type StackThreadRef = { backend: AppServerBackendKind; threadId: string };
export type StackParticipant = StackThreadRef & {
  branch: string;
  title: string;
  active: boolean;
  locked: boolean;
  remote: boolean;
  path?: string;
};

export type StackApplyOptions = { newThread?: boolean; carryChanges?: boolean; askToSettle?: boolean };

export type StackNotification = {
  opId: string;
  actor: StackThreadRef;
  kind: StackOperation["kind"] | "undo";
  participants: StackParticipant[];
  options?: StackApplyOptions;
  operation?: StackOperation;
  steps?: StackPlan["steps"];
  moves?: RefMove[];
  carry?: ThreadWorkspaceHandoffStashSummary;
  provisioningAbandoned?: boolean;
  interrupted?: StackThreadRef[];
};

export type StackCoordinatorPort = {
  newId(): string;
  now(): number;
  plan(operation: StackOperation): Promise<StackPlan>;
  validateApply?(plan: StackPlan): Promise<void>;
  participants(moves: readonly RefMove[], catalog: StackPlan["before"]): Promise<StackParticipant[]>;
  hold(thread: StackThreadRef, opId: string): () => void;
  subscribe(listener: () => void): () => void;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  apply(plan: StackPlan, id: string, now: number, hooks: ApplyHooks, notification: StackNotification): Promise<StackReceipt>;
  undo(id: string, hooks: ApplyHooks, notification: StackNotification): Promise<StackReceipt>;
  receipt(id: string): Promise<StackReceipt>;
  requestWork?(actor: StackThreadRef, owner: StackParticipant, prompt: string, key: string, settleSignal?: AbortSignal): Promise<void>;
  complete?(receipt: StackReceipt, notification: StackNotification): Promise<StackThreadRef | undefined>;
  abandon?(actor: StackThreadRef, opId: string): Promise<boolean>;
  interrupt?(thread: StackThreadRef, opId: string): Promise<void>;
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
  child?: StackThreadRef;
  issue?: { code: string; message: string };
};

type PlanEntry = { plan: StackPlan; actor: StackThreadRef; options?: StackApplyOptions };
type StackRun = {
  actor: StackThreadRef;
  state: StackRunState;
  abort: AbortController;
  plan?: StackPlan;
  options?: StackApplyOptions;
  cutBefore?: string;
  routedConflict?: StackParticipant;
  interrupted: Map<string, StackThreadRef>;
  interrupting?: Promise<void>;
  completion?: () => Promise<StackThreadRef | undefined>;
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
  private readonly backgroundRuns = new Set<Promise<void>>();

  constructor(private readonly port: StackCoordinatorPort) {}

  async plan(actor: StackThreadRef, operation: StackOperation, options?: StackApplyOptions): Promise<StackForecast> {
    const plan = await this.port.plan(operation);
    const participants = await this.port.participants(this.affectedMoves(plan), plan.before);
    const planId = this.port.newId();
    this.plans.set(planId, { plan, actor, options });
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
    if (!entry.plan.steps.some((step) => step.conflict) && !entry.options?.askToSettle) this.assertForecast(entry.plan);
    this.plans.delete(planId);
    return this.start(actor, planId, (run) => this.runApply(run, entry.plan), entry.plan, entry.options);
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

  /** Wait for launched runs to settle, including their completion work and terminal state. */
  async drainBackgroundRuns(): Promise<void> {
    while (this.backgroundRuns.size > 0) await Promise.all(this.backgroundRuns);
  }

  async abort(actor: StackThreadRef, opId: string): Promise<StackRunState> {
    const run = this.runs.get(opId);
    if (!run) {
      if (await this.port.abandon?.(actor, opId)) return { opId, status: "done", undo: `refs/pwragent/undo/${opId}` };
      return this.status(actor, opId);
    }
    this.run(actor, opId);
    if (run.state.status === "waiting") run.abort.abort(new StackOperationError("aborted", "Stack operation cancelled."));
    if (run.state.status === "paused" && run.completion && await this.port.abandon?.(actor, opId)) {
      run.completion = undefined;
      run.state = { ...run.state, status: "done", issue: undefined };
    }
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

  async interrupt(actor: StackThreadRef, opId: string): Promise<StackRunState> {
    const run = this.run(actor, opId);
    const waiting = run.state.waiting;
    if (!this.port.interrupt || run.state.status !== "waiting" || !waiting?.length) {
      throw new StackOperationError("invalid_arguments", "There are no waiting layer turns to interrupt.");
    }
    run.interrupting ??= (async () => {
      for (const thread of waiting) {
        await this.port.interrupt!(thread, opId);
        run.interrupted.set(threadKey(thread), thread);
      }
    })();
    try { await run.interrupting; } finally { run.interrupting = undefined; }
    return run.state;
  }

  async routeConflict(actor: StackThreadRef, opId: string): Promise<StackRunState> {
    const run = this.run(actor, opId);
    const plan = run.plan;
    const step = plan?.steps.find((candidate) => candidate.conflict);
    if (!plan || !step?.conflict || run.state.status !== "paused" || !this.port.requestWork) {
      throw new StackOperationError("invalid_arguments", "This operation has no paused conflict to route.");
    }
    if (run.routedConflict) return run.state;
    await this.port.validateApply?.(plan);
    const owner = (await this.port.participants(this.affectedMoves(plan), plan.before)).find((thread) => thread.branch === step.branch);
    if (!owner || threadKey(owner) === threadKey(actor)) {
      throw new StackOperationError("forecast_conflict", "Resolve the conflict in the checkout that owns the affected branch, then re-plan.");
    }
    this.assertAvailable([owner]);
    const refreshed = await this.port.plan(plan.operation);
    if (forecastSignature(refreshed) !== forecastSignature(plan)) {
      throw new StackOperationError("stale_plan", "The stack forecast changed. Plan again before routing this conflict.");
    }
    if (run.routedConflict) return run.state;
    const verified = refreshed.steps.find((candidate) => candidate.branch === step.branch)!;
    run.plan = refreshed;
    run.routedConflict = owner;
    try {
      await this.port.requestWork(actor, owner, [
        `Resolve the stack conflict on ${JSON.stringify(step.branch)}. Verify the branch is still at ${verified.oldTip}, then rebase from ${verified.oldBase} onto ${verified.newBase} for parent ${JSON.stringify(verified.parent)}.`,
        `Conflicting commit ${step.conflict.commit}. Files: ${step.conflict.files.map((file) => JSON.stringify(file)).join(", ")}.`,
        `Resolve the rebase in this worktree, then call manage_stack_operation with { action: "continue", opId: "${opId}" }.`,
      ].join("\n"), `stack-conflict:${opId}`);
    } catch (error) {
      run.routedConflict = undefined;
      throw error;
    }
    return run.state;
  }

  async continue(actor: StackThreadRef, opId: string): Promise<StackRunState> {
    const candidate = this.runs.get(opId);
    const run = candidate?.routedConflict && threadKey(candidate.routedConflict) === threadKey(actor)
      ? candidate : this.run(actor, opId);
    if (run.state.status === "paused" && run.completion) {
      run.state = { ...run.state, status: "running", issue: undefined };
      try {
        const child = await run.completion();
        run.completion = undefined;
        run.state = { ...run.state, status: "done", ...(child ? { child } : {}) };
      } catch (error) {
        run.state = { ...run.state, status: "paused", issue: { code: "post_apply_failed", message: String(error) } };
      }
      return run.state;
    }
    if (run.state.status !== "paused" || !run.plan || !["dirty_overlap", "forecast_conflict", "stale_plan"].includes(run.state.issue?.code ?? "")) {
      throw new StackOperationError("invalid_arguments", "This operation cannot be continued. Plan a new operation.");
    }
    const conflict = run.routedConflict && run.plan.steps.find((step) => step.branch === run.routedConflict?.branch && step.conflict);
    const operation = conflict ? { ...run.plan.operation, conflictResolution: {
      branch: conflict.branch, base: conflict.newBase, previousTip: conflict.oldTip,
    } } : run.plan.operation;
    const plan = await this.port.plan(operation);
    this.assertForecast(plan);
    const changed = forecastSignature(plan) !== forecastSignature(run.plan);
    if (changed && (!run.routedConflict || plan.catalogHash !== run.plan.catalogHash
      || Object.entries(run.plan.expectedTips).some(([branch, tip]) => branch !== run.routedConflict?.branch && plan.expectedTips[branch] !== tip))) {
      throw new StackOperationError("stale_plan", "The forecast changed. Plan and approve it again.");
    }
    return this.start(run.actor, opId, (next) => this.runApply(next, plan), plan, run.options);
  }

  private run(actor: StackThreadRef, opId: string) {
    const run = this.runs.get(opId);
    if (!run || threadKey(run.actor) !== threadKey(actor)) throw new StackOperationError("not_found", "Stack operation is not owned by this thread.");
    return run;
  }

  private start(actor: StackThreadRef, opId: string, work: (run: StackRun) => Promise<void>, plan?: StackPlan, options?: StackApplyOptions): StackRunState {
    if ([...this.runs.values()].some(({ state }) => state.status === "waiting" || state.status === "running")) {
      throw new StackOperationError("gh_stack_busy", "This clone already has a pending stack operation.");
    }
    const run: StackRun = { actor, state: { opId, status: "waiting" }, abort: new AbortController(), plan, options, interrupted: new Map() };
    this.runs.set(opId, run);
    if (this.runs.size > 64) this.runs.delete(this.runs.keys().next().value!);
    const task = work(run).catch(async (error: unknown) => {
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
          this.start(actor, opId, (next) => this.runApply(next, continued), continued, run.options);
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
    }).finally(() => { this.backgroundRuns.delete(task); });
    this.backgroundRuns.add(task);
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
    await this.port.validateApply?.(original);
    if (original.blocked.length && run.options?.askToSettle && this.port.requestWork) {
      const owners = await this.port.participants(this.affectedMoves(original), original.before);
      this.assertAvailable(owners);
      const destinations = original.blocked.map(({ path, files }) => ({ files, owner: owners.find((thread) => thread.path === path) }));
      if (destinations.every(({ owner }) => owner && threadKey(owner) !== threadKey(run.actor))) {
        for (const { owner, files } of destinations) {
          await this.port.requestWork(run.actor, owner!, [
            `Settle local changes on ${JSON.stringify(owner!.branch)} before the stack operation.`,
            `Commit or stash the overlapping files: ${files.map((file) => JSON.stringify(file)).join(", ")}.`,
            "Keep other local changes intact.",
          ].join("\n"), `stack-settle:${run.state.opId}:${owner!.branch}`, run.abort.signal);
        }
        await this.waitForTurns(run, owners, this.affectedMoves(original), original.before);
        const settled = await this.port.plan(original.operation);
        this.assertForecast(settled);
        const cleanOriginal = { ...original, blocked: [] };
        if (forecastSignature(settled) !== forecastSignature(cleanOriginal)) {
          throw new StackOperationError("stale_plan", "Settling local work changed the forecast. Plan again.");
        }
        original = settled;
      }
    }
    this.assertForecast(original);
    let committed: { receipt: StackReceipt; notification: StackNotification } | undefined;
    await this.runHeld(run, original.moves, original.before, async (participants) => {
      const current = await this.port.plan(original.operation);
      this.assertForecast(current);
      if (forecastSignature(current) !== forecastSignature(original)) {
        throw new StackOperationError("stale_plan", "The stack forecast changed while waiting. Plan again.");
      }
      const notification = { ...this.notification(run, participants, original.operation.kind), moves: current.moves };
      const receipt = await this.port.apply(current, run.state.opId, this.port.now(), {
        beforeTransaction: async () => {
          await this.port.validateApply?.(current);
          const fresh = await this.port.plan(original.operation);
          this.assertForecast(fresh);
          if (forecastSignature(fresh) !== forecastSignature(current)) {
            throw new StackOperationError("stale_plan", "The stack changed before its ref transaction. Plan again.");
          }
          await this.assertParticipants(run, participants, fresh.moves, fresh.before);
        },
      }, notification);
      committed = { receipt, notification };
      return receipt.moves;
    }, async () => committed ? await this.port.complete?.(committed.receipt, committed.notification) : undefined);
  }

  private affectedMoves(plan: StackPlan): RefMove[] {
    const conflict = plan.steps.find((step) => step.conflict);
    return conflict && !plan.moves.some(({ branch }) => branch === conflict.branch)
      ? [...plan.moves, { branch: conflict.branch, old: conflict.oldTip, next: conflict.oldTip }]
      : plan.moves;
  }

  private async runHeld(
    run: StackRun,
    moves: readonly RefMove[],
    catalog: StackPlan["before"],
    operate: (participants: StackParticipant[]) => Promise<RefMove[]>,
    complete?: () => Promise<StackThreadRef | undefined>,
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
      await run.interrupting;
      run.abort.signal.throwIfAborted();
      run.state = { opId: run.state.opId, status: "running" };
      moved = await this.port.exclusive(async () => await operate(initial));
    } finally {
      for (const unlock of release.reverse()) unlock();
    }
    const opId = run.state.opId;
    run.state = {
      opId, status: "running", moved: moved.map(({ branch, old, next }) => ({ branch, from: old, to: next })),
      ...(run.plan ? { undo: `refs/pwragent/undo/${opId}` } : {}),
    };
    run.completion = complete;
    try {
      const child = await complete?.();
      run.completion = undefined;
      run.state = { ...run.state, status: "done", ...(child ? { child } : {}) };
    } catch (error) {
      run.state = { ...run.state, status: "paused", issue: { code: "post_apply_failed", message: String(error) } };
    }
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
    return { opId: run.state.opId, actor: run.actor, kind, participants: participants.filter((participant) => threadKey(participant) !== threadKey(run.actor)),
      options: run.options, operation: run.plan?.operation, steps: run.plan?.steps, interrupted: [...run.interrupted.values()] };
  }
}
