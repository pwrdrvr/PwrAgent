import { describe, expect, it } from "vitest";
import {
  buildPricingSpendByModel,
  type PricingSpendUsageLine,
  prunePricingSpendOverrides,
} from "../pricing-spend-by-model";

function line(
  overrides: Partial<PricingSpendUsageLine> = {},
): PricingSpendUsageLine {
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
  it("keeps the thread's own token volume out of a helper's share", () => {
    /* Sub-agents inherit the parent's model by default, so the common case is
       one bucket holding both. Summing them is right for the bill and wrong
       for the context question — a merged figure is what used to disagree
       with the turn card and with Codex's context-window meter. */
    const groups = buildPricingSpendByModel({
      lines: [
        line({
          cachedInputTokens: 90_000,
          outputTokens: 1_000,
          totalTokens: 101_000,
          uncachedInputTokens: 10_000,
          usageLineId: "parent",
        }),
        line({
          outputTokens: 35_000,
          scope: "monitor",
          sourceItemId: "review:sol",
          totalTokens: 735_000,
          uncachedInputTokens: 700_000,
          usageLineId: "reviewer",
        }),
      ],
    });

    const bucket = groups[0]?.models[0];
    expect(bucket?.summary.uncachedInputTokens).toBe(710_000);
    expect(bucket?.threadSummary?.uncachedInputTokens).toBe(10_000);
    expect(bucket?.threadSummary?.cachedInputTokens).toBe(90_000);
    expect(bucket?.threadSummary?.outputTokens).toBe(1_000);
  });

  it("leaves threadSummary off a bucket nothing else shares", () => {
    /* A second identical figure on the row would read as a second
       measurement, so the split is carried only where there is one. */
    const groups = buildPricingSpendByModel({
      lines: [line({ usageLineId: "parent" })],
    });

    expect(groups[0]?.models[0]?.threadSummary).toBeUndefined();
  });

  it("counts PwrAgent's own helpers apart from dispatched sub-agents", () => {
    /* Token Miser gates and the thread namer bill real money, but the
       operator dispatched none of them; counting them as sub-agents reported
       reviewers that never ran. */
    const groups = buildPricingSpendByModel({
      lines: [
        line({ usageLineId: "parent" }),
        line({
          scope: "monitor",
          sourceItemId: "system:token-miser:gate-1",
          usageLineId: "gate-1",
        }),
        line({
          scope: "monitor",
          sourceItemId: "system:token-miser:gate-2",
          usageLineId: "gate-2",
        }),
        line({
          scope: "monitor",
          sourceItemId: "system:title-helper:codex:thread-1",
          usageLineId: "naming",
        }),
        line({
          scope: "monitor",
          sourceItemId: "review:sol",
          usageLineId: "reviewer",
        }),
      ],
    });

    const bucket = groups[0]?.models[0];
    expect(bucket?.subAgentCount).toBe(1);
    expect(bucket?.systemHelperCount).toBe(3);
    expect(bucket?.threadUsageLineCount).toBe(1);
  });

  it("marks a bucket that a history-gap estimate contributed to", () => {
    const groups = buildPricingSpendByModel({
      lines: [
        line({ usageLineId: "observed" }),
        line({
          estimatedUsageGap: true,
          model: "gpt-5.6-sol",
          provider: "openai",
          scope: "backfill",
          totalCostMicros: 56_230_000,
          usageLineId: "gap",
        }),
      ],
    });

    const byModel = new Map(
      groups.flatMap((group) =>
        group.models.map((model) => [model.model, model.hasEstimatedRows]),
      ),
    );
    expect(byModel.get("gpt-5.6-sol")).toBe(true);
    expect(byModel.get("grok-4.1-fast")).toBe(false);
  });
});

describe("prunePricingSpendOverrides", () => {
  it("drops an override whose bucket was re-keyed by a late model", () => {
    /* A helper's row arrives before its sub-agent summary, so the bucket the
       operator expanded as "Unknown model" is re-keyed once the model lands.
       Left in place, its override would open the next unrelated row. */
    const groups = buildPricingSpendByModel({
      lines: [line({ usageLineId: "parent" })],
    });

    expect(
      prunePricingSpendOverrides(
        { "xai:USD:": true, "xai:USD:grok-4.1-fast": false },
        groups,
      ),
    ).toEqual({ "xai:USD:grok-4.1-fast": false });
  });

  it("keeps every override while its bucket is still rendered", () => {
    const groups = buildPricingSpendByModel({
      lines: [line({ usageLineId: "parent" })],
    });
    const overrides = { "xai:USD:grok-4.1-fast": true };

    expect(prunePricingSpendOverrides(overrides, groups)).toEqual(overrides);
  });
});
