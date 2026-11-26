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

  it("flushes Codex buffered live usage via includeTurns: true and falls back to display pricing snapshot when empty", async () => {
    const requests: Array<{ backend?: string; threadId: string; includeTurns?: boolean; resource?: string }> = [];
    const bufferedCodexLine = makeLine({
      usageLineId: "codex-buffered-1",
      threadId: "review-child",
      totalTokens: 6500,
      uncachedInputTokens: 1500,
      cachedInputTokens: 4200,
      outputTokens: 800,
      totalCostMicros: 8000,
      observedColdReplayCount: 1,
      observedHotReplayCount: 6,
    });
    const flushedThreads = new Set<string>();

    const codexResult = await readCellUsageFromRegistry(
      {
        readThread: async (request) => {
          requests.push({
            backend: request.backend,
            threadId: request.threadId,
            includeTurns: request.includeTurns,
            resource: request.display?.resource,
          });
          // Mirror backend-registry.ts: buffered Codex live usage is only flushed on includeTurns: true.
          if (request.includeTurns === true && request.threadId === "review-child") {
            flushedThreads.add(request.threadId);
            return { pricing: { lines: [bufferedCodexLine], summaries: [] } };
          }
          if (request.display?.resource === "pricing" && request.threadId === "parent-1") {
            return {
              display: {
                pricingPage: {
                  rows: [],
                  totalRows: 0,
                  fallbackEstimate: {
                    totalCostMicros: 12_000,
                    tokens: { inputTokens: 2000, cachedInputTokens: 500, outputTokens: 200, totalTokens: 2200 },
                  },
                },
              } as never,
            };
          }
          return { pricing: { lines: [], summaries: [] } };
        },
      },
      { backend: "codex", parentThreadId: "parent-1", reviewThreadId: "review-child" },
    );

    expect(flushedThreads.has("review-child")).toBe(true);
    expect(requests).toEqual([
      { backend: "codex", threadId: "review-child", includeTurns: true, resource: undefined },
      { backend: "codex", threadId: "parent-1", includeTurns: true, resource: undefined },
      { backend: "codex", threadId: "parent-1", includeTurns: undefined, resource: "pricing" },
    ]);
    expect(codexResult?.source).toBe("ledger");
    expect(codexResult?.lineCount).toBe(1);
    expect(codexResult?.totalTokens).toBe(6500);
    expect(codexResult?.totalReplayCount).toBe(7);
    expect(codexResult?.estimatedCostUsd).toBe(0.008);

    // When Codex has zero ledger lines, display pricing fallbackEstimate populates snapshot tokens and catalog cost.
    const snapshotFallbackResult = await readCellUsageFromRegistry(
      {
        readThread: async (request) => {
          if (request.display?.resource === "pricing") {
            return {
              display: {
                pricingPage: {
                  rows: [],
                  totalRows: 0,
                  fallbackEstimate: {
                    totalCostMicros: 34_500,
                    tokens: {
                      inputTokens: 10_000,
                      cachedInputTokens: 4_000,
                      outputTokens: 1_500,
                      totalTokens: 11_500,
                    },
                  },
                },
              } as never,
            };
          }
          return { pricing: { lines: [], summaries: [] } };
        },
      },
      { backend: "codex", parentThreadId: "codex-native-parent" },
    );
    expect(snapshotFallbackResult?.source).toBe("snapshot");
    expect(snapshotFallbackResult?.totalTokens).toBe(11_500);
    expect(snapshotFallbackResult?.estimatedCostUsd).toBe(0.0345);
  });

  it("reads Claude pricing via display: { resource: 'pricing' } across pages and ignores synthetic gap rows", async () => {
    const requests: Array<{ resource?: string; cursor?: string }> = [];
    const claudeTurnLine = makeLine({
      usageLineId: "claude-turn-1",
      backend: "claude",
      provider: "anthropic",
      threadId: "claude-parent",
      totalTokens: 9000,
      uncachedInputTokens: 3000,
      cachedInputTokens: 5000,
      outputTokens: 1000,
      totalCostMicros: 15_000,
    });
    const claudePage2Line = makeLine({
      usageLineId: "claude-turn-2",
      backend: "claude",
      provider: "anthropic",
      threadId: "claude-parent",
      totalTokens: 3000,
      uncachedInputTokens: 1000,
      cachedInputTokens: 1500,
      outputTokens: 500,
      totalCostMicros: 5_000,
    });
    const syntheticGapLine = {
      ...makeLine({ usageLineId: "gap-1", totalTokens: 99_999, totalCostMicros: 99_999 }),
      estimatedUsageGap: true as const,
    };

    const result = await readCellUsageFromRegistry(
      {
        readThread: async (request) => {
          requests.push({
            resource: request.display?.resource,
            cursor: request.display?.cursor,
          });
          // Mirror backend-registry.ts:7945-7978: Claude readThreadData omits `pricing`.
          if (request.display?.resource !== "pricing") {
            return {};
          }
          if (!request.display.cursor) {
            return {
              display: {
                nextCursor: "rev:1",
                pricingPage: {
                  rows: [
                    { line: claudeTurnLine, gates: [] },
                    { line: syntheticGapLine, gates: [] },
                  ],
                  totalRows: 2,
                },
              } as never,
            };
          }
          return {
            display: {
              pricingPage: {
                rows: [{ line: claudePage2Line, gates: [] }],
                totalRows: 2,
              },
            } as never,
          };
        },
      },
      { backend: "claude", parentThreadId: "claude-parent" },
    );

    expect(requests).toEqual([
      { resource: "pricing", cursor: undefined },
      { resource: "pricing", cursor: "rev:1" },
    ]);
    expect(result?.source).toBe("ledger");
    expect(result?.lineCount).toBe(2);
    expect(result?.totalTokens).toBe(12_000);
    expect(result?.estimatedCostUsd).toBe(0.02);
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
