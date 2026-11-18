import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  estimateOpenAiCodexCreditUsage,
  estimateOpenAiTokenUsageCost,
  resolveTokenUsagePriceUnavailableReason,
} from "../token-usage-pricing";

// Oracle: the November 17 published API and Codex credit rate cards.
// https://developers.openai.com/api/docs/pricing
// https://learn.chatgpt.com/docs/pricing
const releasedAt = Date.UTC(2026, 10, 17);
const models = [
  { model: "gpt-6.2-sol", input: 2, cached: 0.1, write: 2.5, output: 10, credits: [50, 2.5, 250] },
  { model: "gpt-6.2-astra", input: 8, cached: 0.4, write: 10, output: 40, credits: [200, 10, 1_000] },
] as const;

describe("GPT-6.2 pricing", () => {
  it.each(models)("prices $model at both sides of the request boundary", (rates) => {
    for (const input of [272_000, 272_001]) {
      const cost = estimateOpenAiTokenUsageCost({
        at: releasedAt, model: rates.model, inputTokenScope: "request",
        uncachedInputTokens: input, cachedInputTokens: 0, outputTokens: 1_000,
      });
      expect(cost).toMatchObject({
        catalogVersion: "2026-11-17",
        inputUsdPerMillion: rates.input * (input > 272_000 ? 2 : 1),
        outputUsdPerMillion: rates.output * (input > 272_000 ? 1.5 : 1),
      });
    }
  });

  it("matches the published API rate card for any token mixture and supported speed", () => {
    fc.assert(fc.property(
      fc.constantFrom(...models), fc.boolean(),
      fc.oneof(fc.constantFrom(272_000, 272_001), fc.integer({ min: 1, max: 922_000 })),
      fc.integer({ min: 0, max: 1_000 }), fc.integer({ min: 0, max: 1_000 }),
      fc.integer({ min: 0, max: 128_000 }),
      (rates, fastMode, input, cachedShare, writeShare, output) => {
        const cached = Math.floor(input * cachedShare / 1_000);
        const uncached = input - cached;
        const writes = Math.floor(uncached * writeShare / 1_000);
        const speed = fastMode ? 2 : 1;
        const inputFactor = (input > 272_000 ? 2 : 1) * speed;
        const outputFactor = (input > 272_000 ? 1.5 : 1) * speed;
        const cost = estimateOpenAiTokenUsageCost({
          at: releasedAt, model: rates.model, fastMode, inputTokenScope: "request",
          uncachedInputTokens: uncached, cachedInputTokens: cached,
          cacheWriteInputTokens: writes, outputTokens: output,
        });
        expect(cost).toMatchObject({
          inputUsdPerMillion: rates.input * inputFactor,
          cachedInputUsdPerMillion: rates.cached * inputFactor,
          cacheWriteInputUsdPerMillion: rates.write * inputFactor,
          outputUsdPerMillion: rates.output * outputFactor,
          totalCostMicros:
            Math.round((uncached - writes) * rates.input * inputFactor)
            + Math.round(writes * rates.write * inputFactor)
            + Math.round(cached * rates.cached * inputFactor)
            + Math.round(output * rates.output * outputFactor),
        });
      },
    ));
  });

  it("matches Codex credit rates independently of API cache-write surcharges", () => {
    fc.assert(fc.property(
      fc.constantFrom(...models), fc.boolean(),
      fc.nat(1_000_000), fc.nat(1_000_000), fc.nat(128_000),
      (rates, fastMode, uncached, cached, output) => {
        const speed = fastMode ? 2 : 1;
        const cost = estimateOpenAiCodexCreditUsage({
          at: releasedAt, model: rates.model, fastMode,
          uncachedInputTokens: uncached, cachedInputTokens: cached, outputTokens: output,
        });
        expect(cost).toMatchObject({
          inputCreditsPerMillion: rates.credits[0] * speed,
          cachedInputCreditsPerMillion: rates.credits[1] * speed,
          outputCreditsPerMillion: rates.credits[2] * speed,
          totalCreditMicros:
            Math.round(uncached * rates.credits[0] * speed)
            + Math.round(cached * rates.credits[1] * speed)
            + Math.round(output * rates.credits[2] * speed),
        });
      },
    ));
  });

  it.each(models)("keeps dates and unsupported tiers explicit for $model", ({ model }) => {
    const params = { at: releasedAt, model, cachedInputTokens: 0, uncachedInputTokens: 1_000, outputTokens: 1_000 };
    expect(estimateOpenAiTokenUsageCost({ ...params, at: releasedAt - 1 })).toBeUndefined();
    expect(estimateOpenAiCodexCreditUsage({ ...params, at: releasedAt - 1 })).toBeUndefined();
    expect(estimateOpenAiTokenUsageCost({ ...params, serviceTier: "flex" })).toBeUndefined();
    expect(resolveTokenUsagePriceUnavailableReason({ ...params, serviceTier: "flex" }))
      .toBe("unsupported-service-tier");
  });
});
