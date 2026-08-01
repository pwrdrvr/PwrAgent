import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPullRequestStatusKey,
  materializeNavigationThreads,
  type AppServerTurnInputItem,
  type PrSummary,
  type ThreadPrAutoDispatchPending,
} from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import {
  MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
  PR_AUTO_DISPATCH_DELAY_MS,
  PR_AUTO_DISPATCH_LEASE_MS,
  PrAutoDispatchCoordinator,
} from "../pr-status/pr-auto-dispatch";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;
let clock: number;
const extraDbs: StateDb[] = [];

beforeEach(async () => {
  vi.useFakeTimers();
  clock = 1_000;
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-pr-auto-dispatch-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
  await store.setThreadPrAutoDispatchEnabled({
    backend: "codex",
    threadId: "thread-1",
    enabled: true,
  });
});

afterEach(() => {
  for (const db of extraDbs.splice(0)) db.close();
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  const headSha = overrides.headSha ?? "a".repeat(40);
  return {
    provider: "github.com",
    number: 1105,
    org: "pwrdrvr",
    repo: "PwrAgent",
    title: "Auto-fix attached PR failures",
    state: "failing",
    checkState: "failing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    headSha,
    commitShas: [headSha],
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1105",
    ...overrides,
  };
}

function createHarness(options: {
  targetStore?: SqliteOverlayStore;
  busy?: boolean;
  gate?: boolean;
  currentPr?: PrSummary;
} = {}) {
  let busy = options.busy ?? false;
  let gate = options.gate ?? true;
  let currentPr = options.currentPr ?? pr();
  let refreshedPr: PrSummary | undefined;
  const pendingUpdates: Array<ThreadPrAutoDispatchPending | null> = [];
  const submitTurnIfIdle = vi.fn(async (_request: {
    input: AppServerTurnInputItem[];
  }) => busy
    ? { status: "busy" as const }
    : { status: "started" as const, turnId: "turn-auto-1" });
  const coordinator = new PrAutoDispatchCoordinator({
    store: options.targetStore ?? store,
    registry: { submitTurnIfIdle },
    getCurrentPr: () => currentPr,
    refreshPendingPrs: async (pending) => {
      if (refreshedPr) currentPr = refreshedPr;
      return new Set(pending.map((item) => item.prKey));
    },
    isPrAttached: () => true,
    isBackgroundPollingEnabled: () => gate,
    now: () => clock,
    onPendingChanged: ({ pending }) => {
      pendingUpdates.push(pending);
    },
  });
  return {
    coordinator,
    pendingUpdates,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setCurrentPr: (value: PrSummary) => {
      currentPr = value;
    },
    setGate: (value: boolean) => {
      gate = value;
    },
    setRefreshedPr: (value: PrSummary) => {
      refreshedPr = value;
    },
    submitTurnIfIdle,
  };
}

async function observe(
  coordinator: PrAutoDispatchCoordinator,
  currentPr = pr(),
  backgroundPollingEnabled = true,
) {
  return await coordinator.handleStatusSnapshot({
    pr: currentPr,
    threadKeys: ["codex:thread-1"],
    observedAt: clock,
    backgroundPollingEnabled,
  });
}

async function runCountdown(): Promise<void> {
  clock += PR_AUTO_DISPATCH_DELAY_MS;
  await vi.advanceTimersByTimeAsync(PR_AUTO_DISPATCH_DELAY_MS);
}

describe("PrAutoDispatchCoordinator", () => {
  it("keeps the saved preference but schedules nothing while the global gate is off", async () => {
    const harness = createHarness({ gate: false });
    const outcomes = await observe(harness.coordinator, pr(), false);

    expect(outcomes).toEqual([
      { threadKey: "codex:thread-1", status: "gate-off" },
    ]);
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
    expect(
      (await store.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }))?.prAutoDispatchEnabled,
    ).toBe(true);
  });

  it("schedules the current failed PR immediately and exposes a 30-second on-deck item", async () => {
    const harness = createHarness();
    const outcomes = await observe(harness.coordinator);

    expect(outcomes[0]).toMatchObject({ status: "scheduled" });
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.prAutoDispatchPending).toMatchObject({
      prNumber: 1105,
      eventKinds: ["ci-failure"],
      scheduledAt: clock + PR_AUTO_DISPATCH_DELAY_MS,
    });
    const thread = materializeNavigationThreads({
      firstSnapshot: true,
      overlayByThreadKey: { "codex:thread-1": overlay },
      previousKnownThreadKeys: [],
      threads: [{
        id: "thread-1",
        title: "Fix CI",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }],
    })[0];
    expect(thread?.prAutoDispatchPending?.scheduledAt).toBe(
      clock + PR_AUTO_DISPATCH_DELAY_MS,
    );
  });

  it("does not schedule terminal PRs and cancels a pending repair when one closes", async () => {
    const harness = createHarness();
    expect((await observe(
      harness.coordinator,
      pr({ lifecycleState: "merged" }),
    ))[0]?.status).toBe("not-actionable");
    expect(await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    })).toBeUndefined();

    await observe(harness.coordinator);
    const closed = pr({ lifecycleState: "closed" });
    harness.setCurrentPr(closed);
    expect((await observe(harness.coordinator, closed))[0]?.status).toBe(
      "not-actionable",
    );
    expect(await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    })).toBeUndefined();
    await runCountdown();
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
  });

  it("dispatches only after the countdown and includes structured PR context", async () => {
    const harness = createHarness();
    await observe(harness.coordinator);

    await vi.advanceTimersByTimeAsync(PR_AUTO_DISPATCH_DELAY_MS - 1);
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
    clock += PR_AUTO_DISPATCH_DELAY_MS;
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(harness.submitTurnIfIdle.mock.calls[0]?.[0].input[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(`- Head SHA: ${"a".repeat(40)}`),
      }),
    );
    expect(
      await store.getThreadPrAutoDispatchPending({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).toBeUndefined();
  });

  it("sends a scheduled repair immediately when the operator chooses Send now", async () => {
    const harness = createHarness();
    await observe(harness.coordinator);
    const pending = await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(await harness.coordinator.sendPendingNow({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: pending!.pending.fingerprint,
    })).toBe(true);
    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);

    await runCountdown();
    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
  });

  it("does not let Send now bypass the global polling gate", async () => {
    const harness = createHarness();
    await observe(harness.coordinator);
    const pending = await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    });
    harness.setGate(false);

    expect(await harness.coordinator.sendPendingNow({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: pending!.pending.fingerprint,
    })).toBe(false);
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
    expect(await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    })).toBeDefined();
  });

  it("lets the operator cancel and does not recreate the same fingerprint", async () => {
    const harness = createHarness();
    await observe(harness.coordinator);
    const pending = await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(await harness.coordinator.cancelPending({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: pending!.pending.fingerprint,
    })).toBe(true);
    expect((await observe(harness.coordinator))[0]?.status).toBe("duplicate");
    await runCountdown();
    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();

    const reenabled = await harness.coordinator.handleStatusSnapshot({
      pr: pr(),
      threadKeys: ["codex:thread-1"],
      observedAt: clock,
      backgroundPollingEnabled: true,
      operatorInitiated: true,
    });
    expect(reenabled[0]?.status).toBe("scheduled");
  });

  it("treats toggling back on as an explicit retry with a fresh attempt budget", async () => {
    const harness = createHarness();
    await observe(harness.coordinator);
    const firstPending = await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    });
    await harness.coordinator.sendPendingNow({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: firstPending!.pending.fingerprint,
    });

    expect((await observe(harness.coordinator))[0]?.status).toBe("duplicate");
    expect(await store.getThreadPrAutoDispatchAttemptCount({
      backend: "codex",
      threadId: "thread-1",
      prKey: buildPullRequestStatusKey(pr()),
    })).toBe(1);

    expect(await harness.coordinator.resetForOperator({
      backend: "codex",
      threadId: "thread-1",
    })).toBe(true);
    expect(await store.getThreadPrAutoDispatchAttemptCount({
      backend: "codex",
      threadId: "thread-1",
      prKey: buildPullRequestStatusKey(pr()),
    })).toBe(0);

    const reenabled = await harness.coordinator.handleStatusSnapshot({
      pr: pr(),
      threadKeys: ["codex:thread-1"],
      observedAt: clock,
      backgroundPollingEnabled: true,
      operatorInitiated: true,
    });
    expect(reenabled[0]?.status).toBe("scheduled");
    const retryPending = await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    });
    await harness.coordinator.sendPendingNow({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: retryPending!.pending.fingerprint,
    });

    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(2);
    expect(harness.submitTurnIfIdle.mock.calls[1]?.[0].input[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Automatic attempt: 1/2"),
      }),
    );
  });

  it("survives restart without replaying or losing a pending repair", async () => {
    const first = createHarness();
    await observe(first.coordinator);
    first.coordinator.close();

    const dbPath = path.join(tempDir, "state.db");
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    const afterRestart = createHarness();
    await afterRestart.coordinator.resume();
    expect((await observe(afterRestart.coordinator))[0]?.status).toBe("pending");

    await runCountdown();
    expect(afterRestart.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect((await observe(afterRestart.coordinator))[0]?.status).toBe("duplicate");
  });

  it("waits for provider refresh before resuming an overdue paused repair", async () => {
    const harness = createHarness();
    await observe(harness.coordinator);
    harness.coordinator.pause();
    harness.setGate(false);
    clock += PR_AUTO_DISPATCH_DELAY_MS;
    await vi.advanceTimersByTimeAsync(PR_AUTO_DISPATCH_DELAY_MS);
    harness.setRefreshedPr(pr({
      state: "passing",
      checkState: "passing",
    }));
    harness.setGate(true);

    await harness.coordinator.resume();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.submitTurnIfIdle).not.toHaveBeenCalled();
    expect(await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    })).toBeUndefined();
  });

  it("reclaims an orphaned dispatch lease after restart without double-spending", async () => {
    const first = createHarness();
    await observe(first.coordinator);
    first.coordinator.close();
    const pending = await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(await store.beginThreadPrAutoDispatch({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: pending!.pending.fingerprint,
      leaseExpiresAt: clock + PR_AUTO_DISPATCH_LEASE_MS,
      maxAttempts: MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
      now: clock,
      ownerId: "dead-process",
    })).toMatchObject({ status: "ready", attemptCount: 1 });

    const dbPath = path.join(tempDir, "state.db");
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    const afterRestart = createHarness();
    await afterRestart.coordinator.resume();

    clock += PR_AUTO_DISPATCH_LEASE_MS - 1;
    await vi.advanceTimersByTimeAsync(PR_AUTO_DISPATCH_LEASE_MS - 1);
    expect(afterRestart.submitTurnIfIdle).not.toHaveBeenCalled();
    expect(await store.getThreadPrAutoDispatchAttemptCount({
      backend: "codex",
      threadId: "thread-1",
      prKey: buildPullRequestStatusKey(pr()),
    })).toBe(1);

    clock += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect((await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    }))?.pending.scheduledAt).toBe(clock + PR_AUTO_DISPATCH_DELAY_MS);
    expect(await store.getThreadPrAutoDispatchAttemptCount({
      backend: "codex",
      threadId: "thread-1",
      prKey: buildPullRequestStatusKey(pr()),
    })).toBe(0);

    await runCountdown();
    expect(afterRestart.submitTurnIfIdle).toHaveBeenCalledTimes(1);
  });

  it("atomically rejects busy submission and restores the countdown without spending an attempt", async () => {
    const harness = createHarness({ busy: true });
    await observe(harness.coordinator);
    await runCountdown();

    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(1);
    expect(await store.getThreadPrAutoDispatchAttemptCount({
      backend: "codex",
      threadId: "thread-1",
      prKey: buildPullRequestStatusKey(pr()),
    })).toBe(0);
    expect((await store.getThreadPrAutoDispatchPending({
      backend: "codex",
      threadId: "thread-1",
    }))?.pending.scheduledAt).toBe(clock + PR_AUTO_DISPATCH_DELAY_MS);

    harness.setBusy(false);
    await runCountdown();
    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(2);
    expect(await store.getThreadPrAutoDispatchAttemptCount({
      backend: "codex",
      threadId: "thread-1",
      prKey: buildPullRequestStatusKey(pr()),
    })).toBe(1);
  });

  it("does not reset the finite incident budget while a repair head is pending", async () => {
    const harness = createHarness();
    const heads = ["a", "b", "c", "d"].map((value) => value.repeat(40));

    harness.setCurrentPr(pr({ headSha: heads[0] }));
    await observe(harness.coordinator, pr({ headSha: heads[0] }));
    await runCountdown();

    const pendingB = pr({
      headSha: heads[1],
      state: "pending",
      checkState: "pending",
    });
    harness.setCurrentPr(pendingB);
    await observe(harness.coordinator, pendingB);
    expect(await store.getThreadPrAutoDispatchAttemptCount({
      backend: "codex",
      threadId: "thread-1",
      prKey: buildPullRequestStatusKey(pr()),
    })).toBe(1);

    const failingB = pr({ headSha: heads[1] });
    harness.setCurrentPr(failingB);
    await observe(harness.coordinator, failingB);
    await runCountdown();

    const pendingC = pr({
      headSha: heads[2],
      state: "pending",
      checkState: "pending",
    });
    harness.setCurrentPr(pendingC);
    await observe(harness.coordinator, pendingC);
    const failingC = pr({ headSha: heads[2] });
    harness.setCurrentPr(failingC);
    expect((await observe(harness.coordinator, failingC))[0]?.status).toBe(
      "attempt-limit",
    );
    expect(harness.submitTurnIfIdle).toHaveBeenCalledTimes(
      MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
    );

    const passingC = pr({
      headSha: heads[2],
      state: "passing",
      checkState: "passing",
    });
    harness.setCurrentPr(passingC);
    await observe(harness.coordinator, passingC);
    const failingD = pr({ headSha: heads[3] });
    harness.setCurrentPr(failingD);
    expect((await observe(harness.coordinator, failingD))[0]?.status).toBe(
      "scheduled",
    );
  });

  it("uses a unique SQLite claim across two app instances", async () => {
    const secondDb = StateDb.open(path.join(tempDir, "state.db"));
    extraDbs.push(secondDb);
    const secondStore = new SqliteOverlayStore(secondDb);
    const first = createHarness();
    const second = createHarness({ targetStore: secondStore });

    const [firstOutcome, secondOutcome] = await Promise.all([
      observe(first.coordinator),
      observe(second.coordinator),
    ]);
    expect([firstOutcome[0]?.status, secondOutcome[0]?.status].sort()).toEqual([
      "pending",
      "scheduled",
    ]);

    await runCountdown();
    expect(
      first.submitTurnIfIdle.mock.calls.length
      + second.submitTurnIfIdle.mock.calls.length,
    ).toBe(1);
  });

  it("drops a scheduled repair when the PR recovers or is detached before send", async () => {
    let attached = true;
    let currentPr = pr();
    const submitTurnIfIdle = vi.fn(async () => ({
      status: "started" as const,
      turnId: "turn-auto-1",
    }));
    const coordinator = new PrAutoDispatchCoordinator({
      store,
      registry: { submitTurnIfIdle },
      getCurrentPr: () => currentPr,
      isPrAttached: () => attached,
      isBackgroundPollingEnabled: () => true,
      now: () => clock,
    });
    await observe(coordinator, currentPr);
    currentPr = pr({ state: "passing", checkState: "passing" });
    await runCountdown();
    expect(submitTurnIfIdle).not.toHaveBeenCalled();

    currentPr = pr({ headSha: "b".repeat(40) });
    await observe(coordinator, currentPr);
    attached = false;
    await runCountdown();
    expect(submitTurnIfIdle).not.toHaveBeenCalled();
  });
});
