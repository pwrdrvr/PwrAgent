import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import {
  aggregateCellUsage,
  readCellUsageFromRegistry,
  summarizeThreadUsageLines,
} from "../../shared/usage-metrics";

function makeLine(overrides: Partial<ThreadUsageLineRecord> = {}): ThreadUsageLineRecord {
  return {
    usageLineId: "line-1",
    backend: "codex",
    provider: "openai",
    threadId: "child-1",
    turnId: "turn-1",
    scope: "turn",
    source: "live",
    status: "finalized",
    createdAt: 1000,
    completedAt: 2000,
    currency: "USD",
    priceStatus: "priced",
    uncachedInputTokens: 1000,
    cachedInputTokens: 5000,
    cacheWriteInputTokens: 200,
    inputTokens: 6000,
    outputTokens: 800,
    reasoningOutputTokens: 300,
    totalTokens: 6800,
    uncachedInputCostMicros: 2000,
    cachedInputCostMicros: 500,
    cacheWriteInputCostMicros: 250,
    outputCostMicros: 8000,
    totalCostMicros: 10750,
    observedColdReplayCount: 1,
    observedHotReplayCount: 4,
    observedColdReplayUncachedTokens: 1000,
    observedHotReplayCachedTokens: 5000,
    peakContextTokens: 18_000,
    finalContextTokens: 16_000,
    ...overrides,
  };
}

describe("usage-metrics rollup", () => {
  it("deduplicates by usageLineId, prefers finalized over pending, and ignores superseded/fork-baseline/decisions lines", () => {
    const summary = summarizeThreadUsageLines([
      makeLine({ usageLineId: "u1", status: "pending", totalTokens: 100, totalCostMicros: 100 }),
      makeLine({ usageLineId: "u1", status: "finalized", totalTokens: 6800, totalCostMicros: 10750 }),
      makeLine({ usageLineId: "u2", status: "superseded", totalTokens: 99_999, totalCostMicros: 99_999 }),
      makeLine({ usageLineId: "u3", scope: "fork-baseline", totalTokens: 50_000, totalCostMicros: 0 }),
      makeLine({ usageLineId: "u4", source: "openai_decisions", totalTokens: 700, totalCostMicros: 500 }),
    ]);

    expect(summary.source).toBe("ledger");
    expect(summary.lineCount).toBe(1);
    expect(summary.totalTokens).toBe(6800);
    expect(summary.uncachedInputTokens).toBe(1000);
    expect(summary.cachedInputTokens).toBe(5000);
    expect(summary.cacheWriteInputTokens).toBe(200);
    expect(summary.outputTokens).toBe(800);
    expect(summary.reasoningOutputTokens).toBe(300);
    expect(summary.replayObserved).toBe(true);
    expect(summary.coldReplayCount).toBe(1);
    expect(summary.hotReplayCount).toBe(4);
    expect(summary.totalReplayCount).toBe(5);
    expect(summary.peakContextTokens).toBe(18_000);
    expect(summary.finalContextTokens).toBe(16_000);
    expect(summary.estimatedCostUsd).toBe(0.01075);
  });

  it("never double-counts snapshot tokens when ledger lines exist, and falls back to snapshot only when lines are empty", () => {
    const snapshot = {
      estimatedCostMicros: 50_000,
      tokens: {
        uncachedInputTokens: 2000,
        cachedInputTokens: 3000,
        inputTokens: 5000,
        outputTokens: 1000,
        totalTokens: 6000,
      },
    };
    const withLines = summarizeThreadUsageLines([makeLine()], snapshot);
    expect(withLines.source).toBe("ledger");
    expect(withLines.totalTokens).toBe(6800);

    const snapshotOnly = summarizeThreadUsageLines([], snapshot);
    expect(snapshotOnly.source).toBe("snapshot");
    expect(snapshotOnly.totalTokens).toBe(6000);
    expect(snapshotOnly.estimatedCostUsd).toBe(0.05);
    expect(snapshotOnly.replayObserved).toBe(false);
    expect(snapshotOnly.totalReplayCount).toBeNull();
  });

  it("reads parent and review child threads via registry.readThread and deduplicates shared lines", async () => {
    const calls: string[] = [];
    const sharedLine = makeLine({ usageLineId: "shared-1", totalTokens: 4000, totalCostMicros: 5000 });
    const childOnlyLine = makeLine({
      usageLineId: "child-2",
      totalTokens: 2500,
      uncachedInputTokens: 500,
      cachedInputTokens: 1500,
      outputTokens: 500,
      totalCostMicros: 3000,
      observedColdReplayCount: 0,
      observedHotReplayCount: 2,
    });
    const result = await readCellUsageFromRegistry(
      {
        readThread: async ({ threadId }) => {
          calls.push(threadId);
          return threadId === "review-child"
            ? { pricing: { lines: [sharedLine, childOnlyLine], summaries: [] } }
            : { pricing: { lines: [sharedLine], summaries: [] } };
        },
      },
      { backend: "codex", parentThreadId: "parent-1", reviewThreadId: "review-child" },
    );

    expect(calls).toEqual(["review-child", "parent-1"]);
    expect(result?.lineCount).toBe(2);
    expect(result?.totalTokens).toBe(6500);
    expect(result?.totalReplayCount).toBe(7);
    expect(result?.estimatedCostUsd).toBe(0.008);
  });

  it("preserves additive totals and idempotent deduplication across arbitrary line sets (property)", () => {
    const lineArb = fc.record({
      id: fc.integer({ min: 1, max: 20 }),
      uncached: fc.integer({ min: 0, max: 50_000 }),
      cached: fc.integer({ min: 0, max: 100_000 }),
      output: fc.integer({ min: 0, max: 20_000 }),
      reasoning: fc.integer({ min: 0, max: 10_000 }),
      costMicros: fc.integer({ min: 0, max: 500_000 }),
      cold: fc.integer({ min: 0, max: 5 }),
      hot: fc.integer({ min: 0, max: 25 }),
      priced: fc.boolean(),
    });

    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 15 }), (entries) => {
        const lines = entries.map((e, idx) =>
          makeLine({
            usageLineId: `id-${e.id}-${idx}`,
            uncachedInputTokens: e.uncached,
            cachedInputTokens: e.cached,
            cacheWriteInputTokens: 0,
            inputTokens: e.uncached + e.cached,
            outputTokens: e.output,
            reasoningOutputTokens: e.reasoning,
            totalTokens: e.uncached + e.cached + e.output,
            totalCostMicros: e.costMicros,
            priceStatus: e.priced ? "priced" : "unpriced",
            observedColdReplayCount: e.cold,
            observedHotReplayCount: e.hot,
          }),
        );
        const once = summarizeThreadUsageLines(lines);
        const duplicated = summarizeThreadUsageLines([...lines, ...lines]);
        expect(duplicated).toEqual(once);

        const expectedTokens = entries.reduce((s, e) => s + e.uncached + e.cached + e.output, 0);
        const expectedReplays = entries.reduce((s, e) => s + e.cold + e.hot, 0);
        const expectedPricedMicros = entries
          .filter((e) => e.priced)
          .reduce((s, e) => s + e.costMicros, 0);

        expect(once.totalTokens).toBe(expectedTokens);
        expect(once.totalReplayCount).toBe(expectedReplays);
        expect(once.totalCostMicros).toBe(expectedPricedMicros);

        const agg = aggregateCellUsage([once, once]);
        expect(agg.totalTokens).toBe(expectedTokens * 2);
        expect(agg.totalReplayCount).toBe(expectedReplays * 2);
        expect(agg.totalCostMicros).toBe(expectedPricedMicros * 2);
      }),
      { numRuns: 50 },
    );
  });
});
