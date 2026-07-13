import { describe, expect, it } from "vitest";
import {
  estimateOpenAiCodexCreditUsage,
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

  it("bills separately reported reasoning tokens at the output rate", () => {
    const cost = estimateOpenAiTokenUsageCost({
      cachedInputTokens: 0,
      model: "gpt-5.5",
      outputTokens: 2_000,
      reasoningOutputTokens: 500,
      uncachedInputTokens: 0,
    });

    expect(cost).toMatchObject({
      outputCostMicros: 75_000,
      totalCostMicros: 75_000,
      totalUsd: 0.075,
    });
  });

  it("does not double count reasoning tokens when output already includes them", () => {
    const cost = estimateOpenAiTokenUsageCost({
      cachedInputTokens: 0,
      model: "gpt-5.5",
      outputTokens: 2_500,
      outputTokensIncludeReasoning: true,
      reasoningOutputTokens: 500,
      uncachedInputTokens: 0,
    });

    expect(cost).toMatchObject({
      outputCostMicros: 75_000,
      totalCostMicros: 75_000,
      totalUsd: 0.075,
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

  it("prices GPT-5.5 usage from its April 23 release date", () => {
    const cost = estimateOpenAiTokenUsageCost({
      at: Date.UTC(2026, 3, 23, 18, 0, 0),
      cachedInputTokens: 1_000,
      model: "gpt-5.5",
      outputTokens: 2_000,
      uncachedInputTokens: 3_000,
    });

    expect(cost).toMatchObject({
      catalogVersion: "2026-06-16",
      rateId: "openai:2026-06-16:gpt-5.5:standard",
      serviceTier: "standard",
      totalCostMicros: 75_500,
    });
  });

  it("prices GPT-5.5 usage from June 15 even though the local catalog was captured June 16", () => {
    const cost = estimateOpenAiTokenUsageCost({
      at: Date.UTC(2026, 5, 15, 18, 40, 23),
      cachedInputTokens: 38_272,
      model: "gpt-5.5",
      outputTokens: 58,
      uncachedInputTokens: 42_079,
    });

    expect(cost).toMatchObject({
      catalogVersion: "2026-06-16",
      rateId: "openai:2026-06-16:gpt-5.5:standard",
      serviceTier: "standard",
      totalCostMicros: 231_271,
    });
  });

  it("prices GPT-5.6 Terra usage from the July 9 catalog", () => {
    const cost = estimateOpenAiTokenUsageCost({
      at: Date.UTC(2026, 6, 12, 22, 50, 30),
      cachedInputTokens: 0,
      model: "gpt-5.6-terra",
      outputTokens: 15,
      uncachedInputTokens: 26_291,
    });

    expect(cost).toMatchObject({
      catalogVersion: "2026-07-09",
      displayName: "GPT-5.6 Terra Standard",
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
      rateId: "openai:2026-07-09:gpt-5.6-terra:standard",
      serviceTier: "standard",
      uncachedInputCostMicros: 65_728,
      cachedInputCostMicros: 0,
      outputCostMicros: 225,
      totalCostMicros: 65_953,
      totalUsd: 0.065953,
    });
  });

  it("prices GPT-5.6 Sol, Terra, and Luna standard and priority usage", () => {
    const cases = [
      ["gpt-5.6-sol", false, 35_500_000, 5, 0.5, 30],
      ["gpt-5.6-sol", true, 71_000_000, 10, 1, 60],
      ["gpt-5.6-terra", false, 17_750_000, 2.5, 0.25, 15],
      ["gpt-5.6-terra", true, 35_500_000, 5, 0.5, 30],
      ["gpt-5.6-luna", false, 7_100_000, 1, 0.1, 6],
      ["gpt-5.6-luna", true, 14_200_000, 2, 0.2, 12],
    ] as const;

    for (const [
      model,
      fastMode,
      totalCostMicros,
      inputUsdPerMillion,
      cachedInputUsdPerMillion,
      outputUsdPerMillion,
    ] of cases) {
      const cost = estimateOpenAiTokenUsageCost({
        at: Date.UTC(2026, 6, 12),
        cachedInputTokens: 1_000_000,
        fastMode,
        model,
        outputTokens: 1_000_000,
        uncachedInputTokens: 1_000_000,
      });

      expect(cost).toMatchObject({
        catalogVersion: "2026-07-09",
        cachedInputUsdPerMillion,
        inputUsdPerMillion,
        outputUsdPerMillion,
        rateId: `openai:2026-07-09:${model}:${fastMode ? "priority" : "standard"}`,
        serviceTier: fastMode ? "priority" : "standard",
        totalCostMicros,
      });
    }
  });

  it("does not price GPT-5.6 usage before its catalog effective date", () => {
    expect(
      estimateOpenAiTokenUsageCost({
        at: Date.UTC(2026, 6, 8, 23, 59, 59),
        cachedInputTokens: 0,
        model: "gpt-5.6-terra",
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
    expect(listOpenAiTokenUsagePricingRates()).toContainEqual(
      expect.objectContaining({
        catalogId: "openai-api",
        catalogVersion: "2026-07-09",
        currency: "USD",
        displayName: "GPT-5.6 Luna Fast (Priority)",
        inputMicrosPerMillion: 2_000_000,
        cachedInputMicrosPerMillion: 200_000,
        outputMicrosPerMillion: 12_000_000,
        model: "gpt-5.6-luna",
        provider: "openai",
        rateId: "openai:2026-07-09:gpt-5.6-luna:priority",
        serviceTier: "priority",
      }),
    );
  });

  it("estimates Codex Credits from the Codex token rate card", () => {
    const credits = estimateOpenAiCodexCreditUsage({
      cachedInputTokens: 1_000,
      model: "gpt-5.5",
      outputTokens: 2_000,
      uncachedInputTokens: 3_000,
    });

    expect(credits).toMatchObject({
      catalogId: "openai-codex-credits",
      catalogVersion: "2026-06-16",
      provider: "openai",
      rateId: "openai:2026-06-16:codex-credits:gpt-5.5:standard",
      serviceTier: "standard",
      unit: "codex_credits",
      uncachedInputCreditMicros: 375_000,
      cachedInputCreditMicros: 12_500,
      outputCreditMicros: 1_500_000,
      totalCreditMicros: 1_887_500,
      totalCredits: 1.8875,
    });
  });

  it("estimates Fast Codex Credits with model-specific speed multipliers", () => {
    const credits = estimateOpenAiCodexCreditUsage({
      cachedInputTokens: 1_000,
      fastMode: true,
      model: "gpt-5.4",
      outputTokens: 2_000,
      uncachedInputTokens: 3_000,
    });

    expect(credits).toMatchObject({
      rateId: "openai:2026-06-16:codex-credits:gpt-5.4:priority",
      serviceTier: "priority",
      totalCreditMicros: 1_887_500,
    });
  });

  it("estimates GPT-5.6 Codex Credits", () => {
    const credits = estimateOpenAiCodexCreditUsage({
      at: Date.UTC(2026, 6, 12),
      cachedInputTokens: 1_000_000,
      fastMode: true,
      model: "gpt-5.6-terra",
      outputTokens: 1_000_000,
      uncachedInputTokens: 1_000_000,
    });

    expect(credits).toMatchObject({
      catalogId: "openai-codex-credits",
      catalogVersion: "2026-07-09",
      displayName: "GPT-5.6 Terra Fast",
      inputCreditsPerMillion: 125,
      cachedInputCreditsPerMillion: 12.5,
      outputCreditsPerMillion: 750,
      provider: "openai",
      rateId: "openai:2026-07-09:codex-credits:gpt-5.6-terra:priority",
      serviceTier: "priority",
      totalCreditMicros: 887_500_000,
      totalCredits: 887.5,
    });
  });

  it("does not invent Codex Credit rates for unsupported Fast models", () => {
    expect(
      estimateOpenAiCodexCreditUsage({
        cachedInputTokens: 1_000,
        fastMode: true,
        model: "gpt-5.4-mini",
        outputTokens: 2_000,
        uncachedInputTokens: 3_000,
      }),
    ).toBeUndefined();
  });
});
