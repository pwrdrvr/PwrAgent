import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerBackendWake,
  AppServerBackgroundTask,
  ScheduledThreadAction,
  ThreadDependency,
  ThreadPrWatchHistoryEntry,
  ThreadPullRequestWatchSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import {
  SELF_STARTED_TURN_ENTRY_PREFIX,
  buildThreadPendingWakes,
  stopRemoteThreadPendingWake,
  stopThreadPendingWake,
  type PendingHeldQueueEntry,
  type ThreadPendingWakeReaders,
  type ThreadPendingWakeStoppers,
} from "../app-server/thread-pending-wakes";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const THREAD = { backend: "claude" as const, threadId: "waiting" };

function prWatch(overrides: Partial<ThreadPullRequestWatchSummary> = {}): ThreadPullRequestWatchSummary {
  return {
    watchId: "watch-ci",
    backend: "claude",
    threadId: "waiting",
    prKey: "github/acme/widgets#3174",
    prUrl: "https://github.com/acme/widgets/pull/3174",
    prNumber: 3174,
    headSha: "abc1234",
    notifyOn: ["success", "failure"],
    createdAt: 3_000,
    failureHandledByAutoFix: false,
    ...overrides,
  };
}

function dependency(overrides: Partial<ThreadDependency> = {}): ThreadDependency {
  return {
    id: "dep-1",
    backend: "claude",
    threadId: "waiting",
    conditions: [{ backend: "codex", threadId: "lease", when: "turn_completed", title: "Sandbox lease cleanup" }],
    mode: "all",
    onFailure: "notify",
    continuation: "Pick up the lease changes.",
    status: "waiting",
    evidence: [],
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function scheduled(overrides: Partial<ScheduledThreadAction> = {}): ScheduledThreadAction {
  return {
    id: "scheduled-action:1",
    backend: "claude",
    threadId: "waiting",
    kind: "turn",
    origin: "desktop",
    status: "scheduled",
    scheduledFor: 9_000,
    displayText: "Rebase on main and re-run shard 2.",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function task(overrides: Partial<AppServerBackgroundTask> = {}): AppServerBackgroundTask {
  return {
    itemId: "tool-1",
    processId: "task-1",
    command: "pnpm test",
    cwd: "/repo",
    background: true,
    startedAt: 4_000,
    ...overrides,
  };
}

function claudeWake(overrides: Partial<AppServerBackendWake> = {}): AppServerBackendWake {
  return {
    id: "a1b2c3d4",
    origin: "loop_wakeup",
    schedule: "5 14 3 11 *",
    recurring: false,
    prompt: "/loop check the staging deploy",
    reason: "Deploy takes about ten minutes.",
    nextFireAt: 5_000,
    createdAt: 4_500,
    ...overrides,
  };
}

function readers(overrides: Partial<ThreadPendingWakeReaders> = {}): ThreadPendingWakeReaders {
  return {
    prWatches: async () => [],
    prWatchHistory: async () => [],
    autoFix: async () => [],
    dependencies: async () => [],
    scheduledActions: () => ({ actions: [] }),
    monitors: () => [],
    recentSubAgents: async () => [],
    backendTasks: async () => [],
    backendWakes: () => [],
    hold: async () => undefined,
    heldEntries: () => [],
    ...overrides,
  };
}

function heldEntry(overrides: Partial<PendingHeldQueueEntry> = {}): PendingHeldQueueEntry {
  return {
    entryId: "thread-turn:1",
    origin: "manual",
    createdAt: 2_000,
    holdReason: "This thread is locked: Parked. Unlock it before starting a turn.",
    text: "Rebase on main.",
    ...overrides,
  };
}

const LOCKED = { kind: "thread_locked" as const, note: "Parked" };
const PAUSED = { kind: "project_paused" as const, projectLabel: "widgets", directoryKey: "directory:/repo/widgets" };

describe("buildThreadPendingWakes", () => {
  it.each([{ activePrWatches: [] }, { activePrWatches: [prWatch()] }])("reuses selected detail's PR watches without another read (%j)", async ({ activePrWatches }) => {
    const prWatches = vi.fn(async () => { throw new Error("duplicate PR watch read"); });
    const list = await buildThreadPendingWakes(readers({ prWatches }), THREAD, { activePrWatches, endedLimit: 0 });
    expect(list.wakes).toEqual(activePrWatches.map((watch) => expect.objectContaining({ kind: "pr_watch", watch })));
    expect(list.incomplete).toBeUndefined();
    expect(prWatches).not.toHaveBeenCalled();
  });

  it("lists every source's pending wakes, soonest first", async () => {
    const list = await buildThreadPendingWakes(readers({
      prWatches: async () => [
        prWatch({ watchId: "watch-merge", kind: "terminal", notifyOn: ["merged", "closed"], createdAt: 1_500 }),
        prWatch(),
      ],
      autoFix: async () => [
        { backend: "claude", threadId: "waiting", prKey: "github/acme/widgets#3174", state: "active" },
        // Another thread's Auto-fix never shows here.
        { backend: "codex", threadId: "other", prKey: "github/acme/widgets#3174", state: "active" },
      ],
      dependencies: async () => [dependency(), dependency({ id: "dep-done", status: "delivered" })],
      scheduledActions: () => ({ actions: [
        scheduled({ id: "scheduled-action:held", status: "held", scheduledFor: 1 }),
        scheduled(),
        scheduled({ id: "scheduled-action:sent", status: "started" }),
      ] }),
      monitors: () => [{
        monitorId: "monitor-1", task: "Staging deploy reports healthy", backend: "claude",
        createdAt: 5_000, lastActivityAt: 6_000, pollIntervalSeconds: 120,
      }],
      backendTasks: async () => [task(), task({ processId: "foreground", background: undefined })],
    }), THREAD);

    expect(list.wakes.map((wake) => wake.key)).toEqual([
      "scheduled_action:scheduled-action:1",
      "scheduled_action:scheduled-action:held",
      "pr_watch:watch-ci",
      "pr_watch:watch-merge",
      "pr_auto_fix:github/acme/widgets#3174",
      "dependency:dep-1",
      "monitor:monitor-1",
      "backend_task:task-1",
    ]);
    expect(list.incomplete).toBeUndefined();
    const timed = list.wakes[0]!;
    expect(timed).toMatchObject({ wakesAt: 9_000, durable: true, stop: "cancel", createdBy: "operator" });
    expect(list.wakes[1]).not.toHaveProperty("wakesAt");
    expect(list.wakes.find((wake) => wake.kind === "pr_auto_fix")).toMatchObject({ prNumber: 3174, stop: "turn_off" });
    // Process memory: they end if PwrAgent quits, and the row says so.
    expect(list.wakes.filter((wake) => !wake.durable).map((wake) => wake.kind)).toEqual(["monitor", "backend_task"]);
  });

  it("lists Claude's own wakes with the scheduled actions by time, with no stop", async () => {
    const list = await buildThreadPendingWakes(readers({
      scheduledActions: () => ({ actions: [
        scheduled({ id: "scheduled-held", status: "held" }),
        scheduled(),
      ] }),
      backendWakes: () => [
        claudeWake(),
        claudeWake({
          id: "e5f6a7b8", origin: "cron", schedule: "*/5 * * * *", recurring: true, humanSchedule: "every 5 minutes",
          prompt: "x".repeat(5_000), nextFireAt: undefined,
        }),
      ],
    }), THREAD);

    expect(list.wakes.map((wake) => wake.key)).toEqual([
      "backend_wake:a1b2c3d4",
      "scheduled_action:scheduled-action:1",
      "scheduled_action:scheduled-held",
      "backend_wake:e5f6a7b8",
    ]);
    expect(list.wakes[0]).toEqual({
      kind: "backend_wake",
      key: "backend_wake:a1b2c3d4",
      wake: claudeWake(),
      createdAt: 4_500,
      wakesAt: 5_000,
      createdBy: "agent",
      // It lives in Claude's process, and only Claude can cancel it.
      durable: false,
    });
    const cron = list.wakes[3]!;
    expect(cron).not.toHaveProperty("wakesAt");
    expect(cron.kind === "backend_wake" && cron.wake.prompt.length).toBe(600);
  });

  it("holds Claude's own wakes under a lock, which blocks the turn each starts", async () => {
    const list = await buildThreadPendingWakes(readers({
      hold: async () => LOCKED,
      scheduledActions: () => ({ actions: [scheduled()] }),
      backendWakes: () => [claudeWake()],
    }), THREAD);
    expect(list.wakes.map((wake) => [wake.key, wake.held])).toEqual([
      ["backend_wake:a1b2c3d4", LOCKED],
      ["scheduled_action:scheduled-action:1", LOCKED],
    ]);
  });

  it("offers no Turn Off while another thread owns the PR's repairs", async () => {
    const list = await buildThreadPendingWakes(readers({
      autoFix: async () => [{
        backend: "claude", threadId: "waiting", prKey: "github/acme/widgets#1", state: "handled_by_other_thread",
        handledBy: { backend: "codex", threadId: "other", title: "Repairs" },
      }],
    }), THREAD);
    expect(list.wakes).toEqual([expect.objectContaining({ kind: "pr_auto_fix", state: "handled_by_other_thread" })]);
    expect(list.wakes[0]).not.toHaveProperty("stop");
  });

  it("cuts long text so one row cannot flood the list", async () => {
    const list = await buildThreadPendingWakes(readers({
      dependencies: async () => [dependency({ continuation: "x".repeat(5_000) })],
    }), THREAD);
    const wake = list.wakes[0]!;
    expect(wake.kind === "dependency" && wake.dependency.continuation?.length).toBe(600);
  });

  it("bounds backend text and the total pending projection without losing an incomplete signal", async () => {
    const list = await buildThreadPendingWakes(readers({ backendTasks: async () => Array.from({ length: 200 }, (_, index) =>
      task({ processId: `task-${index}`, command: "é".repeat(20_000), progress: "x".repeat(20_000) })) }), THREAD);
    expect(Buffer.byteLength(JSON.stringify(list.wakes))).toBeLessThanOrEqual(64 * 1024);
    expect(list.wakes.length).toBeGreaterThan(0);
    expect(list.wakes.length).toBeLessThan(200);
    expect(list.incomplete).toBe(true);
    expect(list.wakes[0]).toMatchObject({ kind: "backend_task", task: { processId: "task-0" } });
  });

  it("lists ended wakes newest first, from the rows each source keeps", async () => {
    const history: ThreadPrWatchHistoryEntry[] = [
      { ...prWatch(), status: "dispatched", endedReason: "woke", wokeOn: "failure", updatedAt: 40 },
      // A move hands the watch on; nothing ended.
      { ...prWatch({ watchId: "moved" }), status: "superseded", endedReason: "moved", updatedAt: 50 },
    ];
    const cards: ThreadSubAgentSummary[] = [
      { monitorId: "monitor-old", task: "Deploy healthy", status: "success", createdAt: 1, updatedAt: 30, completedAt: 30, outcome: "success" },
      // A review card is a sub-agent, not a wake.
      { monitorId: "review:1", task: "Review", status: "success", createdAt: 1, updatedAt: 60, completedAt: 60, outcome: "success" },
    ];
    const list = await buildThreadPendingWakes(readers({
      prWatchHistory: async () => history,
      dependencies: async () => [dependency({ status: "cancelled", updatedAt: 20 })],
      scheduledActions: () => ({ actions: [scheduled({ status: "started", updatedAt: 35 })] }),
      recentSubAgents: async () => cards,
    }), THREAD, { endedLimit: 3 });
    expect(list.ended.map((entry) => [entry.summary, entry.detail])).toEqual([
      ["PR watch woke the thread", "#3174 CI failed"],
      ["Scheduled message sent", "Rebase on main and re-run shard 2."],
      ["Monitor finished", "Deploy healthy"],
    ]);
  });

  it("reads no ended rows for a list that shows none", async () => {
    const scheduledActions = vi.fn(() => ({ actions: [] as ScheduledThreadAction[] }));
    const prWatchHistory = vi.fn(async () => [] as ThreadPrWatchHistoryEntry[]);
    const recentSubAgents = vi.fn(async () => [] as ThreadSubAgentSummary[]);
    const list = await buildThreadPendingWakes(readers({ scheduledActions, prWatchHistory, recentSubAgents }), THREAD, { endedLimit: 0 });
    expect(list.ended).toEqual([]);
    expect(scheduledActions).toHaveBeenCalledWith(THREAD, 0);
    expect(prWatchHistory).not.toHaveBeenCalled();
    expect(recentSubAgents).not.toHaveBeenCalled();
  });

  it("leaves out a source it cannot read and says the list may be missing a wake", async () => {
    const onReadError = vi.fn();
    const list = await buildThreadPendingWakes(readers({
      dependencies: async () => { throw new Error("locked"); },
      backendTasks: async () => [task()],
    }), THREAD, { onReadError });
    expect(list.incomplete).toBe(true);
    expect(list.wakes.map((wake) => wake.kind)).toEqual(["backend_task"]);
    expect(onReadError).toHaveBeenCalledWith("dependencies", expect.any(Error));
  });
});

describe("held wakes", () => {
  it("lists what a lock holds first, and marks every wake the lock keeps from starting", async () => {
    const list = await buildThreadPendingWakes(readers({
      hold: async () => LOCKED,
      heldEntries: () => [
        heldEntry({ entryId: "task-monitor:monitor-9", origin: "manual", createdAt: 3_000, text: "Monitor finished." }),
        heldEntry(),
        // A held scheduled action is listed as itself, once.
        heldEntry({ entryId: "scheduled-entry", origin: "scheduled", text: "Ping CI." }),
      ],
      scheduledActions: () => ({ actions: [
        scheduled({ id: "scheduled-1", status: "held", queueEntryId: "scheduled-entry" }),
        scheduled({ id: "scheduled-2", scheduledFor: 9_000 }),
      ] }),
      prWatches: async () => [prWatch()],
      autoFix: async () => [{ backend: "claude", threadId: "waiting", prKey: "github/acme/widgets#3174", state: "active" }],
      dependencies: async () => [dependency({ status: "ready" })],
      backendTasks: async () => [task()],
      backendWakes: () => [claudeWake()],
    }), THREAD);

    expect(list.wakes.map((wake) => wake.key)).toEqual([
      "held_message:thread-turn:1",
      "held_message:task-monitor:monitor-9",
      "backend_wake:a1b2c3d4",
      "scheduled_action:scheduled-2",
      "scheduled_action:scheduled-1",
      "pr_watch:watch-ci",
      "pr_auto_fix:github/acme/widgets#3174",
      "dependency:dep-1",
      "backend_task:task-1",
    ]);
    const held = Object.fromEntries(list.wakes.map((wake) => [wake.key, wake.held]));
    expect(held["held_message:thread-turn:1"]).toEqual(LOCKED);
    expect(held["scheduled_action:scheduled-2"]).toEqual(LOCKED);
    expect(held["pr_watch:watch-ci"]).toEqual(LOCKED);
    expect(held["dependency:dep-1"]).toEqual(LOCKED);
    // Claude's task runs on and its wake is due; the turn either starts waits.
    expect(held["backend_task:task-1"]).toEqual(LOCKED);
    expect(held["backend_wake:a1b2c3d4"]).toEqual(LOCKED);
    // Auto-fix is off while locked.
    expect(held["pr_auto_fix:github/acme/widgets#3174"]).toBeUndefined();
    expect(list.wakes[0]).toMatchObject({
      kind: "held_message", entryId: "thread-turn:1", source: "operator", displayText: "Rebase on main.",
      createdBy: "operator", durable: false, stop: "discard",
    });
    expect(list.wakes[1]).toMatchObject({ source: "monitor", createdBy: "agent" });
  });

  it("names a paused project's hold, and leaves scheduled actions alone", async () => {
    const list = await buildThreadPendingWakes(readers({
      hold: async () => ({ ...PAUSED, discardsWakeups: true }),
      heldEntries: () => [heldEntry({
        entryId: "dependency:dep-7",
        origin: "automation",
        holdReason: "Held because forge activity in widgets is paused.",
        projectHold: { ...PAUSED, source: "dependency", summary: "Continue After: Lease cleanup finished" },
      })],
      scheduledActions: () => ({ actions: [scheduled()] }),
      prWatches: async () => [prWatch()],
      dependencies: async () => [dependency()],
      backendTasks: async () => [task()],
      backendWakes: () => [claudeWake()],
    }), THREAD);

    expect(list.wakes[0]).toMatchObject({
      kind: "held_message", source: "dependency", displayText: "Continue After: Lease cleanup finished",
      durable: true, held: PAUSED,
    });
    const held = Object.fromEntries(list.wakes.map((wake) => [wake.kind, wake.held]));
    expect(held.scheduled_action).toBeUndefined();
    // A pause does not hold the turns Claude starts on its own.
    expect(held.backend_task).toBeUndefined();
    expect(held.backend_wake).toBeUndefined();
    expect(held.pr_watch).toEqual({ ...PAUSED, discardsWakeups: true });
    expect(held.dependency).toEqual({ ...PAUSED, discardsWakeups: true });
  });

  it("lists Claude's held turns as an agent's, named by their title", async () => {
    const list = await buildThreadPendingWakes(readers({
      hold: async () => LOCKED,
      heldEntries: () => [heldEntry({
        entryId: `${SELF_STARTED_TURN_ENTRY_PREFIX}waiting`, origin: "manual",
        text: "Claude's answer to a finished background task",
      })],
    }), THREAD);
    expect(list.wakes).toEqual([expect.objectContaining({
      kind: "held_message", source: "other", displayText: "Claude's answer to a finished background task",
      held: LOCKED, stop: "discard",
    })]);
    expect(list.wakes[0]).not.toHaveProperty("createdBy");
  });

  it("says why a queue waits after a failed turn", async () => {
    const list = await buildThreadPendingWakes(readers({
      heldEntries: () => [heldEntry({ origin: "messaging", holdReason: "The previous turn failed." })],
    }), THREAD);
    expect(list.wakes).toEqual([expect.objectContaining({
      source: "messaging", held: { kind: "queue_held", reason: "The previous turn failed." },
    })]);
  });

  it("keeps a failed turn's hold when the thread is also locked, since unlocking does not release it", async () => {
    const list = await buildThreadPendingWakes(readers({
      hold: async () => LOCKED,
      heldEntries: () => [heldEntry({ holdReason: "The previous turn failed." })],
    }), THREAD);
    expect(list.wakes[0]?.held).toEqual({ kind: "queue_held", reason: "The previous turn failed." });
  });

  it("marks the list incomplete when the hold cannot be read", async () => {
    const list = await buildThreadPendingWakes(readers({
      hold: async () => { throw new Error("overlay unreadable"); },
      prWatches: async () => [prWatch()],
    }), THREAD);
    expect(list.incomplete).toBe(true);
    expect(list.wakes[0]?.held).toBeUndefined();
  });
});

describe("stopThreadPendingWake", () => {
  const stoppers = (): ThreadPendingWakeStoppers & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      cancelPrWatch: async (_thread, id) => { calls.push(`pr:${id}`); return { ok: true }; },
      cancelDependency: async (_thread, id) => { calls.push(`dependency:${id}`); },
      stopMonitor: async (_thread, id) => { calls.push(`monitor:${id}`); },
      cancelScheduledAction: async (_thread, id) => { calls.push(`scheduled:${id}`); },
      stopBackendTask: async (_thread, id) => { calls.push(`task:${id}`); },
      discardHeldMessage: async (_thread, id) => { calls.push(`held:${id}`); },
    };
  };

  it("sends each stop to the source that owns the wake", async () => {
    const owner = stoppers();
    for (const key of [
      "pr_watch:watch-ci", "dependency:dep-1", "monitor:monitor-1",
      "scheduled_action:scheduled-action:1", "backend_task:task-1", "held_message:task-monitor:monitor-9",
    ]) {
      await expect(stopThreadPendingWake(owner, THREAD, key)).resolves.toEqual({ ok: true, stopped: true });
    }
    // The scheduled action id keeps its own colon.
    expect(owner.calls).toEqual([
      "pr:watch-ci", "dependency:dep-1", "monitor:monitor-1", "scheduled:scheduled-action:1", "task:task-1",
      "held:task-monitor:monitor-9",
    ]);
  });

  it("answers a failed stop with the source's reason", async () => {
    const owner = stoppers();
    owner.stopMonitor = async () => { throw new Error("Sub-agent is already completing."); };
    await expect(stopThreadPendingWake(owner, THREAD, "monitor:monitor-1")).resolves.toEqual({
      ok: false, error: { code: "failed", message: "Sub-agent is already completing." },
    });
    await expect(stopThreadPendingWake(owner, THREAD, "nonsense")).resolves.toMatchObject({
      ok: false, error: { code: "invalid_arguments" },
    });
    await expect(stopThreadPendingWake(owner, THREAD, "pr_auto_fix:github/acme/widgets#1")).resolves.toMatchObject({
      ok: false, error: { code: "invalid_arguments" },
    });
    // Only Claude can cancel the wakes it scheduled.
    await expect(stopThreadPendingWake(owner, THREAD, "backend_wake:a1b2c3d4")).resolves.toEqual({
      ok: false, error: { code: "invalid_arguments", message: "Only the agent can cancel its own schedule. Ask it to stop." },
    });
    expect(owner.calls).toEqual([]);
  });

  it("keeps a peer's dependencies on their own instance", async () => {
    const remote = {
      cancelPrWatch: vi.fn(async () => ({ ok: true as const })),
      cancelScheduledAction: vi.fn(async () => {}),
      stopMonitor: vi.fn(async () => {}),
      stopBackendTask: vi.fn(async () => {}),
      discardHeldMessage: vi.fn(async () => {}),
    };
    await expect(stopRemoteThreadPendingWake(remote, "dependency:dep-1", "studio-mac")).resolves.toEqual({
      ok: false, error: { code: "federation_unsupported", message: "This runs on studio-mac. Stop it there." },
    });
    await expect(stopRemoteThreadPendingWake(remote, "backend_task:task-1")).resolves.toEqual({ ok: true, stopped: true });
    expect(remote.stopBackendTask).toHaveBeenCalledWith("task-1");
    await expect(stopRemoteThreadPendingWake(remote, "held_message:thread-turn:1")).resolves.toEqual({ ok: true, stopped: true });
    expect(remote.discardHeldMessage).toHaveBeenCalledWith("thread-turn:1");
    await expect(stopRemoteThreadPendingWake(remote, "backend_wake:a1b2c3d4")).resolves.toMatchObject({
      ok: false, error: { code: "invalid_arguments" },
    });
  });
});

describe("pending wake list writes", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it.each([false, true])("reads the stores and writes nothing (reuse watches: %s)", async (reuseWatches) => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const fixture = createTempStateDb("pwragent-pending-wakes-");
    const stateDb = StateDb.open(fixture.dbPath);
    cleanup = () => {
      stateDb.close();
      removeTempStateDbDir(fixture.tempDir);
    };
    const dependencies = new ThreadDependencyStore(stateDb.raw);
    dependencies.register(dependency());
    const scheduledStore = new ScheduledThreadActionStore(stateDb);
    scheduledStore.create({ id: "scheduled-budget", ...THREAD, kind: "turn", origin: "desktop",
      scheduledFor: 100, displayText: "Follow up", now: 1 });
    const overlay = new SqliteOverlayStore(stateDb);
    await overlay.registerThreadPrStatusWatch({ watch: prWatch(), now: 1 });
    await overlay.setThreadPrAutoDispatchEnabled({ ...THREAD, enabled: true });
    await overlay.syncThreadPrAutoDispatchCandidates({ ...THREAD, prKeys: [prWatch().prKey], now: 1 });
    await overlay.upsertThreadSubAgent({ ...THREAD, subAgent: { monitorId: "monitor-ended", task: "Wait for CI",
      status: "success", outcome: "success", createdAt: 1, completedAt: 2, updatedAt: 2 } });
    const { writes } = await measureSqliteWrites(async () => {
      for (let read = 0; read < 50; read += 1) {
        await buildThreadPendingWakes(readers({
          prWatches: (thread) => overlay.listActiveThreadPrStatusWatches(thread),
          prWatchHistory: (thread, limit) => overlay.listThreadPrStatusWatchHistory({ ...thread, limit }),
          autoFix: async (thread) => (await overlay.listPrAutoDispatchCandidates(thread))
            .map((candidate) => ({ backend: candidate.backend, threadId: candidate.threadId, prKey: candidate.prKey, state: "active" as const })),
          dependencies: async (thread, endedLimit) => dependencies.listPendingWakes(thread.backend, thread.threadId, endedLimit),
          scheduledActions: (thread, endedLimit) => scheduledStore.listPendingWakes({ ...thread, endedLimit }),
          recentSubAgents: (thread, limit) => overlay.listEndedThreadTaskMonitors({ ...thread, limit }),
        }), THREAD, reuseWatches ? { endedLimit: 0, activePrWatches: [prWatch()] } : {});
      }
    });
    expectSqliteWriteBudget({
      note: "50 Waiting for list reads over real dependency and scheduled-action stores; a read writes nothing: 0 MB/day.",
      scenario: "thread-pending-wakes-list",
      writes,
    });
  });
});
