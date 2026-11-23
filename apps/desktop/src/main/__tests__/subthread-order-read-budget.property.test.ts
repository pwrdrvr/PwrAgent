import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
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
        expect.stringMatching(/^SEARCH threads USING (COVERING )?INDEX idx_threads_subthread_noncanonical_id/),
        expect.stringMatching(/^SEARCH threads USING (COVERING )?INDEX sqlite_autoindex_threads_1/),
      ]));
      expect(plans.filter((detail) => /^SCAN threads\b/.test(detail))).toEqual([]);
      expect(rowCounts).toEqual([2, 1]);
    } finally {
      db.close();
    }
  }), { numRuns: 20 });
});


it.each([86, 87, 999])("converges v%i profiles with missing or obsolete indexes", async (version) => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-subthread-group-");
  try {
    const older = StateDb.open(dbPath);
    if (version !== 87) {
      older.raw.exec("DROP INDEX idx_threads_subthread_noncanonical_id; DROP INDEX idx_threads_subthread_parent");
    } else {
      older.raw.exec(`CREATE INDEX idx_threads_subthread_id
        ON threads(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END);
        CREATE INDEX idx_threads_subthread_nonstandard_id
        ON threads(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END)
        WHERE CASE WHEN json_valid(payload) THEN thread_id NOT IN (
          'codex:' || json_extract(payload, '$.threadId'), 'claude:' || json_extract(payload, '$.threadId')
        ) END;`);
    }
    older.raw.pragma(`user_version = ${version}`);
    const insert = older.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)");
    insert.run("claude:root", JSON.stringify({ backend: "claude", threadId: "root" }));
    insert.run("acp%3Agrok:legacy", JSON.stringify({ backend: "acp:grok", threadId: "legacy", parentThreadId: "root" }));
    // A legacy stored key can disagree with the payload. Match the payload
    // identity for provider admission and for the just-created-child fallback.
    insert.run("claude:stored-alias", JSON.stringify({
      backend: "claude", threadId: "payload-id", parentThreadId: "legacy-parent", parentThreadBackend: "codex",
    }));
    older.close();

    const reader = StateDb.open(dbPath);
    const writer = StateDb.open(dbPath);
    try {
      const store = new SqliteOverlayStore(reader);
      const scopes = () => [...store.readSubthreadGroup("codex", "root").scopes].map(([backend, ids]) => [backend, [...ids]]);
      expect(scopes()).toEqual([["codex", ["root"]], ["claude", ["root"]], ["acp:grok", ["root", "legacy"]]]);
      expect(reader.raw.pragma("user_version", { simple: true })).toBe(Math.max(CURRENT_STATE_DB_USER_VERSION, version));
      const indexes = reader.raw.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'idx_threads_subthread_%' ORDER BY name");
      expect(indexes.pluck().all()).toEqual(["idx_threads_subthread_noncanonical_id", "idx_threads_subthread_parent"]);
      expect([...store.readSubthreadGroup("codex", "payload-id").scopes.keys()]).toEqual(["codex", "claude"]);
      await expect(store.updateSubthreadOrder({ backend: "codex", parentThreadId: "legacy-parent",
        insertAfter: { threadId: "payload-id", sourceThreadId: "legacy-parent" } })).resolves.toEqual(["payload-id"]);
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


it("matches the legacy JSON lookup for NULL keys, aliases, collisions, and malformed payloads", async () => {
  const rowKinds = ["null", "canonical", "alias", "malformed"] as const;
  async function check(kinds: readonly (typeof rowKinds)[number][]) {
    const state = openInMemoryStateDb();
    try {
      const store = new SqliteOverlayStore(state);
      const put = state.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)");
      const fields = { backend: "claude", threadId: "child", parentThreadId: "root", parentThreadBackend: "codex" };
      for (const kind of kinds) {
        if (kind === "malformed") put.run("claude:broken", "{");
        else put.run(kind === "null" ? null : kind === "canonical" ? "claude:child" : "old-alias", JSON.stringify(fields));
      }
      const matches = state.raw.prepare(`SELECT payload FROM threads
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') = ?
          AND json_extract(payload, '$.parentThreadId') = ?
          AND json_extract(payload, '$.parentThreadBackend') = ? END LIMIT 2`).all("child", "root", "codex");
      const legacyScopes = state.raw.prepare(`SELECT DISTINCT json_extract(payload, '$.backend') AS backend FROM threads
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.parentThreadId') = ?
          OR json_extract(payload, '$.threadId') = ? END`).all("root", "root") as { backend: "claude" }[];
      expect([...store.readSubthreadGroup("codex", "root").scopes.keys()])
        .toEqual(["codex", ...legacyScopes.map(({ backend }) => backend)]);
      const insertion = store.updateSubthreadOrder({ backend: "codex", parentThreadId: "root",
        insertAfter: { threadId: "child", sourceThreadId: "root" } });
      if (matches.length === 1) await expect(insertion).resolves.toEqual(["child"]);
      else await expect(insertion).rejects.toThrow("no longer places");
    } finally {
      state.close();
    }
  }
  await check(["null"]);
  await check(["null", "canonical", "malformed"]);
  await fc.assert(fc.asyncProperty(fc.subarray([...rowKinds]), check), { numRuns: 25 });
});
