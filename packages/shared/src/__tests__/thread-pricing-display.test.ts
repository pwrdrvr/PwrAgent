import { describe, expect, it } from "vitest";
import type { ThreadUsageLineRecord } from "../token-usage-pricing";
import { buildPricingRunningTotals, buildThreadPricingDisplay, buildThreadPricingSnapshotEstimate } from "../thread-pricing-display";

function line(
  usageLineId: string,
  createdAt: number,
  priced: { totalCostMicros: number } | undefined,
): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 0,
    createdAt,
    currency: "USD",
    inputTokens: 1_000,
    outputCostMicros: 0,
    outputTokens: 100,
    priceStatus: priced ? "priced" : "unpriced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "turn",
    source: "live",
    status: "finalized",
    threadId: "thread-1",
    totalCostMicros: priced?.totalCostMicros ?? 0,
    totalTokens: 1_100,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 1_000,
    updatedAt: createdAt,
    usageLineId,
  } as ThreadUsageLineRecord;
}

describe("buildPricingRunningTotals", () => {
  it("carries a repriced earlier row into every running total after it", () => {
    const before = [
      line("parent-1", 1_000, { totalCostMicros: 82_000 }),
      line("worker", 2_000, undefined),
      line("parent-2", 3_000, { totalCostMicros: 10_000 }),
    ];
    const unpriced = buildPricingRunningTotals(before).byLineId;
    expect(unpriced.get("worker")?.runningCostMicros).toBe(82_000);
    expect(unpriced.get("parent-2")?.runningCostMicros).toBe(92_000);

    // A worker line priced late, after its model was read from Codex.
    const after = before.map((entry) =>
      entry.usageLineId === "worker"
        ? { ...entry, priceStatus: "priced" as const, totalCostMicros: 5_000 }
        : entry,
    );
    const repriced = buildPricingRunningTotals(after).byLineId;
    expect(repriced.get("parent-1")?.runningCostMicros).toBe(82_000);
    expect(repriced.get("worker")?.runningCostMicros).toBe(87_000);
    expect(repriced.get("parent-2")?.runningCostMicros).toBe(97_000);
  });
});

describe("unobserved thread pricing", () => {
  const tokens = { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 20_000, reasoningOutputTokens: 10_000, totalTokens: 1_020_000 };

  it("prices the entire snapshot at the current model's rates without adding ledger rows", () => {
    const pricing = { lines: [], summaries: [], snapshot: { model: "gpt-6.1-sol", tokens } };
    const display = buildThreadPricingDisplay({ pricing });
    // $0.40 uncached + $0.08 cached + $0.20 output. Reasoning is an output
    // subset and must not be charged a second time.
    expect(display.fallbackEstimate).toEqual({ model: "gpt-6.1-sol", tokens, totalCostMicros: 680_000 });
    expect(display.summary).toBeUndefined();
    expect(display.rows).toEqual([]);
    expect(display.observedCostMicros).toBe(0);
    expect(pricing.lines).toEqual([]);
  });

  it("does not add cumulative estimates on top of observed turn charges", () => {
    const display = buildThreadPricingDisplay({ pricing: {
      lines: [line("observed", 1_000, { totalCostMicros: 5_000 })], summaries: [],
      snapshot: { model: "gpt-6.1-sol", tokens },
    } });
    expect(display.fallbackEstimate).toBeUndefined();
    expect(display.observedCostMicros).toBe(5_000);
  });

  it("leaves normal helper pricing in place rather than showing a second headline estimate", () => {
    const display = buildThreadPricingDisplay({ pricing: {
      lines: [{ ...line("helper", 1_000, { totalCostMicros: 5_000 }), scope: "monitor", source: "monitor", sourceItemId: "helper" }],
      summaries: [], snapshot: { model: "gpt-6.1-sol", tokens },
    } });
    expect(display.fallbackEstimate).toBeUndefined();
    expect(display.summary?.totalCostMicros).toBe(5_000);
  });

  it("does not turn unavailable or inconsistent token breakdowns into a zero-dollar price", () => {
    for (const counts of [undefined, { inputTokens: 1_000, outputTokens: 100 }, { inputTokens: 100, cachedInputTokens: 200, outputTokens: 100 }]) {
      expect(buildThreadPricingSnapshotEstimate({ model: "gpt-6.1-sol", tokens: counts }).totalCostMicros).toBeUndefined();
    }
    expect(buildThreadPricingSnapshotEstimate({ model: "unknown-model", tokens }).totalCostMicros).toBeUndefined();
  });

  it("recalculates when the current model changes", () => {
    const at = Date.UTC(2026, 9, 3);
    const sol = buildThreadPricingSnapshotEstimate({ model: "gpt-6.1-sol", tokens }, at);
    const astra = buildThreadPricingSnapshotEstimate({ model: "gpt-6-astra", tokens }, at);
    expect(sol.totalCostMicros).toBeDefined();
    expect(astra.totalCostMicros).toBeDefined();
    expect(sol.totalCostMicros).not.toBe(astra.totalCostMicros);
  });

  it("applies the current speed's rates to the entire snapshot", () => {
    const estimate = buildThreadPricingSnapshotEstimate({ model: "gpt-6.1-sol", serviceTier: "priority", tokens }, Date.UTC(2026, 9, 3));
    expect(estimate.totalCostMicros).toBe(1_360_000);
  });

  it.each(["gpt-6.1-sol", "unknown-local-model"])("preserves the declared local zero-cost policy for %s", (model) => {
    for (const counts of [tokens, undefined]) {
      const estimate = buildThreadPricingSnapshotEstimate({ model, localModel: true, tokens: counts });
      expect(estimate.totalCostMicros).toBe(0);
      expect(estimate.tokens).toEqual(counts);
    }
  });
});
