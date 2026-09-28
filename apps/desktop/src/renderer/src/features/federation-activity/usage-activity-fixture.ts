import type { OwnedUsageRow } from "./usage-activity-summary";

export function usageFixture(overrides: Partial<OwnedUsageRow["line"]> = {}): OwnedUsageRow {
  return { owner: "Local", target: { scope: "local" }, title: "Fixture thread", updatedAt: 200,
    line: { backend: "codex", provider: "openai", threadId: "thread", turnId: "turn", usageLineId: "usage",
      scope: "turn", source: "live", status: "pending", turnUsageAttributed: true,
      createdAt: 100, startedAt: 100, completedAt: 200, currency: "USD", priceStatus: "priced",
      inputTokens: 1000, uncachedInputTokens: 300, cachedInputTokens: 700, cacheWriteInputTokens: 50,
      outputTokens: 200, reasoningOutputTokens: 100, totalTokens: 1200,
      cachedInputCostMicros: 100, uncachedInputCostMicros: 100, outputCostMicros: 100, totalCostMicros: 300,
      cumulativeTotalCostMicros: 100_000, cumulativeTotalTokens: 1_000_000, ...overrides } };
}
