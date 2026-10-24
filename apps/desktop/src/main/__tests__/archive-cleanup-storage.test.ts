import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpSessionStore } from "../acp/acp-session-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

afterEach(() => vi.restoreAllMocks());

describe("archive cleanup storage budgets", () => {
  it("projects only ownership/grouping in indexed identity slices, with zero writes", async () => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    const sessions = new AcpSessionStore(db);
    const directory = { id: "external", kind: "worktree", label: "repo", path: "/fixture/repo", worktreePath: "/fixture/worktree", worktreeOwnership: "external" };
    for (let id = 0; id < 51; id += 1) {
      const threadId = String(id).padStart(3, "0");
      db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run(`codex:${threadId}`, JSON.stringify({
        backend: "codex", threadId, extraLinkedDirectories: [directory], parentThreadId: "parent",
        parentThreadBackend: "acp:kimi", parentThreadInstanceId: "remote-owner",
        immutableUsageActivities: [{ text: "contrived history".repeat(1000) }],
      }));
      sessions.upsertSession({ backendId: "acp:kimi", sessionId: threadId, title: "fixture", cwd: "/fixture/worktree",
        executionMode: "default", status: "idle", createdAt: 1, updatedAt: 2, ...(id % 2 ? { archivedAt: 3 } : {}) });
    }
    const prepare = db.raw.prepare.bind(db.raw);
    const plans: string[] = [];
    const spy = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("SELECT")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          plans.push(...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((row) => row.detail));
          return all(...args);
        });
      }
      return statement;
    });
    try {
      const { writes } = await measureSqliteWrites(async () => {
        const projected = await store.getArchiveCleanupOverlayStates({ backend: "codex", threadIds: ["000", "missing"] });
        expect(projected["000"]).toMatchObject({ extraLinkedDirectories: [directory], parentThreadId: "parent", parentThreadInstanceId: "remote-owner" });
        expect(projected["000"]?.immutableUsageActivities).toBeUndefined();
        expect(projected.missing).toBeUndefined();
        let after: string | undefined;
        const ids: string[] = [];
        const pageSizes: number[] = [];
        do {
          const page = sessions.listArchiveCleanupSessionsPage("acp:kimi", { archived: true, after, limit: 25 });
          pageSizes.push(page.sessions.length);
          ids.push(...page.sessions.map((session) => session.sessionId));
          after = page.nextCursor;
        } while (after);
        expect(ids).toHaveLength(25);
        expect(new Set(ids).size).toBe(25);
        expect(pageSizes).toEqual([12, 13, 0]);
      });
      expectSqliteWriteBudget({ scenario: "archive-cleanup-read-only-inventory", note: "One ownership projection and three ACP identity pages: zero SQLite writes; pacing and queue state add 0 MB/day.", writes });
      expect(plans.some((plan) => /SEARCH threads USING INDEX/.test(plan))).toBe(true);
      expect(plans.some((plan) => /SEARCH acp_sessions USING INDEX/.test(plan))).toBe(true);
      expect(plans.some((plan) => /SCAN (threads|acp_sessions)/.test(plan))).toBe(false);
      const before = spy.mock.calls.length;
      await expect(store.getArchiveCleanupOverlayStates({ backend: "codex", threadIds: Array.from({ length: 26 }, (_, id) => String(id)) })).rejects.toThrow("exceeded 25");
      expect(spy.mock.calls.length).toBe(before);
    } finally { db.close(); }
  });
});
