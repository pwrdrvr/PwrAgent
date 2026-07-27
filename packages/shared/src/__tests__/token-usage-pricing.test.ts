import { describe, expect, it } from "vitest";
import {
  estimateOpenAiCodexCreditUsage,
  estimateOpenAiTokenUsageCost,
  estimateTokenUsageCost,
  listOpenAiTokenUsagePricingRates,
  listTokenUsagePricingRates,
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

  it("uses the observed service tier ahead of configured fast-mode intent", () => {
    expect(
      resolveOpenAiPricingServiceTier({
        fastMode: true,
        serviceTier: "default",
      }),
    ).toBe("standard");
    expect(
      resolveOpenAiPricingServiceTier({
        fastMode: false,
        serviceTier: "priority",
      }),
    ).toBe("priority");
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

  it("prices the Grok ACP build model alias with the Grok 4.5 rate", () => {
    const cost = estimateTokenUsageCost({
      at: Date.UTC(2026, 6, 26),
      cachedInputTokens: 11_136,
      model: "grok-4.5-build",
      outputTokens: 45,
      reasoningOutputTokens: 28,
      uncachedInputTokens: 10_072,
    });

    expect(cost).toMatchObject({
      cachedInputCostMicros: 3_341,
      catalogId: "xai-api",
      catalogVersion: "2026-07-17",
      displayName: "Grok 4.5 Standard",
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.3,
      model: "grok-4.5-build",
      outputCostMicros: 270,
      outputTokensIncludeReasoning: true,
      outputUsdPerMillion: 6,
      provider: "xai",
      rateId: "xai:2026-07-17:grok-4.5:standard",
      serviceTier: "standard",
      totalCostMicros: 23_755,
      totalUsd: 0.023755,
      uncachedInputCostMicros: 20_144,
    });
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
    expect(listTokenUsagePricingRates()).toContainEqual(
      expect.objectContaining({
        cachedInputUsdPerMillion: 0.3,
        catalogId: "xai-api",
        catalogVersion: "2026-07-17",
        displayName: "Grok 4.5 Standard",
        inputUsdPerMillion: 2,
        model: "grok-4.5",
        outputUsdPerMillion: 6,
        provider: "xai",
        rateId: "xai:2026-07-17:grok-4.5:standard",
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
    const gpt54Credits = estimateOpenAiCodexCreditUsage({
      cachedInputTokens: 1_000,
      fastMode: true,
      model: "gpt-5.4",
      outputTokens: 2_000,
      uncachedInputTokens: 3_000,
    });

    expect(gpt54Credits).toMatchObject({
      rateId: "openai:2026-06-16:codex-credits:gpt-5.4:priority",
      serviceTier: "priority",
      totalCreditMicros: 1_887_500,
    });

    const gpt55Credits = estimateOpenAiCodexCreditUsage({
      cachedInputTokens: 1_000,
      fastMode: true,
      model: "gpt-5.5",
      outputTokens: 2_000,
      uncachedInputTokens: 3_000,
    });

    expect(gpt55Credits).toMatchObject({
      rateId: "openai:2026-06-16:codex-credits:gpt-5.5:priority",
      serviceTier: "priority",
      totalCreditMicros: 4_718_750,
    });
  });

  it("estimates GPT-5.6 Fast Codex Credits at 2.5x Standard", () => {
    const cases = [
      ["gpt-5.6-sol", "GPT-5.6 Sol Fast", 312.5, 31.25, 1875, 2_218_750_000],
      ["gpt-5.6-terra", "GPT-5.6 Terra Fast", 156.25, 15.625, 937.5, 1_109_375_000],
      ["gpt-5.6-luna", "GPT-5.6 Luna Fast", 62.5, 6.25, 375, 443_750_000],
    ] as const;

    for (const [
      model,
      displayName,
      inputCreditsPerMillion,
      cachedInputCreditsPerMillion,
      outputCreditsPerMillion,
      totalCreditMicros,
    ] of cases) {
      const credits = estimateOpenAiCodexCreditUsage({
        at: Date.UTC(2026, 6, 27),
        cachedInputTokens: 1_000_000,
        model,
        outputTokens: 1_000_000,
        serviceTier: "priority",
        uncachedInputTokens: 1_000_000,
      });

      expect(credits).toMatchObject({
        catalogId: "openai-codex-credits",
        catalogVersion: "2026-07-27",
        displayName,
        inputCreditsPerMillion,
        cachedInputCreditsPerMillion,
        outputCreditsPerMillion,
        provider: "openai",
        rateId: `openai:2026-07-27:codex-credits:${model}:priority`,
        serviceTier: "priority",
        totalCreditMicros,
        totalCredits: totalCreditMicros / 1_000_000,
      });
    }
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
