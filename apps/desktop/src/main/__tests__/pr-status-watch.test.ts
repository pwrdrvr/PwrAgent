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
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
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

  it("lets an accepted Auto-fix event satisfy failure without a duplicate turn", async () => {
    await registerWatch();
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

  it("supersedes a watch when the pull request head changes", async () => {
    await registerWatch();
    const harness = createHarness();

    await harness.coordinator.handleStatusSnapshot(pr({
      headSha: "b".repeat(40),
      commitShas: ["b".repeat(40)],
    }), now);

    expect(await store.listActiveThreadPrStatusWatches({
      backend: "codex",
      threadId: "thread-1",
    })).toEqual([]);
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
    const { writes: registration } = await measureSqliteWrites(async () => {
      await registerTerminalWatch();
    });
    expectSqliteWriteBudget({
      note: "one merge/close watch requested by an agent tool call",
      scenario: "pr-terminal-watch-register",
      writes: registration,
    });
    const harness = createTerminalHarness();
    const { writes: delivery } = await measureSqliteWrites(async () => {
      await harness.coordinator.handleTerminalSnapshot(mergedPr(), now);
    });
    expectSqliteWriteBudget({
      note: "claim and finish one merge/close wake",
      scenario: "pr-terminal-watch-deliver",
      writes: delivery,
    });
  });

  it("adds no commits to the poll path while the PR stays open", async () => {
    await registerTerminalWatch();
    const harness = createTerminalHarness();
    const { writes } = await measureSqliteWrites(async () => {
      for (let tick = 0; tick < 10; tick += 1) {
        now += 1;
        await harness.coordinator.handleStatusSnapshot(pr(), now);
      }
    });
    expectSqliteWriteBudget({
      note: "ten polls of an open PR that has a merge/close watch",
      scenario: "pr-terminal-watch-open-polls",
      writes,
    });
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
  });
});
