import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeAntigravityUsageStatus, normalizeGrokBillingStatus } from "../acp/acp-provider-status";

describe("normalizeAntigravityUsageStatus", () => {
  it("reports every valid 5h and weekly pool while skipping unknown windows, invalid fractions, and epoch resets", () => {
    const validReset = fc.integer({
      min: Date.UTC(2026, 0, 1),
      max: Date.UTC(2028, 0, 1),
    }).map((ms) => new Date(ms).toISOString());
    const invalidReset = fc.constantFrom(
      undefined,
      "",
      "not-a-timestamp",
      "1970-01-01T00:00:00Z",
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00+00:00",
      "1969-12-31T23:59:59Z",
    );
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      fc.oneof(validReset, invalidReset),
      fc.constantFrom("daily", "monthly", "1h", "toString", "constructor"),
      fc.constantFrom(-0.01, -1, 1.01, 2, Number.NaN, Number.POSITIVE_INFINITY, undefined),
      fc.jsonValue(),
      (gemini5h, geminiWeekly, claude5h, claudeWeekly, fiveHourReset, unknownWindow, badFraction, noise) => {
        const weeklyGeminiReset = "2026-11-30T08:00:00Z";
        const weeklyClaudeReset = "2026-11-30T12:00:00Z";
        const fiveHourClaudeReset = "2026-11-26T18:00:00Z";
        const expectedFiveHourGeminiReset = fiveHourReset && Date.parse(fiveHourReset) > 0
          ? Date.parse(fiveHourReset)
          : undefined;
        const result = normalizeAntigravityUsageStatus({
          status: "SUCCESS",
          response: noise,
          usage: noise,
          command: {
            name: "usage",
            data: {
              description: noise,
              groups: [
                {
                  name: "Gemini Models",
                  description: noise,
                  buckets: [
                    {
                      id: "gemini-5h",
                      window: "5h",
                      remaining_fraction: gemini5h / 100,
                      ...(fiveHourReset !== undefined ? { reset_time: fiveHourReset } : {}),
                    },
                    {
                      id: "gemini-weekly",
                      window: "weekly",
                      remaining_fraction: geminiWeekly / 100,
                      reset_time: weeklyGeminiReset,
                    },
                    { id: "gemini-unknown", window: unknownWindow, remaining_fraction: 0.5 },
                    { id: "gemini-bad", window: "5h", remaining_fraction: badFraction },
                  ],
                },
                {
                  name: "Claude and GPT models",
                  description: noise,
                  buckets: [
                    {
                      id: "3p-5h",
                      window: "5h",
                      remaining_fraction: claude5h / 100,
                      reset_time: fiveHourClaudeReset,
                    },
                    {
                      id: "3p-weekly",
                      window: "weekly",
                      remaining_fraction: claudeWeekly / 100,
                      reset_time: weeklyClaudeReset,
                    },
                    { id: "3p-bad", window: "weekly", remaining_fraction: badFraction },
                  ],
                },
              ],
            },
          },
        });
        expect(result?.rateLimits?.map(({ name, limitId, usedPercent, resetAt, windowMinutes }) => ({
          name,
          limitId,
          used: Math.round(usedPercent!),
          hasResetAt: resetAt !== undefined,
          resetAt,
          windowMinutes,
        }))).toEqual([
          {
            name: "5h Gemini limit",
            limitId: "gemini-5h",
            used: 100 - gemini5h,
            hasResetAt: expectedFiveHourGeminiReset !== undefined,
            resetAt: expectedFiveHourGeminiReset,
            windowMinutes: 300,
          },
          {
            name: "Weekly Gemini limit",
            limitId: "gemini-weekly",
            used: 100 - geminiWeekly,
            hasResetAt: true,
            resetAt: Date.parse(weeklyGeminiReset),
            windowMinutes: 10_080,
          },
          {
            name: "5h Claude/GPT limit",
            limitId: "3p-5h",
            used: 100 - claude5h,
            hasResetAt: true,
            resetAt: Date.parse(fiveHourClaudeReset),
            windowMinutes: 300,
          },
          {
            name: "Weekly Claude/GPT limit",
            limitId: "3p-weekly",
            used: 100 - claudeWeekly,
            hasResetAt: true,
            resetAt: Date.parse(weeklyClaudeReset),
            windowMinutes: 10_080,
          },
        ]);
      },
    ));
  });

  it("emits valid 5h and weekly buckets and omits Unix epoch reset timestamps", () => {
    const result = normalizeAntigravityUsageStatus({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  id: "gemini-5h",
                  window: "5h",
                  remaining_fraction: 1,
                  reset_time: "1970-01-01T00:00:00Z",
                },
                {
                  id: "gemini-weekly",
                  window: "weekly",
                  remaining_fraction: 0.75,
                  reset_time: "2026-11-30T08:00:00Z",
                },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                {
                  id: "3p-5h",
                  window: "5h",
                  remaining_fraction: 0.6,
                  reset_time: "2026-11-26T18:00:00Z",
                },
                {
                  id: "3p-weekly",
                  window: "weekly",
                  remaining_fraction: 0.8,
                  reset_time: "2026-11-30T12:00:00Z",
                },
              ],
            },
          ],
        },
      },
    });
    expect(result).toEqual({
      rateLimits: [
        {
          name: "5h Gemini limit",
          limitId: "gemini-5h",
          usedPercent: 0,
          windowMinutes: 300,
        },
        {
          name: "Weekly Gemini limit",
          limitId: "gemini-weekly",
          usedPercent: 25,
          windowMinutes: 10_080,
          resetAt: Date.parse("2026-11-30T08:00:00Z"),
        },
        {
          name: "5h Claude/GPT limit",
          limitId: "3p-5h",
          usedPercent: 40,
          windowMinutes: 300,
          resetAt: Date.parse("2026-11-26T18:00:00Z"),
        },
        {
          name: "Weekly Claude/GPT limit",
          limitId: "3p-weekly",
          usedPercent: 20,
          windowMinutes: 10_080,
          resetAt: Date.parse("2026-11-30T12:00:00Z"),
        },
      ],
    });
    expect("resetAt" in result!.rateLimits![0]!).toBe(false);
  });

  it("ignores ordinary prompt output and skips quota without a valid remaining fraction or window", () => {
    expect(normalizeAntigravityUsageStatus({ status: "SUCCESS", response: "Quota unavailable" })).toBeUndefined();
    expect(normalizeAntigravityUsageStatus({
      status: "SUCCESS",
      command: { name: "usage", data: { groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", window: "weekly" },
            { id: "gemini-5h-low", window: "5h", remaining_fraction: -0.1 },
            { id: "gemini-5h-high", window: "5h", remaining_fraction: 1.1 },
            { id: "gemini-daily", window: "daily", remaining_fraction: 0.5 },
          ],
        },
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
