import { expect, it, vi } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openFreshStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const epoch = Date.UTC(2026, 10, 1);
const historyTurns = 256;
const flushes = 24;
const observationsPerTurn = 4;

function usageLine(turn: number, observation: number, child: boolean, priced: boolean): ThreadUsageLineRecord {
  const threadId = child ? "child" : "root";
  const usageLineId = `codex:${threadId}:turn-${turn}:live-token-usage`;
  const inputTokens = 100 * (observation + 1);
  return {
    backend: "codex", threadId, ...(child ? { parentThreadId: "root" } : {}), turnId: `turn-${turn}`,
    usageLineId, provider: "openai", scope: "turn", source: "live", status: "pending",
    model: priced ? "gpt-5.5" : "unpriced-fixture", currency: "USD", priceStatus: priced ? "priced" : "unpriced",
    ...(priced ? { pricingBasis: "provider-reported" } : {}),
    createdAt: epoch + turn * 10_000, inputTokens, uncachedInputTokens: inputTokens, cachedInputTokens: 0,
    outputTokens: 10, reasoningOutputTokens: 0, totalTokens: inputTokens + 10,
    uncachedInputCostMicros: priced ? inputTokens : 0, cachedInputCostMicros: 0,
    outputCostMicros: 0, totalCostMicros: priced ? inputTokens : 0,
  };
}

async function measureFlushes(indexed: boolean, child: boolean, priced: boolean) {
  const fixture = createTempStateDb("usage-index-wal-");
  const state = openFreshStateDb(fixture.dbPath);
  try {
    if (!indexed) {
      state.raw.exec(`
        DROP INDEX idx_thread_usage_lines_child_turn;
        DROP INDEX idx_thread_usage_lines_unpriced_thread;
        DROP INDEX idx_thread_usage_lines_unpriced_parent;
      `);
    }
    const store = new SqliteOverlayStore(state);
    const seeded = await store.upsertThreadUsageLines({
      lines: Array.from({ length: historyTurns }, (_, turn) => usageLine(turn, 0, child, priced)),
    });
    expect(seeded.lines.every((line) => line.priceStatus === (priced ? "priced" : "unpriced"))).toBe(true);
    state.raw.pragma("wal_autocheckpoint=0");
    state.raw.pragma("wal_checkpoint(TRUNCATE)");

    return await measureSqliteWrites(async () => {
      for (let flush = 0; flush < flushes; flush++) {
        const turn = historyTurns + Math.floor(flush / observationsPerTurn);
        const observation = flush % observationsPerTurn;
        await store.upsertThreadUsageLines({ lines: [usageLine(turn, observation, child, priced)] });
      }
    });
  } finally {
    state.close();
    removeTempStateDbDir(fixture.tempDir);
  }
}

it.each([
  { name: "priced-root", child: false, priced: true },
  { name: "unpriced-root", child: false, priced: false },
  { name: "priced-child", child: true, priced: true },
  { name: "unpriced-child", child: true, priced: false },
])("budgets steady-state usage flushes for $name rows", async ({ name, child, priced }) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    const { writes: control } = await measureFlushes(false, child, priced);
    const { writes } = await measureFlushes(true, child, priced);
    // Adding indexes affects pages written by existing commits.
    expect(writes.commits).toBe(flushes);
    expect({ commits: writes.commits, statements: writes.statements, rows: writes.rowsChanged })
      .toEqual({ commits: control.commits, statements: control.statements, rows: control.rowsChanged });
    expect(control.walBytes).toBeGreaterThan(0);
    expectSqliteWriteBudget({
      scenario: `thread-usage-indexes-${name}`,
      note: `24 single-line usage flushes across six turns, with four observations per turn and a 256-turn ledger. Control with the three indexes dropped wrote ${control.walBytes} WAL bytes.`,
      writes,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
