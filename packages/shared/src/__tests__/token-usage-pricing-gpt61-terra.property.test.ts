import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  estimateOpenAiCodexCreditUsage,
  estimateOpenAiTokenUsageCost,
  resolveTokenUsagePriceUnavailableReason,
} from "../token-usage-pricing";

const model = "gpt-6.1-terra";
const releasedAt = Date.UTC(2026, 9, 26);

// Oracle in cents per million tokens, using the published 30-minute write rates.
// https://developers.openai.com/api/docs/models/gpt-6.1-terra
// https://openai.com/api-fast-mode/
const rateCard = [
  { tier: "standard", band: "short", min: 0, max: 272_000, input: 100, cached: 5, write: 125, output: 500 },
  { tier: "standard", band: "long", min: 272_001, max: 922_000, input: 200, cached: 10, write: 250, output: 750 },
  { tier: "fast", band: "short", min: 0, max: 272_000, input: 200, cached: 10, write: 250, output: 1_000 },
  { tier: "fast", band: "long", min: 272_001, max: 922_000, input: 400, cached: 20, write: 500, output: 1_500 },
] as const;

describe("GPT-6.1 Terra API pricing", () => {
  it.each(rateCard)("prices $tier $band requests against the published rate card", (rates) => {
    fc.assert(fc.property(
      fc.integer({ min: rates.min, max: rates.max }),
      fc.nat(1_000), fc.nat(1_000), fc.nat(128_000),
      (input, cachedShare, writeShare, output) => {
        const cached = Math.floor(input * cachedShare / 1_000);
        const writes = Math.floor((input - cached) * writeShare / 1_000);
        const regularInput = input - cached - writes;
        const uncachedInputCostMicros = Math.round(regularInput * rates.input / 100);
        const cachedInputCostMicros = Math.round(cached * rates.cached / 100);
        const cacheWriteInputCostMicros = Math.round(writes * rates.write / 100);
        const outputCostMicros = Math.round(output * rates.output / 100);

        expect(estimateOpenAiTokenUsageCost({
          model,
          at: releasedAt,
          inputTokenScope: "request",
          serviceTier: rates.tier,
          uncachedInputTokens: regularInput + writes,
          cachedInputTokens: cached,
          cacheWriteInputTokens: writes,
          outputTokens: output,
        })).toMatchObject({
          effectiveFrom: releasedAt,
          inputUsdPerMillion: rates.input / 100,
          cachedInputUsdPerMillion: rates.cached / 100,
          cacheWriteInputUsdPerMillion: rates.write / 100,
          outputUsdPerMillion: rates.output / 100,
          uncachedInputCostMicros,
          cachedInputCostMicros,
          cacheWriteInputCostMicros,
          outputCostMicros,
          totalCostMicros:
            uncachedInputCostMicros + cachedInputCostMicros + cacheWriteInputCostMicros + outputCostMicros,
        });
      },
    ), { examples: [[rates.min, 200, 300, 1_000], [rates.max, 200, 300, 1_000]] });
  });

  it.each(["standard", "fast"])("applies %s API rates from launch and preserves the Codex credit lookup", (serviceTier) => {
    const usage = { model, serviceTier, uncachedInputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100 };
    expect(estimateOpenAiTokenUsageCost({ ...usage, at: releasedAt - 1 })).toBeUndefined();
    expect(estimateOpenAiCodexCreditUsage({ ...usage, at: releasedAt })).toBeUndefined();
  });

  it("leaves Ultrafast unpriced", () => {
    const usage = {
      model, at: releasedAt, serviceTier: "ultrafast",
      uncachedInputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100,
    };
    expect(estimateOpenAiTokenUsageCost(usage)).toBeUndefined();
    expect(resolveTokenUsagePriceUnavailableReason(usage)).toBe("unsupported-service-tier");
  });
});
