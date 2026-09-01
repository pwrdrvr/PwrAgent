import { describe, expect, it } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { buildPricingSpendByModel } from "../pricing-spend-by-model";

function line(
  overrides: Partial<ThreadUsageLineRecord> = {},
): ThreadUsageLineRecord {
  return {
    backend: "acp:grok",
    cachedInputCostMicros: 0,
    cachedInputTokens: 0,
    createdAt: 1_800_000_000_000,
    currency: "USD",
    inputTokens: 100,
    model: "grok-4.1-fast",
    outputCostMicros: 0,
    outputTokens: 10,
    priceStatus: "priced",
    provider: "xai",
    reasoningOutputTokens: 0,
    scope: "turn",
    source: "live",
    status: "finalized",
    threadId: "thread-1",
    totalCostMicros: 1_000,
    totalTokens: 110,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 100,
    usageLineId: "line-1",
    ...overrides,
  };
}

describe("buildPricingSpendByModel", () => {
  it("splits a turn's reviewers out of the provider they share", () => {
    /* Two OpenAI reviews used to collapse into one "OpenAI" row, which is the
       one number an operator comparing reviewers cannot use. */
    const groups = buildPricingSpendByModel({
      lines: [
        line({ totalCostMicros: 2_590_000, usageLineId: "parent" }),
        line({
          model: "gpt-5.6-sol",
          provider: "openai",
          scope: "monitor",
          sourceItemId: "review:sol",
          totalCostMicros: 1_070_000,
          usageLineId: "sol",
        }),
        line({
          model: "gpt-5.6-terra",
          provider: "openai",
          scope: "monitor",
          sourceItemId: "review:terra",
          totalCostMicros: 840_000,
          usageLineId: "terra",
        }),
      ],
    });

    expect(groups.map((group) => group.provider)).toEqual(["xai", "openai"]);
    expect(groups[1]?.totalCostMicros).toBe(1_910_000);
    expect(groups[1]?.usageLineCount).toBe(2);
    expect(groups[1]?.models.map((spend) => spend.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
  });

  it("names the model from the sub-agent when the row carries none", () => {
    /* A helper's usage row often records no model of its own. Bucketed on the
       row alone, every review in a thread lands in one "Unknown model" pile. */
    const groups = buildPricingSpendByModel({
      lines: [
        line({
          model: undefined,
          provider: "openai",
          scope: "monitor",
          sourceItemId: "review:sol",
          usageLineId: "sol",
        }),
      ],
      resolveModel: (record) => record.model ?? "gpt-5.6-sol",
    });

    expect(groups[0]?.models[0]?.model).toBe("gpt-5.6-sol");
  });

  it("counts sub-agents rather than the rows they billed", () => {
    const groups = buildPricingSpendByModel({
      lines: [
        line({ usageLineId: "turn-1" }),
        line({ usageLineId: "turn-2" }),
        line({
          scope: "monitor",
          sourceItemId: "review:one",
          usageLineId: "review-a",
        }),
        line({
          scope: "monitor",
          sourceItemId: "review:one",
          usageLineId: "review-b",
        }),
        line({
          scope: "monitor",
          sourceItemId: "review:two",
          usageLineId: "review-c",
        }),
      ],
    });

    const spend = groups[0]?.models[0];
    expect(spend?.threadUsageLineCount).toBe(2);
    expect(spend?.subAgentCount).toBe(2);
    expect(spend?.summary.usageLineCount).toBe(5);
  });

  it("keeps unnamed rows in a bucket of their own rather than dropping them", () => {
    /* The buckets have to add up to the headline above them, so a row nothing
       named still has to land somewhere. */
    const groups = buildPricingSpendByModel({
      lines: [
        line({ totalCostMicros: 500_000, usageLineId: "named" }),
        line({
          model: undefined,
          totalCostMicros: 500_000,
          usageLineId: "unnamed",
        }),
      ],
    });

    expect(groups[0]?.models.map((spend) => spend.model)).toEqual([
      "grok-4.1-fast",
      undefined,
    ]);
    expect(groups[0]?.totalCostMicros).toBe(1_000_000);
  });

  it("splits one provider's currencies instead of adding them together", () => {
    const groups = buildPricingSpendByModel({
      lines: [
        line({ totalCostMicros: 1_000_000, usageLineId: "usd" }),
        line({
          currency: "EUR",
          totalCostMicros: 2_000_000,
          usageLineId: "eur",
        }),
      ],
    });

    expect(groups.map((group) => group.currency)).toEqual(["EUR", "USD"]);
  });

  it("counts an unpriced row as a decision the dollars do not cover", () => {
    const groups = buildPricingSpendByModel({
      lines: [
        line({ usageLineId: "priced" }),
        line({
          priceStatus: "unpriced",
          priceUnavailableReason: "missing-rate",
          totalCostMicros: 0,
          usageLineId: "unpriced",
        }),
      ],
    });

    expect(groups[0]?.models[0]?.summary.pricedUsageLineCount).toBe(1);
    expect(groups[0]?.models[0]?.summary.unpricedUsageLineCount).toBe(1);
  });

  it("returns nothing for a thread with no usage rows", () => {
    expect(buildPricingSpendByModel({ lines: [] })).toEqual([]);
  });
});
