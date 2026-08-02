import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  type ThreadPullRequestWatchEvent,
  type ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import {
  PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
  PrStatusWatchCoordinator,
} from "../pr-status/pr-status-watch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;
let now: number;
const extraDbs: StateDb[] = [];

beforeEach(() => {
  now = 1_000;
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-pr-status-watch-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  for (const db of extraDbs.splice(0)) db.close();
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
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
  it("persists a one-shot watch across restart and dispatches success once", async () => {
    const watch = await registerWatch();
    stateDb.close();
    stateDb = StateDb.open(path.join(tempDir, "state.db"));
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

  it("wakes on the first failing snapshot without waiting for other jobs", async () => {
    await registerWatch();
    const harness = createHarness();

    await expect(harness.coordinator.handleStatusSnapshot(pr(), now))
      .resolves.toBe(0);
    now += 1;
    await expect(harness.coordinator.handleStatusSnapshot(pr({
      state: "failing",
      checkState: "failing",
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
    await registerWatch();
    const secondDb = StateDb.open(path.join(tempDir, "state.db"));
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
