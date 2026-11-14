import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it.each([false, true].flatMap((legacyFts) => [false, true].map((newer) => ({ legacyFts, newer }))))(
  "converges partial profiles, then indexes/deletes (legacy FTS: $legacyFts, newer version: $newer)",
  async ({ legacyFts, newer }) => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
      const temp = createTempStateDb("search-schema-repair-");
      let db = StateDb.open(temp.dbPath);
      try {
        let store = new ThreadSearchStore(db);
        const threads = Array.from({ length: n }, (_, i) => ({ id: `thread-${i}`, source: "codex" as const,
          title: `Needle ${i}`, titleSource: "explicit" as const, linkedDirectories: [] }));
        store.upsertThreads(threads);
        store.deleteThread({ backend: "codex", threadId: "thread-0" });
        if (legacyFts) {
          // Keep the old mapping with sparse rowids while rebuilding old-format
          // FTS. Convergence must replace the invalidated mapping atomically.
          db.raw.exec(`DROP TABLE thread_search_fts;
            CREATE VIRTUAL TABLE thread_search_fts USING fts5(
              identity_key UNINDEXED, title, summary, project_key, directory_labels,
              directory_paths, git_branch, git_origin_url, model, backend
            )`);
        } else {
          db.raw.exec("DROP TABLE thread_search_fts_rows");
        }
        db.raw.exec("DROP INDEX idx_thread_usage_lines_identity");
        const version = CURRENT_STATE_DB_USER_VERSION + Number(newer);
        db.raw.pragma(`user_version = ${version}`);
        db.close();
        db = StateDb.open(temp.dbPath);
        store = new ThreadSearchStore(db);
        expect(db.raw.pragma("user_version", { simple: true })).toBe(version);
        const mapping = db.raw.prepare("SELECT fts_rowid AS rowid, identity_key FROM thread_search_fts_rows ORDER BY identity_key").all();
        expect(mapping).toEqual(db.raw.prepare("SELECT rowid, identity_key FROM thread_search_fts ORDER BY identity_key").all());
        expect(db.raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_thread_usage_lines_identity'").get()).toBeDefined();
        store.upsertThreads(threads.slice(1));
        store.upsertThread({ ...threads[1], title: "Updated Needle" });
        expect(store.search({ query: "Updated", identityKeys: ["codex:thread-1"], limit: 10 }).map((r) => r.threadId)).toEqual(["thread-1"]);
        store.deleteThread({ backend: "codex", threadId: "thread-1" });
        expect(store.search({ query: "Updated", identityKeys: ["codex:thread-1"], limit: 10 })).toEqual([]);
        db.close();
        const reopened = await measureSqliteWrites(() => StateDb.open(temp.dbPath));
        db = reopened.result;
        expect(reopened.writes.commits).toBe(0);
        expect(reopened.writes.statements).toBe(0);
        expect(reopened.writes.walBytes).toBe(0);
      } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
    }), { numRuns: 8 });
  },
);
