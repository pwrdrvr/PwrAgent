import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-usage-pricing-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteOverlayStore thread usage pricing ledger", () => {
  it("upserts a priced usage line and cached summary idempotently", async () => {
    const line = buildUsageLine();

    await store.upsertThreadUsageLine({ line });
    await store.upsertThreadUsageLine({ line });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        cachedInputTokens: 200,
        currency: "USD",
        inputTokens: 1_000,
        outputTokens: 300,
        pricedUsageLineCount: 1,
        threadId: "thread-1",
        totalCostMicros: 5_000,
        totalTokens: 1_300,
        uncachedInputTokens: 800,
        unpricedUsageLineCount: 0,
        usageLineCount: 1,
      }),
    ]);
  });

  it("excludes superseded rows from active summaries while preserving diagnostics", async () => {
    await store.upsertThreadUsageLine({ line: buildUsageLine() });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        status: "superseded",
        totalCostMicros: 5_000,
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        outputTokens: 600,
        totalCostMicros: 9_000,
        totalTokens: 1_600,
        usageLineId: "line-1-hydrated",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines.map((line) => line.usageLineId)).toEqual([
      "line-1-hydrated",
    ]);
    expect(pricing.summaries[0]).toMatchObject({
      outputTokens: 600,
      totalCostMicros: 9_000,
      totalTokens: 1_600,
      usageLineCount: 1,
    });
  });

  it("rolls sub-agent usage into the parent thread once", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        parentThreadId: "thread-1",
        threadId: "monitor-thread-1",
        totalCostMicros: 7_000,
        usageLineId: "monitor-line-1",
      }),
    });

    const parentPricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const monitorPricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "monitor-thread-1",
    });

    expect(parentPricing.lines).toHaveLength(1);
    expect(parentPricing.summaries[0]).toMatchObject({
      threadId: "thread-1",
      totalCostMicros: 7_000,
      usageLineCount: 1,
    });
    expect(monitorPricing.lines).toHaveLength(1);
    expect(monitorPricing.summaries).toEqual([]);
  });

  it("tracks unpriced token rows separately from priced cost totals", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        priceStatus: "unpriced",
        priceUnavailableReason: "missing-model",
        pricingCatalogId: undefined,
        pricingCatalogVersion: undefined,
        pricingRateId: undefined,
        totalCostMicros: 0,
        usageLineId: "line-unpriced",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "unpriced",
      priceUnavailableReason: "missing-model",
    });
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 0,
      totalCostMicros: 0,
      unpricedUsageLineCount: 1,
      usageLineCount: 1,
    });
  });

  it("records one provider-scoped usage turn for multiple usage lines from the same turn", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        source: "live",
        totalCostMicros: 4_000,
        usageLineId: "line-1-live",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        source: "hydration",
        totalCostMicros: 5_000,
        usageLineId: "line-1-hydrated",
      }),
    });

    const turns = stateDb.raw
      .prepare(
        `SELECT usage_turn_id, provider, backend, thread_id, turn_id, model
         FROM thread_usage_turns
         ORDER BY usage_turn_id`,
      )
      .all() as Array<{
        usage_turn_id: string;
        provider: string;
        backend: string;
        thread_id: string;
        turn_id: string | null;
        model: string | null;
      }>;

    expect(turns).toEqual([
      {
        backend: "codex",
        model: "gpt-5.5",
        provider: "openai",
        thread_id: "thread-1",
        turn_id: "turn-1",
        usage_turn_id: "openai:codex:thread-1:turn-1",
      },
    ]);
  });

  it("keeps pricing summaries separated by provider", async () => {
    await store.upsertThreadUsageLine({ line: buildUsageLine() });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        model: "grok-4.20-reasoning",
        outputCostMicros: 2_000,
        provider: "xai",
        pricingCatalogId: "xai-api",
        pricingCatalogVersion: "2026-06-16",
        pricingRateId: "xai:2026-06-16:grok-4.20-reasoning:standard",
        totalCostMicros: 3_000,
        usageLineId: "xai-line-1",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.summaries).toHaveLength(2);
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        provider: "openai",
        totalCostMicros: 5_000,
        usageLineCount: 1,
      }),
      expect.objectContaining({
        provider: "xai",
        totalCostMicros: 3_000,
        usageLineCount: 1,
      }),
    ]);
  });
});

function buildUsageLine(
  overrides: Partial<ThreadUsageLineRecord> = {},
): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 100,
    cachedInputTokens: 200,
    createdAt: 1_000,
    currency: "USD",
    fastMode: false,
    inputTokens: 1_000,
    model: "gpt-5.5",
    outputCostMicros: 4_000,
    outputTokens: 300,
    priceStatus: "priced",
    provider: "openai",
    pricingCatalogId: "openai-api",
    pricingCatalogVersion: "2026-06-16",
    pricingRateId: "openai:2026-06-16:gpt-5.5:standard",
    reasoningEffort: "high",
    reasoningOutputTokens: 100,
    scope: "turn",
    serviceTier: "standard",
    settingsConfidence: "exact",
    settingsSource: "turn-context",
    source: "hydration",
    sourceItemId: "item-1",
    status: "finalized",
    threadId: "thread-1",
    totalCostMicros: 5_000,
    totalTokens: 1_300,
    turnId: "turn-1",
    uncachedInputCostMicros: 900,
    uncachedInputTokens: 800,
    usageLineId: "line-1",
    ...overrides,
  };
}
