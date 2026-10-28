import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { buildLegacyEncodedThreadIdentityKey } from "@pwragent/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const start = Date.UTC(2026, 9, 27, 15);
const window = { from: start, to: start + 10_000 };

function fixture(db = openInMemoryStateDb()) {
  const store = new SqliteOverlayStore(db);
  const insert = db.raw.prepare(`INSERT INTO thread_usage_lines
    (usage_line_id, backend, thread_id, parent_thread_id, provider, source, source_item_id,
     scope, status, created_at, completed_at, updated_at, input_tokens, cached_input_tokens,
     uncached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
     price_status, currency, uncached_input_cost_micros, cached_input_cost_micros,
     output_cost_micros, total_cost_micros)
    VALUES (@id, @backend, @thread, @parent, 'openai', 'live', @source,
      @scope, @status, @created, @completed, @updated, 10, 2, 8, 3, 1, 13,
      'priced', 'USD', 8, 2, 3, 13)`);
  const add = (id: string, overrides: Record<string, unknown> = {}) => insert.run({
    id, backend: "codex", thread: "fixture-thread", parent: null, source: id,
    scope: "turn", status: "pending", created: start + 1000,
    completed: start + 2000, updated: start + 2000, ...overrides,
  });
  return { db, store, add };
}

/** Count actual sqlite -> JS rows, rather than the response's already bounded rows. */
function observe(db: ReturnType<typeof openInMemoryStateDb>) {
  const prepare = db.raw.prepare.bind(db.raw);
  const reads: Array<{ sql: string; args: unknown[]; rows: number; plan: string[] }> = [];
  vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return statement;
    const all = statement.all.bind(statement);
    vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
      const result = all(...args);
      reads.push({ sql, args, rows: result.length,
        plan: (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
          .map((row) => row.detail),
      });
      return result;
    });
    return statement;
  });
  return reads;
}

/** Optional contrived-only artifacts for scripts/measure-usage-activity-queries.py. */
async function report(name: string, db: ReturnType<typeof openInMemoryStateDb>, reads: ReturnType<typeof observe>) {
  const directory = process.env.PWRAGENT_USAGE_QUERY_REPORT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await db.raw.backup(path.join(directory, `${name}.db`));
  writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(reads, null, 2));
}

describe("Usage Activity read budgets", () => {
  it("keeps backend identity and account groups separate and aggregates every cost component", async () => {
    const { db, store, add } = fixture();
    try {
      db.raw.transaction(() => {
        for (const backend of ["codex", "acp:qwen"]) {
          for (let index = 0; index < 3; index++) add(`${backend}-${index}`, {
            backend, parent: "same-parent", thread: "same-helper", scope: "monitor", status: "finalized",
            source: `system:title:${index}`, completed: null,
          });
          db.raw.prepare(`INSERT INTO thread_search_documents
            (identity_key, backend, thread_id, title, linked_directories_json, display_json, indexed_at)
            VALUES (?, ?, 'same-parent', ?, '[]', '{}', ?)`)
            .run(buildLegacyEncodedThreadIdentityKey(backend, "same-parent"), backend, `${backend} title`, start);
        }
        db.raw.prepare("UPDATE thread_usage_lines SET account_key = 'other' WHERE usage_line_id = 'codex-2'").run();
        db.raw.prepare("UPDATE thread_usage_lines SET cache_write_input_tokens = 5, cache_write_input_cost_micros = 7").run();
      })();
      const { rows } = await store.readUsageActivity(window);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.line.usageLineId)).size).toBe(3);
      expect(rows.map((row) => [row.line.backend, row.title, row.rollup?.count, row.line.cacheWriteInputTokens,
        row.line.cacheWriteInputCostMicros]).sort()).toEqual([
        ["acp:qwen", "acp:qwen title", 3, 15, 21],
        ["codex", "codex title", 1, 5, 7],
        ["codex", "codex title", 2, 10, 14],
      ]);
    } finally { db.close(); }
  });

  it("retains exact overlap and order at sub-minute boundaries despite coarse admission", async () => {
    const { db, store, add } = fixture();
    try {
      add("at-end", { created: window.to, completed: window.to });
      add("completed-at-start", { created: start - 1, completed: start, updated: start + 5 });
      add("before-start", { created: start - 2, completed: start - 1 });
      add("live-at-start", { created: start - 1, completed: null, updated: start });
      add("stale-live", { created: start - 1, completed: null, updated: start - 1 });
      add("helper-at-end", { created: start - 1, completed: window.to, scope: "monitor",
        status: "finalized", source: "system:title:boundary", updated: start + 5 });
      const snapshot = await store.readUsageActivity(window);
      expect(snapshot.rows.map((row) => row.line.usageLineId))
        .toEqual(["completed-at-start", "helper-at-end", "live-at-start"]);
      expect(snapshot.rows.every((row) => !row.rollup)).toBe(true);
    } finally { db.close(); }
  });

  it("invalidates admitted reads for other connections and never caches an uncommitted view", async () => {
    const temp = createTempStateDb("pwragent-activity-external-");
    const { db, store, add } = fixture(StateDb.open(temp.dbPath));
    const other = StateDb.open(temp.dbPath);
    try {
      add("current");
      expect((await store.readUsageActivity(window)).rows[0].title).toBe("fixture-thread");
      other.raw.prepare(`INSERT INTO thread_usage_titles(identity_key, title) VALUES (?, 'External title')`)
        .run(buildLegacyEncodedThreadIdentityKey("codex", "fixture-thread"));
      expect((await store.readUsageActivity(window)).rows[0].title).toBe("External title");
      let uncommitted: ReturnType<typeof store.readUsageActivity> | undefined;
      expect(() => db.raw.transaction(() => {
        add("uncommitted");
        uncommitted = store.readUsageActivity(window);
        throw new Error("rollback");
      })()).toThrow("rollback");
      expect((await uncommitted)?.rows).toHaveLength(2);
      expect((await store.readUsageActivity(window)).rows).toHaveLength(1);
      other.raw.prepare("UPDATE thread_usage_lines SET completed_at = ? WHERE usage_line_id = 'current'").run(start - 1);
      expect((await store.readUsageActivity(window)).rows).toHaveLength(0);
    } finally { other.close(); db.close(); removeTempStateDbDir(temp.tempDir); }
  });

  it.each(["within-minute", "minute-boundaries"])("measures interval maintenance for live updates: %s", async (scenario) => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-activity-budget-");
    const { db, store, add } = fixture(StateDb.open(temp.dbPath));
    try {
      db.raw.pragma("wal_autocheckpoint = 0");
      add("live-budget", { created: start, completed: null, updated: start });
      const update = db.raw.prepare("UPDATE thread_usage_lines SET updated_at = ?, output_tokens = ? WHERE usage_line_id = 'live-budget'");
      const { writes } = await measureSqliteWrites(() => {
        for (let index = 1; index <= 100; index++) {
          update.run(start + index * (scenario === "within-minute" ? 100 : 60_000), index);
        }
      });
      expectSqliteWriteBudget({ scenario: `usage-activity-index-${scenario}`, writes,
        note: "100 existing live-row commits; minute-wide interval coordinates avoid tree maintenance within a minute; no timer or added commit" });
      const read = await measureSqliteWrites(async () => {
        await store.readUsageActivity(window);
        await store.readUsageActivity(window);
      });
      expect(read.writes.commits).toBe(0);
      expect(read.writes.walBytes).toBe(0);
    } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
  });

  it.each([1_000, 20_000])("seeks a narrow interval across %i past and future rows", async (count) => {
    const { db, store, add } = fixture();
    try {
      db.raw.transaction(() => {
        for (let index = 0; index < count; index++) {
          const time = start + (index % 2 ? 1 : -1) * (index + 10) * 60_000;
          add(`history-${index}`, { created: time, completed: time + 1000, updated: time + 1000 });
        }
        add("contained");
        add("live", { created: start - 86400000, completed: null, updated: start + 3000 });
        add("stale-live", { created: start - 86400000, completed: null, updated: start - 60_000 });
        add("spanning", { created: start - 86400000, completed: start + 86400000 });
      })();
      const reads = observe(db);
      const snapshot = await store.readUsageActivity(window);
      await report(`history-${count}`, db, reads);
      expect(snapshot.rows.map((row) => row.line.usageLineId).sort()).toEqual(["contained", "live", "spanning"]);
      const ledger = reads.filter((read) => /thread_usage_lines/.test(read.sql));
      expect(ledger.length).toBeGreaterThan(0);
      expect(ledger.flatMap((read) => read.plan).filter((plan) => /SCAN (l|t)\b/.test(plan))).toEqual([]);
      expect(ledger.reduce((sum, read) => sum + read.rows, 0)).toBeLessThanOrEqual(4);
      expect(reads.length).toBeLessThanOrEqual(8);
    } finally { db.close(); }
  });

  it("materializes groups for 6000 rollup-only monitors without spending the turn limit", async () => {
    const { db, store, add } = fixture();
    try {
      db.raw.transaction(() => {
        for (let index = 0; index < 6000; index++) add(`monitor-${index}`, {
          thread: `helper-${index}`, parent: "fixture-thread", source: `system:title:${index}`,
          scope: "monitor", status: "finalized", created: start + 1000, completed: null,
        });
      })();
      const reads = observe(db);
      const snapshot = await store.readUsageActivity(window);
      await report("monitors-6000", db, reads);
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.rows).toHaveLength(1);
      expect(snapshot.rows[0]).toMatchObject({ rollup: { count: 6000 },
        line: { totalTokens: 78_000, totalCostMicros: 78_000, threadId: "fixture-thread" } });
      expect(reads.filter((read) => /thread_usage_lines/.test(read.sql))
        .reduce((sum, read) => sum + read.rows, 0)).toBeLessThanOrEqual(2);
    } finally { db.close(); }
  });

  it("admits unchanged refreshes without ledger or title materialization and returns independent rows", async () => {
    const { db, store, add } = fixture();
    try {
      add("current");
      const first = await store.readUsageActivity(window);
      first.rows[0].title = "caller decoration";
      const reads = observe(db);
      const second = await store.readUsageActivity(window);
      await report("unchanged", db, reads);
      expect(second.rows[0].title).toBe("fixture-thread");
      expect(reads).toEqual([]);
      add("new");
      expect((await store.readUsageActivity(window)).rows).toHaveLength(2);
      expect(reads.length).toBeGreaterThan(0);
    } finally { db.close(); }
  });
});
