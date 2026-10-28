import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.restoreAllMocks());

const start = Date.UTC(2026, 9, 27, 15);
const window = { from: start, to: start + 10_000 };

function fixture() {
  const db = openInMemoryStateDb();
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
  const reads: Array<{ sql: string; rows: number; plan: string[] }> = [];
  vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return statement;
    const all = statement.all.bind(statement);
    vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
      const result = all(...args);
      reads.push({ sql, rows: result.length,
        plan: (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
          .map((row) => row.detail),
      });
      return result;
    });
    return statement;
  });
  return reads;
}

describe("Usage Activity read budgets", () => {
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
      expect(second.rows[0].title).toBe("fixture-thread");
      expect(reads).toEqual([]);
      add("new");
      expect((await store.readUsageActivity(window)).rows).toHaveLength(2);
      expect(reads.length).toBeGreaterThan(0);
    } finally { db.close(); }
  });
});
