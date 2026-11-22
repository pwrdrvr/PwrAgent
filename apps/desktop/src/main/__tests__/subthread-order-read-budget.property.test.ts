import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

it("seeks stored subthread membership by parent or child ID regardless of unrelated overlays", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 100 }), async (unrelated) => {
    const db = openInMemoryStateDb();
    try {
      const store = new SqliteOverlayStore(db);
      const put = db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)");
      db.raw.transaction(() => {
        for (let index = 0; index < unrelated; index++) {
          const threadId = `foreign-${index}`;
          put.run(`codex:${threadId}`, JSON.stringify({ backend: "codex", threadId, parentThreadId: "elsewhere" }));
        }
      })();
      await store.setThreadParent({ backend: "claude", threadId: "fresh", parentThreadId: "root", parentThreadBackend: "codex" });
      db.raw.exec("ANALYZE threads");
      const plans: string[] = [];
      const rowCounts: number[] = [];
      const prepare = db.raw.prepare.bind(db.raw);
      vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (/FROM threads\b/.test(sql) && sql.includes("$.parentThreadId")) {
          const all = statement.all.bind(statement);
          vi.spyOn(statement, "all").mockImplementation((...bindings: unknown[]) => {
            const plan = prepare("EXPLAIN QUERY PLAN " + sql).all(...bindings) as { detail: string }[];
            plans.push(...plan.map(({ detail }) => detail));
            const rows = all(...bindings);
            rowCounts.push(rows.length);
            return rows;
          });
        }
        return statement;
      });
      expect([...store.readSubthreadGroup("codex", "root").scopes.keys()]).toEqual(["codex", "claude"]);
      await expect(store.updateSubthreadOrder({
        backend: "codex", parentThreadId: "root", insertAfter: { threadId: "fresh", sourceThreadId: "root" },
      })).resolves.toEqual(["fresh"]);
      expect(plans, plans.join("\n")).toEqual(expect.arrayContaining([
        expect.stringMatching(/^SEARCH threads USING (COVERING )?INDEX idx_threads_subthread_parent/),
        expect.stringMatching(/^SEARCH threads USING (COVERING )?INDEX idx_threads_subthread_id/),
      ]));
      expect(plans.filter((detail) => /^SCAN threads\b/.test(detail))).toEqual([]);
      expect(rowCounts).toEqual([2, 1]);
    } finally {
      db.close();
    }
  }), { numRuns: 20 });
});


it.each([86, 87, 999])("backfills links when a v%i profile lacks the indexes", async (version) => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-subthread-group-");
  try {
    const older = StateDb.open(dbPath);
    older.raw.exec("DROP INDEX idx_threads_subthread_id; DROP INDEX idx_threads_subthread_parent");
    older.raw.pragma(`user_version = ${version}`);
    const insert = older.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)");
    insert.run("claude:root", JSON.stringify({ backend: "claude", threadId: "root" }));
    insert.run("acp%3Agrok:legacy", JSON.stringify({ backend: "acp:grok", threadId: "legacy", parentThreadId: "root" }));
    older.close();

    const reader = StateDb.open(dbPath);
    const writer = StateDb.open(dbPath);
    try {
      const store = new SqliteOverlayStore(reader);
      const scopes = () => [...store.readSubthreadGroup("codex", "root").scopes].map(([backend, ids]) => [backend, [...ids]]);
      expect(scopes()).toEqual([["codex", ["root"]], ["claude", ["root"]], ["acp:grok", ["root", "legacy"]]]);
      expect(reader.raw.pragma("user_version", { simple: true })).toBe(Math.max(87, version));
      const move = writer.raw.prepare("UPDATE threads SET payload = json_set(payload, '$.parentThreadId', ?) WHERE thread_id = ?");
      move.run("elsewhere", "acp%3Agrok:legacy");
      expect(scopes()).toEqual([["codex", ["root"]], ["claude", ["root"]]]);
      move.run("root", "acp%3Agrok:legacy");
      expect(scopes()).toContainEqual(["acp:grok", ["root", "legacy"]]);
      writer.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("claude:root");
      expect(scopes()).toEqual([["codex", ["root"]], ["acp:grok", ["root", "legacy"]]]);
    } finally {
      writer.close();
      reader.close();
    }
  } finally {
    removeTempStateDbDir(tempDir);
  }
});
