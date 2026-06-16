import { describe, expect, it } from "vitest";
import {
  estimateOpenAiTokenUsageCost,
  listOpenAiTokenUsagePricingRates,
  resolveOpenAiPricingServiceTier,
} from "../token-usage-pricing";

describe("token usage pricing", () => {
  it("prices standard usage with persisted micro-unit cost components", () => {
    const cost = estimateOpenAiTokenUsageCost({
      cachedInputTokens: 1_000,
      model: "gpt-5.5",
      outputTokens: 2_000,
      uncachedInputTokens: 3_000,
    });

    expect(cost).toMatchObject({
      catalogId: "openai-api",
      catalogVersion: "2026-06-16",
      currency: "USD",
      provider: "openai",
      rateId: "openai:2026-06-16:gpt-5.5:standard",
      serviceTier: "standard",
      uncachedInputCostMicros: 15_000,
      cachedInputCostMicros: 500,
      outputCostMicros: 60_000,
      totalCostMicros: 75_500,
      totalUsd: 0.0755,
    });
  });

  it("prices fast mode as priority processing", () => {
    const cost = estimateOpenAiTokenUsageCost({
      cachedInputTokens: 1_000,
      fastMode: true,
      model: "gpt-5.4",
      outputTokens: 2_000,
      uncachedInputTokens: 3_000,
    });

    expect(cost).toMatchObject({
      rateId: "openai:2026-06-16:gpt-5.4:priority",
      serviceTier: "priority",
      standardInputRateMultiplier: 2,
      totalCostMicros: 75_500,
    });
  });

  it("returns undefined when the effective date does not match a local catalog row", () => {
    expect(
      estimateOpenAiTokenUsageCost({
        at: Date.UTC(2026, 0, 1),
        cachedInputTokens: 0,
        model: "gpt-5.5",
        outputTokens: 100,
        uncachedInputTokens: 100,
      }),
    ).toBeUndefined();
  });

  it("returns undefined for unsupported models or service tiers", () => {
    expect(
      estimateOpenAiTokenUsageCost({
        cachedInputTokens: 0,
        model: "unknown-model",
        outputTokens: 100,
        uncachedInputTokens: 100,
      }),
    ).toBeUndefined();
    expect(resolveOpenAiPricingServiceTier({ serviceTier: "flex" })).toBeUndefined();
  });

  it("exposes catalog rates with currency-specific metadata", () => {
    expect(listOpenAiTokenUsagePricingRates()).toContainEqual(
      expect.objectContaining({
        catalogId: "openai-api",
        catalogVersion: "2026-06-16",
        currency: "USD",
        displayName: "GPT-5.5 Standard",
        inputMicrosPerMillion: 5_000_000,
        model: "gpt-5.5",
        provider: "openai",
        rateId: "openai:2026-06-16:gpt-5.5:standard",
        serviceTier: "standard",
      }),
    );
  });
});
