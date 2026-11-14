import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerBackendKind } from "@pwragent/shared";
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
 * review service's live review sub-agents.
 */
function createService(options: {
  claudeTasks?: ReadonlyMap<string, number>;
  reviews?: ReadonlyMap<string, ReviewSubAgentRecord>;
  host?: Partial<SubAgentMonitorServiceHost>;
  stores?: Record<string, unknown>;
} = {}) {
  const context = {
    stores: { subAgents: {}, threads: {}, usage: {}, ...options.stores },
    providers: {
      claude: { activeTaskCount: (threadId: string) => options.claudeTasks?.get(threadId) ?? 0 },
    },
    lifecycle: { closed: false },
    emit: async () => {},
  } as unknown as RegistryContext;
  const dependencies = {
    forgeToolBridge: {},
    threadMcpConnections: {},
    managedReviewService: { activeReviewSubAgentRecords: options.reviews ?? new Map() },
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
    const { registry } = createRegistry();
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
    }
  });

  it("lets the registry read the monitor and native worker state only through the module's views", async () => {
    const { registry } = createRegistry();
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
    }
  });

  it("releases its monitor and reconciliation state when the registry closes, in the registry's close order", async () => {
    vi.useFakeTimers();
    const { registry } = createRegistry();
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
