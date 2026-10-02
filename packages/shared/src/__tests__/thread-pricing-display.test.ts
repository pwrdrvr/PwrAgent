import { describe, expect, it } from "vitest";
import type { ThreadUsageLineRecord } from "../token-usage-pricing";
import { buildPricingRunningTotals } from "../thread-pricing-display";

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
