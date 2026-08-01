import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  materializeNavigationThreads,
  type AppServerTurnInputItem,
  type PrSummary,
} from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import {
  MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
  PrAutoDispatchCoordinator,
} from "../pr-status/pr-auto-dispatch";
import { computePrStatusTransition } from "../pr-status/pr-transitions";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(async () => {
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
    title: "Auto-fix attached PR failures",
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

function failingTransition(headSha = "a".repeat(40)) {
  return computePrStatusTransition(
    pr({ headSha, checkState: "pending", state: "pending" }),
    pr({ headSha, checkState: "failing", state: "failing" }),
    ["codex:thread-1"],
  )!;
}

function passingTransition(headSha = "a".repeat(40)) {
  return computePrStatusTransition(
    pr({ headSha, checkState: "failing", state: "failing" }),
    pr({ headSha, checkState: "passing", state: "passing" }),
    ["codex:thread-1"],
  )!;
}

function conflictingTransition(headSha = "a".repeat(40)) {
  return computePrStatusTransition(
    pr({ headSha, mergeState: "mergeable" }),
    pr({ headSha, mergeState: "conflicting" }),
    ["codex:thread-1"],
  )!;
}

function newFailingHeadTransition(previousHead: string, nextHead: string) {
  return computePrStatusTransition(
    pr({
      headSha: previousHead,
      commitShas: [previousHead],
      checkState: "failing",
      state: "failing",
    }),
    pr({
      headSha: nextHead,
      commitShas: [nextHead],
      checkState: "failing",
      state: "failing",
    }),
    ["codex:thread-1"],
  )!;
}

function createHarness(options: { busy?: boolean } = {}) {
  const submitTurn = vi.fn(async (_request: {
    input: AppServerTurnInputItem[];
  }) => ({
    status: "started" as const,
    turnId: "turn-auto-1",
  }));
  const coordinator = new PrAutoDispatchCoordinator({
    store,
    registry: {
      canStartThreadTurnImmediately: () => !options.busy,
      submitTurn,
    },
  });
  return { coordinator, submitTurn };
}

describe("PrAutoDispatchCoordinator", () => {
  it("does nothing when the global background-polling gate is off", async () => {
    const { coordinator, submitTurn } = createHarness();
    const outcomes = await coordinator.handleTransition({
      transition: failingTransition(),
      source: "background-poll",
      observedAt: 1_000,
      backgroundPollingEnabled: false,
    });

    expect(outcomes).toEqual([
      { threadKey: "codex:thread-1", status: "gate-off" },
    ]);
    expect(submitTurn).not.toHaveBeenCalled();
    expect(
      (await store.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }))?.prAutoDispatchEnabled,
    ).toBe(true);
  });

  it("rechecks the global gate before claiming a dispatch", async () => {
    let backgroundPollingEnabled = true;
    const submitTurn = vi.fn(async () => ({
      status: "started" as const,
      turnId: "turn-auto-1",
    }));
    const coordinator = new PrAutoDispatchCoordinator({
      store,
      registry: {
        canStartThreadTurnImmediately: () => {
          backgroundPollingEnabled = false;
          return true;
        },
        submitTurn,
      },
      isBackgroundPollingEnabled: () => backgroundPollingEnabled,
    });

    const outcomes = await coordinator.handleTransition({
      transition: failingTransition(),
      source: "background-poll",
      observedAt: 1_000,
      backgroundPollingEnabled: true,
    });

    expect(outcomes).toEqual([
      { threadKey: "codex:thread-1", status: "gate-off" },
    ]);
    expect(submitTurn).not.toHaveBeenCalled();
    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.prAutoDispatchHandledFingerprints).toBeUndefined();
    expect(overlay?.prAutoDispatchAttemptCounts).toBeUndefined();
  });

  it("claims before dispatch and never replays the same fingerprint after restart", async () => {
    const first = createHarness();
    const transition = failingTransition();
    const firstOutcomes = await first.coordinator.handleTransition({
      transition,
      source: "background-poll",
      observedAt: 1_000,
      backgroundPollingEnabled: true,
    });

    expect(firstOutcomes[0]?.status).toBe("dispatched");
    expect(first.submitTurn).toHaveBeenCalledTimes(1);
    expect(first.submitTurn.mock.calls[0]?.[0].input[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(`- Head SHA: ${"a".repeat(40)}`),
      }),
    );

    const dbPath = path.join(tempDir, "state.db");
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    const restoredOverlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    const restoredThread = materializeNavigationThreads({
      firstSnapshot: true,
      overlayByThreadKey: { "codex:thread-1": restoredOverlay },
      previousKnownThreadKeys: [],
      threads: [{
        id: "thread-1",
        title: "Fix CI",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }],
    })[0];
    expect(restoredThread?.prAutoDispatchEnabled).toBe(true);
    const afterRestart = createHarness();
    const replayOutcomes = await afterRestart.coordinator.handleTransition({
      transition,
      source: "background-poll",
      observedAt: 2_000,
      backgroundPollingEnabled: true,
    });

    expect(replayOutcomes[0]?.status).toBe("duplicate");
    expect(afterRestart.submitTurn).not.toHaveBeenCalled();
  });

  it("does not queue an automatic turn while the thread is active or queued", async () => {
    const busy = createHarness({ busy: true });
    const transition = failingTransition();
    const busyOutcomes = await busy.coordinator.handleTransition({
      transition,
      source: "background-poll",
      observedAt: 1_000,
      backgroundPollingEnabled: true,
    });

    expect(busyOutcomes[0]?.status).toBe("busy");
    expect(busy.submitTurn).not.toHaveBeenCalled();

    const idle = createHarness();
    const idleOutcomes = await idle.coordinator.handleTransition({
      transition,
      source: "background-poll",
      observedAt: 2_000,
      backgroundPollingEnabled: true,
    });
    expect(idleOutcomes[0]?.status).toBe("dispatched");
    expect(idle.submitTurn).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent observations while dispatch is pending", async () => {
    let releaseSubmit!: () => void;
    const submitPending = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const submitTurn = vi.fn(async (_request: {
      input: AppServerTurnInputItem[];
    }) => {
      await submitPending;
      return { status: "started" as const, turnId: "turn-auto-1" };
    });
    const coordinator = new PrAutoDispatchCoordinator({
      store,
      registry: {
        canStartThreadTurnImmediately: () => true,
        submitTurn,
      },
    });
    const request = {
      transition: conflictingTransition(),
      source: "background-poll",
      observedAt: 1_000,
      backgroundPollingEnabled: true,
    };
    const first = coordinator.handleTransition(request);
    await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(1));
    const second = await coordinator.handleTransition(request);

    expect(second[0]?.status).toBe("pending");
    releaseSubmit();
    expect((await first)[0]?.status).toBe("dispatched");
    expect(submitTurn).toHaveBeenCalledTimes(1);
    expect(submitTurn.mock.calls[0]?.[0].input[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("- Event kinds: merge-conflict"),
      }),
    );
  });

  it("re-arms for a new head fingerprint but caps a continuous failure incident", async () => {
    const { coordinator, submitTurn } = createHarness();
    const heads = ["a", "b", "c"].map((value) => value.repeat(40));
    const transitions = [
      failingTransition(heads[0]!),
      newFailingHeadTransition(heads[0]!, heads[1]!),
    ];
    for (const [index, transition] of transitions.entries()) {
      const outcomes = await coordinator.handleTransition({
        transition,
        source: "background-poll",
        observedAt: 1_000 + index,
        backgroundPollingEnabled: true,
      });
      expect(outcomes[0]?.status).toBe("dispatched");
    }

    const capped = await coordinator.handleTransition({
      transition: newFailingHeadTransition(heads[1]!, heads[2]!),
      source: "background-poll",
      observedAt: 2_000,
      backgroundPollingEnabled: true,
    });
    expect(capped[0]?.status).toBe("attempt-limit");
    expect(submitTurn).toHaveBeenCalledTimes(
      MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
    );

    await coordinator.handleTransition({
      transition: passingTransition("c".repeat(40)),
      source: "background-poll",
      observedAt: 3_000,
      backgroundPollingEnabled: true,
    });
    const rearmed = await coordinator.handleTransition({
      transition: failingTransition("d".repeat(40)),
      source: "background-poll",
      observedAt: 4_000,
      backgroundPollingEnabled: true,
    });
    expect(rearmed[0]?.status).toBe("dispatched");
    expect(submitTurn).toHaveBeenCalledTimes(3);
  });
});
