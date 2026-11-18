import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadTurnMetadata, ThreadDependency } from "@pwragent/shared";
import { CodexThreadBusyBeforeStartError, classifyCodexResumeError } from "../codex-app-server/desktop-client";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { ThreadDependencyCoordinator } from "../app-server/thread-dependency-coordinator";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

/*
 * The incident: an orchestrator thread re-registered Continue After on its
 * rolling workers while its own parent turn was active. That turn was not
 * one the registry had started, so `isConsumerBusy` read idle and every
 * ready wait went to the provider, which refused `thread/resume` with the
 * Token Miser activation message.
 *
 * The oracle is a provider model that speaks the same protocol: a thread has
 * at most one active turn, resume during it is refused with the exact
 * JSON-RPC error, and turn/start admits a turn. Its notifications reach the
 * coordinator now, later, or never. Registry knowledge is modeled as the
 * turns the registry itself started.
 */

const CONSUMER = "orchestrator";
const WORKERS = ["worker-a", "worker-b"] as const;
const ROLLING_PLAN = "Collect the finished worker results and dispatch the next batch.";

type Turn = AppServerThreadTurnMetadata;
type Fate = "now" | "later" | "never";
type ProviderEvent = { threadId: string; turn?: Turn; idle?: true };

class ProviderModel {
  readonly turns = new Map<string, Turn[]>();
  readonly registryStarted = new Set<string>();
  /** turn/start requests the provider received while a turn was active. */
  readonly duplicateStarts: string[] = [];
  readonly startedFor = new Map<string, string>();
  /** Continuations the registry's queue steered into a turn it had started. */
  readonly steeredInto = new Map<string, string>();
  private sequence = 0;

  constructor() {
    this.turns.set(CONSUMER, [{ id: "parent-turn", status: "in_progress" }]);
    for (const worker of WORKERS) this.turns.set(worker, [{ id: `${worker}-t0`, status: "in_progress" }]);
  }

  active(threadId: string): Turn | undefined {
    return this.turns.get(threadId)!.find((turn) => turn.status === "in_progress");
  }

  /** `thread/resume`, as the app-server answers while a turn is active. */
  resume(threadId: string): void {
    if (this.active(threadId)) {
      throw new Error(`json-rpc error (-32600): cannot change PwrAgent Token Miser activation while thread ${threadId} has an active turn`);
    }
  }

  turnStart(threadId: string, dependencyId: string): string {
    if (this.active(threadId)) this.duplicateStarts.push(dependencyId);
    const id = `continuation-${++this.sequence}`;
    this.turns.get(threadId)!.push({ id, status: "in_progress" });
    this.registryStarted.add(id);
    this.startedFor.set(dependencyId, id);
    return id;
  }

  complete(threadId: string): Turn | undefined {
    const turn = this.active(threadId);
    if (!turn) return undefined;
    turn.status = "completed";
    return { ...turn };
  }

  startWorkerTurn(worker: string): void {
    const turns = this.turns.get(worker)!;
    turns.push({ id: `${worker}-t${turns.length}`, status: "in_progress" });
  }
}

/**
 * The registry's `submitTurnIfIdle` with `joinRunningTurn`. A turn the
 * registry started takes the wake into its queue, which steers it in and
 * reports the wake's own `started` event. Otherwise the client resumes the
 * thread, then turn/start.
 */
function submitThrough(provider: ProviderModel, started: (dependencyId: string, turnId: string) => void) {
  return async (params: { threadId: string; messageOrigin: { dependencyId?: string } }) => {
    const active = provider.active(params.threadId);
    if (active && provider.registryStarted.has(active.id)) {
      provider.steeredInto.set(params.messageOrigin.dependencyId!, active.id);
      started(params.messageOrigin.dependencyId!, active.id);
      return { status: "queued" as const };
    }
    try {
      try {
        provider.resume(params.threadId);
      } catch (error) {
        throw classifyCodexResumeError(error, params.threadId);
      }
      return { status: "started" as const, turnId: provider.turnStart(params.threadId, params.messageOrigin.dependencyId!) };
    } catch (error) {
      if (error instanceof CodexThreadBusyBeforeStartError) return { status: "busy" as const };
      throw error;
    }
  };
}

type Command =
  | { kind: "worker"; worker: number; fate: Fate }
  | { kind: "register"; plan: "rolling" | "independent" }
  | { kind: "consumerEnds"; fate: Fate }
  | { kind: "flush" }
  | { kind: "reconcile" };

const fate = fc.constantFrom<Fate>("now", "later", "never");
const command: fc.Arbitrary<Command> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("worker" as const), worker: fc.integer({ min: 0, max: WORKERS.length - 1 }), fate }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("register" as const), plan: fc.constantFrom("rolling" as const, "independent" as const) }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("consumerEnds" as const), fate }), weight: 2 },
  { arbitrary: fc.constant({ kind: "flush" as const }), weight: 1 },
  { arbitrary: fc.constant({ kind: "reconcile" as const }), weight: 1 },
);

async function withHarness(run: (harness: {
  store: ThreadDependencyStore;
  provider: ProviderModel;
  coordinator: ThreadDependencyCoordinator;
  deliver: (event: ProviderEvent, fate: Fate) => Promise<void>;
  flush: () => Promise<void>;
  register: (plan: "rolling" | "independent") => Promise<void>;
  independentPlans: Set<string>;
  submit: ReturnType<typeof vi.fn>;
}) => Promise<void>) {
  const { tempDir, dbPath } = createTempStateDb("dependency-rolling-");
  const db = StateDb.open(dbPath);
  const store = new ThreadDependencyStore(db.raw);
  const provider = new ProviderModel();
  // The queue reports a steered wake's started event after admission returns.
  const late: { coordinator?: ThreadDependencyCoordinator } = {};
  const submit = vi.fn(submitThrough(provider, (dependencyId, turnId) => {
    void late.coordinator?.handleDeliveryProgress({ backend: "codex", threadId: CONSUMER, dependencyId, status: "started", turnId });
  }));
  let now = 1_000;
  const coordinator = new ThreadDependencyCoordinator({
    store, submit, changed: async () => {},
    now: () => ++now,
    readThread: async (target) => ({
      // The service reads activeTurnId from the registry, which never
      // started the parent or worker turns.
      activeTurnId: [...provider.registryStarted].find((id) => provider.active(target.threadId)?.id === id),
      turns: provider.turns.get(target.threadId)!.map((turn) => ({ ...turn })),
      prs: [],
    }),
    // Owner-confirmed idle: the registry holds no turn and the provider's
    // own thread read shows none in progress.
    confirmConsumerIdle: async (target) => !provider.active(target.threadId),
  });
  late.coordinator = coordinator;
  const delayed: ProviderEvent[] = [];
  const handle = (event: ProviderEvent) => coordinator.handleThreadEvent(
    { backend: "codex", threadId: event.threadId }, event.turn, true);
  const deliver = async (event: ProviderEvent, eventFate: Fate) => {
    if (eventFate === "now") await handle(event);
    else if (eventFate === "later") delayed.push(event);
  };
  const flush = async () => {
    for (const event of delayed.splice(0)) await handle(event);
  };
  const independentPlans = new Set<string>();
  let independent = 0;
  const register = async (plan: "rolling" | "independent") => {
    const continuation = plan === "rolling" ? ROLLING_PLAN : `Independent check ${++independent}`;
    const response = await coordinator.manage({
      action: "create", backend: "codex", threadId: CONSUMER, mode: "any", continuation,
      conditions: (plan === "rolling" ? WORKERS : [WORKERS[independent % WORKERS.length]!])
        .map((threadId) => ({ backend: "codex" as const, threadId, when: "turn_completed" as const, title: `Worker ${threadId}` })),
    }).catch((error: unknown) => ({ error }));
    if ("error" in response) throw response.error;
    if (plan === "independent") independentPlans.add(continuation);
  };
  try {
    await run({ store, provider, coordinator, deliver, flush, register, independentPlans, submit });
  } finally {
    db.close();
    removeTempStateDbDir(tempDir);
  }
}

const isReady = (item: ThreadDependency) => item.status === "ready" && item.outcome === "success";
const uncertain = (store: ThreadDependencyStore) => store.active().filter((item) => item.status === "dispatching" && item.error);

describe("rolling worker Continue After lifecycle", () => {
  it("delivers every continuation without uncertain claims, duplicate starts, or superseded pile-up", async () => {
    await fc.assert(fc.asyncProperty(fc.array(command, { minLength: 8, maxLength: 40, size: "max" }), async (commands) => {
      await withHarness(async ({ store, provider, coordinator, deliver, flush, register, independentPlans, submit }) => {
        for (const step of commands) {
          if (step.kind === "worker") {
            const worker = WORKERS[step.worker]!;
            const turn = provider.complete(worker);
            provider.startWorkerTurn(worker);
            if (turn) await deliver({ threadId: worker, turn }, step.fate);
          } else if (step.kind === "register") {
            await register(step.plan);
          } else if (step.kind === "consumerEnds") {
            const turn = provider.complete(CONSUMER);
            if (turn) {
              await deliver({ threadId: CONSUMER, turn }, step.fate);
              await deliver({ threadId: CONSUMER, idle: true }, step.fate);
            }
          } else if (step.kind === "flush") {
            await flush();
          } else {
            await coordinator.reconcile();
          }
          // The incident's symptom: a provider busy refusal recorded as an
          // uncertain delivery needing review.
          expect(uncertain(store)).toEqual([]);
          // The provider never received turn/start during an active turn.
          expect(provider.duplicateStarts).toEqual([]);
          // A rolling plan re-registered on each worker update keeps one
          // active registration; superseded ones do not accumulate.
          expect(store.active().filter((item) => item.continuation === ROLLING_PLAN).length).toBeLessThanOrEqual(1);
        }
        // Drain with every consumer-idle notification lost. Owner-confirmed
        // idle reconciliation alone must deliver every ready wait.
        for (const worker of WORKERS) {
          const turn = provider.complete(worker);
          if (turn) await deliver({ threadId: worker, turn }, "never");
        }
        for (let pass = 0; pass < 80 && store.active().length > 0; pass++) {
          const turn = provider.complete(CONSUMER);
          if (turn) await deliver({ threadId: CONSUMER, turn }, "never");
          await coordinator.reconcile();
        }
        expect(store.active()).toEqual([]);
        const ended = store.list("codex", CONSUMER);
        // Each continuation names the turn it reached: one it started, or the
        // running turn the queue steered it into. Each provider turn/start
        // belongs to exactly one continuation.
        const delivered = ended.filter((item) => item.status === "delivered");
        expect(delivered.every((item) => (provider.startedFor.get(item.id) ?? provider.steeredInto.get(item.id)) === item.turnId)).toBe(true);
        expect(new Set(provider.startedFor.values()).size).toBe(provider.startedFor.size);
        expect(submit.mock.results.filter((result) => result.type === "return").length).toBeGreaterThanOrEqual(delivered.length);
        // Independent waits are never retired as superseded.
        for (const plan of independentPlans) {
          expect(ended.find((item) => item.continuation === plan)?.status).toBe("delivered");
        }
        // Only rolling waits may be superseded, and only by a newer one.
        for (const item of ended.filter((entry) => entry.supersededBy)) {
          expect(item.continuation).toBe(ROLLING_PLAN);
          expect(ended.find((entry) => entry.id === item.supersededBy)!.createdAt).toBeGreaterThan(item.createdAt);
        }
        expect(ended.filter(isReady)).toEqual([]);
      });
    }), { numRuns: 30 });
  });

  it("recovers the busy latch from owner-confirmed idle when the idle notification never arrives", async () => {
    // The shrunk incident: one ready wait, a refused resume, a lost idle event.
    await withHarness(async ({ store, provider, coordinator, register, deliver }) => {
      await register("rolling");
      const turn = provider.complete("worker-a")!;
      await deliver({ threadId: "worker-a", turn }, "now");
      expect(store.active()).toMatchObject([{ status: "ready" }]);
      provider.complete(CONSUMER);
      await coordinator.reconcile();
      expect(store.active()).toEqual([]);
      expect(store.list("codex", CONSUMER)[0]).toMatchObject({ status: "delivered", turnId: "continuation-1" });
    });
  });

  it("does not clear the latch while the owner still reports an active turn", async () => {
    await withHarness(async ({ store, provider, coordinator, register, deliver, submit }) => {
      await register("rolling");
      await deliver({ threadId: "worker-a", turn: provider.complete("worker-a")! }, "now");
      expect(submit).toHaveBeenCalledTimes(1);
      for (let pass = 0; pass < 5; pass++) await coordinator.reconcile();
      // Still busy per the owner: no further resume attempts.
      expect(submit).toHaveBeenCalledTimes(1);
      expect(store.active()).toMatchObject([{ status: "ready" }]);
    });
  });

  it("supersedes an older rolling wait in the registering commit and keeps a different plan", async () => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    await withHarness(async ({ store, provider, register }) => {
      await register("rolling");
      // An ordinary registration: its insert, then its first evaluation.
      const { writes: ordinary } = await measureSqliteWrites(async () => {
        await register("independent");
      });
      provider.complete("worker-a");
      provider.startWorkerTurn("worker-a");
      const { writes } = await measureSqliteWrites(async () => {
        await register("rolling");
      });
      // Retiring the older wait shares the registering transaction.
      expect(writes.commits).toBe(ordinary.commits);
      expectSqliteWriteBudget({
        scenario: "thread-dependencies-rolling-supersede",
        note: "One rolling re-registration that retires its older wait: the insert and the retirement share one commit, plus the first evaluation, as for any registration (~25 KB WAL; 300 worker turns a day is ~7 MB/day, with or without supersession).",
        writes,
      });
      const rolling = store.list("codex", CONSUMER).filter((item) => item.continuation === ROLLING_PLAN);
      const newer = rolling.find((item) => item.status === "waiting")!;
      expect(rolling.map((item) => item.status).sort()).toEqual(["cancelled", "waiting"]);
      expect(rolling.find((item) => item.status === "cancelled")).toMatchObject({ supersededBy: newer.id });
      expect(newer.conditions.map((condition) => condition.turnId)).toEqual(["worker-a-t1", "worker-b-t0"]);
      expect(store.active().map((item) => item.continuation).sort()).toEqual([ROLLING_PLAN, "Independent check 1"]);
    });
  });
});
