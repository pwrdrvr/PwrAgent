import type {
  AppServerReadThreadResponse,
  ThreadTokenMiserAccounting,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { aggregateUsageLines } from "@pwragent/shared";

/** Contrived usage: $20.19 recorded, $12.26 historical gap, $7.71 saved. */
export function buildTokenMiserPricingFixture() {
  const parent: ThreadUsageLineRecord = {
    backend: "codex",
    provider: "openai",
    threadId: "thread-1",
    turnId: "turn-1",
    usageLineId: "parent-1",
    source: "live",
    scope: "turn",
    status: "finalized",
    createdAt: 1_800_000_000_000,
    model: "gpt-6-astra",
    currency: "USD",
    priceStatus: "priced",
    inputTokens: 2_100_000,
    cachedInputTokens: 100_000,
    uncachedInputTokens: 2_000_000,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 2_100_000,
    uncachedInputCostMicros: 20_000_000,
    cachedInputCostMicros: 100_000,
    outputCostMicros: 0,
    totalCostMicros: 20_100_000,
    cumulativeInputTokens: 12_326_000,
    cumulativeCachedInputTokens: 10_100_000,
    cumulativeOutputTokens: 0,
    cumulativeReasoningOutputTokens: 0,
  };
  const gate: ThreadUsageLineRecord = {
    ...parent,
    usageLineId: "gate-1",
    source: "monitor",
    sourceItemId: "system:token-miser:gate-1",
    scope: "monitor",
    model: "gpt-6-luna",
    inputTokens: 850_000,
    cachedInputTokens: 0,
    uncachedInputTokens: 850_000,
    totalTokens: 850_000,
    uncachedInputCostMicros: 85_000,
    cachedInputCostMicros: 0,
    totalCostMicros: 85_000,
  };
  const lines = [parent, gate];
  const pricing: NonNullable<AppServerReadThreadResponse["pricing"]> = {
    lines,
    summaries: [aggregateUsageLines(lines)!],
  };
  const accounting: ThreadTokenMiserAccounting = {
    interceptionCount: 1,
    originalCharacters: 160_000,
    baselineParentTokens: 40_000,
    replacementTokens: 1_400,
    retrievedTokens: 0,
    estimatedParentTokensSaved: 38_600,
    savings: {
      currency: "USD",
      pricedGateCount: 1,
      gateCount: 1,
      withoutGateCostMicros: 20_575_000,
      gateCostMicros: 85_000,
      revealedCostMicros: 12_780_000,
      savingsMicros: 7_710_000,
      directlyObservedReplayCount: 47,
      reconstructedReplayCount: 0,
    },
  };
  return { pricing, accounting };
}
