import { OPENROUTER_ASSUMED_PRICING_CATALOG_ID } from "@pwragent/shared/openrouter-assumed-pricing";
import type { ThreadPricingSummary } from "@pwragent/shared/token-usage-pricing";
import { expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const root = { backend: "codex", threadId: "root" } as const;
const assumed = OPENROUTER_ASSUMED_PRICING_CATALOG_ID;

function pricingFixture(db: ReturnType<typeof openInMemoryStateDb>, unrelated: number, sameThread: number) {
  db.raw.transaction(() => {
    const insert = db.raw.prepare(`INSERT INTO thread_usage_lines (
      usage_line_id, backend, thread_id, parent_thread_id, provider, currency, pricing_catalog_id,
      source, scope, status, price_status, created_at, updated_at,
      input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens, reasoning_output_tokens,
      total_tokens, uncached_input_cost_micros, cached_input_cost_micros, output_cost_micros, total_cost_micros
    ) VALUES (@id, @backend, @thread, @parent, @provider, @currency, @catalog, 'hydration', 'turn',
      @status, @priceStatus, 1, 1, 10, 0, 10, 2, 0, 12,
      CASE WHEN @priceStatus = 'priced' THEN 5 ELSE 0 END, 0,
      CASE WHEN @priceStatus = 'priced' THEN 2 ELSE 0 END,
      CASE WHEN @priceStatus = 'priced' THEN 7 ELSE 0 END)`);
    const add = (id: string, fields: Partial<{
      backend: string; thread: string; parent: string | null; provider: string; currency: string;
      catalog: string; status: string; priceStatus: string;
    }> = {}) => insert.run({
      id, backend: "codex", thread: "root", parent: null, provider: "custom-provider",
      currency: "EUR", catalog: "metered", status: "finalized", priceStatus: "priced", ...fields,
    });
    add("root-assumed", { currency: "USD", catalog: assumed });
    add("child-assumed", { thread: "worker", parent: "root", provider: "other-provider", currency: "USD", catalog: assumed });
    add("root-metered", { parent: "root" });
    add("child-metered", { thread: "worker", parent: "root" });
    add("unrelated-assumed", { thread: "outside", parent: "outside-root", catalog: assumed });
    add("other-backend", { backend: "claude", catalog: assumed });
    add("superseded-assumed", { thread: "worker", parent: "root", catalog: assumed, status: "superseded" });
    add("unpriced-assumed", { catalog: assumed, priceStatus: "unpriced" });
    for (let i = 0; i < unrelated; i++) {
      const id = `outside-${i}`;
      add(id, { thread: id });
    }
    for (let i = 0; i < sameThread; i++) {
      const direct = i % 2 === 0;
      add(`history-${i}`, direct ? {} : { thread: "worker", parent: "root" });
    }
    // Store the running totals represented by the persisted, non-superseded lines.
    db.raw.exec(`INSERT INTO thread_pricing_summaries (
      provider, backend, thread_id, currency, usage_line_count, priced_usage_line_count,
      unpriced_usage_line_count, input_tokens, cached_input_tokens, uncached_input_tokens,
      output_tokens, reasoning_output_tokens, total_tokens, total_cost_micros, updated_at
    )
    SELECT provider, backend, coalesce(parent_thread_id, thread_id), currency,
      count(*), sum(price_status = 'priced'), sum(price_status != 'priced'), sum(input_tokens), 0, sum(uncached_input_tokens),
      sum(output_tokens), 0, sum(total_tokens), sum(total_cost_micros), 1
    FROM thread_usage_lines WHERE status != 'superseded'
    GROUP BY provider, backend, coalesce(parent_thread_id, thread_id), currency`);
  })();
}

function observeReads(db: ReturnType<typeof openInMemoryStateDb>) {
  const summaryPlans: string[] = [];
  const prepare = db.raw.prepare.bind(db.raw);
  const spy = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (statement.reader && /\bFROM thread_pricing_summaries\b/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = (...bindings: unknown[]) => {
        const result = all(...bindings);
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>;
        summaryPlans.push(plan.map(({ detail }) => detail).join("\n"));
        return result;
      };
    }
    return statement;
  });
  return { summaryPlans, restore: () => spy.mockRestore() };
}

function totals(summaries: ThreadPricingSummary[]) {
  return summaries.map(({ backend, threadId, provider, currency, usageLineCount, unpricedUsageLineCount,
    totalTokens, totalCostMicros, hasAssumedPricing }) =>
    [backend, threadId, provider, currency, usageLineCount, unpricedUsageLineCount, totalTokens, totalCostMicros, hasAssumedPricing]);
}

function expectSummarySeek(plan: string) {
  // A skip-scan still visits unrelated providers. Seek the thread's backend
  // and ID as the leading keys regardless of planner statistics.
  expect.soft(plan).toMatch(/SEARCH (?:summary|thread_pricing_summaries) USING .*\(backend=\? AND thread_id=\?\)/);
}

it.each(
  [false, true].flatMap((analyzed) =>
    ([[1_000, 0], [2_000, 0], [50_000, 0], [1_000, 50_000]] as const).map(([unrelated, sameThread]) =>
      ({ analyzed, unrelated, sameThread }))),
)("bounds pricing reads with $unrelated unrelated and $sameThread family rows (ANALYZE=$analyzed)",
  async ({ analyzed, unrelated, sameThread }) => {
    const db = openInMemoryStateDb();
    try {
      pricingFixture(db, unrelated, sameThread);
      if (analyzed) db.raw.exec("ANALYZE");
      const store = new SqliteOverlayStore(db);
      const observation = observeReads(db);
      try {
        const metered = ["codex", "root", "custom-provider", "EUR", 3 + sameThread, 1, 36 + 12 * sameThread, 14 + 7 * sameThread];
        const direct = ["codex", "root", "custom-provider", "USD", 1, 0, 12, 7];
        const child = ["codex", "root", "other-provider", "USD", 1, 0, 12, 7];
        if (sameThread === 0) {
          const ledger = await store.readThreadPricing(root);
          expect(ledger.lines.map(({ usageLineId }) => usageLineId)).toEqual([
            "unpriced-assumed", "root-metered", "root-assumed", "child-metered", "child-assumed",
          ]);
          expect(totals(ledger.summaries)).toEqual([
            [...metered, undefined], [...direct, undefined], [...child, undefined],
          ]);
          expect(observation.summaryPlans).toHaveLength(1);
          expectSummarySeek(observation.summaryPlans[0]!);
          observation.summaryPlans.length = 0;
        }
        const summaries = await store.readThreadPricingSummaries([root]);
        expect(totals(summaries)).toEqual([[...metered, undefined], [...direct, true], [...child, true]]);
        expect(observation.summaryPlans).toHaveLength(1);
        const [plan] = observation.summaryPlans;
        expectSummarySeek(plan!);
        // Each family's missing match must be decided by two seeks into the
        // assumed-price subset. Seeking all lines for the family is still a
        // scan of its full history when there is no assumed-price match.
        expect.soft(plan).toMatch(/SEARCH .* USING .*idx_thread_usage_lines_assumed_thread \(backend=\? AND thread_id=\? AND provider=\? AND currency=\?\)/);
        expect.soft(plan).toMatch(/SEARCH .* USING .*idx_thread_usage_lines_assumed_parent \(backend=\? AND parent_thread_id=\? AND provider=\? AND currency=\?\)/);
      } finally {
        observation.restore();
      }
    } finally {
      db.close();
    }
  },
);

it("reopens an existing ledger with the new indexes and reads it without a write commit", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-pricing-read-indexes-");
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    const schema = StateDb.open(dbPath);
    let before: ThreadPricingSummary[];
    try {
      pricingFixture(schema, 0, 0);
      before = await new SqliteOverlayStore(schema).readThreadPricingSummaries([root]);
      schema.raw.exec(`DROP INDEX idx_thread_pricing_summaries_thread;
        DROP INDEX idx_thread_usage_lines_assumed_thread;
        DROP INDEX idx_thread_usage_lines_assumed_parent`);
    } finally {
      schema.close();
    }
    const reopened = StateDb.open(dbPath);
    try {
      const store = new SqliteOverlayStore(reopened);
      const { result, writes } = await measureSqliteWrites(async () => ({
        pricing: await store.readThreadPricing(root),
        summaries: await store.readThreadPricingSummaries([root]),
      }));
      expect(result.summaries).toEqual(before);
      expect(result.pricing.summaries).toEqual(before.map(({ hasAssumedPricing: _assumed, ...summary }) => summary));
      expect(writes.commits).toBe(0);
      expect(writes.walBytes).toBe(0);
    } finally {
      reopened.close();
    }
  } finally {
    vi.unstubAllEnvs();
    removeTempStateDbDir(tempDir);
  }
});
