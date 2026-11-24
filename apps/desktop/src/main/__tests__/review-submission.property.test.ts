import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AppServerReviewPullRequestSnapshot, AppServerReviewTarget } from "@pwragent/shared/contracts/normalized-app-server";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { immutableReviewDiffHash } from "../app-server/agent-review-submission";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
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

async function withReviewOwner(run: (owner: {
  registry: DesktopBackendRegistry;
  ask: (turnId: string, target: AppServerReviewTarget, callId: string) => Promise<boolean>;
  complete: (turnId: string) => Promise<void>;
  start: (source: "automation" | "desktop") => Promise<string>;
  providerStarts: () => number;
}) => Promise<void>, options: {
  overlayStore?: ReturnType<typeof createOverlayStoreMock> | SqliteOverlayStore;
  turnPrefix?: string;
  beforeReview?: () => Promise<void>;
} = {}): Promise<void> {
  let started = 0;
  const codexClient = new MockBackendClient({
    initializeResult: { methods: ["turn/start", "review/start", "thread/resume"] },
    startTurnResults: Array.from({ length: 20 }, (_, index) => ({
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
  try {
    await run({
      registry,
      ask: async (turnId, target, callId) => {
        const result = await callRegistryMcpTool({
          registry, ...thread, turnId, tool: "start_review", args: { target }, callId,
        });
        return result?.isError !== true && result?.structuredContent?.status === "scheduled";
      },
      complete: async (turnId) => await codexClient.emit({
        method: "turn/completed",
        params: { threadId: thread.threadId, turnId, turn: { id: turnId, status: "completed", output: [] } },
      }),
      start: async (source) => {
        const { turnId } = await registry.startTurn({
          ...thread, input: [{ type: "text", text: "Review the current change" }],
          ...(source === "automation" ? { messageOrigin: { kind: "pwragent" } } : {}),
        }, source);
        await codexClient.emit({
          method: "turn/started",
          params: { threadId: thread.threadId, turnId, turn: { id: turnId } },
        });
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
});
