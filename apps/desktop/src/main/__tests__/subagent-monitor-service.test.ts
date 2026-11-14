import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerBackendKind, TaskMonitorRequest, TaskMonitorResponse } from "@pwragent/shared";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type {
  CodexNativeSubAgentReconciliation,
  ReviewSubAgentRecord,
  TaskMonitorDelegationRecord,
} from "../app-server/backend-registry-types";
import { TASK_MONITOR_STALE_GRACE_MS } from "../app-server/backend-registry-runtime-helpers";
import type { RegistryContext } from "../app-server/registry-context";
import {
  SubAgentMonitorService,
  type SubAgentMonitorServiceDependencies,
  type SubAgentMonitorServiceHost,
} from "../app-server/subagent-monitor-service";
import { taskMonitorThreadKey } from "../app-server/thread-turn-keys";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/** The service's own state and steps, which only its tests reach. */
type ServiceInternals = {
  taskMonitorDelegations: Map<string, TaskMonitorDelegationRecord>;
  completedTaskMonitorsByThread: Map<string, TaskMonitorDelegationRecord>;
  codexNativeSubAgentParents: Map<string, string>;
  codexNativeSubAgentReconciliations: Map<string, CodexNativeSubAgentReconciliation>;
  startTaskMonitorRecoveryTurn(params: { record: TaskMonitorDelegationRecord; terminalStatus: string }): Promise<void>;
  synthesizeTaskMonitorFallbackCompletion(params: { record: TaskMonitorDelegationRecord; reason: string }): Promise<void>;
  interruptManagedTaskMonitor(record: TaskMonitorDelegationRecord): Promise<void>;
  handleTaskMonitorRequest(request: TaskMonitorRequest): Promise<TaskMonitorResponse>;
  startManagedTaskMonitor(params: { monitorId: string; monitorBackend: AppServerBackendKind }): Promise<{
    executionMode: string;
    threadId: string;
    turnId: string;
  }>;
  resolveTaskMonitorModelSettings(params: unknown): Promise<{
    monitorBackend: AppServerBackendKind;
    preferredModel: string;
    preferredReasoningEffort: string;
    runtimeModel?: string;
  }>;
  persistTaskMonitorSubAgent(record: TaskMonitorDelegationRecord, patch?: { status?: string }): Promise<void>;
  injectTaskMonitorCompletionMessage(params: unknown): Promise<void>;
  emitTaskMonitorCompletionState(params: unknown): Promise<void>;
  emitTaskMonitorUsageActivity(params: unknown): Promise<void>;
  scheduleCodexNativeSubAgentReconciliation(params: { delayMs: number; parentThreadId: string; receiverThreadId: string }): void;
  clearCodexNativeSubAgentReconciliation(receiverThreadId: string): void;
  reconcileCodexNativeSubAgent(receiverThreadId: string): Promise<void>;
};

function monitorRecord(overrides: Partial<TaskMonitorDelegationRecord> = {}): TaskMonitorDelegationRecord {
  return {
    activeCommandCount: 0,
    backend: "codex",
    createdAt: 1_000,
    heartbeatIntervalSeconds: 30,
    lastActivityAt: 1_000,
    monitorId: "monitor-1",
    monitorThreadId: "monitor-thread",
    monitorTurnId: "monitor-turn",
    parentBackend: "codex",
    parentThreadId: "parent-thread",
    parentTurnId: "parent-turn",
    pollIntervalSeconds: 30,
    preferredModel: "gpt-fixture",
    preferredReasoningEffort: "low",
    startupTimeoutSeconds: 45,
    task: "Wait for CI",
    ...overrides,
  };
}

/**
 * A service over a fixture context and host. `claudeTasks` is what the Claude
 * provider reports running for each monitor thread; `reviews` are the managed
 * review service's live review sub-agents. `claude` and `dependencies` add to
 * the Claude provider and the service's collaborators.
 */
function createService(options: {
  claudeTasks?: ReadonlyMap<string, number>;
  reviews?: ReadonlyMap<string, ReviewSubAgentRecord>;
  host?: Partial<SubAgentMonitorServiceHost>;
  stores?: Record<string, unknown>;
  claude?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
} = {}) {
  const context = {
    stores: { subAgents: {}, threads: {}, usage: {}, ...options.stores },
    providers: {
      claude: {
        activeTaskCount: (threadId: string) => options.claudeTasks?.get(threadId) ?? 0,
        ...options.claude,
      },
    },
    lifecycle: { closed: false },
    emit: async () => {},
  } as unknown as RegistryContext;
  const dependencies = {
    forgeToolBridge: {},
    threadMcpConnections: {},
    managedReviewService: { activeReviewSubAgentRecords: options.reviews ?? new Map() },
    ...options.dependencies,
  } as unknown as SubAgentMonitorServiceDependencies;
  const host = {
    invalidateThreadListCache: () => {},
    registrySessionId: "session-fixture",
    registrySessionStartedAt: 5_000,
    runtimeInstanceId: "runtime-fixture",
    liveProfileRuntimeInstanceIds: () => undefined,
    ...options.host,
  } as unknown as SubAgentMonitorServiceHost;
  const service = new SubAgentMonitorService(context, dependencies, () => host);
  return { service, internals: service as unknown as ServiceInternals };
}

function createRegistry() {
  const db = openInMemoryStateDb();
  const registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [], onNotification: () => () => {},
      onPendingRequest: () => () => {},
    } as never,
    overlayStore: new SqliteOverlayStore(db),
  });
  return { registry, db };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SubAgentMonitorService", () => {
  it("reads neither its host nor its stores until it is used", async () => {
    let bound = false;
    const reconciled: unknown[] = [];
    const context = {
      get stores() {
        if (!bound) throw new Error("store read while constructing");
        return {
          subAgents: {
            moveLegacyThreadSubAgents: async () => {},
            reconcileOrphanedThreadSubAgents: async (params: unknown) => {
              reconciled.push(params);
              return { repairedSubAgents: 0 };
            },
          },
        };
      },
    } as unknown as RegistryContext;
    // Each read builds a new host, so a host kept from an earlier call goes stale.
    let liveIds: string[] | undefined;
    const service = new SubAgentMonitorService(context, {} as SubAgentMonitorServiceDependencies, () => {
      if (!bound) throw new Error("host read while constructing");
      const ids = liveIds;
      return {
        liveProfileRuntimeInstanceIds: () => ids,
        runtimeInstanceId: "runtime",
        registrySessionId: "session",
        registrySessionStartedAt: 1,
        invalidateThreadListCache: () => {},
      } as unknown as SubAgentMonitorServiceHost;
    });
    bound = true;
    await service.reconcileOrphanedThreadSubAgentsAtStartup();
    expect(reconciled).toEqual([]);
    liveIds = ["runtime"];
    await service.reconcileOrphanedThreadSubAgentsAtStartup();
    expect(reconciled).toHaveLength(1);
  });

  it("keeps the registry's sub-agent members as facades that forward every argument and the module's result", async () => {
    const { registry, db } = createRegistry();
    try {
      const monitors = registryModules(registry).subAgentMonitorService;
      const stopped = Promise.resolve({ backend: "codex" as const, threadId: "parent-thread", monitorId: "monitor-1", status: "cancelled" as const });
      const stop = vi.spyOn(monitors, "stopSubAgent").mockReturnValue(stopped as never);
      const request = { backend: "codex" as const, threadId: "parent-thread", monitorId: "monitor-1" };
      expect(registry.stopSubAgent(request)).toBe(stopped);
      expect(stop).toHaveBeenLastCalledWith(request);

      const wakes = [{ monitorId: "monitor-1", task: "t", backend: "codex" as const, createdAt: 1, lastActivityAt: 1, pollIntervalSeconds: 30 }];
      const list = vi.spyOn(monitors, "listPendingTaskMonitorWakes").mockReturnValue(wakes);
      const thread = { backend: "codex" as const, threadId: "parent-thread" };
      expect(registry.listPendingTaskMonitorWakes(thread)).toBe(wakes);
      expect(list).toHaveBeenLastCalledWith(thread);

      // The ports other modules and the providers call reach the module.
      const ports = registry.constructionPorts();
      const record = monitorRecord();
      const isMonitor = vi.spyOn(monitors, "isTaskMonitorThread").mockReturnValue(true);
      const forThread = vi.spyOn(monitors, "taskMonitorForThread").mockReturnValue(record);
      const handled = Promise.resolve({ ok: true } as never);
      const handle = vi.spyOn(monitors, "handleAgentTaskMonitorRequest").mockReturnValue(handled);
      const recorded = Promise.resolve();
      const recordCards = vi.spyOn(monitors, "recordClaudeSubAgents").mockReturnValue(recorded);
      const context = { backend: "codex" as const, threadId: "monitor-thread" };
      expect(ports.isTaskMonitorThread(context)).toBe(true);
      expect(isMonitor).toHaveBeenLastCalledWith(context);
      expect(ports.taskMonitorForThread(context)).toBe(record);
      expect(forThread).toHaveBeenLastCalledWith(context);
      const taskRequest = { operation: "create_monitor_delegation" } as never;
      expect(ports.handleAgentTaskMonitorRequest(taskRequest)).toBe(handled);
      expect(handle).toHaveBeenLastCalledWith(taskRequest);
      const cards = { threadId: "claude-thread", subAgents: [] };
      expect(ports.recordClaudeSubAgents(cards)).toBe(recorded);
      expect(recordCards).toHaveBeenLastCalledWith(cards);
    } finally {
      await registry.close();
      db.close();
    }
  });

  it("lets the registry read the monitor and native worker state only through the module's views", async () => {
    const { registry, db } = createRegistry();
    try {
      const monitors = registryModules(registry).subAgentMonitorService;
      const internals = monitors as unknown as ServiceInternals;
      const record = monitorRecord();
      internals.taskMonitorDelegations.set(record.monitorId, record);
      internals.completedTaskMonitorsByThread.set(taskMonitorThreadKey("codex", "done-thread"), record);
      expect(registry.constructionPorts().taskMonitorDelegations).toBe(monitors.taskMonitorDelegationRecords);
      expect([...monitors.taskMonitorDelegationRecords.values()]).toEqual([record]);
      expect(monitors.completedTaskMonitorRecords.has(taskMonitorThreadKey("codex", "done-thread"))).toBe(true);

      // The registry's thread listing records a worker's parent through the module.
      monitors.setCodexNativeSubAgentParent("worker", "parent");
      expect(monitors.codexNativeSubAgentParentRecords.get("worker")).toBe("parent");
      expect(monitors.resolveSubAgentThreadOwner({ backend: "codex", threadId: "worker" }))
        .toEqual({ backend: "codex", isSubAgent: true, threadId: "parent" });
    } finally {
      await registry.close();
      db.close();
    }
  });

  it("releases its monitor and reconciliation state when the registry closes, in the registry's close order", async () => {
    vi.useFakeTimers();
    const { registry, db } = createRegistry();
    const monitors = registryModules(registry).subAgentMonitorService;
    const internals = monitors as unknown as ServiceInternals;
    const fired = vi.fn();
    internals.codexNativeSubAgentReconciliations.set("worker", {
      attempts: 0, parentThreadId: "parent", receiverThreadId: "worker", startedAt: 0,
      timer: setTimeout(fired, 1_000) as unknown as NodeJS.Timeout,
    });
    internals.completedTaskMonitorsByThread.set(taskMonitorThreadKey("codex", "done-thread"), monitorRecord());
    const clear = vi.spyOn(monitors, "clearCompletedTaskMonitors");
    const persist = vi.spyOn(monitors, "persistLiveCodexNativeSubAgentUsage");
    const cancel = vi.spyOn(monitors, "cancelCodexNativeSubAgentReconciliations");
    await registry.close();
    db.close();
    expect(clear).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(persist.mock.invocationCallOrder[0]!);
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0]!);
    expect(monitors.completedTaskMonitorRecords.size).toBe(0);
    expect(internals.codexNativeSubAgentReconciliations.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(fired).not.toHaveBeenCalled();
  });
});

// ---- Stale monitor watchdog -------------------------------------------------

type WatchdogAction =
  | "recover"
  | "fallback:monitor_recovery_turn_stale_without_completion"
  | "fallback:monitor_stale_interrupt_no_terminal"
  | "interrupt"
  | "fallback:monitor_stale_interrupt_failed";

type WatchdogCase = {
  backend: "codex" | "claude";
  hasThread: boolean;
  hasTurn: boolean;
  cancelled: boolean;
  activeCommandCount: number;
  pendingMcpApprovalCount?: number;
  claudeTasks: number;
  heartbeatIntervalSeconds: number;
  pollIntervalSeconds: number;
  startupTimeoutSeconds: number;
  /** Idle time relative to the stale threshold, or an absolute idle time. */
  idle: { offsetMs: number } | { absoluteMs: number };
  awaitingClaudeTaskWake: boolean;
  recoveryAttempted: boolean;
  staleInterruptAttempted: boolean;
  interruptFails: boolean;
};

const watchdogCase: fc.Arbitrary<WatchdogCase> = fc.record({
  backend: fc.constantFrom("codex" as const, "claude" as const),
  hasThread: fc.constantFrom(true, true, true, false),
  hasTurn: fc.boolean(),
  cancelled: fc.boolean(),
  activeCommandCount: fc.constantFrom(0, 0, 0, 1),
  pendingMcpApprovalCount: fc.option(fc.constantFrom(0, 0, 1), { nil: undefined }),
  claudeTasks: fc.constantFrom(0, 0, 1),
  heartbeatIntervalSeconds: fc.integer({ min: 1, max: 120 }),
  pollIntervalSeconds: fc.integer({ min: 1, max: 120 }),
  startupTimeoutSeconds: fc.integer({ min: 1, max: 300 }),
  idle: fc.oneof(
    fc.record({ offsetMs: fc.integer({ min: -2, max: 2 }) }),
    fc.record({ absoluteMs: fc.integer({ min: 0, max: 900_000 }) }),
  ),
  awaitingClaudeTaskWake: fc.boolean(),
  recoveryAttempted: fc.boolean(),
  staleInterruptAttempted: fc.boolean(),
  interruptFails: fc.boolean(),
});

const staleAfterMs = (c: WatchdogCase) =>
  Math.max(c.heartbeatIntervalSeconds * 2, c.pollIntervalSeconds * 2, c.startupTimeoutSeconds) * 1000
  + TASK_MONITOR_STALE_GRACE_MS;

const idleMs = (c: WatchdogCase) => "offsetMs" in c.idle ? staleAfterMs(c) + c.idle.offsetMs : c.idle.absoluteMs;

/** The watchdog's rule, written as a decision table over one record. */
function expectedWatchdogActions(c: WatchdogCase): WatchdogAction[] {
  if (!c.hasThread || !c.hasTurn || c.cancelled) return [];
  if (c.activeCommandCount > 0 || (c.pendingMcpApprovalCount ?? 0) > 0) return [];
  if (c.backend === "claude" && c.claudeTasks > 0) return [];
  if (idleMs(c) < staleAfterMs(c)) return [];
  if (c.awaitingClaudeTaskWake) return ["recover"];
  if (c.recoveryAttempted) return ["fallback:monitor_recovery_turn_stale_without_completion"];
  if (c.staleInterruptAttempted) return ["fallback:monitor_stale_interrupt_no_terminal"];
  return c.interruptFails ? ["interrupt", "fallback:monitor_stale_interrupt_failed"] : ["interrupt"];
}

describe("SubAgentMonitorService stale monitor watchdog", () => {
  it("acts on each monitor exactly as the decision table says, and only once it is stale", async () => {
    await fc.assert(fc.asyncProperty(fc.array(watchdogCase, { minLength: 1, maxLength: 6 }), async (cases) => {
      const now = 10_000_000;
      const claudeTasks = new Map(cases.map((c, index) => [`monitor-thread-${index}`, c.claudeTasks]));
      const { service, internals } = createService({ claudeTasks });
      const actions = new Map<string, WatchdogAction[]>();
      const act = (record: TaskMonitorDelegationRecord, action: WatchdogAction) =>
        actions.set(record.monitorId, [...actions.get(record.monitorId) ?? [], action]);
      vi.spyOn(internals, "startTaskMonitorRecoveryTurn").mockImplementation(async ({ record }) => { act(record, "recover"); });
      vi.spyOn(internals, "synthesizeTaskMonitorFallbackCompletion").mockImplementation(async ({ record, reason }) => {
        act(record, `fallback:${reason}` as WatchdogAction);
      });
      const failing = new Set<string>();
      vi.spyOn(internals, "interruptManagedTaskMonitor").mockImplementation(async (record) => {
        act(record, "interrupt");
        if (failing.has(record.monitorId)) throw new Error("fixture interrupt failure");
      });
      const records = cases.map((c, index) => {
        const record = monitorRecord({
          activeCommandCount: c.activeCommandCount,
          awaitingClaudeTaskWake: c.awaitingClaudeTaskWake,
          backend: c.backend,
          cancellation: c.cancelled ? ({ reason: "fixture" } as never) : undefined,
          heartbeatIntervalSeconds: c.heartbeatIntervalSeconds,
          lastActivityAt: now - idleMs(c),
          monitorId: `monitor-${index}`,
          monitorThreadId: c.hasThread ? `monitor-thread-${index}` : undefined,
          monitorTurnId: c.hasTurn ? `monitor-turn-${index}` : undefined,
          pendingMcpApprovalCount: c.pendingMcpApprovalCount,
          pollIntervalSeconds: c.pollIntervalSeconds,
          recoveryAttempted: c.recoveryAttempted,
          staleInterruptAttempted: c.staleInterruptAttempted,
          startupTimeoutSeconds: c.startupTimeoutSeconds,
        });
        if (c.interruptFails) failing.add(record.monitorId);
        internals.taskMonitorDelegations.set(record.monitorId, record);
        return { ...record };
      });

      await service.checkStaleTaskMonitors(now);

      cases.forEach((c, index) => {
        const expected = expectedWatchdogActions(c);
        const monitorId = `monitor-${index}`;
        expect(actions.get(monitorId) ?? [], monitorId).toEqual(expected);
        const record = internals.taskMonitorDelegations.get(monitorId)!;
        // A recovery consumes the Claude wake; an interrupt is remembered so
        // the next stale check falls back instead of interrupting again.
        expect(record.awaitingClaudeTaskWake).toBe(expected[0] === "recover" ? false : records[index]!.awaitingClaudeTaskWake);
        expect(record.staleInterruptAttempted).toBe(expected[0] === "interrupt" ? true : records[index]!.staleInterruptAttempted);
        if (expected.length === 0) expect(record).toEqual(records[index]);
      });
    }), { numRuns: 300 });
  });
});

// ---- Monitor lookups and sub-agent ownership --------------------------------

const BACKENDS: AppServerBackendKind[] = ["codex", "claude", "acp:kimi"];
const THREADS = ["t-0", "t-1", "t-2", "t-3"];

describe("SubAgentMonitorService monitor lookups", () => {
  it("finds a thread's monitor by backend and thread, and counts a finished monitor's thread as a monitor thread", () => {
    const delegation = fc.record({
      backend: fc.constantFrom(...BACKENDS),
      monitorThreadId: fc.option(fc.constantFrom(...THREADS), { nil: undefined }),
    });
    const completed = fc.record({ backend: fc.constantFrom(...BACKENDS), threadId: fc.constantFrom(...THREADS) });
    const query = fc.record({ backend: fc.constantFrom(...BACKENDS), threadId: fc.constantFrom(...THREADS) });
    fc.assert(fc.property(fc.array(delegation, { maxLength: 6 }), fc.array(completed, { maxLength: 4 }), query, (live, done, context) => {
      const { service, internals } = createService();
      const records = live.map((entry, index) => monitorRecord({ ...entry, monitorId: `monitor-${index}` }));
      for (const record of records) internals.taskMonitorDelegations.set(record.monitorId, record);
      for (const entry of done) {
        internals.completedTaskMonitorsByThread.set(taskMonitorThreadKey(entry.backend, entry.threadId), monitorRecord());
      }
      // The first live delegation, in creation order, on that backend's thread.
      const expected = records.find((record) => record.backend === context.backend && record.monitorThreadId === context.threadId);
      expect(service.taskMonitorForThread(context)).toBe(expected);
      const finished = done.some((entry) => entry.backend === context.backend && entry.threadId === context.threadId);
      expect(service.isTaskMonitorThread(context)).toBe(Boolean(expected) || finished);
    }), { numRuns: 300 });
  });

  it("resolves any worker to the durable root thread of its parent chain", () => {
    // A forest over Codex threads: each thread after the first may hang off an
    // earlier one through a task monitor, a review child or a native worker.
    type Link = { kind: "monitor" | "review" | "native"; parent: number } | undefined;
    const forest = fc.integer({ min: 1, max: 8 }).chain((size) =>
      fc.tuple(...Array.from({ length: size }, (_, index) => index === 0
        ? fc.constant<Link>(undefined)
        : fc.option(fc.record({
            kind: fc.constantFrom("monitor" as const, "review" as const, "native" as const),
            parent: fc.integer({ min: 0, max: index - 1 }),
          }), { nil: undefined }))));
    fc.assert(fc.property(forest, fc.nat(), (links, pick) => {
      const reviews = new Map<string, ReviewSubAgentRecord>();
      const { service, internals } = createService({ reviews });
      links.forEach((link, index) => {
        if (!link) return;
        const threadId = `w-${index}`;
        const parentThreadId = `w-${link.parent}`;
        if (link.kind === "monitor") {
          const record = monitorRecord({ monitorId: `monitor-${index}`, monitorThreadId: threadId, parentThreadId });
          internals.taskMonitorDelegations.set(record.monitorId, record);
        } else if (link.kind === "review") {
          reviews.set(`review-${index}`, {
            backend: "codex", createdAt: 1, displayText: "review", mode: "managed",
            parentBackend: "codex", parentThreadId, reviewThreadId: threadId, task: "review", turnId: `turn-${index}`,
          });
        } else {
          service.setCodexNativeSubAgentParent(threadId, parentThreadId);
        }
      });
      const start = pick % links.length;
      let root = start;
      while (links[root]) root = links[root]!.parent;
      expect(service.resolveSubAgentThreadOwner({ backend: "codex", threadId: `w-${start}` }))
        .toEqual({ backend: "codex", isSubAgent: root !== start, threadId: `w-${root}` });
    }), { numRuns: 300 });
  });

  it("stops at a thread already visited when parent links form a cycle", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 6 }), fc.nat(), (size, pick) => {
      const { service } = createService();
      // w-0 -> w-1 -> ... -> w-(size-1) -> w-0
      for (let index = 0; index < size; index += 1) {
        service.setCodexNativeSubAgentParent(`w-${index}`, `w-${(index + 1) % size}`);
      }
      const start = pick % size;
      const owner = service.resolveSubAgentThreadOwner({ backend: "codex", threadId: `w-${start}` });
      // A self-parent is no parent; a longer cycle walks once round to the start.
      expect(owner).toEqual({ backend: "codex", isSubAgent: size > 1, threadId: `w-${start}` });
    }));
  });
});

// ---- Startup sub-agent reconciliation ---------------------------------------

describe("SubAgentMonitorService startup reconciliation", () => {
  it("repairs orphaned cards only with the live owners in hand, and refreshes lists only for a repair", async () => {
    const scenario = fc.record({
      hasReconcile: fc.boolean(),
      hasMove: fc.boolean(),
      liveIds: fc.option(fc.array(fc.constantFrom("runtime-a", "runtime-b"), { maxLength: 2 }), { nil: undefined }),
      repaired: fc.integer({ min: 0, max: 3 }),
    });
    await fc.assert(fc.asyncProperty(scenario, async ({ hasReconcile, hasMove, liveIds, repaired }) => {
      const calls: string[] = [];
      const reconcileParams: unknown[] = [];
      const invalidated = vi.fn();
      const { service } = createService({
        host: {
          liveProfileRuntimeInstanceIds: () => liveIds,
          invalidateThreadListCache: invalidated,
        },
        stores: {
          subAgents: {
            ...(hasMove ? { moveLegacyThreadSubAgents: async () => { calls.push("move"); } } : {}),
            ...(hasReconcile ? {
              reconcileOrphanedThreadSubAgents: async (params: unknown) => {
                calls.push("reconcile");
                reconcileParams.push(params);
                return { repairedSubAgents: repaired };
              },
            } : {}),
          },
        },
      });

      await service.reconcileOrphanedThreadSubAgentsAtStartup();

      // A store without the repair does nothing; without the live owners only
      // the one-time card move runs; otherwise only the repair runs.
      const expected = !hasReconcile ? [] : !liveIds ? (hasMove ? ["move"] : []) : ["reconcile"];
      expect(calls).toEqual(expected);
      if (expected[0] === "reconcile") {
        expect(reconcileParams).toEqual([{
          currentRuntimeInstanceId: "runtime-fixture",
          currentRegistrySessionId: "session-fixture",
          liveRuntimeInstanceIds: liveIds,
          sessionStartedAt: 5_000,
        }]);
      }
      expect(invalidated).toHaveBeenCalledTimes(expected[0] === "reconcile" && repaired > 0 ? 1 : 0);
    }), { numRuns: 200 });
  });
});

// ---- Native worker reconciliation timers ------------------------------------

type ReconcileCommand =
  | { kind: "schedule"; worker: string; parent: string; delayMs: number }
  | { kind: "clear"; worker: string }
  | { kind: "advance"; ms: number };

const WORKERS = ["worker-a", "worker-b", "worker-c"];

const reconcileCommand: fc.Arbitrary<ReconcileCommand> = fc.oneof(
  fc.record({
    kind: fc.constant("schedule" as const),
    worker: fc.constantFrom(...WORKERS),
    parent: fc.constantFrom("parent-1", "parent-2"),
    delayMs: fc.integer({ min: 1, max: 5 }).map((seconds) => seconds * 1_000),
  }),
  fc.record({ kind: fc.constant("clear" as const), worker: fc.constantFrom(...WORKERS) }),
  fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 6_000 }) }),
);

describe("SubAgentMonitorService native worker reconciliation", () => {
  it("keeps one pending reconciliation per worker, and runs each scheduled one once unless replaced or cleared", async () => {
    await fc.assert(fc.asyncProperty(fc.array(reconcileCommand, { maxLength: 30 }), async (commands) => {
      vi.useFakeTimers();
      try {
        const { internals } = createService();
        const fired: string[] = [];
        vi.spyOn(internals, "reconcileCodexNativeSubAgent").mockImplementation(async (worker) => { fired.push(worker); });
        // The model: a worker's record lives from its first schedule until it
        // is cleared, keeps its first start time, and has at most one deadline.
        const model = new Map<string, { parent: string; startedAt: number; deadline?: number }>();
        const expectedFired: string[] = [];
        for (const command of commands) {
          if (command.kind === "schedule") {
            const now = Date.now();
            const existing = model.get(command.worker);
            model.set(command.worker, {
              parent: command.parent,
              startedAt: existing?.startedAt ?? now,
              deadline: now + command.delayMs,
            });
            internals.scheduleCodexNativeSubAgentReconciliation({
              delayMs: command.delayMs,
              parentThreadId: command.parent,
              receiverThreadId: command.worker,
            });
          } else if (command.kind === "clear") {
            model.delete(command.worker);
            internals.clearCodexNativeSubAgentReconciliation(command.worker);
          } else {
            const until = Date.now() + command.ms;
            for (const [worker, entry] of model) {
              if (entry.deadline !== undefined && entry.deadline <= until) {
                expectedFired.push(worker);
                entry.deadline = undefined;
              }
            }
            await vi.advanceTimersByTimeAsync(command.ms);
          }
          expect([...fired].sort()).toEqual([...expectedFired].sort());
          expect([...internals.codexNativeSubAgentReconciliations.keys()].sort()).toEqual([...model.keys()].sort());
          for (const [worker, entry] of model) {
            const actual = internals.codexNativeSubAgentReconciliations.get(worker)!;
            expect(actual.parentThreadId).toBe(entry.parent);
            expect(actual.startedAt).toBe(entry.startedAt);
            expect(actual.timer !== undefined, worker).toBe(entry.deadline !== undefined);
          }
        }
      } finally {
        vi.useRealTimers();
      }
    }), { numRuns: 200 });
  });
});

// ---- Task monitor lifecycle -------------------------------------------------

type MonitorBackend = "codex" | "claude";
type TerminalStatus = "completed" | "failed" | "cancelled";

type LifecycleCommand =
  | { kind: "create"; parent: string; backend: MonitorBackend; startFails: boolean }
  | { kind: "complete"; pick: number; outcome: "success" | "failure"; triggerParentTurn: boolean }
  | { kind: "cancel"; pick: number; interruptFails: boolean }
  | {
      kind: "terminal";
      pick: number;
      status: TerminalStatus;
      turn: "current" | "stale" | "none";
      watcherRunning: boolean;
      recoveryStartFails: boolean;
    };

const MONITOR_PARENTS = ["parent-0", "parent-1"];

const lifecycleCommand: fc.Arbitrary<LifecycleCommand> = fc.oneof(
  fc.record({
    kind: fc.constant("create" as const),
    parent: fc.constantFrom(...MONITOR_PARENTS),
    backend: fc.constantFrom("codex" as const, "claude" as const),
    startFails: fc.constantFrom(false, false, false, true),
  }),
  fc.record({
    kind: fc.constant("complete" as const),
    pick: fc.nat(),
    outcome: fc.constantFrom("success" as const, "failure" as const),
    triggerParentTurn: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("cancel" as const),
    pick: fc.nat(),
    interruptFails: fc.constantFrom(false, false, true),
  }),
  fc.record({
    kind: fc.constant("terminal" as const),
    pick: fc.nat(),
    status: fc.constantFrom("completed" as const, "failed" as const, "cancelled" as const),
    turn: fc.constantFrom("current" as const, "current" as const, "stale" as const, "none" as const),
    watcherRunning: fc.boolean(),
    recoveryStartFails: fc.constantFrom(false, false, true),
  }),
);

/** The model's view of one live delegation. */
type ModelMonitor = {
  monitorId: string;
  parentThreadId: string;
  backend: MonitorBackend;
  threadId: string;
  turnId: string;
  cancelling: boolean;
  recoveryAttempted: boolean;
  awaitingWake: boolean;
};

const flushLifecycle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("SubAgentMonitorService task monitor lifecycle", () => {
  it("keeps a delegation live exactly until it finishes, and every lookup agrees with the model at each step", async () => {
    await fc.assert(fc.asyncProperty(fc.array(lifecycleCommand, { minLength: 1, maxLength: 24 }), async (commands) => {
      // Fixture switches each command sets before it runs.
      let nextTurnId = "turn-0";
      let failInterrupt = false;
      let failRecoveryStart = false;
      let claudeTaskCount = 0;
      const parentWakes: string[] = [];
      const lastStatus = new Map<string, string | undefined>();
      const turnStart = async (params: { threadId: string }) => {
        if (failRecoveryStart) throw new Error("fixture recovery start failure");
        return { threadId: params.threadId, turnId: nextTurnId };
      };
      const interrupt = async () => {
        if (failInterrupt) throw new Error("fixture interrupt failure");
      };
      const { service, internals } = createService({
        claude: {
          activeTaskCount: () => claudeTaskCount,
          readThread: async () => ({ entries: [] }),
          releaseEphemeralThread: () => {},
        },
        dependencies: {
          threadMcpConnections: { taskMonitorMcpAccess: async () => ({ connectionIds: [] }) },
        },
        stores: {
          subAgents: { getThreadSubAgent: async () => undefined },
          threads: { getThreadOverlayState: async () => undefined },
        },
        host: {
          bindStartingTurnOrigin: () => {},
          canStartThreadTurnImmediately: () => false,
          dropStartingTurnOrigin: () => {},
          getClient: () => ({ interruptTurn: interrupt, startTurn: turnStart }) as never,
          interruptTurn: interrupt as never,
          persistStartingTurnOrigin: async () => {},
          readCausalMessagingContext: (async () => undefined) as never,
          readDelegatedTurnAncestry: async () => ({}),
          readThreadLock: async () => undefined,
          resolvePausedThreadProject: () => undefined,
          shutdownRequested: false,
          startTurnWithoutHandoff: turnStart as never,
          stoppingRunningTurnsForShutdown: false,
          submitTurn: (async (wake: { threadId: string }) => {
            parentWakes.push(wake.threadId);
            return { status: "started", turnId: "parent-wake", entry: { id: "wake-entry" } };
          }) as never,
        },
      });
      let startFails = false;
      let startedThreadId = "";
      vi.spyOn(internals, "resolveTaskMonitorModelSettings").mockImplementation(async (params) => ({
        monitorBackend: (params as { backend: MonitorBackend }).backend === "claude" ? "claude" : "codex",
        preferredModel: "gpt-fixture",
        preferredReasoningEffort: "low",
      }));
      vi.spyOn(internals, "startManagedTaskMonitor").mockImplementation(async () => {
        if (startFails) throw new Error("fixture start failure");
        return { executionMode: "default", threadId: startedThreadId, turnId: nextTurnId };
      });
      vi.spyOn(internals, "persistTaskMonitorSubAgent").mockImplementation(async (record, patch) => {
        lastStatus.set(record.monitorId, patch?.status);
      });
      vi.spyOn(internals, "injectTaskMonitorCompletionMessage").mockResolvedValue(undefined);
      vi.spyOn(internals, "emitTaskMonitorCompletionState").mockResolvedValue(undefined);
      vi.spyOn(internals, "emitTaskMonitorUsageActivity").mockResolvedValue(undefined);

      // The model. A finished monitor's thread stays a monitor thread only
      // when the monitor reported its own result, until that thread's final
      // turn reports its end.
      const live = new Map<string, ModelMonitor>();
      const completed = new Map<string, string>();
      const created: Array<{ monitorId: string; backend: MonitorBackend; threadId: string; turnId: string }> = [];
      const outcomes = new Map<string, string>();
      const expectedWakes: string[] = [];
      const cancelCalls: Array<{ monitorId: string; settled?: TaskMonitorResponse }> = [];
      const expectedCancels: string[] = [];
      const unknown = { monitorId: "monitor-unknown", backend: "codex" as const, threadId: "monitor-thread-unknown", turnId: "turn-unknown" };
      const pick = (index: number) => index % (created.length + 1) < created.length
        ? created[index % (created.length + 1)]!
        : unknown;
      const finish = (monitor: ModelMonitor, outcome: string, wakesParent: boolean) => {
        live.delete(monitor.monitorId);
        outcomes.set(monitor.monitorId, outcome);
        if (wakesParent) expectedWakes.push(monitor.parentThreadId);
        expectedCancels.forEach((state, index) => {
          if (state === "pending" && cancelCalls[index]!.monitorId === monitor.monitorId) expectedCancels[index] = "cancelled";
        });
      };

      for (const [step, command] of commands.entries()) {
        nextTurnId = `turn-${step}`;
        if (command.kind === "create") {
          startFails = command.startFails;
          startedThreadId = `monitor-thread-${step}`;
          const response = await internals.handleTaskMonitorRequest({
            operation: "create_monitor_delegation",
            context: { backend: command.backend, threadId: command.parent, turnId: `${command.parent}-turn` },
            args: { task: `Watch job ${step}` },
          });
          expect(response.ok, JSON.stringify(response)).toBe(!command.startFails);
          if (response.ok && response.operation === "create_monitor_delegation") {
            const monitor: ModelMonitor = {
              monitorId: response.data.monitorId,
              parentThreadId: command.parent,
              backend: command.backend,
              threadId: startedThreadId,
              turnId: nextTurnId,
              cancelling: false,
              recoveryAttempted: false,
              awaitingWake: false,
            };
            live.set(monitor.monitorId, monitor);
            created.push(monitor);
          }
        } else if (command.kind === "complete") {
          const target = pick(command.pick);
          const monitor = live.get(target.monitorId);
          const response = await internals.handleTaskMonitorRequest({
            operation: "complete_monitoring",
            context: { backend: target.backend, threadId: target.threadId, turnId: target.turnId },
            args: {
              monitorId: target.monitorId,
              outcome: command.outcome,
              summary: "Fixture result.",
              triggerParentTurn: command.triggerParentTurn,
            },
          });
          const accepted = Boolean(monitor && !monitor.cancelling);
          expect(response.ok).toBe(accepted);
          if (monitor && accepted) {
            finish(monitor, command.outcome, command.triggerParentTurn);
            completed.set(taskMonitorThreadKey(monitor.backend, monitor.threadId), monitor.turnId);
          }
        } else if (command.kind === "cancel") {
          const target = pick(command.pick);
          const monitor = live.get(target.monitorId);
          failInterrupt = command.interruptFails;
          const call: { monitorId: string; settled?: TaskMonitorResponse } = { monitorId: target.monitorId };
          cancelCalls.push(call);
          void internals.handleTaskMonitorRequest({
            operation: "cancel_monitor_delegation",
            // Each fixture monitor runs on its parent's provider.
            context: { backend: target.backend, threadId: monitor?.parentThreadId ?? "parent-0", turnId: "parent-turn" },
            args: { monitorId: target.monitorId },
          }).then((response) => { call.settled = response; });
          await flushLifecycle();
          if (!monitor) {
            expectedCancels.push("not_found");
          } else if (monitor.cancelling) {
            // A second request shares the first one's interrupt and result.
            expectedCancels.push("pending");
          } else if (command.interruptFails) {
            expectedCancels.push("internal_error");
          } else {
            expectedCancels.push("pending");
            monitor.cancelling = true;
            // A Claude monitor waiting on its watcher has no turn to end.
            if (monitor.awaitingWake) finish(monitor, "cancelled", false);
          }
        } else {
          const target = pick(command.pick);
          const key = taskMonitorThreadKey(target.backend, target.threadId);
          const monitor = [...live.values()].find((candidate) => candidate.monitorId === target.monitorId);
          const currentTurn = monitor?.turnId ?? completed.get(key) ?? target.turnId;
          const turnId = command.turn === "current" ? currentTurn : command.turn === "stale" ? `${target.threadId}:stale` : undefined;
          claudeTaskCount = command.watcherRunning ? 1 : 0;
          failRecoveryStart = command.recoveryStartFails;
          await service.handleTaskMonitorTerminalNotification(target.backend, {
            method: `turn/${command.status}`,
            params: { threadId: target.threadId, ...(turnId ? { turn: { id: turnId } } : {}) },
          } as never);
          await flushLifecycle();
          const fallbackOutcome = command.status === "cancelled" ? "cancelled" : "failure";
          if (completed.has(key) && (!turnId || completed.get(key) === turnId)) {
            completed.delete(key);
          } else if (!monitor || (turnId && monitor.turnId !== turnId)) {
            // Not this monitor's turn.
          } else if (monitor.cancelling) {
            if (turnId) finish(monitor, "cancelled", false);
          } else if (
            monitor.backend === "claude"
            && !monitor.recoveryAttempted
            && command.status === "completed"
            && command.watcherRunning
          ) {
            monitor.awaitingWake = true;
          } else if (!monitor.recoveryAttempted) {
            monitor.recoveryAttempted = true;
            if (command.recoveryStartFails) finish(monitor, fallbackOutcome, true);
            else monitor.turnId = nextTurnId;
          } else {
            finish(monitor, fallbackOutcome, true);
          }
        }

        // The service agrees with the model.
        expect([...internals.taskMonitorDelegations.keys()].sort(), `step ${step}`).toEqual([...live.keys()].sort());
        for (const monitor of live.values()) {
          const record = internals.taskMonitorDelegations.get(monitor.monitorId)!;
          expect(record.monitorThreadId).toBe(monitor.threadId);
          expect(record.monitorTurnId).toBe(monitor.turnId);
          expect(Boolean(record.cancellation)).toBe(monitor.cancelling);
          expect(Boolean(record.recoveryAttempted)).toBe(monitor.recoveryAttempted);
        }
        expect([...internals.completedTaskMonitorsByThread.keys()].sort(), `step ${step}`).toEqual([...completed.keys()].sort());
        for (const thread of [...created, unknown]) {
          for (const backend of ["codex", "claude"] as const) {
            const context = { backend, threadId: thread.threadId };
            const expected =
              [...live.values()].some((monitor) => monitor.backend === backend && monitor.threadId === thread.threadId)
              || completed.has(taskMonitorThreadKey(backend, thread.threadId));
            expect(service.isTaskMonitorThread(context), `${backend}:${thread.threadId}`).toBe(expected);
          }
        }
        for (const parent of MONITOR_PARENTS) {
          for (const backend of ["codex", "claude"] as const) {
            const expected = [...live.values()]
              .filter((monitor) => monitor.backend === backend && monitor.parentThreadId === parent && !monitor.cancelling)
              .map((monitor) => monitor.monitorId)
              .sort();
            const actual = service.listPendingTaskMonitorWakes({ backend, threadId: parent }).map((wake) => wake.monitorId).sort();
            expect(actual, `${backend}:${parent}`).toEqual(expected);
          }
        }
        for (const [monitorId, outcome] of outcomes) {
          expect(lastStatus.get(monitorId), monitorId).toBe(outcome);
        }
        expect(parentWakes).toEqual(expectedWakes);
        expect(cancelCalls.map((call) => !call.settled
          ? "pending"
          : call.settled.ok
            ? (call.settled.data as { outcome?: string }).outcome
            : call.settled.error.code)).toEqual(expectedCancels);
      }
    }), { numRuns: 200 });
  });
});
