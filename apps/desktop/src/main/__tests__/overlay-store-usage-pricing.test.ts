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
        totalCostMicros: 16_100,
        totalTokens: 1_300,
        uncachedInputTokens: 800,
        unpricedUsageLineCount: 0,
        usageLineCount: 1,
      }),
    ]);
  });

  it("stores running totals on usage lines without adding them to summaries", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputTokens: 200,
        cumulativeCachedInputTokens: 10_200,
        cumulativeInputTokens: 11_000,
        cumulativeOutputTokens: 500,
        cumulativeReasoningOutputTokens: 100,
        cumulativeTotalCostMicros: 42_000,
        cumulativeTotalTokens: 11_600,
        cumulativeUncachedInputTokens: 800,
        inputTokens: 1_000,
        outputTokens: 50,
        reasoningOutputTokens: 10,
        totalCostMicros: 5_900,
        totalTokens: 1_060,
        uncachedInputTokens: 800,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      cumulativeCachedInputTokens: 10_200,
      cumulativeInputTokens: 11_000,
      cumulativeOutputTokens: 500,
      cumulativeReasoningOutputTokens: 100,
      cumulativeTotalCostMicros: 42_000,
      cumulativeTotalTokens: 11_600,
      cumulativeUncachedInputTokens: 800,
      inputTokens: 1_000,
      totalCostMicros: 5_900,
      totalTokens: 1_060,
    });
    expect(pricing.summaries[0]).toMatchObject({
      cachedInputTokens: 200,
      inputTokens: 1_000,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      totalCostMicros: 5_900,
      totalTokens: 1_060,
    });
  });

  it("keeps the original usage line timestamp when live usage is updated", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: 1_000,
        source: "live",
        status: "pending",
        totalCostMicros: 4_000,
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: 2_000,
        inputTokens: 1_400,
        source: "live",
        status: "pending",
        totalCostMicros: 16_100,
        totalTokens: 1_700,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      createdAt: 1_000,
      inputTokens: 1_400,
      totalCostMicros: 16_100,
      totalTokens: 1_700,
    });
  });

  it("does not erase known turn settings when usage updates omit them", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: 1_000,
        fastMode: true,
        model: "gpt-5.5",
        serviceTier: "priority",
        settingsConfidence: "exact",
        settingsSource: "turn-context",
        source: "live",
        status: "pending",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: 2_000,
        fastMode: undefined,
        model: undefined,
        serviceTier: undefined,
        settingsConfidence: "unknown",
        settingsSource: "unknown",
        source: "live",
        status: "pending",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const turn = stateDb.raw
      .prepare(
        `SELECT model, service_tier, fast_mode, settings_source, settings_confidence
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        fast_mode: number | null;
        model: string | null;
        service_tier: string | null;
        settings_confidence: string | null;
        settings_source: string | null;
      };

    expect(pricing.lines[0]).toMatchObject({
      fastMode: true,
      model: "gpt-5.5",
      serviceTier: "priority",
      settingsConfidence: "exact",
      settingsSource: "turn-context",
    });
    expect(turn).toEqual({
      fast_mode: 1,
      model: "gpt-5.5",
      service_tier: "priority",
      settings_confidence: "exact",
      settings_source: "turn-context",
    });
  });

  it("excludes superseded rows from active summaries while preserving diagnostics", async () => {
    await store.upsertThreadUsageLine({ line: buildUsageLine() });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        status: "superseded",
        totalCostMicros: 16_100,
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        outputTokens: 600,
        totalCostMicros: 25_100,
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
      totalCostMicros: 25_100,
      totalTokens: 1_600,
      usageLineCount: 1,
    });
  });

  it("rolls sub-agent usage into the parent thread once", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        parentThreadId: "thread-1",
        threadId: "monitor-thread-1",
        totalCostMicros: 16_100,
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
      totalCostMicros: 16_100,
      usageLineCount: 1,
    });
    expect(monitorPricing.lines).toHaveLength(1);
    expect(monitorPricing.summaries).toEqual([]);
  });

  it("tracks unpriced token rows separately from priced cost totals", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        model: undefined,
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
        totalCostMicros: 16_100,
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
        totalCostMicros: 16_100,
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
    outputCostMicros: 12_000,
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
    totalCostMicros: 16_100,
    totalTokens: 1_300,
    turnId: "turn-1",
    uncachedInputCostMicros: 4_000,
    uncachedInputTokens: 800,
    usageLineId: "line-1",
    ...overrides,
  };
}
