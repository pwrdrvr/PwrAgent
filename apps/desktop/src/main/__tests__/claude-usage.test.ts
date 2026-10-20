import { describe, expect, it } from "vitest";
import type { ModelUsage, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { claudeRateLimits, claudeStreamRateLimits, claudeTurnUsage } from "../claude/claude-usage";

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
      { name: "5-hour limit", limitId: "five_hour", usedPercent: 24, resetAt: 1788465600000 },
      { name: "Weekly limit", limitId: "seven_day", usedPercent: 13, resetAt: 1789005600000 },
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
      usedPercent: 22, resetAt: Date.parse("2026-10-27T00:00:00Z") }]);
    expect(claudeRateLimits({ ...usage, rate_limits_available: false })).toEqual([]);
  });
});
