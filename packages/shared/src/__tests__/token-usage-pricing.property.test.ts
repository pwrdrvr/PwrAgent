import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { buildTokenUsageActivityEntry } from "../thread-usage-display";
import {
  estimateOpenAiCodexCreditUsage,
  estimateOpenAiTokenUsageCost,
  estimateTokenUsageCost,
  listOpenAiTokenUsagePricingRates,
  resolveOpenAiPricingServiceTier,
} from "../token-usage-pricing";

const promotionEnd = Date.parse("2027-03-01T00:00:00-08:00");
const noUsage = { cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0 };

// OpenAI API pricing, verified 2026-11-17: https://developers.openai.com/api/docs/pricing.md
// Each tuple is input, cached input, 30-minute cache write, and output in cents per million.
const ultrafastApiRates = [
  ["gpt-6.2-astra", [2400, 120, 3000, 12000], [4800, 240, 6000, 18000], [4800, 240, 6000, 24000], [9600, 480, 12000, 36000]],
  ["gpt-6.2-sol", [600, 30, 750, 3000], [1200, 60, 1500, 4500], [1200, 60, 1500, 6000], [2400, 120, 3000, 9000]],
  ["gpt-6-astra", [6000, 600, 7500, 30000], [12000, 1200, 15000, 45000], [6000, 600, 7500, 30000], [12000, 1200, 15000, 45000]],
  ["gpt-6.1-sol", [1200, 60, 1500, 6000], [2400, 120, 3000, 9000], [1200, 60, 1500, 6000], [2400, 120, 3000, 9000]],
] as const;

// ChatGPT Learn pricing, verified 2026-11-17: https://learn.chatgpt.com/docs/pricing
// Standard credits per million and purchased-credit Ultrafast multipliers before and after the cutover.
const codexCreditRates = [
  ["gpt-6.2-astra", [200, 10, 1000], [3, 6]],
  ["gpt-6.2-sol", [50, 2.5, 250], [3, 6]],
  ["gpt-6-astra", [250, 25, 1250], [6, 6]],
  ["gpt-6.1-sol", [50, 2.5, 250], [6, 6]],
  ["gpt-6.1-terra", [25, 1.25, 125], undefined],
  ["gpt-6-sol", [50, 5, 250], undefined],
  ["gpt-6-luna", [2.5, 0.25, 12.5], undefined],
] as const;

function usdMicros(tokens: number, centsPerMillion: number): number {
  return Math.floor((tokens * centsPerMillion + 50) / 100);
}

describe("OpenAI Ultrafast API pricing", () => {
  it("uses the published date and request bands and bills each token category once", () => {
    fc.assert(fc.property(
      fc.constantFrom(...ultrafastApiRates),
      fc.oneof(fc.constantFrom(271_999, 272_000, 272_001), fc.integer({ min: 3, max: 922_000 })),
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 1, max: 100_000 }),
      fc.integer({ min: -8 * 3600_000, max: 8 * 3600_000 }),
      fc.boolean(),
      ([model, promoShort, promoLong, listShort, listLong], inputTokens, cachedShare, writesShare, outputTokens, offset, isRequest) => {
        const cachedInputTokens = Math.ceil(inputTokens * cachedShare / 2000);
        const uncachedInputTokens = inputTokens - cachedInputTokens;
        const cacheWriteInputTokens = Math.ceil(uncachedInputTokens * writesShare / 2000);
        const long = isRequest && inputTokens > 272_000;
        const [input, cached, write, output] = offset < 0
          ? (long ? promoLong : promoShort)
          : (long ? listLong : listShort);
        const usage = {
          at: promotionEnd + offset,
          model, cachedInputTokens, uncachedInputTokens, cacheWriteInputTokens, outputTokens,
          inputTokenScope: isRequest ? "request" as const : "aggregate" as const,
          serviceTier: " UlTrAfAsT ",
          fastMode: true,
        };
        const costs = {
          uncachedInputCostMicros: usdMicros(uncachedInputTokens - cacheWriteInputTokens, input),
          cachedInputCostMicros: usdMicros(cachedInputTokens, cached),
          cacheWriteInputCostMicros: usdMicros(cacheWriteInputTokens, write),
          outputCostMicros: usdMicros(outputTokens, output),
        };
        expect(estimateOpenAiTokenUsageCost(usage)).toMatchObject({
          ...costs,
          serviceTier: "ultrafast",
          totalCostMicros: Object.values(costs).reduce((sum, cost) => sum + cost, 0),
        });
        expect(estimateTokenUsageCost(usage)).toEqual(estimateOpenAiTokenUsageCost(usage));
      },
    ));
  });

  it("closes the promotion at midnight Pacific and assigns distinct rate IDs", () => {
    const usage = { ...noUsage, model: "gpt-6.2-sol", serviceTier: "ultrafast", outputTokens: 1 };
    const before = estimateOpenAiTokenUsageCost({ ...usage, at: promotionEnd - 1 });
    const after = estimateOpenAiTokenUsageCost({ ...usage, at: promotionEnd });
    expect(before).toMatchObject({ effectiveTo: promotionEnd, totalCostMicros: 30, standardOutputRateMultiplier: 3 });
    expect(after).toMatchObject({ effectiveFrom: promotionEnd, totalCostMicros: 60, standardOutputRateMultiplier: 6 });
    expect(before?.rateId).not.toBe(after?.rateId);
    const listed = listOpenAiTokenUsagePricingRates().filter((rate) => rate.model === usage.model && rate.serviceTier === usage.serviceTier);
    expect(listed).toHaveLength(4);
    expect(new Set(listed.map((rate) => rate.rateId)).size).toBe(4);
  });

  it("uses the active interval for usage without a timestamp", () => {
    const usage = { ...noUsage, model: "gpt-6.2-sol", serviceTier: "ultrafast", outputTokens: 1 };
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(promotionEnd - 1);
      expect(estimateOpenAiTokenUsageCost(usage)?.totalCostMicros).toBe(30);
      expect(estimateOpenAiCodexCreditUsage(usage)?.totalCreditMicros).toBe(750);
      now.mockReturnValue(promotionEnd);
      expect(estimateOpenAiTokenUsageCost(usage)?.totalCostMicros).toBe(60);
      expect(estimateOpenAiCodexCreditUsage(usage)?.totalCreditMicros).toBe(1500);
    } finally {
      now.mockRestore();
    }
  });

  it("prices historical activity against the timestamp displayed on its usage row", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(promotionEnd);
    try {
      const activity = buildTokenUsageActivityEntry({
        createdAt: promotionEnd - 1,
        id: "ultrafast-usage",
        model: "gpt-6.2-sol",
        serviceTier: "ultrafast",
        tokenUsage: { last: { outputTokens: 100_000 } },
      });
      expect(activity?.details).toContainEqual(expect.objectContaining({
        id: "ultrafast-usage-cost",
        label: "Cost: $3.00 list price for GPT-6.2 Sol Ultrafast (<=272K input)",
      }));
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ["gpt-6-astra", "2026-09-29"],
    ["gpt-6.1-sol", "2026-10-08"],
    ["gpt-6.2-astra", "2026-11-17"],
    ["gpt-6.2-sol", "2026-11-17"],
  ])("starts %s Ultrafast pricing on its published release date", (model, date) => {
    const at = Date.parse(date);
    const usage = { ...noUsage, model, serviceTier: "ultrafast" };
    expect(estimateOpenAiTokenUsageCost({ ...usage, at: at - 1 })).toBeUndefined();
    expect(estimateOpenAiTokenUsageCost({ ...usage, at })?.effectiveFrom).toBe(at);
    expect(estimateOpenAiCodexCreditUsage({ ...usage, at: at - 1 })).toBeUndefined();
    expect(estimateOpenAiCodexCreditUsage({ ...usage, at })?.effectiveFrom).toBe(at);
  });

  it("keeps unsupported tier and model combinations unpriced despite the legacy Fast flag", () => {
    expect(resolveOpenAiPricingServiceTier({ serviceTier: " UlTrAfAsT ", fastMode: true })).toBe("ultrafast");
    const at = Date.parse("2026-11-17");
    for (const model of ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-5.6-sol"]) {
      const usage = { ...noUsage, at, model, serviceTier: "ultrafast", fastMode: true };
      expect(estimateTokenUsageCost(usage)).toBeUndefined();
      expect(estimateOpenAiCodexCreditUsage(usage)).toBeUndefined();
    }
    for (const serviceTier of ["flex", "batch", "future-tier"]) {
      const usage = { ...noUsage, at, model: "gpt-6.2-sol", serviceTier, fastMode: true };
      expect(estimateTokenUsageCost(usage)).toBeUndefined();
      expect(estimateOpenAiCodexCreditUsage(usage)).toBeUndefined();
    }
  });
});

describe("purchased Codex credit pricing", () => {
  it("uses the published token rates and paid speed multipliers across both intervals", () => {
    fc.assert(fc.property(
      fc.constantFrom(...codexCreditRates),
      fc.record({
        uncachedInputTokens: fc.integer({ min: 1, max: 800_000 }),
        cachedInputTokens: fc.integer({ min: 0, max: 100_000 }),
        outputTokens: fc.integer({ min: 0, max: 100_000 }),
        reasoningOutputTokens: fc.integer({ min: 0, max: 28_000 }),
      }),
      fc.integer({ min: -8 * 3600_000, max: 8 * 3600_000 }),
      ([model, [input, cached, output], ultrafast], tokens, offset) => {
        const usage = { ...tokens, model, at: promotionEnd + offset };
        for (const [serviceTier, multiplier] of [
          ["standard", 1],
          ["priority", 2],
          ["ultrafast", ultrafast?.[offset < 0 ? 0 : 1]],
        ] as const) {
          const estimate = estimateOpenAiCodexCreditUsage({ ...usage, serviceTier });
          if (multiplier === undefined) {
            expect(estimate).toBeUndefined();
            continue;
          }
          const costs = {
            uncachedInputCreditMicros: Math.round(tokens.uncachedInputTokens * input * multiplier),
            cachedInputCreditMicros: Math.round(tokens.cachedInputTokens * cached * multiplier),
            outputCreditMicros: Math.round((tokens.outputTokens + tokens.reasoningOutputTokens) * output * multiplier),
          };
          expect(estimate).toMatchObject({
            ...costs,
            serviceTier,
            totalCreditMicros: Object.values(costs).reduce((sum, cost) => sum + cost, 0),
          });
        }
      },
    ));
  });

  it("charges 750 then 1500 microcredits for one GPT-6.2 Sol output token", () => {
    const usage = { ...noUsage, model: "gpt-6.2-sol", serviceTier: "ultrafast", outputTokens: 1 };
    const before = estimateOpenAiCodexCreditUsage({ ...usage, at: promotionEnd - 1 });
    const after = estimateOpenAiCodexCreditUsage({ ...usage, at: promotionEnd });
    expect(before).toMatchObject({ effectiveTo: promotionEnd, totalCreditMicros: 750 });
    expect(after).toMatchObject({ effectiveFrom: promotionEnd, totalCreditMicros: 1500 });
    expect(before?.rateId).not.toBe(after?.rateId);
  });
});
