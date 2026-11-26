import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppServerReviewPullRequestSnapshot, AppServerReviewTarget } from "@pwragent/shared/contracts/normalized-app-server";
import { buildPendingTurnId } from "@pwragent/shared/turn-placeholder";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { immutableReviewDiffHash } from "../app-server/agent-review-submission";
import { autoFixReviewFindingsPrompt, fixReviewFindingsPrompt, isReviewFixPromptText } from "../../shared/review-fix-prompts";
import * as gitExecutable from "../app-server/git-executable";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import {
  callRegistryMcpTool,
  createDeferred,
  createOverlayStoreMock,
  MockBackendClient,
} from "./helpers/backend-registry-fixture";

const thread = { backend: "codex" as const, threadId: "review-parent" };

function commit(value: number): AppServerReviewTarget {
  return { type: "commit", sha: value.toString(16).padStart(40, "0"), title: null };
}

async function withReviewOwner<T>(run: (owner: {
  registry: DesktopBackendRegistry;
  ask: (turnId: string, target: AppServerReviewTarget, callId: string, cwd?: string) => Promise<boolean>;
  askDetail: (turnId: string, target: AppServerReviewTarget, callId: string, cwd?: string) => Promise<{ accepted: boolean; text: string }>;
  emitStarted: (turnId: string) => Promise<void>;
  complete: (turnId: string) => Promise<void>;
  start: (source: "automation" | "desktop") => Promise<string>;
  providerStarts: () => number;
}) => Promise<T>, options: {
  overlayStore?: ReturnType<typeof createOverlayStoreMock> | SqliteOverlayStore;
  turnPrefix?: string;
  startTurnResults?: Array<{ threadId: string; turnId: string }>;
  beforeReview?: () => Promise<void>;
  cwd?: string;
} = {}): Promise<T> {
  let started = 0;
  const codexClient = new MockBackendClient({
    initializeResult: { methods: ["turn/start", "review/start", "thread/resume"] },
    ...(options.cwd ? { threads: [{
      id: thread.threadId, source: thread.backend, title: "Review parent", titleSource: "explicit",
      linkedDirectories: [{ id: options.cwd, kind: "local", label: "Project", path: options.cwd }],
    }] } : {}),
    startTurnResults: options.startTurnResults ?? Array.from({ length: 20 }, (_, index) => ({
      threadId: thread.threadId, turnId: `${options.turnPrefix ?? "turn"}-${index}`,
    })),
  });
  vi.spyOn(codexClient, "startReview").mockImplementation(async ({ threadId }) => {
    const turnId = `review-${++started}`;
    await options.beforeReview?.();
    return { threadId, reviewThreadId: threadId, turnId };
  });
  const registry = createDesktopBackendRegistry({
    codexClient, overlayStore: options.overlayStore ?? createOverlayStoreMock(), threadTitleGenerationService: null,
  });
  const emitStarted = async (turnId: string) => await codexClient.emit({
    method: "turn/started",
    params: { threadId: thread.threadId, turnId, turn: { id: turnId } },
  });
  const askDetail = async (
    turnId: string,
    target: AppServerReviewTarget,
    callId: string,
    cwd?: string,
  ): Promise<{ accepted: boolean; text: string }> => {
    const result = await callRegistryMcpTool({
      registry, ...thread, turnId, tool: "start_review", args: { target, ...(cwd ? { cwd } : {}) }, callId,
    });
    const text = result?.content
      ?.flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
      .join("\n") ?? "";
    return {
      accepted: result?.isError !== true && result?.structuredContent?.status === "scheduled",
      text,
    };
  };
  try {
    return await run({
      registry,
      ask: async (turnId, target, callId, cwd) => (await askDetail(turnId, target, callId, cwd)).accepted,
      askDetail,
      emitStarted,
      complete: async (turnId) => await codexClient.emit({
        method: "turn/completed",
        params: { threadId: thread.threadId, turnId, turn: { id: turnId, status: "completed", output: [] } },
      }),
      start: async (source) => {
        const { turnId } = await registry.startTurn({
          ...thread, input: [{ type: "text", text: "Review the current change" }],
          ...(source === "automation" ? { messageOrigin: { kind: "pwragent" } } : {}),
        }, source);
        await emitStarted(turnId);
        return turnId;
      },
      providerStarts: () => started,
    });
  } finally {
    await registry.close();
  }
}

describe("agent review submission", () => {
  it("identifies the same set of PR diffs across reordered requests and refreshed snapshots", () => {
    const snapshot = (number: number, capturedAt: number): AppServerReviewPullRequestSnapshot => ({
      pullRequest: {
        provider: "github.com", org: "example", repo: "project", number,
        url: `https://github.com/example/project/pull/${number}`, baseRefName: "main", headRefName: "fix",
      },
      capturedAt, baseCommit: "a".repeat(40), mergeBaseCommit: "b".repeat(40), headCommit: "c".repeat(40),
    });
    const identify = (snapshots: AppServerReviewPullRequestSnapshot[]) => immutableReviewDiffHash({
      ...thread,
      target: { type: "pullRequests", pullRequests: snapshots.map((item) => ({ url: item.pullRequest.url, snapshot: item })) },
    });
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { minLength: 2, maxLength: 5 }),
      fc.nat(), (numbers, newest) => {
        const original = numbers.map((number) => snapshot(number, 0));
        const refreshed = numbers.map((number) => snapshot(number, newest)).reverse();
        // A newer base tip with the same merge base does not change the reviewed diff.
        refreshed[0]!.baseCommit = "d".repeat(40);
        expect(identify(original)).toBe(identify(refreshed));
        refreshed[0]!.headCommit = "e".repeat(40);
        expect(identify(original)).not.toBe(identify(refreshed));
      }));
  });

  it("bounds automatic review starts even as each CI wake names a different commit", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { minLength: 4, maxLength: 7 }),
      async (commits) => await withReviewOwner(async (owner) => {
        for (const [index, value] of commits.entries()) {
          const turn = await owner.start("automation");
          const accepted = await owner.ask(turn, commit(value), `call-${index}`);
          await owner.complete(turn);
          if (accepted) await owner.complete(`review-${owner.providerStarts()}`);
        }
        // New call IDs, turn IDs and commit SHAs cannot extend an autonomous run.
        expect(owner.providerStarts()).toBe(3);
      }),
    ), { numRuns: 12 });
  });

  it("stops the fourth CI wake and lets a new operator turn request another review", async () => {
    await withReviewOwner(async (owner) => {
      for (const value of [1, 2, 3, 4]) {
        const turn = await owner.start("automation");
        const accepted = await owner.ask(turn, commit(value), `auto-${value}`);
        await owner.complete(turn);
        if (accepted) await owner.complete(`review-${owner.providerStarts()}`);
        expect(accepted).toBe(value < 4);
      }
      const operator = await owner.start("desktop");
      await owner.complete(operator);
      const next = await owner.start("automation");
      expect(await owner.ask(next, commit(4), "after-operator")).toBe(true);
      await owner.complete(next);
      await owner.complete("review-4");
    });
  });

  it("starts one review when concurrent calls use different call IDs in the same turn", async () => {
    await withReviewOwner(async (owner) => {
      const first = await owner.start("automation");
      expect(await Promise.all([
        owner.ask(first, commit(1), "initial"),
        owner.ask(first, commit(1), "parallel-retry"),
      ])).toEqual([true, true]);
      await owner.complete(first);
      await owner.complete("review-1");
      expect(owner.providerStarts()).toBe(1);
    });
  });

  it("refuses to run the same immutable review in a later automated turn", async () => {
    await withReviewOwner(async (owner) => {
      const first = await owner.start("automation");
      expect(await owner.ask(first, commit(1), "initial")).toBe(true);
      await owner.complete(first);
      await owner.complete("review-1");
      const later = await owner.start("automation");
      const accepted = await owner.ask(later, commit(1), "later-retry");
      await owner.complete(later);
      if (accepted) await owner.complete("review-2");
      expect(accepted).toBe(false);
      expect(owner.providerStarts()).toBe(1);
    });
  });

  it("deduplicates a full commit when either request names the thread checkout explicitly", async () => {
    // Turn completion checks the branch. An existing empty directory lets the
    // filesystem probe rule out a repository. A missing path falls back to
    // launching Git, which uses a PowerShell Job wrapper on Windows.
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pwragent-review-parent-"));
    const restoreGitEnvironment = isolateProcessGitEnvironment();
    const runGit = vi.spyOn(gitExecutable, "runGitCommand");
    try {
      for (const explicitFirst of [false, true]) {
        const value = 1;
        await withReviewOwner(async (owner) => {
          const first = await owner.start("automation");
          expect(await owner.ask(first, commit(value), "first", explicitFirst ? cwd : undefined)).toBe(true);
          await owner.complete(first);
          await owner.complete("review-1");
          const later = await owner.start("automation");
          const duplicate = await owner.ask(later, commit(value), "duplicate", explicitFirst ? undefined : cwd);
          await owner.complete(later);
          if (duplicate) await owner.complete("review-2");
          expect(duplicate).toBe(false);
          expect(owner.providerStarts()).toBe(1);
        }, { cwd });
        expect(runGit).not.toHaveBeenCalled();
      }
    } finally {
      runGit.mockRestore();
      restoreGitEnvironment();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the next independent review waiting when the invoking terminal is redelivered", async () => {
    const enteringProvider = createDeferred<void>();
    const providerRelease = createDeferred<void>();
    await withReviewOwner(async (owner) => {
      const turnId = await owner.start("automation");
      for (const value of [1, 2]) {
        await expect(owner.registry.submitReview({
          ...thread, target: commit(value), idempotencyKey: `operator-${value}`,
        })).resolves.toMatchObject({ status: "scheduled" });
      }
      const terminal = owner.complete(turnId);
      try {
        await enteringProvider.promise;
        await registryModules(owner.registry).managedReviewService.drainPendingReviewStartsForTerminalTurn({
          ...thread, turnId, method: "turn/completed",
        });
      } finally {
        providerRelease.resolve();
        await terminal;
      }
      expect(owner.providerStarts()).toBe(1);
      await owner.complete("review-1");
      expect(owner.providerStarts()).toBe(2);
      await owner.complete("review-2");
    }, {
      beforeReview: async () => {
        enteringProvider.resolve();
        await providerRelease.promise;
      },
    });
  });

  it("retains the admission limit and rejects retries after the owner restarts", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("review-admission-");
    const admissions: Awaited<ReturnType<typeof measureSqliteWrites<boolean>>>[] = [];
    try {
      for (const value of [1, 2, 3, 4]) {
        // Reopen the same profile database under a fresh backend owner.
        const reopened = StateDb.open(dbPath);
        try {
          await withReviewOwner(async (owner) => {
            const turn = await owner.start("automation");
            const { result, writes } = await measureSqliteWrites(async () =>
              await owner.ask(turn, commit(value), `restart-${value}`));
            await owner.complete(turn);
            if (result) await owner.complete("review-1");
            expect(result).toBe(value < 4);
            expect(owner.providerStarts()).toBe(value < 4 ? 1 : 0);
            admissions.push({ result, writes });
          }, { overlayStore: new SqliteOverlayStore(reopened), turnPrefix: `restart-${value}` });
        } finally {
          reopened.close();
        }
      }
    } finally {
      removeTempStateDbDir(tempDir);
      vi.unstubAllEnvs();
    }
    for (const { result, writes } of admissions) {
      expectSqliteWriteBudget({
        scenario: result ? "agent-review-admission" : "agent-review-refusal",
        note: result
          ? "One commit per admitted agent review. At 100 admissions/day and 8,240 WAL bytes per commit, about 0.82 MB/day."
          : "A review refused at the limit makes no writes.",
        writes,
      });
    }
  });

  it("preserves an operator turn's reset across a restart before another review is requested", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("review-rearm-");
    try {
      const beforeRestart = StateDb.open(dbPath);
      const measured = await withReviewOwner(async (owner) => {
        for (const value of [1, 2, 3]) {
          const turn = await owner.start("automation");
          expect(await owner.ask(turn, commit(value), `review-${value}`)).toBe(true);
          await owner.complete(turn);
          await owner.complete(`review-${value}`);
        }
        const reset = await measureSqliteWrites(() => owner.start("desktop"));
        await owner.complete(reset.result);
        const idle = await measureSqliteWrites(() => owner.start("desktop"));
        await owner.complete(idle.result);
        return { reset: reset.writes, idle: idle.writes };
      }, { overlayStore: new SqliteOverlayStore(beforeRestart), turnPrefix: "before-rearm-restart" }).finally(() => {
        beforeRestart.close();
      });
      const afterRestart = StateDb.open(dbPath);
      try {
        await withReviewOwner(async (owner) => {
          const turn = await owner.start("automation");
          const accepted = await owner.ask(turn, commit(1), "after-restart");
          await owner.complete(turn);
          if (accepted) await owner.complete("review-1");
          expect(accepted).toBe(true);
          expect(owner.providerStarts()).toBe(1);
        }, { overlayStore: new SqliteOverlayStore(afterRestart), turnPrefix: "after-rearm-restart" });
      } finally {
        afterRestart.close();
      }
      expectSqliteWriteBudget({
        scenario: "agent-review-operator-reset",
        note: "An accepted operator turn clears used review attempts in one commit. At 100 resets/day and 8,240 WAL bytes per commit, about 0.82 MB/day.",
        writes: measured.reset,
      });
      expectSqliteWriteBudget({
        scenario: "agent-review-operator-reset-empty",
        note: "An accepted operator turn with no used review attempts makes no review admission writes.",
        writes: measured.idle,
      });
    } finally {
      removeTempStateDbDir(tempDir);
      vi.unstubAllEnvs();
    }
  });

  it("recognizes single-finding and multi-finding canonical review-fix prompts", () => {
    const single = [{ title: "Keep search available", priority: 2 }];
    const multi = [
      { title: "Keep search available", priority: 2 },
      { title: "Avoid duplicate writes", priority: 3 },
    ];
    expect(isReviewFixPromptText(autoFixReviewFindingsPrompt("Review of PR #4493", single))).toBe(true);
    expect(isReviewFixPromptText(autoFixReviewFindingsPrompt("Review of PR #4493", multi))).toBe(true);
    expect(isReviewFixPromptText(`  \n${autoFixReviewFindingsPrompt("Review of PR #4493", multi)}`)).toBe(true);
    expect(isReviewFixPromptText(fixReviewFindingsPrompt("Review of PR #4493", single))).toBe(true);
    expect(isReviewFixPromptText(fixReviewFindingsPrompt("Review of PR #4493", multi))).toBe(true);
    expect(isReviewFixPromptText("Auto-fix the lint warnings and run tests")).toBe(false);
    expect(isReviewFixPromptText("Use PwrAgent's `list_reviews` tool to inspect open findings.")).toBe(false);
  });

  it("refuses start_review from review-fix turns and never lets review-card Auto-fix or Fix turns reset the cap", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("review-fix-loop-");
    const stateDb = StateDb.open(dbPath);
    const reviewFixRefusal = "PwrAgent does not schedule another review from a review-fix turn.";
    try {
      await withReviewOwner(async (owner) => {
        // Reproduce PR #4493: agent handoff + PR watch wakes interleaved with
        // desktop/federation Review card Auto-fix, Fix, and automatic Auto-fix turns.
        const handoff = await owner.start("automation");
        expect(await owner.ask(handoff, commit(1), "handoff-1")).toBe(true);
        await owner.complete(handoff);
        await owner.complete("review-1");

        const watch1 = await owner.start("automation");
        expect(await owner.ask(watch1, commit(2), "watch-1")).toBe(true);
        await owner.complete(watch1);
        await owner.complete("review-2");

        // Card-clicked Auto-fix from desktop (explicit reviewFix: true):
        // must NOT reset attempts (still 2/3) and must refuse start_review with 0 SQLite writes.
        const cardAutoFix = await owner.registry.startTurn({
          ...thread,
          input: [{ type: "text", text: autoFixReviewFindingsPrompt("Review of PR #4493", [{ title: "Keep search available", priority: 2 }]) }],
          reviewFix: true,
        }, "desktop");
        await owner.emitStarted(cardAutoFix.turnId);
        const refusedCard = await measureSqliteWrites(() => owner.askDetail(cardAutoFix.turnId, commit(3), "card-autofix-review"));
        expect(refusedCard.result.accepted).toBe(false);
        expect(refusedCard.result.text).toContain(reviewFixRefusal);
        expectSqliteWriteBudget({
          scenario: "agent-review-refusal",
          note: "A review refused inside a review-fix turn makes no writes.",
          writes: refusedCard.writes,
        });
        await owner.complete(cardAutoFix.turnId);

        // Card-clicked multi-finding Auto-fix from an older Federation viewer (no reviewFix flag):
        // must ALSO refuse start_review and must NOT reset attempts (still 2/3).
        const legacyFedAutoFix = await owner.registry.startTurn({
          ...thread,
          input: [{
            type: "text",
            text: autoFixReviewFindingsPrompt("Review of PR #4493", [
              { title: "Keep search available", priority: 2 },
              { title: "Avoid duplicate writes", priority: 3 },
            ]),
          }],
        }, "federation");
        await owner.emitStarted(legacyFedAutoFix.turnId);
        const refusedLegacyAutoFix = await owner.askDetail(legacyFedAutoFix.turnId, commit(3), "legacy-fed-autofix-review");
        expect(refusedLegacyAutoFix.accepted).toBe(false);
        expect(refusedLegacyAutoFix.text).toContain(reviewFixRefusal);
        await owner.complete(legacyFedAutoFix.turnId);

        // Card-clicked Fix from an older Federation viewer (no reviewFix flag, canonical prompt only):
        // must ALSO refuse start_review and must NOT reset attempts (still 2/3).
        const legacyFedFix = await owner.registry.startTurn({
          ...thread,
          input: [{ type: "text", text: fixReviewFindingsPrompt("Review of PR #4493", [{ title: "Keep search available", priority: 2 }]) }],
        }, "federation");
        await owner.emitStarted(legacyFedFix.turnId);
        const refusedLegacyFix = await owner.askDetail(legacyFedFix.turnId, commit(4), "legacy-fed-fix-review");
        expect(refusedLegacyFix.accepted).toBe(false);
        expect(refusedLegacyFix.text).toContain(reviewFixRefusal);
        await owner.complete(legacyFedFix.turnId);

        // Automatic review Auto-fix (messageOrigin.reviewAutoFix):
        // must refuse start_review and must NOT reset attempts (still 2/3).
        const automaticAutoFix = await owner.registry.startTurn({
          ...thread,
          input: [{ type: "text", text: "Fix review findings" }],
          messageOrigin: { kind: "pwragent", reviewAutoFix: { reviewId: "rev-2", title: "Review of PR #4493", findingCount: 1 } },
        }, "automation");
        await owner.emitStarted(automaticAutoFix.turnId);
        const refusedAutomatic = await owner.askDetail(automaticAutoFix.turnId, commit(5), "auto-autofix-review");
        expect(refusedAutomatic.accepted).toBe(false);
        expect(refusedAutomatic.text).toContain(reviewFixRefusal);
        await owner.complete(automaticAutoFix.turnId);

        // Next PR watch wake consumes the 3rd and final slot (3/3).
        const watch2 = await owner.start("automation");
        expect(await owner.ask(watch2, commit(6), "watch-2")).toBe(true);
        await owner.complete(watch2);
        await owner.complete("review-3");

        // Another Review card Auto-fix click after hitting the limit still does NOT reset!
        const cardAutoFixAtCap = await owner.registry.startTurn({
          ...thread,
          input: [{ type: "text", text: autoFixReviewFindingsPrompt("Review of PR #4493", [{ title: "Still failing", priority: 2 }]) }],
          reviewFix: true,
        }, "desktop");
        await owner.emitStarted(cardAutoFixAtCap.turnId);
        const refusedAtCap = await owner.askDetail(cardAutoFixAtCap.turnId, commit(7), "card-at-cap");
        expect(refusedAtCap.accepted).toBe(false);
        expect(refusedAtCap.text).toContain(reviewFixRefusal);
        await owner.complete(cardAutoFixAtCap.turnId);

        // Next PR watch wake is hard-stopped at 3/3 (loop broken!).
        const watch3 = await owner.start("automation");
        const refusedLimit = await owner.askDetail(watch3, commit(8), "watch-3");
        expect(refusedLimit.accepted).toBe(false);
        expect(refusedLimit.text).toContain("stopped after 3 agent-requested reviews");
        await owner.complete(watch3);

        expect(owner.providerStarts()).toBe(3);

        // A genuine typed operator turn still rearms the allowance.
        const genuineOperator = await owner.start("desktop");
        expect(await owner.ask(genuineOperator, commit(8), "after-genuine-operator")).toBe(true);
        await owner.complete(genuineOperator);
        await owner.complete("review-4");
        expect(owner.providerStarts()).toBe(4);
      }, { overlayStore: new SqliteOverlayStore(stateDb) });
    } finally {
      stateDb.close();
      removeTempStateDbDir(tempDir);
      vi.unstubAllEnvs();
    }
  });

  it("rearms on a genuine operator turn even when Date.now ties or steps backwards", async () => {
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      await withReviewOwner(async (owner) => {
        // Anchor a persisted operator turn at baseTime first so both clock-tie
        // (baseTime === baseTime) and backward-step (baseTime - 50 < baseTime)
        // falsify wall-clock comparisons.
        const seed = await owner.start("automation");
        expect(await owner.ask(seed, commit(1), "seed-1")).toBe(true);
        await owner.complete(seed);
        await owner.complete("review-1");

        const anchorOperator = await owner.start("desktop");
        await owner.complete(anchorOperator);

        for (const value of [1, 2, 3]) {
          const turn = await owner.start("automation");
          expect(await owner.ask(turn, commit(value), `tie-auto-${value}`)).toBe(true);
          await owner.complete(turn);
          await owner.complete(`review-${value + 1}`);
        }

        // Same-millisecond tie: Date.now() is still baseTime.
        const sameMsOperator = await owner.start("desktop");
        expect(await owner.ask(sameMsOperator, commit(1), "rearmed-same-ms")).toBe(true);
        await owner.complete(sameMsOperator);
        await owner.complete("review-5");

        for (const value of [2, 3]) {
          const turn = await owner.start("automation");
          expect(await owner.ask(turn, commit(value), `skew-auto-${value}`)).toBe(true);
          await owner.complete(turn);
          await owner.complete(`review-${value + 4}`);
        }

        // Backward clock step: Date.now() moves earlier than baseTime.
        nowSpy.mockReturnValue(baseTime - 50);
        const backwardOperator = await owner.start("desktop");
        expect(await owner.ask(backwardOperator, commit(1), "rearmed-backward-clock")).toBe(true);
        await owner.complete(backwardOperator);
        await owner.complete("review-8");
        expect(owner.providerStarts()).toBe(8);
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rearms across Codex turns whose turn/start RPC returns a pending placeholder before turn/started", async () => {
    const { dbPath, tempDir } = createTempStateDb("review-pending-codex-turn-");
    const pendingTurnId = buildPendingTurnId(thread.threadId);
    const stateDb = StateDb.open(dbPath);
    try {
      await withReviewOwner(async (owner) => {
        // First automated review, followed by a genuine operator turn whose
        // turn/start RPC omits the turn ID and falls back to pending:<threadId>.
        const seed = await owner.start("automation");
        expect(await owner.ask(seed, commit(1), "seed-review")).toBe(true);
        await owner.complete(seed);
        await owner.complete("review-1");

        const firstOpStart = await owner.registry.startTurn({
          ...thread,
          input: [{ type: "text", text: "Try again" }],
        }, "desktop");
        expect(firstOpStart.turnId).toBe(pendingTurnId);
        await owner.emitStarted("real-op-1");
        await owner.complete("real-op-1");

        // Exhaust the 3-review cap after the first pending-RPC operator turn.
        for (const value of [1, 2, 3]) {
          const turn = await owner.start("automation");
          expect(await owner.ask(turn, commit(value), `post-op1-${value}`)).toBe(true);
          await owner.complete(turn);
          await owner.complete(`review-${value + 1}`);
        }

        // Second genuine operator turn whose turn/start RPC also returns pending:<threadId>.
        // Because the placeholder was never persisted as operatorTurnId, real-op-2 rearms the budget.
        const secondOpStart = await owner.registry.startTurn({
          ...thread,
          input: [{ type: "text", text: "One more review pass" }],
        }, "desktop");
        expect(secondOpStart.turnId).toBe(pendingTurnId);
        await owner.emitStarted("real-op-2");
        await owner.complete("real-op-2");

        const next = await owner.start("automation");
        expect(await owner.ask(next, commit(1), "after-op2")).toBe(true);
        await owner.complete(next);
        await owner.complete("review-5");
        expect(owner.providerStarts()).toBe(5);
      }, {
        overlayStore: new SqliteOverlayStore(stateDb),
        startTurnResults: [
          { threadId: thread.threadId, turnId: "auto-0" },
          { threadId: thread.threadId, turnId: pendingTurnId },
          { threadId: thread.threadId, turnId: "auto-1" },
          { threadId: thread.threadId, turnId: "auto-2" },
          { threadId: thread.threadId, turnId: "auto-3" },
          { threadId: thread.threadId, turnId: pendingTurnId },
          { threadId: thread.threadId, turnId: "auto-4" },
        ],
      });
    } finally {
      stateDb.close();
      removeTempStateDbDir(tempDir);
    }
  });

  it("preserves reviewFix across queued turns so a queued review-card Auto-fix still refuses start_review and keeps the cap", async () => {
    await withReviewOwner(async (owner) => {
      for (const value of [1, 2, 3]) {
        const turn = await owner.start("automation");
        expect(await owner.ask(turn, commit(value), `auto-${value}`)).toBe(true);
        await owner.complete(turn);
        await owner.complete(`review-${value}`);
      }
      // Start an active turn so the reviewFix submission queues behind it.
      const active = await owner.start("automation");
      const queuedStarted = createDeferred<string>();
      owner.registry.onEvent(({ notification }) => {
        if (notification.method === "thread/turnQueue/updated" && notification.params.status === "started"
          && typeof notification.params.turnId === "string") {
          queuedStarted.resolve(notification.params.turnId);
        }
      });
      // Use non-matching text so this test falsifies queue reviewFix propagation
      // directly instead of relying on the prompt-text fallback.
      const queued = await owner.registry.submitTurn({
        ...thread,
        input: [{ type: "text", text: "Fix the findings" }],
        origin: "manual",
        reviewFix: true,
      }, "desktop");
      expect(queued.status).toBe("queued");

      await owner.complete(active);
      const queuedTurnId = await queuedStarted.promise;
      await owner.emitStarted(queuedTurnId);
      const refusedQueued = await owner.askDetail(queuedTurnId, commit(4), "queued-review-fix");
      expect(refusedQueued.accepted).toBe(false);
      expect(refusedQueued.text).toContain("PwrAgent does not schedule another review from a review-fix turn.");
      await owner.complete(queuedTurnId);

      // Next automated wake is still refused at 3/3.
      const watch = await owner.start("automation");
      const refusedWatch = await owner.askDetail(watch, commit(5), "watch-after-queued-fix");
      expect(refusedWatch.accepted).toBe(false);
      expect(refusedWatch.text).toContain("stopped after 3 agent-requested reviews");
      await owner.complete(watch);
      expect(owner.providerStarts()).toBe(3);
    });
  });
});
