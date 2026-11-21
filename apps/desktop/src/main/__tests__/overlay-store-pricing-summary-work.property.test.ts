import { readFileSync } from "node:fs";
import type { ThreadPricingSummary, ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const thread = { backend: "codex", threadId: "pricing-root" } as const;

function usageLine(id: string, fields: Partial<ThreadUsageLineRecord> = {}): ThreadUsageLineRecord {
  return {
    ...thread,
    usageLineId: id,
    turnId: id,
    createdAt: Date.UTC(2026, 3, 23),
    provider: "openai",
    currency: "USD",
    source: "live",
    scope: "turn",
    status: "pending",
    priceStatus: "priced",
    pricingBasis: "configured-provider",
    cachedInputCostMicros: 10,
    uncachedInputCostMicros: 100,
    outputCostMicros: 20,
    totalCostMicros: 130,
    inputTokens: 11,
    cachedInputTokens: 1,
    uncachedInputTokens: 10,
    outputTokens: 3,
    reasoningOutputTokens: 2,
    totalTokens: 14,
    ...fields,
  };
}

// Aggregate the complete persisted ledger independently of the write path.
function expectSummary(db: StateDb, { updatedAt: _updatedAt, ...summary }: ThreadPricingSummary) {
  const expected = db.raw.prepare(`
    SELECT COUNT(*) AS usageLineCount,
      COUNT(CASE WHEN price_status = 'priced' THEN 1 END) AS pricedUsageLineCount,
      COUNT(CASE WHEN price_status <> 'priced' THEN 1 END) AS unpricedUsageLineCount,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
      COALESCE(SUM(uncached_input_tokens), 0) AS uncachedInputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens,
      COALESCE(SUM(total_tokens), 0) AS totalTokens,
      COALESCE(SUM(CASE WHEN price_status = 'priced' THEN total_cost_micros END), 0) AS totalCostMicros
    FROM thread_usage_lines
    WHERE backend = @backend AND provider = @provider AND currency = @currency
      AND (thread_id = @threadId OR parent_thread_id = @threadId)
      AND status <> 'superseded'
  `).get(summary);
  expect(summary).toMatchObject(expected as object);
}

async function appendAndCheck(store: SqliteOverlayStore, db: StateDb, id: string) {
  const { summary } = await store.upsertThreadUsageLine({ line: usageLine(id) });
  expectSummary(db, summary);
  expect(await store.readThreadPricingSummaries([thread])).toContainEqual(summary);
}

async function expectAppendBudget(history: number, flushes: number) {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    await store.upsertThreadUsageLines({ lines: [
      usageLine("root"),
      usageLine("child", { threadId: "child", parentThreadId: thread.threadId }),
      ...Array.from({ length: history }, (_, index) =>
        usageLine(`history-${index}`, { provider: index % 2 ? "openai" : "qwen" })),
    ] });
    let measuring = false;
    let sumInputs = 0;
    // Count inputs consumed by SQLite's SUM on actual dispatched SQL.
    // This keeps the budget independent of elapsed time and SQLite plans.
    db.raw.aggregate("sum", {
      start: null as number | null,
      step: (total, value: number | null) => {
        if (measuring) sumInputs += 1;
        return value === null ? total : (total ?? 0) + value;
      },
    });
    for (let index = 0; index < flushes; index += 1) {
      measuring = true;
      const { summary } = await store.upsertThreadUsageLine({ line: usageLine(`append-${index}`) });
      measuring = false;
      expectSummary(db, summary);
      expect(await store.readThreadPricingSummaries([thread])).toContainEqual(summary);
    }
    expect(sumInputs).toBeLessThanOrEqual(10 * flushes);
  } finally {
    db.close();
  }
}

it("keeps eight appends within budget after 64 historical lines", async () => {
  await expectAppendBudget(64, 8);
});

it("bounds cumulative summary work by the number of one-line flushes", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 64, max: 120 }),
    fc.integer({ min: 8, max: 18 }),
    expectAppendBudget,
  ), { numRuns: 15 });
});

it("keeps checkpoints equal to the ledger through replay, regrouping, and repricing", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 20, max: 50_000 }), async (lateTokens) => {
    const db = openInMemoryStateDb();
    try {
      const store = new SqliteOverlayStore(db);
      const other = { ...thread, threadId: "other-root" };
      const live = usageLine("active");
      const check = async (lines: ThreadUsageLineRecord[]) => {
        const result = await store.upsertThreadUsageLines({ lines });
        for (const summary of result.summaries) expectSummary(db, summary);
        for (const summary of await store.readThreadPricingSummaries([thread, other])) {
          expectSummary(db, summary);
        }
      };

      await check([
        usageLine("fixed-root", { parentThreadId: thread.threadId }),
        usageLine("moving", { threadId: "worker", parentThreadId: thread.threadId }),
        usageLine("fixed-other", { threadId: other.threadId, provider: "qwen", currency: "EUR" }),
        live,
      ]);
      // A late live update replaces the previous contribution. A duplicate ID
      // in the same flush uses its last supplied value.
      await check([live, { ...live, totalTokens: lateTokens }]);
      await check([usageLine("snapshot", {
        turnId: live.turnId, source: "hydration", scope: "latest-request", status: "finalized",
      })]);
      await check([usageLine("hydrated-turn", { turnId: live.turnId, source: "backfill", status: "finalized" })]);
      // Hydration replaces the live turn but must leave the snapshot superseded.
      const pricing = await store.readThreadPricing(thread);
      expect(pricing.lines.map(({ usageLineId }) => usageLineId)).toContain("hydrated-turn");
      expect(pricing.lines.map(({ usageLineId }) => usageLineId)).not.toContain("active");
      expect(pricing.lines.map(({ usageLineId }) => usageLineId)).not.toContain("snapshot");

      await check([usageLine("moving", {
        threadId: "worker", parentThreadId: other.threadId, provider: "qwen", currency: "EUR",
      })]);
      await check([usageLine("moving", {
        threadId: "worker", parentThreadId: other.threadId, provider: "qwen", currency: "EUR",
        status: "superseded",
      })]);

      await check([usageLine("unpriced", {
        model: "unknown-pricing-model", priceStatus: "unpriced", pricingBasis: undefined,
      })]);
      db.raw.prepare("UPDATE thread_usage_lines SET model = 'gpt-5.5' WHERE usage_line_id = 'unpriced'").run();
      const repaired = await store.readThreadPricing(thread);
      expect(repaired.lines.find(({ usageLineId }) => usageLineId === "unpriced")?.priceStatus).toBe("priced");
      for (const summary of repaired.summaries) expectSummary(db, summary);
    } finally {
      db.close();
    }
  }), { numRuns: 25 });
});

const pricingDeltaVersion = 85;
it.each([82, 83, 84, pricingDeltaVersion, CURRENT_STATE_DB_USER_VERSION + 1])("upgrades pricing from a v%i profile and keeps peer writes and rollbacks in the ledger commit", async (version) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("pwragent-pricing-summary-");
  let db: StateDb | undefined;
  let peer: StateDb | undefined;
  try {
    db = StateDb.open(temp.dbPath);
    await new SqliteOverlayStore(db).upsertThreadUsageLines({ lines: [
      usageLine("legacy-root"),
      usageLine("legacy-child", { threadId: "legacy-child", parentThreadId: thread.threadId }),
    ] });
    const readUsageIndexes = (state: StateDb) => state.raw.prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'index' AND tbl_name IN ('thread_usage_lines', 'thread_usage_turns')
       ORDER BY name`,
    ).all();
    const expectedIndexes = readUsageIndexes(db);
    // Rewind the indexes the two upstream migrations replaced.
    if (version < 84) {
      db.raw.exec(`
        DROP INDEX idx_thread_usage_lines_completion_turn;
        DROP INDEX idx_thread_usage_turns_turn;
        DROP INDEX idx_thread_usage_lines_read_parent;
        CREATE INDEX idx_thread_usage_turns_turn
          ON thread_usage_turns(provider, backend, thread_id, turn_id);
        CREATE INDEX idx_thread_usage_lines_read_parent
          ON thread_usage_lines(backend, parent_thread_id, created_at DESC, usage_line_id DESC)
          WHERE status != 'superseded';
      `);
    }
    if (version < 83) {
      db.raw.exec(`
        DROP INDEX idx_thread_usage_lines_gate_child_source;
        DROP INDEX idx_thread_usage_lines_gate_usage_turn;
        DROP INDEX idx_thread_usage_lines_source;
        DROP INDEX idx_thread_usage_lines_turn;
        CREATE INDEX idx_thread_usage_lines_turn
          ON thread_usage_lines(provider, backend, thread_id, turn_id);
        CREATE INDEX idx_thread_usage_lines_source
          ON thread_usage_lines(provider, backend, thread_id, source, source_item_id);
      `);
    }
    // Emulate a ledger edit that summaries from builds without deltas did not capture.
    db.raw.exec(`
      DROP TRIGGER thread_pricing_summary_delta_insert;
      DROP TRIGGER thread_pricing_summary_delta_update;
      DROP TRIGGER thread_pricing_summary_delta_delete;
      ALTER TABLE thread_pricing_summaries DROP COLUMN ledger_delta_ready;
      UPDATE thread_usage_lines SET input_tokens = 100 WHERE usage_line_id = 'legacy-child';
    `);
    db.raw.pragma(`user_version = ${version}`);
    const readLedger = (state: StateDb) => ({
      lines: state.raw.prepare("SELECT * FROM thread_usage_lines ORDER BY usage_line_id").all(),
      turns: state.raw.prepare("SELECT * FROM thread_usage_turns ORDER BY usage_turn_id").all(),
    });
    const existingLedger = readLedger(db);
    db.close();
    db = StateDb.open(temp.dbPath);
    expect(readUsageIndexes(db)).toEqual(expectedIndexes);
    expect(readLedger(db)).toEqual(existingLedger);
    const migrationWal = readFileSync(`${temp.dbPath}-wal`);
    const frameSize = migrationWal.readUInt32BE(8) + 24;
    let migrationCommits = 0;
    for (let offset = 32; offset < migrationWal.length; offset += frameSize) {
      if (migrationWal.readUInt32BE(offset + 4) !== 0) migrationCommits++;
    }
    // Each numbered upgrade commits once. A profile stamped v85 or higher
    // without the pricing schema also needs the pricing delta transaction.
    const pendingMigrations = Math.max(0, CURRENT_STATE_DB_USER_VERSION - version);
    const missingPricingMigration = version >= pricingDeltaVersion ? 1 : 0;
    expect(migrationCommits).toBe(pendingMigrations + missingPricingMigration);
    const store = new SqliteOverlayStore(db);
    await appendAndCheck(store, db, "first-upgraded");
    expect(db.raw.pragma("user_version", { simple: true })).toBe(Math.max(version, CURRENT_STATE_DB_USER_VERSION));

    // Alternating owners and a raw edit exercise the SQLite triggers on
    // independent connections. A trigger write counts in total_changes().
    const versionBeforeReopen = db.raw.pragma("data_version", { simple: true });
    peer = StateDb.open(temp.dbPath);
    expect(db.raw.pragma("data_version", { simple: true })).toBe(versionBeforeReopen);
    const peerStore = new SqliteOverlayStore(peer);
    const writers = [{ store, db }, { store: peerStore, db: peer }];
    const totalChanges = () => writers.reduce((sum, writer) =>
      sum + (writer.db.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n, 0);
    const before = totalChanges();
    const { writes } = await measureSqliteWrites(async () => {
      for (let index = 0; index < 8; index += 1) {
        const writer = writers[index % 2]!;
        await appendAndCheck(writer.store, writer.db, `peer-${index}`);
      }
    });
    expect(totalChanges() - before).toBe(24);
    expectSqliteWriteBudget({
      scenario: "thread-pricing-checkpoint-repeated-flush",
      note: "Eight one-line flushes alternating two connections. Two dispatched write statements and one trigger summary update per flush share the existing commit.",
      writes,
    });

    peer.raw.prepare("UPDATE thread_usage_lines SET total_tokens = 40 WHERE usage_line_id = 'legacy-child'").run();
    const [current] = await store.readThreadPricingSummaries([thread]);
    expectSummary(db, current!);
    expect(current!.totalTokens).toBe(10 * 14 + 40);
    db.raw.exec(`
      CREATE TRIGGER fixture_reject_usage_line BEFORE INSERT ON thread_usage_lines
      WHEN NEW.usage_line_id = 'reject' BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END
    `);
    await expect(store.upsertThreadUsageLines({ lines: [usageLine("rolled-back"), usageLine("reject")] }))
      .rejects.toThrow("fixture rollback");
    expect(await peerStore.readThreadPricingSummaries([thread])).toEqual([current]);
    expectSummary(peer, current!);
    expect(peer.raw.prepare("SELECT 1 FROM thread_usage_lines WHERE usage_line_id = 'rolled-back'").get()).toBeUndefined();

    peer.raw.prepare("DELETE FROM thread_usage_lines WHERE usage_line_id = 'legacy-child'").run();
    const [afterDelete] = await store.readThreadPricingSummaries([thread]);
    expectSummary(db, afterDelete!);
    expect(afterDelete!.usageLineCount).toBe(10);
  } finally {
    peer?.close();
    if (db?.raw.open) db.close();
    removeTempStateDbDir(temp.tempDir);
    vi.unstubAllEnvs();
  }
});
