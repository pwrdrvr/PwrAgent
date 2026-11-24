import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeAntigravityUsageStatus, normalizeGrokBillingStatus } from "../acp/acp-provider-status";

describe("normalizeAntigravityUsageStatus", () => {
  it("reports each weekly pool independently of short windows and unrelated CLI output", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      fc.jsonValue(),
      (geminiRemaining, claudeRemaining, noise) => {
        const pools = [
          { name: "Gemini Models", id: "gemini-weekly", remaining: geminiRemaining, reset: "2026-11-30T08:00:00Z" },
          { name: "Claude and GPT models", id: "3p-weekly", remaining: claudeRemaining, reset: "2026-11-30T12:00:00Z" },
        ];
        const result = normalizeAntigravityUsageStatus({
          status: "SUCCESS",
          response: noise,
          usage: noise,
          command: {
            name: "usage",
            data: {
              description: noise,
              groups: pools.map(({ name, id, remaining, reset }) => ({
                name,
                description: noise,
                buckets: [
                  { id: id + "-5h", window: "5h", remaining_fraction: 0 },
                  { id, window: "weekly", remaining_fraction: remaining / 100, reset_time: reset },
                  { id: id + "-bad", window: "weekly", remaining_fraction: 1.1 },
                ],
              })),
            },
          },
        });
        expect(result?.rateLimits?.map(({ name, limitId, usedPercent, resetAt }) => ({
          name, limitId, used: Math.round(usedPercent!), resetAt,
        }))).toEqual([
          { name: "Weekly Gemini limit", limitId: "gemini-weekly", used: 100 - geminiRemaining, resetAt: Date.parse(pools[0]!.reset) },
          { name: "Weekly Claude/GPT limit", limitId: "3p-weekly", used: 100 - claudeRemaining, resetAt: Date.parse(pools[1]!.reset) },
        ]);
      },
    ));
  });

  it("ignores ordinary prompt output and skips quota without a known remaining fraction", () => {
    expect(normalizeAntigravityUsageStatus({ status: "SUCCESS", response: "Quota unavailable" })).toBeUndefined();
    expect(normalizeAntigravityUsageStatus({
      status: "SUCCESS",
      command: { name: "usage", data: { groups: [
        { name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly" }] },
      ] } },
    })).toBeUndefined();
  });
});

describe("normalizeGrokBillingStatus", () => {
  it("normalizes the current percentage-based weekly billing shape", () => {
    expect(
      normalizeGrokBillingStatus({
        config: {
          creditUsagePercent: 42.5,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-07-20T00:00:00Z",
            end: "2026-07-27T00:00:00Z",
          },
        },
        subscription_tier: "SuperGrok Heavy",
      }),
    ).toEqual({
      account: {
        type: "provider",
        label: "Grok account",
        planType: "SuperGrok Heavy",
      },
      rateLimits: [
        {
          name: "Weekly limit",
          usedPercent: 42.5,
          resetAt: Date.parse("2026-07-27T00:00:00Z"),
        },
      ],
    });
  });

  it("keeps camel-case subscription tiers as a compatibility fallback", () => {
    expect(
      normalizeGrokBillingStatus({
        config: null,
        subscriptionTier: "SuperGrok",
      }),
    ).toEqual({
      account: {
        type: "provider",
        label: "Grok account",
        planType: "SuperGrok",
      },
    });
  });

  it("supports the legacy monthly cent limit shape and result wrapper", () => {
    expect(
      normalizeGrokBillingStatus({
        result: {
          config: {
            monthlyLimit: { val: 2_000 },
            used: { val: 500 },
            billingPeriodEnd: "2026-08-01T00:00:00Z",
          },
        },
      }),
    ).toEqual({
      account: {
        type: "provider",
        label: "Grok account",
      },
      rateLimits: [
        {
          name: "Included credits",
          usedPercent: 25,
          resetAt: Date.parse("2026-08-01T00:00:00Z"),
        },
      ],
    });
  });

  it("returns no provider status when billing is unavailable", () => {
    expect(normalizeGrokBillingStatus({ config: null })).toBeUndefined();
  });
});
