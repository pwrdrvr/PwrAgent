import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { estimateOpenAiCodexCreditUsage } from "../token-usage-pricing";

// Codex launch date and the purchased-credit rate card, in credits per 1M tokens.
// https://learn.chatgpt.com/docs/changelog#gpt-61-terra-in-work-and-codex
// https://learn.chatgpt.com/docs/pricing#token-rates
const launchedAt = Date.UTC(2026, 9, 26);
const model = "gpt-6.1-terra";
const creditRates = [
  { speed: "Standard", fastMode: false, input: 25, cached: 1.25, output: 125 },
  { speed: "Fast", fastMode: true, input: 50, cached: 2.5, output: 250 },
] as const;

describe("GPT-6.1 Terra Codex purchased credits", () => {
  it.each(creditRates)("uses the $speed rate on both sides of 272K input", (rates) => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 272_000 }),
      fc.integer({ min: 272_001, max: 922_000 }),
      fc.nat(1_000), fc.nat(128_000),
      (shortInput, longInput, cachedShare, outputTokens) => {
        for (const inputTokens of [shortInput, longInput]) {
          const cachedInputTokens = Math.floor(inputTokens * cachedShare / 1_000);
          const uncachedInputTokens = inputTokens - cachedInputTokens;
          const uncachedInputCreditMicros = Math.round(uncachedInputTokens * rates.input);
          const cachedInputCreditMicros = Math.round(cachedInputTokens * rates.cached);
          const outputCreditMicros = Math.round(outputTokens * rates.output);

          expect(estimateOpenAiCodexCreditUsage({
            at: launchedAt,
            model,
            fastMode: rates.fastMode,
            cachedInputTokens,
            uncachedInputTokens,
            outputTokens,
          })).toMatchObject({
            catalogId: "openai-codex-credits",
            effectiveFrom: launchedAt,
            unit: "codex_credits",
            inputCreditsPerMillion: rates.input,
            cachedInputCreditsPerMillion: rates.cached,
            outputCreditsPerMillion: rates.output,
            uncachedInputCreditMicros,
            cachedInputCreditMicros,
            outputCreditMicros,
            totalCreditMicros: uncachedInputCreditMicros + cachedInputCreditMicros + outputCreditMicros,
          });
        }
      },
    ), { examples: [[272_000, 272_001, 200, 1_000]] });
  });

  it.each(creditRates)("leaves $speed Codex usage before launch unpriced", ({ fastMode }) => {
    expect(estimateOpenAiCodexCreditUsage({
      at: launchedAt - 1, model, fastMode,
      cachedInputTokens: 500, uncachedInputTokens: 500, outputTokens: 100,
    })).toBeUndefined();
  });
});
