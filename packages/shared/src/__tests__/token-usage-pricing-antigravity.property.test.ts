import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  estimateTokenUsageCost,
  listTokenUsagePricingRates,
  resolveTokenUsagePriceUnavailableReason,
} from "../token-usage-pricing";

const NO_USAGE = {
  cachedInputTokens: 0,
  outputTokens: 0,
  uncachedInputTokens: 0,
};

function usdMicros(tokens: number, usdPerMillion: number): number {
  return Math.round((tokens * Math.round(usdPerMillion * 1_000_000)) / 1_000_000);
}

// Published Google Gemini API pricing (https://ai.google.dev/gemini-api/docs/pricing):
// - Gemini 4 Neon: launched 2026-11-18, flat $3.00 / $0.15 cached / $15.00 output.
// - Gemini 4 Carbon: launched 2026-10-28, intro $2.00 / $0.10 / $10.00 through 2026-11-30,
//   standard $4.00 / $0.20 / $20.00 starting 2026-12-01 UTC.
// - Gemini 4 Argon: announced 2026-09-30, intro $2.00 / $0.10 / $10.00 through 2026-11-30,
//   standard $4.00 / $0.20 / $20.00 starting 2026-12-01 UTC.
// - Gemini 4 Hydrogen: launched 2026-11-12, flat $1.50 / $0.075 / $7.50 output.
// - Gemini 3.8 Flash: launched 2026-09-02, intro $0.75 / $0.075 / $3.75 through 2026-12-31,
//   standard $1.50 / $0.15 / $7.50 starting 2027-01-01 UTC.
const GEMINI_RATE_CARDS = [
  {
    aliases: ["gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-high", "gemini-4-neon-xhigh"],
    launchAt: Date.UTC(2026, 10, 18),
    model: "gemini-4-neon",
    rates: [{ at: Date.UTC(2026, 10, 18), cached: 0.15, input: 3, output: 15 }],
  },
  {
    aliases: ["gemini-4-carbon-low", "gemini-4-carbon-medium", "gemini-4-carbon-high"],
    launchAt: Date.UTC(2026, 9, 28),
    model: "gemini-4-carbon",
    rates: [
      { at: Date.UTC(2026, 10, 30, 23, 59, 59), cached: 0.1, input: 2, output: 10 },
      { at: Date.UTC(2026, 11, 1), cached: 0.2, input: 4, output: 20 },
    ],
  },
  {
    aliases: ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"],
    launchAt: Date.UTC(2026, 8, 30),
    model: "gemini-4-argon",
    rates: [
      { at: Date.UTC(2026, 10, 30, 23, 59, 59), cached: 0.1, input: 2, output: 10 },
      { at: Date.UTC(2026, 11, 1), cached: 0.2, input: 4, output: 20 },
    ],
  },
  {
    aliases: ["gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh"],
    launchAt: Date.UTC(2026, 10, 12),
    model: "gemini-4-hydrogen",
    rates: [{ at: Date.UTC(2026, 10, 12), cached: 0.075, input: 1.5, output: 7.5 }],
  },
  {
    aliases: ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"],
    launchAt: Date.UTC(2026, 8, 2),
    model: "gemini-3.8-flash",
    rates: [
      { at: Date.UTC(2026, 11, 31, 23, 59, 59), cached: 0.075, input: 0.75, output: 3.75 },
      { at: Date.UTC(2027, 0, 1), cached: 0.15, input: 1.5, output: 7.5 },
    ],
  },
] as const;

// Published Anthropic API pricing (https://platform.claude.com) for Claude 5.5
// models exposed by Antigravity ACP.
const CLAUDE_55_RATE_CARDS = [
  {
    aliases: ["claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high"],
    cacheWrite: 5,
    cached: 0.2,
    input: 4,
    launchAt: Date.UTC(2026, 8, 22),
    model: "claude-opus-5-5",
    output: 20,
  },
  {
    aliases: ["claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high"],
    cacheWrite: 2.5,
    cached: 0.1,
    input: 2,
    launchAt: Date.UTC(2026, 8, 28),
    model: "claude-sonnet-5-5",
    output: 10,
  },
] as const;

describe("Antigravity Gemini and Claude 5.5 list pricing", () => {
  it("prices every Gemini model and thought-level alias by published date without double-counting thoughts", () => {
    fc.assert(fc.property(
      fc.constantFrom(...GEMINI_RATE_CARDS),
      fc.integer({ min: 0, max: 500_000 }),
      fc.integer({ min: 0, max: 500_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      (card, uncachedInputTokens, cachedInputTokens, outputTokens, rawThoughtTokens) => {
        const reasoningOutputTokens = Math.min(rawThoughtTokens, outputTokens);
        for (const interval of card.rates) {
          const expectedUncached = usdMicros(uncachedInputTokens, interval.input);
          const expectedCached = usdMicros(cachedInputTokens, interval.cached);
          const expectedOutput = usdMicros(outputTokens, interval.output);
          const expectedTotal = expectedUncached + expectedCached + expectedOutput;

          const canonical = estimateTokenUsageCost({
            at: interval.at,
            cachedInputTokens,
            model: card.model,
            outputTokens,
            reasoningOutputTokens,
            uncachedInputTokens,
          });
          expect(canonical).toMatchObject({
            cachedInputCostMicros: expectedCached,
            outputCostMicros: expectedOutput,
            outputTokensIncludeReasoning: true,
            provider: "google",
            serviceTier: "standard",
            totalCostMicros: expectedTotal,
            uncachedInputCostMicros: expectedUncached,
          });

          for (const alias of card.aliases) {
            const aliased = estimateTokenUsageCost({
              at: interval.at,
              cachedInputTokens,
              model: alias,
              outputTokens,
              reasoningOutputTokens,
              uncachedInputTokens,
            });
            expect(aliased?.totalCostMicros).toBe(expectedTotal);
            expect(aliased?.rateId).toBe(canonical?.rateId);
          }
        }
      },
    ));
  });

  it("prices Claude Opus 5.5 and Sonnet 5.5 with 5-minute cache writes and no thought double-counting", () => {
    fc.assert(fc.property(
      fc.constantFrom(...CLAUDE_55_RATE_CARDS),
      fc.integer({ min: 0, max: 300_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      fc.integer({ min: 0, max: 500_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      (card, regularInputTokens, cacheWriteInputTokens, cachedInputTokens, outputTokens, rawThoughtTokens) => {
        const uncachedInputTokens = regularInputTokens + cacheWriteInputTokens;
        const reasoningOutputTokens = Math.min(rawThoughtTokens, outputTokens);
        const expectedUncached = usdMicros(regularInputTokens, card.input);
        const expectedCacheWrite = usdMicros(cacheWriteInputTokens, card.cacheWrite);
        const expectedCached = usdMicros(cachedInputTokens, card.cached);
        const expectedOutput = usdMicros(outputTokens, card.output);
        const expectedTotal = expectedUncached + expectedCacheWrite + expectedCached + expectedOutput;

        const canonical = estimateTokenUsageCost({
          at: card.launchAt,
          cacheWriteInputTokens,
          cachedInputTokens,
          model: card.model,
          outputTokens,
          reasoningOutputTokens,
          uncachedInputTokens,
        });
        expect(canonical).toMatchObject({
          cacheWriteInputCostMicros: expectedCacheWrite,
          cachedInputCostMicros: expectedCached,
          outputCostMicros: expectedOutput,
          outputTokensIncludeReasoning: true,
          provider: "anthropic",
          serviceTier: "standard",
          totalCostMicros: expectedTotal,
          uncachedInputCostMicros: expectedUncached,
        });

        for (const alias of card.aliases) {
          const aliased = estimateTokenUsageCost({
            at: card.launchAt,
            cacheWriteInputTokens,
            cachedInputTokens,
            model: alias,
            outputTokens,
            reasoningOutputTokens,
            uncachedInputTokens,
          });
          expect(aliased?.totalCostMicros).toBe(expectedTotal);
          expect(aliased?.rateId).toBe(canonical?.rateId);
        }
      },
    ));
  });

  it("prices the captured Antigravity 1.5.14 Gemini 4 Neon and Claude Sonnet 5.5 turns", () => {
    // Captured tool-using turn on gemini-4-neon: 16,793 uncached input,
    // 12,368 cached read, 541 output (436 thoughts included).
    const neonToolTurn = estimateTokenUsageCost({
      at: Date.UTC(2026, 10, 23),
      cachedInputTokens: 12_368,
      model: "gemini-4-neon",
      outputTokens: 541,
      reasoningOutputTokens: 436,
      uncachedInputTokens: 16_793,
    });
    expect(neonToolTurn).toMatchObject({
      cachedInputCostMicros: 1_855,
      outputCostMicros: 8_115,
      provider: "google",
      totalCostMicros: 60_349,
      uncachedInputCostMicros: 50_379,
    });

    // Captured turn on claude-sonnet-5-5 through Antigravity: 14,823 uncached
    // input, 7,516 cached read, 4 output.
    const sonnetTurn = estimateTokenUsageCost({
      at: Date.UTC(2026, 10, 23),
      cachedInputTokens: 7_516,
      model: "claude-sonnet-5-5",
      outputTokens: 4,
      reasoningOutputTokens: 0,
      uncachedInputTokens: 14_823,
    });
    expect(sonnetTurn).toMatchObject({
      cachedInputCostMicros: 752,
      outputCostMicros: 40,
      provider: "anthropic",
      totalCostMicros: 30_438,
      uncachedInputCostMicros: 29_646,
    });
  });

  it("respects launch dates, introductory cutovers, and standard-only service tiers", () => {
    for (const card of GEMINI_RATE_CARDS) {
      expect(estimateTokenUsageCost({ ...NO_USAGE, at: card.launchAt - 1, model: card.model })).toBeUndefined();
      expect(
        resolveTokenUsagePriceUnavailableReason({
          ...NO_USAGE,
          at: card.launchAt,
          model: card.model,
          serviceTier: "priority",
        }),
      ).toBe("unsupported-service-tier");
    }

    const dec1 = Date.UTC(2026, 11, 1);
    const carbonBefore = estimateTokenUsageCost({ ...NO_USAGE, at: dec1 - 1, model: "gemini-4-carbon", outputTokens: 100_000 });
    const carbonAfter = estimateTokenUsageCost({ ...NO_USAGE, at: dec1, model: "gemini-4-carbon", outputTokens: 100_000 });
    expect(carbonBefore?.totalCostMicros).toBe(1_000_000);
    expect(carbonAfter?.totalCostMicros).toBe(2_000_000);
    expect(carbonBefore?.rateId).not.toBe(carbonAfter?.rateId);

    const jan1 = Date.UTC(2027, 0, 1);
    const flashBefore = estimateTokenUsageCost({ ...NO_USAGE, at: jan1 - 1, model: "gemini-3.8-flash", outputTokens: 100_000 });
    const flashAfter = estimateTokenUsageCost({ ...NO_USAGE, at: jan1, model: "gemini-3.8-flash", outputTokens: 100_000 });
    expect(flashBefore?.totalCostMicros).toBe(375_000);
    expect(flashAfter?.totalCostMicros).toBe(750_000);
    expect(flashBefore?.rateId).not.toBe(flashAfter?.rateId);

    const googleRates = listTokenUsagePricingRates().filter((rate) => rate.provider === "google");
    expect(googleRates.length).toBeGreaterThanOrEqual(8);
    expect(new Set(googleRates.map((rate) => rate.rateId)).size).toBe(googleRates.length);
  });
});
