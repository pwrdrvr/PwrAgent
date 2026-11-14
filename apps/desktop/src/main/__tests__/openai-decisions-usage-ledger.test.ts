import { afterEach, beforeEach, expect, it } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { estimateTokenUsageCost } from "@pwragent/shared";
import { buildOpenAIDecisionsUsageLine } from "../openai-decisions/openai-decisions-service";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import type { StateDb } from "../state/state-db";
import { codexModelProviderAccountKey, usageAccountKey } from "../usage-account-identity";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const CODEX_ACCOUNT = usageAccountKey({ type: "chatgpt", accountId: "acct-fixture" } as never)!;
const API_PROJECT_ACCOUNT = codexModelProviderAccountKey("https://api.openai.com", "sk-test-ledger-fixture-key");

let db: StateDb;
let store: SqliteOverlayStore;

beforeEach(() => {
  db = openInMemoryStateDb();
  store = new SqliteOverlayStore(db);
});
afterEach(() => db.close());

function codexTurnLine(): ThreadUsageLineRecord {
  return {
    usageLineId: "codex:thread-a:turn-1",
    provider: "openai",
    accountKey: CODEX_ACCOUNT,
    backend: "codex",
    threadId: "thread-a",
    turnId: "turn-1",
    source: "live",
    scope: "turn",
    status: "finalized",
    createdAt: Date.UTC(2026, 10, 14) - 60_000,
    completedAt: Date.UTC(2026, 10, 14) - 1_000,
    model: "gpt-5.6-sol",
    inputTokens: 50_000,
    cachedInputTokens: 30_000,
    cacheWriteInputTokens: 0,
    uncachedInputTokens: 20_000,
    outputTokens: 2_000,
    reasoningOutputTokens: 500,
    totalTokens: 52_000,
    currency: "USD",
    priceStatus: "unpriced",
    uncachedInputCostMicros: 0,
    cachedInputCostMicros: 0,
    outputCostMicros: 0,
    totalCostMicros: 0,
  };
}

function decisionsLine(): ThreadUsageLineRecord {
  return buildOpenAIDecisionsUsageLine({
    caller: { backend: "codex", threadId: "thread-a" },
    decisionId: "decision-1",
    version: 1,
    attempt: {
      status: 200,
      requestId: "req_ledger",
      model: "gpt-6-luna",
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 7 },
      },
    },
    accountKey: API_PROJECT_ACCOUNT,
    now: Date.UTC(2026, 10, 14),
    fallbackId: "unused",
  });
}

function codexSubscriptionView() {
  return {
    summaries: db.raw.prepare(
      "SELECT * FROM thread_pricing_summaries WHERE provider = 'openai' ORDER BY thread_id",
    ).all(),
    parentTurn: db.raw.prepare(
      "SELECT * FROM thread_usage_turns WHERE provider = 'openai' AND turn_id = 'turn-1'",
    ).all(),
    accountTotals: db.raw.prepare(
      `SELECT account_key, SUM(input_tokens) AS input, SUM(cached_input_tokens) AS cached,
              SUM(output_tokens) AS output, SUM(reasoning_output_tokens) AS reasoning,
              SUM(total_cost_micros) AS cost, COUNT(*) AS lines
         FROM thread_usage_lines WHERE provider = 'openai' AND account_key = ? GROUP BY account_key`,
    ).all(CODEX_ACCOUNT),
  };
}

it("leaves the parent turn, the Codex subscription totals, and the thread's model untouched", async () => {
  await store.upsertThreadUsageLine({ line: codexTurnLine() });
  const before = codexSubscriptionView();
  const modelBefore = await store.readLatestThreadUsageModel({ backend: "codex", threadId: "thread-a" });
  expect(before.parentTurn).toHaveLength(1);

  const { line } = await store.upsertThreadUsageLine({ line: decisionsLine() });

  expect(codexSubscriptionView()).toEqual(before);
  expect(await store.readLatestThreadUsageModel({ backend: "codex", threadId: "thread-a" }))
    .toEqual(modelBefore);
  // The spend is still visible on the calling thread, under its own provider.
  const summaries = await store.readThreadPricingSummaries([{ backend: "codex", threadId: "thread-a" }]);
  expect(summaries.find((summary) => summary.provider === "openai_decisions")).toMatchObject({
    totalCostMicros: 67,
    inputTokens: 1000,
    cachedInputTokens: 400,
    outputTokens: 7,
    pricedUsageLineCount: 1,
  });
  // Stored after the store's own repricing pass: output stays $0 and cache
  // tokens are not added on top of input.
  expect(line).toMatchObject({
    provider: "openai_decisions",
    accountKey: API_PROJECT_ACCOUNT,
    inputTokens: 1000,
    cachedInputTokens: 400,
    cacheWriteInputTokens: 100,
    uncachedInputTokens: 600,
    outputCostMicros: 0,
    totalCostMicros: 67,
  });
  expect(line.turnId).toBeUndefined();
  expect(line.accountKey).not.toBe(CODEX_ACCOUNT);
});

it("is not priced by the Codex openai catalog, which would charge gpt-6-luna output", async () => {
  // The Codex catalog does price gpt-6-luna output; that is why the
  // Decisions line must never be read as provider openai.
  const codexRate = estimateTokenUsageCost({
    model: "gpt-6-luna",
    cachedInputTokens: 400,
    uncachedInputTokens: 600,
    cacheWriteInputTokens: 100,
    outputTokens: 7,
    inputTokenScope: "request",
    at: Date.UTC(2026, 10, 14),
  });
  expect(codexRate?.outputCostMicros).toBeGreaterThan(0);

  const { line } = await store.upsertThreadUsageLine({ line: decisionsLine() });
  expect(line.outputCostMicros).toBe(0);
  expect(line.pricingRateId).toBe("gpt-6-luna-decisions-input-lte-272k");

  // The same counts filed as an ordinary openai line are re-priced from the
  // Codex catalog, output included.
  const { line: misfiled } = await store.upsertThreadUsageLine({
    line: { ...decisionsLine(), usageLineId: "misfiled", provider: "openai", pricingBasis: "aggregate" },
  });
  expect(misfiled.outputCostMicros).toBeGreaterThan(0);
});
