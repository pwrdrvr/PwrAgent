import { describe, expect, it } from "vitest";
import { normalizeGrokBillingStatus } from "../acp-provider-status";

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
        subscriptionTier: "SuperGrok Heavy",
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
