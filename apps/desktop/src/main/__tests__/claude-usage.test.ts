import { describe, expect, it } from "vitest";
import type { ModelUsage, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeRateLimits, claudeStreamRateLimits, claudeTurnUsage, liveClaudeRateLimits,
  mergeClaudeRateLimits, nextClaudeRateLimitReset,
} from "../claude/claude-usage";

const model: ModelUsage = {
  inputTokens: 100, outputTokens: 40, thinkingTokens: 10,
  cacheReadInputTokens: 200, cacheCreationInputTokens: 50,
  costUSD: 0.125, webSearchRequests: 0, contextWindow: 200_000, maxOutputTokens: 32_000,
};

describe("Claude usage normalization", () => {
  it("normalizes sparse stream windows from fractional utilization and epoch seconds", () => {
    const info = { status: "allowed" as const, unifiedWindows: {
      five_hour: { utilization: 0.24, resetsAt: 1788465600 },
      seven_day: { utilization: 0.13, resetsAt: 1789005600 },
    } };
    expect(claudeStreamRateLimits(info)).toEqual([
      { name: "5-hour limit", limitId: "five_hour", usedPercent: 24, resetAt: 1788465600000, windowMinutes: 300 },
      { name: "Weekly limit", limitId: "seven_day", usedPercent: 13, resetAt: 1789005600000, windowMinutes: 10_080 },
    ]);
    expect(claudeStreamRateLimits({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5 })[0].usedPercent).toBe(50);
  });
  it("counts cache creation, reads, and subagents without double-counting thinking", () => {
    expect(claudeTurnUsage({ opus: model, haiku: model })).toEqual({
      last: { inputTokens: 700, cachedInputTokens: 400, cacheWriteInputTokens: 100,
        outputTokens: 80, reasoningOutputTokens: 20, totalTokens: 780 },
      claudeCostUSD: 0.25, model: "opus, haiku",
    });
  });
  it("subtracts resumed totals and handles a clear resetting them", () => {
    expect(claudeTurnUsage({ opus: model }, { opus: model }).last.totalTokens).toBe(0);
    const next = { ...model, inputTokens: 120, costUSD: 0.15 };
    expect(claudeTurnUsage({ opus: next }, { opus: model }).last.totalTokens).toBe(20);
    expect(claudeTurnUsage({ opus: next }, { opus: model }).claudeCostUSD).toBeCloseTo(0.025);
    expect(claudeTurnUsage({ opus: model }, { opus: next }).claudeCostUSD).toBe(0.125);
  });
  it("reports only actual Claude limit windows, not extra-usage credit balances", () => {
    const usage = { rate_limits_available: true, rate_limits: {
      seven_day: { utilization: 22, resets_at: "2026-10-27T00:00:00Z" },
      five_hour: { utilization: null, resets_at: null },
      extra_usage: { is_enabled: true, used_credits: 50 },
    } } as unknown as SDKControlGetUsageResponse;
    expect(claudeRateLimits(usage)).toEqual([{ name: "Weekly limit", limitId: "seven_day",
      usedPercent: 22, resetAt: Date.parse("2026-10-27T00:00:00Z"), windowMinutes: 10_080 }]);
    expect(claudeRateLimits({ ...usage, rate_limits_available: false })).toEqual([]);
  });
  it("reads per-model weekly windows and names cloud credits and unknown keys", () => {
    const usage = { rate_limits_available: true, rate_limits: {
      seven_day: { utilization: 25, resets_at: "2026-10-27T11:00:00Z" },
      iguana_necktie: { utilization: 30, resets_at: "2026-11-05T07:59:00Z" },
      walrus_monocle: { utilization: 5, resets_at: null },
      model_scoped: [
        { display_name: "Fable", utilization: 40, resets_at: "2026-10-27T11:00:00Z" },
        { display_name: "Haiku", utilization: null, resets_at: null },
      ],
    } } as unknown as SDKControlGetUsageResponse;
    expect(claudeRateLimits(usage)).toEqual([
      { name: "Weekly limit", limitId: "seven_day", usedPercent: 25, resetAt: Date.parse("2026-10-27T11:00:00Z"),
        windowMinutes: 10_080 },
      { name: "Cloud session credits", limitId: "iguana_necktie", usedPercent: 30,
        resetAt: Date.parse("2026-11-05T07:59:00Z"), expires: true },
      { name: "Other plan limit", limitId: "walrus_monocle", limitName: "walrus_monocle", usedPercent: 5 },
      { name: "Weekly Fable limit", limitId: "seven_day_overage_included", usedPercent: 40,
        resetAt: Date.parse("2026-10-27T11:00:00Z"), windowMinutes: 10_080 },
    ]);
  });
  it("labels the streamed overage windows instead of printing their keys", () => {
    const names = claudeStreamRateLimits({ status: "allowed", unifiedWindows: {
      seven_day_overage_included: { utilization: 0.1, resetsAt: 1789005600 },
    } } as never).map((limit) => limit.name);
    expect(names).toEqual(["Weekly Fable limit"]);
    expect(claudeStreamRateLimits({ status: "allowed", rateLimitType: "overage", utilization: 0.2 })[0].name)
      .toBe("Extra usage");
  });
  it("merges Fable snapshots and stream readings into one weekly allowance", () => {
    const now = Date.parse("2026-10-21T14:30:00Z");
    const snapshot = claudeRateLimits({ rate_limits_available: true, rate_limits: {
      seven_day: { utilization: 11, resets_at: "2026-10-27T11:00:00Z" },
      model_scoped: [{ display_name: "Fable", utilization: 10.8, resets_at: "2026-10-27T10:20:00Z" }],
    } } as SDKControlGetUsageResponse);
    const stream = claudeStreamRateLimits({ status: "allowed", rateLimitType: "seven_day_overage_included",
      utilization: 0.11, resetsAt: Date.parse("2026-10-27T11:00:00Z") / 1000 });
    const merged = mergeClaudeRateLimits(snapshot, stream, now);
    expect(merged).toEqual([snapshot[0], { ...snapshot[1], usedPercent: 11 }]);
    expect(mergeClaudeRateLimits(merged, stream, now)).toEqual(merged);
    const next = { ...stream[0], usedPercent: 1, resetAt: Date.parse("2026-11-03T11:00:00Z") };
    expect(mergeClaudeRateLimits(merged, [next], now)).toEqual([snapshot[0], next]);
  });
  it("collapses already cached Fable aliases before displaying limits", () => {
    const named = { name: "Weekly Fable limit", limitId: "model_scoped:Fable", usedPercent: 10.8,
      resetAt: 10_000, windowMinutes: 10_080 };
    const streamed = { ...named, name: "Weekly limit with extra usage", limitId: "seven_day_overage_included",
      usedPercent: 11 };
    const expected = [{ ...named, limitId: "seven_day_overage_included", usedPercent: 11 }];
    expect(liveClaudeRateLimits([named, streamed], 1_000)).toEqual(expected);
    expect(mergeClaudeRateLimits([named, streamed], [], 1_000)).toEqual(expected);
    expect(liveClaudeRateLimits([named, streamed], 10_000)).toEqual([]);
  });
  it("raises a live window from the stream but takes a reading from the next window", () => {
    const hour = 3_600_000;
    const now = Date.parse("2026-10-21T14:30:00Z");
    // Known from an earlier stream event, its reset rounded up to the hour.
    const known = { name: "5-hour limit", limitId: "five_hour", usedPercent: 98, resetAt: now + hour / 2 };
    expect(mergeClaudeRateLimits([known], [{ ...known, usedPercent: 99 }], now))
      .toEqual([{ ...known, usedPercent: 99 }]);
    expect(mergeClaudeRateLimits([known], [{ ...known, usedPercent: 40, resetAt: known.resetAt + hour }], now))
      .toEqual([known]);
    // The window reset early and a new one began: a far later reset replaces it.
    const next = { ...known, usedPercent: 2, resetAt: now + 5 * hour };
    expect(mergeClaudeRateLimits([known], [next], now)).toEqual([next]);
  });
  it("keeps an unknown reading unknown when merging", () => {
    const known = { name: "Weekly limit", limitId: "seven_day", resetAt: 2_000 };
    expect(mergeClaudeRateLimits([known], [{ name: "Weekly limit", limitId: "seven_day" }], 1_000))
      .toEqual([known]);
    expect(mergeClaudeRateLimits([known], [{ ...known, usedPercent: 5 }], 1_000))
      .toEqual([{ ...known, usedPercent: 5 }]);
  });
  it("only moves each window forward when readings arrive out of order", () => {
    const hour = 3_600_000;
    const now = Date.parse("2026-11-01T20:00:00Z");
    const weeklyReset = Date.parse("2026-11-03T14:00:00Z");
    const credits = { name: "Cloud session credits", limitId: "iguana_necktie", usedPercent: 33,
      resetAt: Date.parse("2026-11-05T10:59:00Z"), expires: true };
    const fable = { name: "Weekly Fable limit", limitId: "seven_day_overage_included", usedPercent: 0,
      resetAt: weeklyReset, windowMinutes: 10_080 };
    const shown = [{ name: "Weekly limit", limitId: "seven_day", usedPercent: 50, resetAt: weeklyReset,
      windowMinutes: 10_080 }, credits, fable];
    // Another CLI's probe, taken before the stream reading above: one window, lower.
    const older = [{ name: "Weekly limit", limitId: "seven_day", usedPercent: 49.4, resetAt: weeklyReset - 17 * 60_000,
      windowMinutes: 10_080 }];
    const merged = mergeClaudeRateLimits(shown, older, now, { precise: true });
    expect(merged).toEqual([{ ...older[0], usedPercent: 50 }, credits, fable]);
    // A reading from the window before the reset is ignored outright.
    const lastWeek = [{ ...older[0], usedPercent: 97, resetAt: weeklyReset - 7 * 24 * hour }];
    expect(mergeClaudeRateLimits(merged, lastWeek, now, { precise: true })).toEqual(merged);
    // A higher reading of the same window moves it forward.
    const newer = [{ ...older[0], usedPercent: 51.2 }];
    expect(mergeClaudeRateLimits(merged, newer, now, { precise: true })[0].usedPercent).toBe(51.2);
  });
  it("lets a precise reading refine a stream window's reset but not the reverse", () => {
    const now = Date.parse("2026-11-01T20:00:00Z");
    const streamed = { name: "5-hour limit", limitId: "five_hour", usedPercent: 12, resetAt: Date.parse("2026-11-01T23:00:00Z") };
    const probed = { ...streamed, usedPercent: 11.6, resetAt: Date.parse("2026-11-01T22:21:00Z") };
    expect(mergeClaudeRateLimits([streamed], [probed], now, { precise: true }))
      .toEqual([{ ...probed, usedPercent: 12 }]);
    expect(mergeClaudeRateLimits([probed], [streamed], now)).toEqual([{ ...probed, usedPercent: 12 }]);
  });
  it("finds the next reset still ahead", () => {
    expect(nextClaudeRateLimitReset([
      { name: "a", limitId: "a", resetAt: 500 }, { name: "b", limitId: "b", resetAt: 3_000 },
      { name: "c", limitId: "c", resetAt: 2_000 }, { name: "d", limitId: "d" },
    ], 1_000)).toBe(2_000);
    expect(nextClaudeRateLimitReset([{ name: "a", limitId: "a", resetAt: 500 }], 1_000)).toBeUndefined();
  });
});
