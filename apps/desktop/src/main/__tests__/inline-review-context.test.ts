import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AppServerReviewContext } from "@pwragent/shared";
import { persistInlineReviewContext } from "../app-server/inline-review-context";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

describe("inline PR review provenance", () => {
  it("publishes and retains the selected scope after database reopen with a bounded write", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("inline-pr-review-");
    let db = StateDb.open(dbPath);
    try {
      const store = new SqliteOverlayStore(db);
      // Setup is outside the measured feature.
      await store.setThreadModelSettings({ backend: "codex", threadId: "parent", model: "fixture-model" });
      const pullRequest = { provider: "github.com", org: "fixture", repo: "project", number: 1, url: "https://github.com/fixture/project/pull/1", baseRefName: "main", headRefName: "first" };
      const context: AppServerReviewContext = {
        workspacePath: "/repo/checkout-at-second-pr", gitBranch: "first", baseBranch: "main",
        headCommit: "b".repeat(40), baseCommit: "a".repeat(40), pullRequest,
        pullRequestSnapshot: { pullRequest, headCommit: "b".repeat(40), baseCommit: "a".repeat(40), mergeBaseCommit: "a".repeat(40), capturedAt: 1 },
      };
      const events: AgentEvent[] = [];
      const { writes } = await measureSqliteWrites(async () => {
        await persistInlineReviewContext({
          store, threadId: "parent", turnId: "ordinary-turn", context,
          reviewer: { backend: "codex" },
          emit: async (event) => { events.push(event); },
        });
      });
      expectSqliteWriteBudget({
        scenario: "inline-pr-review-context",
        note: "One captured PR scope card for an ordinary parent turn; no sub-agent, streamed writes, or completion rewrite",
        writes,
      });
      expect(events).toContainEqual(expect.objectContaining({ notification: expect.objectContaining({
        method: "item/completed", params: expect.objectContaining({ item: expect.objectContaining({ data: { context, reviewer: { backend: "codex" } } }) }),
      }) }));
      db.close();
      db = StateDb.open(dbPath);
      const reopened = await new SqliteOverlayStore(db).getThreadOverlayState({ backend: "codex", threadId: "parent" });
      expect(reopened?.managedReviewEntries).toContainEqual(expect.objectContaining({ context, id: "inline-review:ordinary-turn:context" }));
      expect(reopened?.managedReviewEntries?.[0].turn).toBeUndefined();
      expect(reopened?.subAgents).toBeUndefined();
    } finally {
      db.close();
      removeTempStateDbDir(tempDir);
      vi.unstubAllEnvs();
    }
  });
});
