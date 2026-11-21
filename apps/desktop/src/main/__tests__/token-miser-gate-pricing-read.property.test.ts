import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { CURRENT_STATE_DB_USER_VERSION } from "../state/state-db";
import {
  createTempStateDb,
  openFreshStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

const request = {
  backend: "codex",
  threadId: "parent",
  sourceItemIds: ["gate-item", "gate-item"],
  turnIds: ["gate-turn", "opaque-turn-key", "gate-turn"],
} as const;

function usage(
  usageLineId: string,
  overrides: Partial<ThreadUsageLineRecord>,
): ThreadUsageLineRecord {
  return {
    usageLineId, backend: request.backend, threadId: request.threadId, provider: "openai",
    createdAt: 1000, startedAt: 999, source: "live", scope: "turn", status: "pending",
    model: "gpt-5.5", currency: "USD", priceStatus: "priced", pricingBasis: "provider-reported",
    inputTokens: 100, uncachedInputTokens: 100, cachedInputTokens: 0, outputTokens: 10,
    reasoningOutputTokens: 0, totalTokens: 110, uncachedInputCostMicros: 0,
    cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0, ...overrides,
  };
}

async function checkHistory(count: number, analyze: boolean): Promise<void> {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    const child = { threadId: "child", parentThreadId: request.threadId, scope: "monitor" } as const;
    await store.upsertThreadUsageLines({ lines: [
      usage("direct-turn", { turnId: "gate-turn" }),
      usage("direct-source", { sourceItemId: "gate-item", provider: "openrouter" }),
      usage("direct-opaque", { usageTurnId: "opaque-turn-key", turnId: "different-turn" }),
      usage("multi-match", { sourceItemId: "gate-item", turnId: "gate-turn", parentThreadId: request.threadId }),
      usage("child-source", { ...child, sourceItemId: "gate-item" }),
      usage("child-turn-only", { ...child, turnId: "gate-turn" }),
      usage("wrong-family", { threadId: "elsewhere", sourceItemId: "gate-item", turnId: "gate-turn" }),
      usage("wrong-backend", { backend: "claude", sourceItemId: "gate-item", turnId: "gate-turn" }),
      usage("superseded", { sourceItemId: "gate-item", status: "superseded" }),
    ] });
    db.raw.prepare(`WITH RECURSIVE history(n) AS (
        SELECT 1 WHERE ? > 0 UNION ALL SELECT n + 1 FROM history WHERE n < ?
      )
      INSERT INTO thread_usage_lines (
        usage_line_id, usage_turn_id, backend, thread_id, parent_thread_id, turn_id,
        source, source_item_id, scope, status, created_at, updated_at,
        input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens,
        reasoning_output_tokens, total_tokens, price_status, currency,
        uncached_input_cost_micros, cached_input_cost_micros, output_cost_micros, total_cost_micros
      )
      SELECT 'old-' || n, 'old-key-' || n, 'codex',
        CASE n % 3 WHEN 0 THEN 'parent' WHEN 1 THEN 'old-child' ELSE 'elsewhere' END,
        CASE n % 3 WHEN 1 THEN 'parent' END,
        CASE n % 3 WHEN 2 THEN 'gate-turn' ELSE 'old-turn-' || n END,
        'live', CASE n % 3 WHEN 2 THEN 'gate-item' ELSE 'old-item-' || n END,
        'turn', 'finalized', 100, 100, 100, 0, 100, 10, 0, 110, 'priced', 'USD', 0, 0, 0, 0
      FROM history`).run(count, count);
    if (analyze) db.raw.exec("ANALYZE");

    const { lines } = await store.readThreadPricing(request);
    const expected = lines.filter((line) => request.sourceItemIds.some((id) => id === line.sourceItemId)
      || (line.threadId === request.threadId
        && request.turnIds.some((id) => id === line.turnId || id === line.usageTurnId)));
    expect(expected.map((line) => line.usageLineId)).toEqual([
      "multi-match", "direct-turn", "direct-source", "direct-opaque", "child-source",
    ]);
    expect(expected.map((line) => line.startedAt)).toEqual([999, 999, 999, 999, 999]);

    const prepare = db.raw.prepare.bind(db.raw);
    const plan: string[] = [];
    const observe = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!/\b(FROM|JOIN) thread_usage_(lines|turns)\b/.test(sql)) return statement;
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        const rows = all(...args);
        const accesses = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>;
        plan.push(...accesses.map(({ detail }) => detail));
        return rows;
      });
      return statement;
    });
    try {
      expect(await store.readTokenMiserGatePricingLines(request)).toEqual(expected);
    } finally {
      observe.mockRestore();
    }

    // A family-only SEARCH still walks all of that thread's historical rows.
    // Budget the line access paths by requiring both family and lookup-key
    // equalities, including when ANALYZE gives the planner a skewed history.
    const lineLookups = plan.filter((detail) => /^(SEARCH|SCAN) (thread_usage_lines|line)\b/.test(detail));
    expect(lineLookups).toEqual(expect.arrayContaining([
      expect.stringMatching(/\(backend=\? AND thread_id=\? AND source_item_id=\?\)/),
      expect.stringMatching(/\(backend=\? AND thread_id=\? AND turn_id=\?\)/),
      expect.stringMatching(/\(backend=\? AND thread_id=\? AND usage_turn_id=\?\)/),
      expect.stringMatching(/\(backend=\? AND parent_thread_id=\? AND source_item_id=\?\)/),
    ]));
    expect(lineLookups).toHaveLength(5);
    expect(lineLookups).toContain("SEARCH line USING INTEGER PRIMARY KEY (rowid=?)");
    expect(plan.filter((detail) => /^(SEARCH|SCAN) (thread_usage_turns|turn)\b/.test(detail)))
      .toEqual([expect.stringMatching(/\(usage_turn_id=\?\)/)]);
  } finally {
    db.close();
  }
}

it("seeks only the requested gate keys with 1,000 older lines", () => checkHistory(1_000, false));

it("keeps the same lookup work bound as old family and unrelated history grow", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1_000, max: 2_000 }), fc.boolean(), checkHistory),
    { numRuns: 20 });
});

it("upgrades a v82 ledger with opaque turn keys and child source items in place", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-gate-pricing-v82-");
  try {
    const legacy = openFreshStateDb(dbPath);
    let expected: ThreadUsageLineRecord[];
    try {
      legacy.raw.exec(`
        DROP INDEX idx_thread_usage_lines_gate_child_source;
        DROP INDEX idx_thread_usage_lines_gate_usage_turn;
        DROP INDEX idx_thread_usage_lines_source;
        DROP INDEX idx_thread_usage_lines_turn;
        DROP INDEX idx_thread_usage_lines_completion_turn;
        DROP INDEX idx_thread_usage_turns_turn;
        DROP INDEX idx_thread_usage_lines_read_parent;
        CREATE INDEX idx_thread_usage_lines_turn
          ON thread_usage_lines(provider, backend, thread_id, turn_id);
        CREATE INDEX idx_thread_usage_lines_source
          ON thread_usage_lines(provider, backend, thread_id, source, source_item_id);
        CREATE INDEX idx_thread_usage_turns_turn
          ON thread_usage_turns(provider, backend, thread_id, turn_id);
        CREATE INDEX idx_thread_usage_lines_read_parent
          ON thread_usage_lines(backend, parent_thread_id, created_at DESC, usage_line_id DESC)
          WHERE status != 'superseded';
        PRAGMA user_version = 82;
      `);
      const store = new SqliteOverlayStore(legacy);
      await store.upsertThreadUsageLines({ lines: [
        usage("opaque-line", { turnId: "request-turn", usageTurnId: "opaque-turn-key" }),
        usage("child-gate", {
          threadId: "child", parentThreadId: request.threadId, sourceItemId: "gate-item", scope: "monitor",
        }),
      ] });
      expected = (await store.readThreadPricing(request)).lines;
    } finally {
      legacy.close();
    }

    const upgraded = openFreshStateDb(dbPath);
    try {
      const store = new SqliteOverlayStore(upgraded);
      expect(await store.readTokenMiserGatePricingLines(request)).toEqual(expected);
      expect(upgraded.raw.pragma("user_version", { simple: true })).toBe(CURRENT_STATE_DB_USER_VERSION);
    } finally {
      upgraded.close();
    }
  } finally {
    removeTempStateDbDir(tempDir);
  }
});
