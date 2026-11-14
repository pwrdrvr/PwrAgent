import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AppServerBackendKind, AppServerThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { searchUsageInsert, seedSearchUsage } from "./helpers/thread-search-fixture";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const summary = (id: string, source: AppServerBackendKind = "codex", archived = false): AppServerThreadSummary => ({
  id, source, title: `Needle ${id}`, titleSource: "explicit", linkedDirectories: [],
  updatedAt: 100, ...(archived ? { archivedAt: 200 } : {}),
});
afterEach(() => vi.unstubAllEnvs());

it("uses each request's inventory as an oracle without deleting omitted provider rows", async () => {
  const db = openInMemoryStateDb();
  try {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        backend: fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:gemini"),
        archived: fc.boolean(), present: fc.boolean(),
      }), { minLength: 1, maxLength: 25, size: "max" }),
      fc.boolean(), fc.constantFrom<AppServerBackendKind | undefined>(undefined, "codex", "acp:gemini"),
      async (rows, includeArchived, backend) => {
        db.raw.exec("DELETE FROM thread_search_documents; DELETE FROM thread_search_fts");
        const store = new ThreadSearchStore(db);
        const all = rows.map((row, i) => summary(`session:α%/${i}`, row.backend, row.archived));
        store.upsertThreads(all);
        const inventory = all.filter((thread, i) => rows[i].present && (!backend || thread.source === backend));
        const service = new ThreadSearchService(store, async ({ archived }) => inventory.filter((t) => Boolean(t.archivedAt) === Boolean(archived)));
        const result = await service.search({ query: "Needle", filters: { backend, includeArchived }, limit: 100 });
        expect(result.results.map((r) => r.identityKey).sort()).toEqual(inventory
          .filter((t) => includeArchived || !t.archivedAt).map((t) => buildThreadIdentityKey(t.source, t.id)).sort());
        // The lister carries no proof of completeness. Omission must not erase
        // titles or other partitions, even when that request includes archives.
        expect(db.raw.prepare("SELECT count(*) FROM thread_search_documents").pluck().get()).toBe(all.length);
      },
    ), { numRuns: 30 });
  } finally { db.close(); }
});

it("budgets deletion maintenance as at most 64 identities and one commit per slice", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("search-prune-budget-");
  const db = StateDb.open(temp.dbPath);
  try {
    const store = new ThreadSearchStore(db);
    store.upsertThreads(Array.from({ length: 200 }, (_, i) => summary(`stale-${i}`)));
    const prepare = vi.spyOn(db.raw, "prepare");
    const { writes } = await measureSqliteWrites(() => store.pruneMissingThreads({ includeArchived: true, retainedIdentityKeys: [] }));
    expect(prepare.mock.calls.length).toBe(321);
    prepare.mockRestore();
    expect(db.raw.prepare("SELECT count(*) FROM thread_search_documents").pluck().get()).toBe(136);
    expect(writes.commits).toBe(1);
    expectSqliteWriteBudget({ scenario: "thread-search-prune-slice", writes,
      note: "One explicit 64-identity cleanup slice; no search or timer schedules this. ~95 KB WAL/slice; at 10 explicit slices/day projects ~0.948 MB/day (1/8640 slices/s × 94760 bytes × 86400 s); 0 MB/day idle." });
  } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
});

it.each([100, 1000])("keeps repeated searches independent of %i omitted index/ledger rows", async (n) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("search-repeat-budget-");
  const db = StateDb.open(temp.dbPath);
  try {
    const store = new ThreadSearchStore(db);
    store.upsertThreads(Array.from({ length: n }, (_, i) => summary(`omitted-${i}`)));
    seedSearchUsage(db, n);
    const current = summary("current");
    store.upsertThread(current);
    const service = new ThreadSearchService(store, async () => [current]);
    const prune = vi.spyOn(store, "pruneMissingThreads");
    const prepare = vi.spyOn(db.raw, "prepare");
    const { writes } = await measureSqliteWrites(async () => {
      for (let i = 0; i < 10; i++) {
        expect((await service.search({ query: "Needle", limit: 1, contentMode: "metadata" })).results.map((r) => r.threadId)).toEqual(["current"]);
      }
    });
    expect(prune).not.toHaveBeenCalled();
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(20);
    expect(writes.commits).toBe(0);
    expectSqliteWriteBudget({ scenario: "thread-search-repeat-unchanged", writes,
      note: "Ten unchanged searches with omitted provider rows: zero commits and zero WAL; 0 MB/day at any search frequency." });
  } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
});

it("yields and honors cancellation before indexing another 64-provider-row slice", async () => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    const controller = new AbortController();
    const inventory = Array.from({ length: 200 }, (_, i) => summary(`current-${i}`));
    const upsert = store.upsertThreads.bind(store);
    const batches: number[] = [];
    vi.spyOn(store, "upsertThreads").mockImplementation((threads) => {
      batches.push(threads.length);
      upsert(threads);
      setImmediate(() => controller.abort());
    });
    const service = new ThreadSearchService(store, async () => inventory);
    const prepare = vi.spyOn(db.raw, "prepare");
    await expect(service.search({ contentMode: "metadata" }, controller.signal)).rejects.toThrow();
    expect(batches).toEqual([64]);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(448);
  } finally { db.close(); }
});

it("models FTS key stability through replacement, deletion and rowid reuse", () => {
  const db = openInMemoryStateDb();
  try {
    fc.assert(fc.property(fc.array(fc.record({
      id: fc.integer({ min: 0, max: 6 }), remove: fc.boolean(), legacy: fc.boolean(),
      backend: fc.constantFrom<AppServerBackendKind>("codex", "acp:gemini"),
    }), { minLength: 1, maxLength: 40, size: "max" }), (ops) => {
      const store = new ThreadSearchStore(db);
      db.raw.exec("DELETE FROM thread_search_documents; DELETE FROM thread_search_fts; DELETE FROM thread_search_fts_rows");
      const model = new Map<string, { thread: AppServerThreadSummary; rowid: number }>();
      for (const [i, op] of ops.entries()) {
        const thread = { ...summary(`id:α%/${op.id}`, op.backend), title: `Needle revision ${i}` };
        const key = buildThreadIdentityKey(thread.source, thread.id);
        if (op.remove) {
          store.deleteThread({ backend: op.backend, threadId: thread.id });
          model.delete(key);
        } else {
          const previous = model.get(key);
          store.upsertThread(thread);
          if (op.legacy) {
            // The v81 writer replaces tokens without updating the new mapping.
            db.raw.prepare("DELETE FROM thread_search_fts WHERE identity_key = ?").run(
              db.raw.prepare("SELECT identity_key FROM thread_search_documents WHERE backend = ? AND thread_id = ?").pluck().get(thread.source, thread.id));
            db.raw.prepare(`INSERT INTO thread_search_fts (identity_key, title, backend, thread_id)
              SELECT identity_key, title, backend, thread_id FROM thread_search_documents WHERE backend = ? AND thread_id = ?`).run(thread.source, thread.id);
            store.upsertThread(thread);
          }
          const rowid = db.raw.prepare("SELECT rowid FROM thread_search_fts WHERE title = ?").pluck().get(thread.title) as number;
          if (previous && !op.legacy) expect(rowid).toBe(previous.rowid);
          model.set(key, { thread, rowid });
        }
        const actual = store.search({ query: "Needle", includeArchived: true, limit: 100 });
        expect(actual.map((r) => [r.identityKey, r.title]).sort()).toEqual([...model].map(([key, v]) => [key, v.thread.title]).sort());
        expect(db.raw.prepare("SELECT count(*) FROM thread_search_fts").pluck().get()).toBe(model.size);
        expect(db.raw.prepare("SELECT count(*) FROM thread_search_fts_rows").pluck().get()).toBe(model.size);
      }
    }), { numRuns: 25 });
    db.raw.exec("VACUUM");
    expect(db.raw.prepare(`SELECT count(*) FROM thread_search_fts_rows k
      JOIN thread_search_fts f ON f.rowid = k.fts_rowid WHERE f.identity_key != k.identity_key`).pluck().get()).toBe(0);
  } finally { db.close(); }
});

it("retains a title iff any provider/status has direct or automation-execution usage", () => {
  const db = openInMemoryStateDb();
  try {
    seedSearchUsage(db, 1);
    const store = new ThreadSearchStore(db);
    fc.assert(fc.property(fc.record({
      backend: fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:gemini"),
      provider: fc.constantFrom("openai", "anthropic", "future-provider"),
      superseded: fc.boolean(), execution: fc.boolean(), hasUsage: fc.boolean(),
    }), ({ backend, provider, superseded, execution, hasUsage }) => {
      db.raw.prepare("DELETE FROM thread_usage_titles").run();
      db.raw.prepare("UPDATE thread_usage_lines SET backend = ?, provider = ?, thread_id = ?, status = ?").run(
        backend, provider, hasUsage ? "target" : "unrelated", superseded ? "superseded" : "finalized");
      db.raw.prepare("UPDATE automation_runs SET backend = ?, thread_id = ?, payload = ?").run(
        backend, execution ? "target" : "unrelated-owner", JSON.stringify({ backendThreadId: "target" }));
      store.upsertThread(summary("target", backend));
      store.deleteThread({ backend, threadId: "target" });
      expect(db.raw.prepare("SELECT title FROM thread_usage_titles").pluck().all()).toEqual(hasUsage ? ["Needle target"] : []);
      // Execution-owner title follows usage on a distinct execution thread.
      db.raw.prepare("UPDATE thread_usage_lines SET thread_id = ?").run(hasUsage ? "execution" : "unrelated");
      db.raw.prepare("UPDATE automation_runs SET payload = ?").run(JSON.stringify({ backendThreadId: "execution" }));
      db.raw.prepare("DELETE FROM thread_usage_titles").run();
      store.upsertThread(summary("target", backend));
      store.deleteThread({ backend, threadId: "target" });
      expect(db.raw.prepare("SELECT title FROM thread_usage_titles").pluck().all()).toEqual(hasUsage && execution ? ["Needle target"] : []);
    }), { numRuns: 30 });
  } finally { db.close(); }
});

it("upgrades v81 FTS keys without rebuilding rows and keeps them valid after reopen/VACUUM", () => {
  const temp = createTempStateDb("search-keys-migration-");
  let db = StateDb.open(temp.dbPath);
  try {
    const store = new ThreadSearchStore(db);
    store.upsertThreads([summary("one"), summary("two", "acp:gemini")]);
    const before = db.raw.prepare("SELECT rowid, * FROM thread_search_fts ORDER BY rowid").all();
    db.raw.exec("DROP TABLE thread_search_fts_rows; DROP INDEX idx_thread_usage_lines_identity; PRAGMA user_version = 81");
    db.close();
    db = StateDb.open(temp.dbPath);
    expect(db.raw.prepare("SELECT rowid, * FROM thread_search_fts ORDER BY rowid").all()).toEqual(before);
    const mapping = db.raw.prepare("SELECT * FROM thread_search_fts_rows ORDER BY fts_rowid").all();
    db.raw.exec("VACUUM");
    db.close();
    db = StateDb.open(temp.dbPath);
    expect(db.raw.prepare("SELECT * FROM thread_search_fts_rows ORDER BY fts_rowid").all()).toEqual(mapping);
    new ThreadSearchStore(db).deleteThread({ backend: "acp:gemini", threadId: "two" });
    expect(new ThreadSearchStore(db).search({ query: "Needle", limit: 10 }).map((r) => r.threadId)).toEqual(["one"]);
  } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
});

it("budgets usage-index insertion and bounded cold indexing without adding idle commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("search-write-cost-");
  const db = StateDb.open(temp.dbPath);
  try {
    const insert = searchUsageInsert(db);
    const { writes: ledger } = await measureSqliteWrites(() => insert.run({ id: "line", provider: "openai",
      backend: "codex", thread: "usage", status: "superseded" }));
    if (process.env.THREAD_SEARCH_BENCHMARK) console.log(JSON.stringify({ usageIndexWrites: ledger }));
    expectSqliteWriteBudget({ scenario: "thread-search-usage-identity-index", writes: ledger,
      note: "One existing usage-line insert including the new all-status identity index. Same one commit; 28,872 bytes versus 24,752 before. At 1,000 individual inserts/day: 28.872 MB/day total, +4.120 MB/day for the index; 0 MB/day idle." });
    const store = new ThreadSearchStore(db);
    const inventory = Array.from({ length: 200 }, (_, i) => summary(`current-${i}`));
    const service = new ThreadSearchService(store, async () => inventory);
    const { writes } = await measureSqliteWrites(() => service.search({ contentMode: "metadata" }));
    expect(writes.commits).toBe(4);
    expectSqliteWriteBudget({ scenario: "thread-search-cold-sliced-index", writes,
      note: "200 changed projections in four 64-row-or-smaller transactions, yielding between them. Finite inventory-change work; unchanged searches and idle add 0 MB/day. 321,360 bytes per cold 200-row inventory; 10 such inventories/day projects 3.214 MB/day (10/86400 × 321360 × 86400)." });
  } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
});

it("models bounded cleanup as a subset of omissions in the selected backend/archive partition", () => {
  const db = openInMemoryStateDb();
  try {
    fc.assert(fc.property(fc.array(fc.record({
      backend: fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:gemini"),
      archived: fc.boolean(), retained: fc.boolean(),
    }), { minLength: 65, maxLength: 150, size: "max" }), fc.boolean(),
    fc.constantFrom<AppServerBackendKind | undefined>(undefined, "codex", "acp:gemini"), (rows, includeArchived, backend) => {
      db.raw.exec("DELETE FROM thread_search_documents; DELETE FROM thread_search_fts; DELETE FROM thread_search_fts_rows");
      const store = new ThreadSearchStore(db);
      const all = rows.map((r, i) => summary(`id:${i}%α`, r.backend, r.archived));
      store.upsertThreads(all);
      const retainedIdentityKeys = all.filter((_, i) => rows[i].retained).map((t) => buildThreadIdentityKey(t.source, t.id));
      const survivors = all.filter((t, i) => rows[i].retained || (backend && t.source !== backend) || (!includeArchived && t.archivedAt));
      let previous = all.length;
      for (let i = 0; i < Math.ceil(all.length / 64); i++) {
        store.pruneMissingThreads({ backend, includeArchived, retainedIdentityKeys });
        const current = store.search({ includeArchived: true, limit: 1000 });
        expect(previous - current.length).toBeLessThanOrEqual(64);
        expect(current.map((r) => r.identityKey)).toEqual(expect.arrayContaining(survivors.map((t) => buildThreadIdentityKey(t.source, t.id))));
        previous = current.length;
      }
      expect(store.search({ includeArchived: true, limit: 1000 }).map((r) => r.identityKey).sort()).toEqual(survivors.map((t) => buildThreadIdentityKey(t.source, t.id)).sort());
    }), { numRuns: 25 });
  } finally { db.close(); }
});

it("never deletes another identity when a legacy writer reuses its mapped FTS rowid", () => {
  const db = openInMemoryStateDb();
  try {
    const store = new ThreadSearchStore(db);
    store.upsertThreads([summary("one"), summary("two"), summary("three")]);
    db.raw.prepare("DELETE FROM thread_search_fts WHERE identity_key IN (?, ?)").run("codex:two", "codex:three");
    db.raw.prepare("INSERT INTO thread_search_fts (rowid, identity_key, title) VALUES (3, 'codex:two', 'Needle two')").run();
    store.deleteThread({ backend: "codex", threadId: "three" });
    expect(store.search({ query: "Needle", limit: 10 }).map((r) => r.threadId).sort()).toEqual(["one", "two"]);
    store.upsertThread(summary("two"));
    expect(store.search({ query: "Needle", identityKeys: ["codex:two"], limit: 10 }).map((r) => r.threadId)).toEqual(["two"]);
  } finally { db.close(); }
});

it.each([0, 1, 63, 64, 65, 200])("budgets a sweep of 1,000 documents/ledger rows with %i stale identities", async (m) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("search-sweep-budget-");
  const db = StateDb.open(temp.dbPath);
  try {
    const store = new ThreadSearchStore(db);
    const threads = Array.from({ length: 1000 }, (_, i) => summary(`id-${String(i).padStart(5, "0")}`));
    store.upsertThreads(threads);
    seedSearchUsage(db, 1000);
    const retainedIdentityKeys = threads.slice(m).map((t) => buildThreadIdentityKey(t.source, t.id));
    const { writes } = await measureSqliteWrites(() => {
      for (let i = 0; i < Math.ceil(1000 / 64); i++) store.pruneMissingThreads({ includeArchived: true, retainedIdentityKeys });
    });
    expect(writes.commits).toBe(Math.ceil(m / 64));
    expect(writes.statements).toBe(4 * m);
    expect(db.raw.prepare("SELECT count(*) FROM thread_search_documents").pluck().get()).toBe(1000 - m);
  } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
});
