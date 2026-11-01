import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import {
  buildPullRequestStatusKey,
  type AppServerTurnInputItem,
  type PrSummary,
  type PullRequestTerminalDetails,
  type ThreadPullRequestWatchEvent,
  type ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import {
  PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
  PrStatusWatchCoordinator,
} from "../pr-status/pr-status-watch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  measureSqliteWrites,
  SQLITE_WRITE_METRICS_ENV,
} from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string | undefined;
let now: number;
const extraDbs: StateDb[] = [];

/**
 * Move this test onto a real database file and return its path. Only the
 * tests that close the database and reopen the same path, or open a second
 * connection to it, need one: a second `:memory:` open is a second empty
 * database, so those assertions would hold while testing nothing.
 */
function useFileStateDb(): string {
  stateDb.close();
  const temp = createTempStateDb("pwragent-pr-status-watch-");
  tempDir = temp.tempDir;
  stateDb = StateDb.open(temp.dbPath);
  store = new SqliteOverlayStore(stateDb);
  return temp.dbPath;
}

beforeEach(() => {
  now = 1_000;
  tempDir = undefined;
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const db of extraDbs.splice(0)) db.close();
  stateDb.close();
  if (tempDir !== undefined) {
    removeTempStateDbDir(tempDir);
  }
});

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  const headSha = overrides.headSha ?? "a".repeat(40);
  return {
    provider: "github.com",
    number: 1105,
    org: "pwrdrvr",
    repo: "PwrAgent",
    title: "Wake the thread when CI completes",
    state: "pending",
    checkState: "pending",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    headSha,
    commitShas: [headSha],
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1105",
    ...overrides,
  };
}

async function registerWatch(
  targetStore = store,
  notifyOn: ThreadPullRequestWatchEvent[] = ["success", "failure"],
  threadId = "thread-1",
): Promise<ThreadPullRequestWatchSummary> {
  const target = pr();
  const watch: ThreadPullRequestWatchSummary = {
    watchId: `watch-${Math.random()}`,
    backend: "codex",
    threadId,
    prKey: buildPullRequestStatusKey(target),
    prUrl: target.url,
    prNumber: target.number,
    prTitle: target.title,
    headSha: target.headSha!,
    notifyOn,
    createdAt: now,
    failureHandledByAutoFix: false,
  };
  return (await targetStore.registerThreadPrStatusWatch({ watch, now })).watch;
}

type SubmitTurnIfIdle = (_request: {
  input: AppServerTurnInputItem[];
}) => Promise<
  | { status: "started"; turnId: string }
  | { status: "busy" }
>;

function createHarness(
  targetStore = store,
  submitTurnIfIdle: Mock<SubmitTurnIfIdle> = vi.fn(async (_request: {
    input: AppServerTurnInputItem[];
  }) => ({ status: "started" as const, turnId: "turn-watch-1" })),
) {
  return {
    coordinator: new PrStatusWatchCoordinator({
      store: targetStore,
      registry: { submitTurnIfIdle },
      now: () => now,
    }),
    submitTurnIfIdle,
  };
}

describe("PrStatusWatchCoordinator", () => {
  it("migrates a legacy fork-keyed watch and completes it only for its destination", async () => {
    const dbPath = useFileStateDb();
    const watch = await registerWatch();
    const legacy = { ...watch, prKey: "github.com/fork/project#38",
      prUrl: "https://github.com/upstream/project/pull/38", prNumber: 38 };
    stateDb.raw.prepare("UPDATE pr_status_watches SET pr_key = ?, payload = ? WHERE watch_id = ?")
      .run(legacy.prKey, JSON.stringify(legacy), watch.watchId);
    stateDb.raw.pragma("user_version = 62");
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    expect(await store.listActiveThreadPrStatusWatches({ backend: "codex", threadId: "thread-1" }))
      .toEqual([{ ...legacy, prKey: "github.com/upstream/project#38" }]);
    const harness = createHarness();
    const fork = pr({ number: 38, org: "fork", repo: "project", state: "passing", checkState: "passing",
      url: "https://github.com/fork/project/pull/38" });
    expect(await harness.coordinator.handleStatusSnapshot(fork, now)).toBe(0);
    expect(await harness.coordinator.handleStatusSnapshot({ ...fork, org: "upstream", url: legacy.prUrl }, now)).toBe(1);
    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
  });

  it("merges legacy and corrected active watches during upgrade without duplicate wakeups", async () => {
    const dbPath = useFileStateDb();
    const oldest = await registerWatch(store, ["failure"]);
    const legacy = { ...oldest, prKey: "github.com/fork/pwragent#1105" };
    stateDb.raw.prepare("UPDATE pr_status_watches SET pr_key = ?, payload = ? WHERE watch_id = ?")
      .run(legacy.prKey, JSON.stringify(legacy), oldest.watchId);
    now += 100;
    await registerWatch(store, ["success"]);
    stateDb.raw.pragma("user_version = 62");
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    const active = await store.listActiveThreadPrStatusWatches({ backend: "codex", threadId: "thread-1" });
    expect(active).toEqual([{ ...oldest, notifyOn: ["failure", "success"] }]);
    const afterUpgrade = stateDb.raw.prepare("SELECT * FROM pr_status_watches ORDER BY watch_id").all();
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    expect(stateDb.raw.prepare("SELECT * FROM pr_status_watches ORDER BY watch_id").all()).toEqual(afterUpgrade);
    const harness = createHarness();
    expect(await harness.coordinator.handleStatusSnapshot(pr({ state: "passing", checkState: "passing" }), now)).toBe(1);
    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
  });

  it("persists a one-shot watch across restart and dispatches success once", async () => {
    const dbPath = useFileStateDb();
    const watch = await registerWatch();
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);

    expect(await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-1",
    })).toEqual([watch]);

    const harness = createHarness();
    const passing = pr({ state: "passing", checkState: "passing" });
    await expect(harness.coordinator.handleStatusSnapshot(passing, now))
      .resolves.toBe(1);
    await expect(harness.coordinator.handleStatusSnapshot(passing, now + 1))
      .resolves.toBe(0);
    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(harness.submitTurnIfIdle.mock.calls[0]?.[0].input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("- Outcome: success"),
    });
    expect(harness.submitTurnIfIdle.mock.calls[0]?.[0]).toMatchObject({
      messageOrigin: {
        kind: "pwragent",
        prAutomation: {
          kind: "watch",
          prNumber: 1105,
          outcome: "success",
        },
      },
    });
  });

  it("waits for remaining checks before waking on a failed suite", async () => {
    await registerWatch();
    const harness = createHarness();

    await expect(harness.coordinator.handleStatusSnapshot(pr(), now))
      .resolves.toBe(0);
    now += 1;
    await expect(harness.coordinator.handleStatusSnapshot(pr({
      state: "failing",
      checkState: "failing",
      checksStillRunning: true,
    }), now)).resolves.toBe(0);
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();

    now += 1;
    await expect(harness.coordinator.handleStatusSnapshot(pr({
      state: "failing",
      checkState: "failing",
      checksStillRunning: false,
    }), now)).resolves.toBe(1);

    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(harness.submitTurnIfIdle.mock.calls[0]?.[0].input[0]).toMatchObject({
      text: expect.stringContaining("- Outcome: failure"),
    });
  });

  it("lets an accepted Auto-fix event satisfy a failure-only watch without a duplicate turn", async () => {
    await registerWatch(store, ["failure"]);
    const harness = createHarness();

    await harness.coordinator.handleStatusSnapshot(pr({
      state: "failing",
      checkState: "failing",
    }), now, new Set(["codex:thread-1"]));

    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
    expect(await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-1",
    })).toEqual([]);
  });

  it("dispatches failure notification when Auto-fix does not accept the event", async () => {
    await registerWatch();
    const harness = createHarness();

    await harness.coordinator.handleStatusSnapshot(pr({
      state: "failing",
      checkState: "failing",
    }), now);

    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
  });

  it("does not spend an attempt while the watched thread is busy", async () => {
    await registerWatch();
    let busy = true;
    const submitTurnIfIdle = vi.fn(async () => busy
      ? { status: "busy" as const }
      : { status: "started" as const, turnId: "turn-watch-1" });
    const harness = createHarness(store, submitTurnIfIdle);
    const passing = pr({ state: "passing", checkState: "passing" });

    await harness.coordinator.handleStatusSnapshot(passing, now);
    const attemptAfterBusy = stateDb.raw
      .prepare("SELECT attempt_count FROM pr_status_watches")
      .get() as { attempt_count: number };
    expect(attemptAfterBusy.attempt_count).toBe(0);

    busy = false;
    now += 1;
    await harness.coordinator.handleStatusSnapshot(passing, now);
    expect(submitTurnIfIdle).toHaveBeenCalledTimes(2);
  });

  it("does not claim or dispatch while background PR polling is off", async () => {
    await registerWatch();
    const submitTurnIfIdle = vi.fn(async () => ({
      status: "started" as const,
      turnId: "turn-watch-1",
    }));
    const coordinator = new PrStatusWatchCoordinator({
      store,
      registry: { submitTurnIfIdle },
      isBackgroundPollingEnabled: () => false,
      now: () => now,
    });

    await expect(coordinator.handleStatusSnapshot(pr({
      state: "passing",
      checkState: "passing",
    }), now)).resolves.toBe(0);
    expect(submitTurnIfIdle).not.toHaveBeenCalled();
    expect(await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-1",
    })).toHaveLength(1);
  });

  it("claims a watch atomically across app instances", async () => {
    const dbPath = useFileStateDb();
    await registerWatch();
    const secondDb = StateDb.open(dbPath);
    extraDbs.push(secondDb);
    const secondStore = new SqliteOverlayStore(secondDb);
    const first = createHarness(store);
    const second = createHarness(secondStore);
    const passing = pr({ state: "passing", checkState: "passing" });

    await Promise.all([
      first.coordinator.handleStatusSnapshot(passing, now),
      second.coordinator.handleStatusSnapshot(passing, now),
    ]);

    expect(
      first.submitTurnIfIdle.mock.calls.length
      + second.submitTurnIfIdle.mock.calls.length,
    ).toBe(1);
  });

  it("notifies only the oldest thread watching the same PR head", async () => {
    await registerWatch(store, ["success"], "thread-1");
    now += 1;
    await registerWatch(store, ["success"], "thread-2");
    const harness = createHarness();

    await expect(harness.coordinator.handleStatusSnapshot(pr({
      state: "passing",
      checkState: "passing",
    }), now)).resolves.toBe(1);

    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(harness.submitTurnIfIdle.mock.calls[0]?.[0]).toMatchObject({
      threadId: "thread-1",
    });
    expect(await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-2",
    })).toEqual([]);
    // Only thread-1 got a turn, so only its history says it woke.
    expect(await store.listThreadPrStatusWatchHistory({
      backend: "codex", threadId: "thread-1", limit: 5,
    })).toEqual([expect.objectContaining({ endedReason: "woke", wokeOn: "success" })]);
    expect(await store.listThreadPrStatusWatchHistory({
      backend: "codex", threadId: "thread-2", limit: 5,
    })).toEqual([expect.objectContaining({
      status: "dispatched", endedReason: "another_thread_woke", wokeOn: "success",
    })]);
  });

  it("promotes the next-oldest watch when the first thread detaches", async () => {
    await registerWatch(store, ["success"], "thread-1");
    now += 1;
    await registerWatch(store, ["success"], "thread-2");
    await store.cancelThreadPrStatusWatchesForPr({
      backend: "codex",
      threadId: "thread-1",
      prKey: buildPullRequestStatusKey(pr()),
      now,
    });
    const harness = createHarness();

    await harness.coordinator.handleStatusSnapshot(pr({
      state: "passing",
      checkState: "passing",
    }), now);

    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(harness.submitTurnIfIdle.mock.calls[0]?.[0]).toMatchObject({
      threadId: "thread-2",
    });
  });

  it("moves a CI watch to the new head when the pull request head changes", async () => {
    const original = await registerWatch();
    const harness = createHarness();

    await harness.coordinator.handleStatusSnapshot(pr({
      headSha: "b".repeat(40),
      commitShas: ["b".repeat(40)],
    }), now);

    const [moved] = await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(moved).toMatchObject({
      headSha: "b".repeat(40),
      followedFrom: "a".repeat(40),
      notifyOn: ["success", "failure"],
      createdAt: original.createdAt,
    });
    expect(moved?.watchId).not.toBe(original.watchId);
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
  });

  it("cancels an active watch when its pull request is detached", async () => {
    await registerWatch();

    await expect(store.cancelThreadPrStatusWatchesForPr({
      backend: "codex",
      threadId: "thread-1",
      prKey: buildPullRequestStatusKey(pr()),
      now,
    })).resolves.toBe(1);
    expect(await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-1",
    })).toEqual([]);
  });

  it("stops retrying after a finite number of failed submissions", async () => {
    await registerWatch();
    const submitTurnIfIdle = vi.fn(async () => {
      throw new Error("backend unavailable");
    });
    const harness = createHarness(store, submitTurnIfIdle);
    const passing = pr({ state: "passing", checkState: "passing" });

    for (let attempt = 0; attempt < PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS + 1; attempt += 1) {
      now += 1;
      await harness.coordinator.handleStatusSnapshot(passing, now);
    }

    expect(submitTurnIfIdle).toHaveBeenCalledTimes(
      PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
    );
  });
});

function ciWatch(overrides: Partial<ThreadPullRequestWatchSummary> = {}): ThreadPullRequestWatchSummary {
  const target = pr();
  return {
    watchId: `watch-${Math.random()}`,
    backend: "codex",
    threadId: "thread-1",
    prKey: buildPullRequestStatusKey(target),
    prUrl: target.url,
    prNumber: target.number,
    prTitle: target.title,
    headSha: target.headSha!,
    notifyOn: ["success", "failure"],
    createdAt: now,
    failureHandledByAutoFix: false,
    kind: "checks",
    ...overrides,
  };
}

const ATTEMPT_ONE_FAILURE = "https://github.com/pwrdrvr/PwrAgent/actions/runs/42/job/1";
const ATTEMPT_TWO_FAILURE = "https://github.com/pwrdrvr/PwrAgent/actions/runs/42/job/2";

function failingPr(overrides: Partial<PrSummary> = {}): PrSummary {
  return pr({
    state: "failing",
    checkState: "failing",
    failedCheckUrl: ATTEMPT_ONE_FAILURE,
    ...overrides,
  });
}

async function registerBaselineWatch(
  overrides: Partial<ThreadPullRequestWatchSummary> = {},
): Promise<ThreadPullRequestWatchSummary> {
  return (await store.registerThreadPrStatusWatch({
    watch: ciWatch({
      baseline: {
        outcome: "failure",
        observedAt: now - 5,
        failedCheckUrl: ATTEMPT_ONE_FAILURE,
        rerunRequestedAt: now - 1,
        runAttempt: 2,
      },
      ...overrides,
    }),
    now,
  })).watch;
}

function activeWatches(threadId = "thread-1") {
  return store.listActiveThreadPrStatusWatches({ backend: "codex", threadId });
}

describe("PrStatusWatchCoordinator baselines after a re-run", () => {
  it("does not fire on the baseline failure, clears it while checks run, then fires on the next failure", async () => {
    const watch = await registerBaselineWatch();
    const onWatchesChanged = vi.fn();
    const submitTurnIfIdle = vi.fn(async (_request: { input: AppServerTurnInputItem[] }) => ({
      status: "started" as const, turnId: "turn-watch-1",
    }));
    const coordinator = new PrStatusWatchCoordinator({
      store, registry: { submitTurnIfIdle }, onWatchesChanged, now: () => now,
    });

    // The poll that still shows attempt 1's failure.
    await expect(coordinator.handleStatusSnapshot(failingPr(), now)).resolves.toBe(0);
    expect(submitTurnIfIdle).not.toHaveBeenCalled();
    expect(onWatchesChanged).not.toHaveBeenCalled();

    now += 1;
    await coordinator.handleStatusSnapshot(pr({ checksStillRunning: true }), now);
    expect((await activeWatches())[0]).not.toHaveProperty("baseline");
    expect(onWatchesChanged).toHaveBeenCalledWith([
      { backend: "codex", threadId: "thread-1", prKey: watch.prKey },
    ]);

    now += 1;
    await expect(coordinator.handleStatusSnapshot(failingPr(), now)).resolves.toBe(1);
    expect(submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(await activeWatches()).toEqual([]);
    expect(onWatchesChanged).toHaveBeenLastCalledWith([
      { backend: "codex", threadId: "thread-1", prKey: watch.prKey },
    ]);
    expect(await store.listThreadPrStatusWatchHistory({
      backend: "codex", threadId: "thread-1", limit: 5,
    })).toEqual([expect.objectContaining({
      watchId: watch.watchId, status: "dispatched", endedReason: "woke", wokeOn: "failure",
    })]);
  });

  it("fires on a failure at another check without seeing the checks run", async () => {
    await registerBaselineWatch();
    const harness = createHarness();

    await expect(harness.coordinator.handleStatusSnapshot(
      failingPr({ failedCheckUrl: ATTEMPT_TWO_FAILURE }),
      now,
    )).resolves.toBe(1);
    expect(promptOf(harness.submitTurnIfIdle)).toContain("- Outcome: failure");
  });

  it("fires at once on success after a failure baseline", async () => {
    await registerBaselineWatch();
    const harness = createHarness();

    await expect(harness.coordinator.handleStatusSnapshot(
      pr({ state: "passing", checkState: "passing" }),
      now,
    )).resolves.toBe(1);
    expect(promptOf(harness.submitTurnIfIdle)).toContain("- Outcome: success");
  });

  it("keeps a baselined watch waiting when another thread's watch wakes on the baseline failure", async () => {
    await store.registerThreadPrStatusWatch({ watch: ciWatch({ threadId: "thread-older" }), now });
    now += 1;
    await registerBaselineWatch();
    const harness = createHarness();

    await expect(harness.coordinator.handleStatusSnapshot(failingPr(), now)).resolves.toBe(1);
    expect(harness.submitTurnIfIdle.mock.calls[0]?.[0]).toMatchObject({ threadId: "thread-older" });
    expect(await activeWatches()).toHaveLength(1);
  });

  it("merges a newer baseline into an armed watch that had none, and reports it existed", async () => {
    const first = await store.registerThreadPrStatusWatch({ watch: ciWatch(), now });
    expect(first.existed).toBe(false);
    const second = await store.registerThreadPrStatusWatch({
      watch: ciWatch({ baseline: { outcome: "failure", observedAt: now, failedCheckUrl: ATTEMPT_ONE_FAILURE } }),
      now,
    });
    expect(second).toMatchObject({
      existed: true,
      watch: { watchId: first.watch.watchId, baseline: { outcome: "failure" } },
    });
    const harness = createHarness();
    await expect(harness.coordinator.handleStatusSnapshot(failingPr(), now)).resolves.toBe(0);
  });
});

describe("PrStatusWatchCoordinator Auto-fix coverage", () => {
  it("does not let another thread's Auto-fix coverage finish this thread's failure watch", async () => {
    await registerWatch(store, ["failure"], "thread-a");
    const harness = createHarness();

    // Thread B owns Auto-fix for the PR. Before the fix, any covered thread
    // finished every claimed failure watch on the PR.
    await expect(harness.coordinator.handleStatusSnapshot(
      failingPr(),
      now,
      new Set(["codex:thread-b"]),
    )).resolves.toBe(1);
    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(harness.submitTurnIfIdle.mock.calls[0]?.[0]).toMatchObject({ threadId: "thread-a" });
  });

  it("wakes an uncovered thread in the same poll when an older covered thread's failure-only watch hands off to Auto-fix", async () => {
    const covered = await registerWatch(store, ["failure"], "thread-a");
    now += 1;
    await registerWatch(store, ["failure"], "thread-b");
    const onWatchesChanged = vi.fn();
    const submitTurnIfIdle = vi.fn(async (_request: { input: AppServerTurnInputItem[] }) => ({
      status: "started" as const, turnId: "turn-watch-1",
    }));
    const coordinator = new PrStatusWatchCoordinator({
      store, registry: { submitTurnIfIdle }, onWatchesChanged, now: () => now,
    });

    // Before the fix, A's Auto-fix ended B's watch as covered and B never woke.
    await expect(coordinator.handleStatusSnapshot(
      failingPr(),
      now,
      new Set(["codex:thread-a"]),
    )).resolves.toBe(1);
    expect(submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(submitTurnIfIdle.mock.calls[0]?.[0]).toMatchObject({ threadId: "thread-b" });
    expect(await store.listThreadPrStatusWatchHistory({
      backend: "codex", threadId: "thread-a", limit: 5,
    })).toEqual([expect.objectContaining({
      watchId: covered.watchId, status: "dispatched", endedReason: "covered_by_auto_fix",
    })]);
    expect(await store.listThreadPrStatusWatchHistory({
      backend: "codex", threadId: "thread-b", limit: 5,
    })).toEqual([expect.objectContaining({ endedReason: "woke", wokeOn: "failure" })]);
    const prKey = buildPullRequestStatusKey(pr());
    expect(onWatchesChanged).toHaveBeenCalledWith([{ backend: "codex", threadId: "thread-a", prKey }]);
    expect(onWatchesChanged).toHaveBeenCalledWith([{ backend: "codex", threadId: "thread-b", prKey }]);
  });

  it("reports a watch held past a covered failure, so its baseline reaches the rail", async () => {
    await registerWatch();
    const onWatchesChanged = vi.fn();
    const coordinator = new PrStatusWatchCoordinator({
      store, registry: { submitTurnIfIdle: vi.fn(async () => ({ status: "busy" as const })) },
      onWatchesChanged, now: () => now,
    });

    await coordinator.handleStatusSnapshot(failingPr(), now, new Set(["codex:thread-1"]));
    expect(onWatchesChanged).toHaveBeenCalledTimes(1);
    expect(onWatchesChanged).toHaveBeenCalledWith([{
      backend: "codex", threadId: "thread-1", prKey: buildPullRequestStatusKey(pr()),
    }]);
    // The repeat poll finds the baseline already set and reports nothing.
    now += 1;
    await coordinator.handleStatusSnapshot(failingPr(), now, new Set(["codex:thread-1"]));
    expect(onWatchesChanged).toHaveBeenCalledTimes(1);
  });

  it("leaves a success and failure watch waiting past a covered failure, then wakes on success at the pushed head", async () => {
    await registerWatch();
    const harness = createHarness();
    const covered = new Set(["codex:thread-1"]);

    await expect(harness.coordinator.handleStatusSnapshot(failingPr(), now, covered)).resolves.toBe(0);
    expect(await activeWatches()).toEqual([
      expect.objectContaining({ baseline: expect.objectContaining({ outcome: "failure" }) }),
    ]);
    // The same failure on later polls is an Auto-fix duplicate, no longer
    // covered. The watch must not wake on it.
    now += 1;
    await expect(harness.coordinator.handleStatusSnapshot(failingPr(), now)).resolves.toBe(0);
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();

    // Auto-fix pushes a fix; CI passes at the new head.
    now += 1;
    const fixed = "e".repeat(40);
    await harness.coordinator.handleStatusSnapshot(pr({ headSha: fixed, commitShas: [fixed] }), now);
    now += 1;
    await expect(harness.coordinator.handleStatusSnapshot(pr({
      headSha: fixed, commitShas: [fixed], state: "passing", checkState: "passing",
    }), now)).resolves.toBe(1);
    expect(promptOf(harness.submitTurnIfIdle)).toContain(`- Watched head SHA: ${fixed}`);
    expect(promptOf(harness.submitTurnIfIdle)).toContain("- Outcome: success");
  });

  it("finishes a covered failure-only watch as handled by Auto-fix", async () => {
    const watch = await registerWatch(store, ["failure"]);
    const harness = createHarness();

    await harness.coordinator.handleStatusSnapshot(failingPr(), now, new Set(["codex:thread-1"]));
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
    expect(await store.listThreadPrStatusWatchHistory({
      backend: "codex", threadId: "thread-1", limit: 5,
    })).toEqual([expect.objectContaining({
      watchId: watch.watchId, status: "dispatched", endedReason: "covered_by_auto_fix",
    })]);
  });
});

describe("advanceThreadPrStatusWatches", () => {
  it("moves a CI watch, only supersedes one that conflicts at the new head, and leaves merge/close watches", async () => {
    const moving = await registerWatch(store, ["success", "failure"], "thread-1");
    const conflicting = await registerWatch(store, ["failure"], "thread-2");
    const terminal = await registerTerminalWatch(store, ["merged"], "thread-1");
    const newHead = "b".repeat(40);
    await store.registerThreadPrStatusWatch({
      watch: ciWatch({ threadId: "thread-2", headSha: newHead, notifyOn: ["success"] }),
      now,
    });

    now += 1;
    const result = await store.advanceThreadPrStatusWatches({
      prKey: moving.prKey, headSha: newHead, checksRunning: true, now,
    });
    expect(result).toMatchObject({ moved: 1, superseded: 1, baselinesCleared: 0 });
    expect(result.threads).toEqual(expect.arrayContaining([
      { backend: "codex", threadId: "thread-1", prKey: moving.prKey },
      { backend: "codex", threadId: "thread-2", prKey: moving.prKey },
    ]));
    const threadOne = await activeWatches("thread-1");
    expect(threadOne).toEqual(expect.arrayContaining([
      expect.objectContaining({ watchId: terminal.watchId, kind: "terminal" }),
      expect.objectContaining({ headSha: newHead, followedFrom: "a".repeat(40) }),
    ]));
    expect(threadOne).toHaveLength(2);
    expect(await activeWatches("thread-2")).toEqual([
      expect.objectContaining({ headSha: newHead, notifyOn: ["success"] }),
    ]);
    const movedTo = threadOne.find((watch) => watch.headSha === newHead)!.watchId;
    expect(await store.listThreadPrStatusWatchHistory({ backend: "codex", threadId: "thread-1", limit: 5 }))
      .toEqual([expect.objectContaining({
        watchId: moving.watchId, status: "superseded", endedReason: "moved", movedTo,
      })]);
    expect(await store.listThreadPrStatusWatchHistory({ backend: "codex", threadId: "thread-2", limit: 5 }))
      .toEqual([expect.objectContaining({
        watchId: conflicting.watchId, status: "superseded", endedReason: "head_changed",
      })]);
  });

  it("drops the baseline when a watch follows a push", async () => {
    await registerBaselineWatch();
    const newHead = "b".repeat(40);
    await store.advanceThreadPrStatusWatches({
      prKey: buildPullRequestStatusKey(pr()), headSha: newHead, checksRunning: false, now: now + 1,
    });
    const [moved] = await activeWatches();
    expect(moved).toMatchObject({ headSha: newHead });
    expect(moved).not.toHaveProperty("baseline");
  });
});

describe("cancelThreadPrStatusWatch", () => {
  it("stops exactly one watch, keeps its sibling, and refuses one being delivered", async () => {
    const ci = await registerWatch();
    const terminal = await registerTerminalWatch();
    const sibling = await registerWatch(store, ["success"], "thread-2");

    now += 1;
    await expect(store.cancelThreadPrStatusWatch({
      backend: "codex", threadId: "thread-1", watchId: ci.watchId, now,
    })).resolves.toEqual({ backend: "codex", threadId: "thread-1", prKey: ci.prKey });
    expect(await activeWatches()).toEqual([expect.objectContaining({ watchId: terminal.watchId })]);
    expect(await store.listThreadPrStatusWatchHistory({ backend: "codex", threadId: "thread-1", limit: 20 }))
      .toEqual([expect.objectContaining({
        watchId: ci.watchId, status: "cancelled", endedReason: "cancelled_by_operator", updatedAt: now,
      })]);
    // Another thread cannot stop it by naming its id.
    await expect(store.cancelThreadPrStatusWatch({
      backend: "codex", threadId: "thread-1", watchId: sibling.watchId, now,
    })).resolves.toBeUndefined();

    const { claims } = await store.claimThreadPrStatusWatches({
      prKey: sibling.prKey, headSha: sibling.headSha, outcome: "success", now,
      ownerId: "owner", leaseExpiresAt: now + 60_000, maxAttempts: 3,
    });
    expect(claims.map((claim) => claim.watch.watchId)).toEqual([sibling.watchId]);
    await expect(store.cancelThreadPrStatusWatch({
      backend: "codex", threadId: "thread-2", watchId: sibling.watchId, now,
    })).resolves.toBeUndefined();
    expect(await store.listAllActivePrStatusWatches()).toEqual(expect.arrayContaining([
      expect.objectContaining({ watchId: terminal.watchId }),
      expect.objectContaining({ watchId: sibling.watchId }),
    ]));
  });
});

describe("PR watch notifications and write budgets", () => {
  it("reports moved, failed, and delivered watches to onWatchesChanged", async () => {
    await registerWatch();
    const onWatchesChanged = vi.fn();
    const submitTurnIfIdle = vi.fn(async () => {
      throw new Error("backend unavailable");
    });
    const coordinator = new PrStatusWatchCoordinator({
      store, registry: { submitTurnIfIdle }, onWatchesChanged, now: () => now,
    });
    const thread = { backend: "codex", threadId: "thread-1", prKey: buildPullRequestStatusKey(pr()) };
    const newHead = "b".repeat(40);

    await coordinator.handleStatusSnapshot(pr({ headSha: newHead, commitShas: [newHead] }), now);
    expect(onWatchesChanged).toHaveBeenCalledTimes(1);
    expect(onWatchesChanged).toHaveBeenLastCalledWith([thread]);

    for (let attempt = 0; attempt < PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS; attempt += 1) {
      now += 1;
      await coordinator.handleStatusSnapshot(pr({
        headSha: newHead, commitShas: [newHead], state: "passing", checkState: "passing",
      }), now);
    }
    // Only the last failed submission ends the watch.
    expect(onWatchesChanged).toHaveBeenCalledTimes(2);
    expect(await store.listThreadPrStatusWatchHistory({ backend: "codex", threadId: "thread-1", limit: 1 }))
      .toEqual([expect.objectContaining({ status: "failed", endedReason: "failed" })]);
  });

  it("records the commits for a baseline clear, a head follow, and an operator stop", async () => {
    useMeasuredFileStateDb();
    await registerBaselineWatch();
    const harness = createHarness();
    const { writes: clear } = await measureSqliteWrites(async () => {
      await harness.coordinator.handleStatusSnapshot(pr({ checksStillRunning: true }), now);
      // Later polls while checks run find nothing to clear.
      for (let tick = 1; tick < 10; tick += 1) {
        await harness.coordinator.handleStatusSnapshot(pr({ checksStillRunning: true }), now + tick);
      }
    });
    expectSqliteWriteBudget({
      note: "ten polls while re-run checks run, one baselined watch: 1 commit clears the baseline once, the other 9 polls only read; at most 1 commit per watch lifetime",
      scenario: "pr-watch-baseline-clear",
      writes: clear,
    });

    const newHead = "b".repeat(40);
    const { writes: follow } = await measureSqliteWrites(async () => {
      await harness.coordinator.handleStatusSnapshot(pr({ headSha: newHead, commitShas: [newHead] }), now + 20);
    });
    expectSqliteWriteBudget({
      note: "one poll that sees a pushed head: the CI watch's copy and the old row's end share 1 commit; only on pushes, well under 1 MB/day",
      scenario: "pr-watch-follow-head",
      writes: follow,
    });

    const [moved] = await activeWatches();
    const { writes: cancel } = await measureSqliteWrites(async () => {
      await store.cancelThreadPrStatusWatch({
        backend: "codex", threadId: "thread-1", watchId: moved!.watchId, now: now + 30,
      });
    });
    expectSqliteWriteBudget({
      note: "the operator stops one PR watch: 1 commit per click, 0 idle writes",
      scenario: "pr-watch-operator-cancel",
      writes: cancel,
    });
  });

  it("records the commits for a failure Auto-fix covers, held once and then only read", async () => {
    useMeasuredFileStateDb();
    await registerWatch();
    const harness = createHarness();
    const covered = new Set(["codex:thread-1"]);
    const { writes } = await measureSqliteWrites(async () => {
      await harness.coordinator.handleStatusSnapshot(failingPr(), now, covered);
      // Each later poll of the same failure finds the baseline already set.
      for (let tick = 1; tick < 10; tick += 1) {
        await harness.coordinator.handleStatusSnapshot(failingPr(), now + tick, covered);
      }
    });
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
    expectSqliteWriteBudget({
      note: "ten polls of one CI failure that Auto-fix covers, one success and failure watch: 1 commit holds the failure as its baseline, the other 9 polls only read; at most 1 commit per failure",
      scenario: "pr-watch-autofix-hold",
      writes,
    });
  });
});

async function registerTerminalWatch(
  targetStore = store,
  notifyOn: ThreadPullRequestWatchEvent[] = ["merged", "closed"],
  threadId = "thread-1",
): Promise<ThreadPullRequestWatchSummary> {
  const target = pr();
  const watch: ThreadPullRequestWatchSummary = {
    watchId: `terminal-${Math.random()}`,
    backend: "codex",
    threadId,
    prKey: buildPullRequestStatusKey(target),
    prUrl: target.url,
    prNumber: target.number,
    prTitle: target.title,
    headSha: target.headSha!,
    notifyOn,
    createdAt: now,
    failureHandledByAutoFix: false,
    kind: "terminal",
  };
  return (await targetStore.registerThreadPrStatusWatch({ watch, now })).watch;
}

/** Budgets need the metrics wrapper, which StateDb.open installs, and a WAL file. */
function useMeasuredFileStateDb(): void {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  useFileStateDb();
}

function mergedPr(overrides: Partial<PrSummary> = {}): PrSummary {
  return pr({
    state: "passing",
    checkState: "passing",
    lifecycleState: "merged",
    baseRefName: "main",
    mergedAt: Date.parse("2026-10-25T12:00:00.000Z"),
    ...overrides,
  });
}

function squashDetails(): PullRequestTerminalDetails {
  return {
    outcome: "merged",
    prKey: buildPullRequestStatusKey(pr()),
    prUrl: pr().url,
    prNumber: 1105,
    prTitle: pr().title,
    baseBranch: "main",
    headSha: "a".repeat(40),
    mergeMethod: "squash",
    mergeMethodEvidence: "The merge commit has one parent and is a new commit.",
    mergeCommitSha: "f".repeat(40),
    mergedBy: "octocat",
    mergedAt: "2026-10-25T12:00:00.000Z",
  };
}

function createTerminalHarness(
  options: {
    targetStore?: SqliteOverlayStore;
    submitTurnIfIdle?: Mock<SubmitTurnIfIdle>;
    fetchTerminalDetails?: Mock<(pr: PrSummary) => Promise<PullRequestTerminalDetails | undefined>>;
  } = {},
) {
  const submitTurnIfIdle = options.submitTurnIfIdle
    ?? vi.fn(async (_request: { input: AppServerTurnInputItem[] }) => ({
      status: "started" as const,
      turnId: "turn-terminal-1",
    }));
  const fetchTerminalDetails = options.fetchTerminalDetails
    ?? vi.fn(async (_pr: PrSummary) => squashDetails());
  return {
    coordinator: new PrStatusWatchCoordinator({
      store: options.targetStore ?? store,
      registry: { submitTurnIfIdle },
      fetchTerminalDetails,
      now: () => now,
    }),
    fetchTerminalDetails,
    submitTurnIfIdle,
  };
}

function promptOf(mock: Mock<SubmitTurnIfIdle>, call = 0): string {
  const item = mock.mock.calls[call]?.[0].input[0];
  return item && item.type === "text" ? item.text : "";
}

describe("PrStatusWatchCoordinator merge/close watches", () => {
  it("outlives pushes and CI results, then wakes once on merge with the merge details", async () => {
    await registerTerminalWatch();
    const harness = createTerminalHarness();

    // CI passing at one head, then a push to a new head: neither ends it.
    await expect(harness.coordinator.handleStatusSnapshot(
      pr({ state: "passing", checkState: "passing" }),
      now,
    )).resolves.toBe(0);
    now += 1;
    const pushed = pr({ headSha: "b".repeat(40), commitShas: ["b".repeat(40)] });
    await harness.coordinator.handleStatusSnapshot(pushed, now);
    expect(await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-1",
    })).toHaveLength(1);

    now += 1;
    await expect(harness.coordinator.handleStatusSnapshot(
      mergedPr({ headSha: "b".repeat(40) }),
      now,
    )).resolves.toBe(1);
    await expect(harness.coordinator.handleStatusSnapshot(
      mergedPr({ headSha: "b".repeat(40) }),
      now + 1,
    )).resolves.toBe(0);

    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    const prompt = promptOf(harness.submitTurnIfIdle);
    expect(prompt).toContain("- Outcome: merged");
    expect(prompt).toContain("- Merge method: squash");
    expect(prompt).toContain(`- Merge commit SHA: ${"f".repeat(40)}`);
    expect(prompt).toContain("- Merged by: octocat");
    expect(prompt).toContain("- Merged at: 2026-10-25T12:00:00.000Z");
    expect(prompt).toContain("- Base branch: main");
    expect(prompt).toContain(`- URL: ${pr().url}`);
    expect(harness.submitTurnIfIdle.mock.calls[0]?.[0]).toMatchObject({
      messageOrigin: {
        kind: "pwragent",
        prAutomation: { kind: "watch", prNumber: 1105, outcome: "merged" },
      },
    });
  });

  it("wakes on close without merge and says so", async () => {
    await registerTerminalWatch();
    const harness = createTerminalHarness({
      fetchTerminalDetails: vi.fn(async (_pr: PrSummary) => ({
        outcome: "closed" as const,
        prKey: buildPullRequestStatusKey(pr()),
        prUrl: pr().url,
        prNumber: 1105,
        baseBranch: "main",
        closedBy: "octocat",
        closedAt: "2026-10-25T13:00:00.000Z",
      })),
    });

    await expect(harness.coordinator.handleStatusSnapshot(
      pr({ lifecycleState: "closed", state: "failing", checkState: "failing" }),
      now,
    )).resolves.toBe(1);

    const prompt = promptOf(harness.submitTurnIfIdle);
    expect(prompt).toContain("saw the PR closed without merge");
    expect(prompt).toContain("- Outcome: closed without merge");
    expect(prompt).toContain("- Closed by: octocat");
    expect(prompt).not.toContain("Merge method");
  });

  it("ignores a close when only merged was requested", async () => {
    await registerTerminalWatch(store, ["merged"]);
    const harness = createTerminalHarness();

    await expect(harness.coordinator.handleTerminalSnapshot(
      pr({ lifecycleState: "closed" }),
      now,
    )).resolves.toBe(0);
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
    expect(harness.fetchTerminalDetails).not.toHaveBeenCalled();
  });

  it("gives a thread with both watches one merge wake, not a CI success as well", async () => {
    await registerWatch(store, ["success"]);
    await registerTerminalWatch();
    const harness = createTerminalHarness();

    await expect(harness.coordinator.handleStatusSnapshot(mergedPr(), now))
      .resolves.toBe(1);
    await expect(harness.coordinator.handleStatusSnapshot(mergedPr(), now + 1))
      .resolves.toBe(0);

    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(promptOf(harness.submitTurnIfIdle)).toContain("- Outcome: merged");
    expect(await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-1",
    })).toEqual([]);
    // The merge woke the thread; no push ended the CI watch.
    expect(await store.listThreadPrStatusWatchHistory({
      backend: "codex", threadId: "thread-1", limit: 5,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "terminal", status: "dispatched", endedReason: "woke", wokeOn: "merged" }),
      expect.objectContaining({ notifyOn: ["success"], status: "superseded", endedReason: "pr_merged" }),
    ]));
  });

  it("wakes every thread that asked about the merge", async () => {
    await registerTerminalWatch(store, ["merged"], "thread-1");
    now += 1;
    await registerTerminalWatch(store, ["merged"], "thread-2");
    const harness = createTerminalHarness();

    await expect(harness.coordinator.handleStatusSnapshot(mergedPr(), now))
      .resolves.toBe(2);
    expect(harness.submitTurnIfIdle.mock.calls.map((call) =>
      (call[0] as unknown as { threadId: string }).threadId
    )).toEqual(["thread-1", "thread-2"]);
    expect(harness.fetchTerminalDetails).toHaveBeenCalledTimes(1);
  });

  it("survives a restart before the merge is observed", async () => {
    const dbPath = useFileStateDb();
    const watch = await registerTerminalWatch();
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);

    expect(await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-1",
    })).toEqual([watch]);
    expect(await store.listPendingPrTerminalWatchPrKeys()).toEqual([
      buildPullRequestStatusKey(pr()),
    ]);

    const harness = createTerminalHarness();
    await expect(harness.coordinator.handleStatusSnapshot(mergedPr(), now))
      .resolves.toBe(1);
    expect(promptOf(harness.submitTurnIfIdle)).toContain("- Merge method: squash");
    expect(await store.listPendingPrTerminalWatchPrKeys()).toEqual([]);
  });

  it("retries a busy wake from cached status after a restart, without spending an attempt", async () => {
    const dbPath = useFileStateDb();
    await registerTerminalWatch();
    const busy = createTerminalHarness({
      submitTurnIfIdle: vi.fn(async () => ({ status: "busy" as const })),
    });
    await expect(busy.coordinator.handleStatusSnapshot(mergedPr(), now))
      .resolves.toBe(1);
    expect(await store.listPendingPrTerminalWatchPrKeys({
      backend: "codex",
      threadId: "thread-1",
    })).toEqual([buildPullRequestStatusKey(pr())]);

    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    now += 1;
    // The poller no longer fetches a merged PR; the app re-offers the cached
    // snapshot through handleTerminalSnapshot.
    const idle = createTerminalHarness();
    await expect(idle.coordinator.handleTerminalSnapshot(mergedPr(), now))
      .resolves.toBe(1);
    expect(idle.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    const attempts = stateDb.raw
      .prepare("SELECT attempt_count, status FROM pr_status_watches WHERE head_sha = ''")
      .get() as { attempt_count: number; status: string };
    expect(attempts).toEqual({ attempt_count: 1, status: "dispatched" });
  });

  it("adds PwrAgent's sandbox cleanup to the wake, and still wakes if it throws", async () => {
    await registerTerminalWatch();
    const submitTurnIfIdle: Mock<SubmitTurnIfIdle> = vi.fn(async () => ({
      status: "started" as const,
      turnId: "turn-1",
    }));
    const prepareTerminalWake = vi.fn(async () => [
      "",
      "Sandboxer cleanup by PwrAgent (sandboxes this thread created)",
      "- sb_one: deleted",
    ]);
    const coordinator = new PrStatusWatchCoordinator({
      store,
      registry: { submitTurnIfIdle },
      fetchTerminalDetails: async () => squashDetails(),
      prepareTerminalWake,
      now: () => now,
    });
    await expect(coordinator.handleTerminalSnapshot(mergedPr(), now)).resolves.toBe(1);
    expect(prepareTerminalWake).toHaveBeenCalledWith(expect.objectContaining({
      watch: expect.objectContaining({ threadId: "thread-1" }),
    }));
    const prompt = promptOf(submitTurnIfIdle);
    expect(prompt).toContain("- sb_one: deleted");
    expect(prompt).toContain("do not stop or delete them yourself");

    await registerTerminalWatch(store, ["merged"], "thread-2");
    const throwing = new PrStatusWatchCoordinator({
      store,
      registry: { submitTurnIfIdle },
      fetchTerminalDetails: async () => squashDetails(),
      prepareTerminalWake: async () => {
        throw new Error("cleanup exploded");
      },
      now: () => now,
    });
    await expect(throwing.handleTerminalSnapshot(mergedPr(), now + 1)).resolves.toBe(1);
    expect(promptOf(submitTurnIfIdle, 1)).toContain("- Outcome: merged");
  });

  it("prepares every thread's wake at once, so one slow cleanup does not hold the rest", async () => {
    await registerTerminalWatch(store, ["merged"], "thread-1");
    now += 1;
    await registerTerminalWatch(store, ["merged"], "thread-2");
    const submitTurnIfIdle: Mock<SubmitTurnIfIdle> = vi.fn(async () => ({
      status: "started" as const,
      turnId: "turn-1",
    }));
    const started: string[] = [];
    let finish: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const coordinator = new PrStatusWatchCoordinator({
      store,
      registry: { submitTurnIfIdle },
      fetchTerminalDetails: async () => squashDetails(),
      prepareTerminalWake: async ({ watch }) => {
        started.push(watch.threadId);
        if (started.length === 2) finish();
        // Neither returns until both have started.
        await bothStarted;
        return [`- cleaned ${watch.threadId}`];
      },
      now: () => now,
    });
    await expect(coordinator.handleTerminalSnapshot(mergedPr(), now)).resolves.toBe(2);
    expect(started).toEqual(["thread-1", "thread-2"]);
    expect(promptOf(submitTurnIfIdle, 0)).toContain("- cleaned thread-1");
    expect(promptOf(submitTurnIfIdle, 1)).toContain("- cleaned thread-2");
  });

  it("still wakes the thread when the merge-details lookup fails", async () => {
    await registerTerminalWatch();
    const harness = createTerminalHarness({
      fetchTerminalDetails: vi.fn(async (_pr: PrSummary) => {
        throw new Error("gh is signed out");
      }),
    });

    await expect(harness.coordinator.handleStatusSnapshot(mergedPr(), now))
      .resolves.toBe(1);
    const prompt = promptOf(harness.submitTurnIfIdle);
    expect(prompt).toContain("- Outcome: merged");
    expect(prompt).toContain("- Merge method: unknown");
    expect(prompt).toContain("- Base branch: main");
    expect(prompt).toContain("gh is signed out");
  });

  it("reads fresh details for a second close after a reopen", async () => {
    const fetchTerminalDetails = vi.fn(async (target: PrSummary) => ({
      outcome: "closed" as const,
      prKey: buildPullRequestStatusKey(target),
      prUrl: target.url,
      prNumber: target.number,
      closedAt: new Date(target.closedAt!).toISOString(),
    }));
    const harness = createTerminalHarness({ fetchTerminalDetails });
    const first = pr({ lifecycleState: "closed", closedAt: Date.parse("2026-10-25T10:00:00Z") });
    const second = pr({ lifecycleState: "closed", closedAt: Date.parse("2026-10-25T14:00:00Z") });

    await harness.coordinator.resolveTerminalDetails(first);
    await harness.coordinator.resolveTerminalDetails(first);
    expect(fetchTerminalDetails).toHaveBeenCalledTimes(1);
    await expect(harness.coordinator.resolveTerminalDetails(second)).resolves
      .toMatchObject({ closedAt: "2026-10-25T14:00:00.000Z" });
    expect(fetchTerminalDetails).toHaveBeenCalledTimes(2);
  });

  it("does not wake while background PR polling is off", async () => {
    await registerTerminalWatch();
    const submitTurnIfIdle: Mock<SubmitTurnIfIdle> = vi.fn(async () => ({
      status: "started" as const,
      turnId: "turn-1",
    }));
    const coordinator = new PrStatusWatchCoordinator({
      store,
      registry: { submitTurnIfIdle },
      isBackgroundPollingEnabled: () => false,
      now: () => now,
    });
    await expect(coordinator.handleTerminalSnapshot(mergedPr(), now))
      .resolves.toBe(0);
    expect(submitTurnIfIdle).not.toHaveBeenCalled();
    expect(await store.listPendingPrTerminalWatchPrKeys()).toHaveLength(1);
  });

  it("merges notification interests into one terminal watch per thread and PR", async () => {
    const first = await registerTerminalWatch(store, ["merged"]);
    const second = await registerTerminalWatch(store, ["closed"]);
    expect(second.watchId).toBe(first.watchId);
    expect(second.notifyOn).toEqual(["merged", "closed"]);
  });

  it("records one commit per terminal watch registration and delivery", async () => {
    useMeasuredFileStateDb();
    const { writes: registration } = await measureSqliteWrites(async () => {
      await registerTerminalWatch();
    });
    expectSqliteWriteBudget({
      note: "one merge/close watch requested by an agent tool call: 1 commit/~16.5 KB WAL; ~0.8 MB/day at 50 requests/day, zero idle writes",
      scenario: "pr-terminal-watch-register",
      writes: registration,
    });
    const harness = createTerminalHarness();
    const { writes: delivery } = await measureSqliteWrites(async () => {
      await harness.coordinator.handleTerminalSnapshot(mergedPr(), now);
    });
    expectSqliteWriteBudget({
      note: "claim and finish one merge/close wake: 2 commits/~24.7 KB WAL per merged PR; ~1.2 MB/day at 50 merges/day, zero idle writes",
      scenario: "pr-terminal-watch-deliver",
      writes: delivery,
    });
  });

  it("adds no commits to the poll path while the PR stays open", async () => {
    useMeasuredFileStateDb();
    await registerTerminalWatch();
    const harness = createTerminalHarness();
    const { writes } = await measureSqliteWrites(async () => {
      for (let tick = 0; tick < 10; tick += 1) {
        now += 1;
        await harness.coordinator.handleStatusSnapshot(pr(), now);
      }
    });
    expectSqliteWriteBudget({
      note: "ten polls of an open PR that has a merge/close watch: 0 commits, 0 rows and 0 WAL; the per-poll head/baseline advance only reads when nothing moved, so the watch adds 0 MB/day",
      scenario: "pr-terminal-watch-open-polls",
      writes,
    });
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
  });
});
