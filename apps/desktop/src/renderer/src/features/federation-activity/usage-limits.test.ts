import { describe, expect, it } from "vitest";
import type { UsageLimitObservation } from "@pwragent/shared";
import { buildLimitAccounts, fiveHourSeries, limitLabel, projectLimit, seriesStart, sinceResetSeries } from "./usage-limits";

const HOUR = 3_600_000;
const t0 = new Date(2026, 8, 28, 9).getTime();
const weekly = (at: number, usedPercent: number, resetAt = t0 + 7 * 24 * HOUR): UsageLimitObservation => ({
  observedAt: at, accountKey: "a", planType: "plus",
  limits: [{ name: "Weekly limit", windowKey: "secondary", usedPercent, resetAt, windowMinutes: 10_080 }],
});

describe("usage limit history", () => {
  it("measures pace from the scheduled window start when readings are sparse", () => {
    const [account] = buildLimitAccounts([{ owner: "Studio", current: weekly(t0 + 3 * HOUR, 9) }]);
    const series = sinceResetSeries(account)!;
    expect(series.windowStart).toBe(t0);
    expect(series.pacePerHour).toBeCloseTo(3);
    expect(projectLimit(series)).toEqual({ kind: "full", at: t0 + 3 * HOUR + 91 / 3 * HOUR });
  });

  it("treats an unexplained drop as a reset and restarts the window where it was first seen", () => {
    // The schedule says the window began days ago; the operator reset it at 9:30.
    const resetAt = t0 + 4 * 24 * HOUR;
    const history = [weekly(t0 - HOUR, 62, resetAt), weekly(t0 + 30 * 60_000, 1, resetAt), weekly(t0 + 2.5 * HOUR, 7, resetAt)];
    const [account] = buildLimitAccounts([{ owner: "Studio", history }]);
    const series = sinceResetSeries(account)!;
    expect(series.resets).toEqual([{ at: t0 + 30 * 60_000, kind: "unscheduled", after: t0 - HOUR, before: t0 + 30 * 60_000 }]);
    expect(series.windowStart).toBe(t0 + 30 * 60_000);
    expect(series.pacePerHour).toBeCloseTo(3.5);
    expect(projectLimit(series)).toEqual({ kind: "full", at: t0 + 2.5 * HOUR + 93 / 3.5 * HOUR });
  });

  it("starts an early reset's window from its new schedule when no reading saw it happen", () => {
    // The provider reset the week early at 9:00 and moved the reset to a week
    // later; this instance's next reading came six hours after.
    const before = weekly(t0 - 20 * HOUR, 64, t0 + 3 * 24 * HOUR);
    const after = weekly(t0 + 6 * HOUR, 22, t0 + 7 * 24 * HOUR);
    const [account] = buildLimitAccounts([{ owner: "Studio", history: [before], current: after }]);
    const series = sinceResetSeries(account)!;
    expect(series.resets).toEqual([{ at: t0, kind: "unscheduled", after: t0 - 20 * HOUR, before: t0 + 6 * HOUR }]);
    expect(seriesStart(series)).toBe(t0);
    expect(series.pacePerHour).toBeCloseTo(22 / 6);
  });

  it("restarts where an early reset was first seen when its new schedule began before the previous reading", () => {
    // The new schedule claims a start three hours ago, but a reading an hour
    // ago was still in the old window, so the reset came after that reading.
    const before = weekly(t0 - HOUR, 62, t0 + 3 * 24 * HOUR);
    const after = weekly(t0 + HOUR, 5, t0 + 7 * 24 * HOUR - 3 * HOUR);
    const [account] = buildLimitAccounts([{ owner: "Studio", history: [before], current: after }]);
    const series = sinceResetSeries(account)!;
    expect(series.resets).toEqual([{ at: t0 + HOUR, kind: "unscheduled", after: t0 - HOUR, before: t0 + HOUR }]);
    expect(seriesStart(series)).toBe(t0 + HOUR);
  });

  it("marks a reset scheduled when the previous window had elapsed", () => {
    const first = weekly(t0 - 2 * HOUR, 88, t0);
    const second = weekly(t0 + HOUR, 2, t0 + 7 * 24 * HOUR);
    const [account] = buildLimitAccounts([{ owner: "Studio", history: [first, second] }]);
    expect(sinceResetSeries(account)!.resets).toEqual([{ at: t0, kind: "scheduled", after: t0 - 2 * HOUR, before: t0 + HOUR }]);
  });

  it("keeps accounts apart and merges owners that share one", () => {
    const credit: UsageLimitObservation = { observedAt: t0 + HOUR, accountKey: "b", planType: "business", limits: [
      { name: "Individual limit", windowKey: "individual", usedPercent: 37.2, used: 37_223, limit: 100_000, resetAt: new Date(2026, 8, 30).getTime() },
      { name: "Credits", windowKey: "credits", hasCredits: true },
    ] };
    const accounts = buildLimitAccounts([
      { owner: "Studio", current: weekly(t0 + 2 * HOUR, 9) },
      { owner: "Build", current: weekly(t0 + HOUR, 8) },
      { owner: "Work", current: credit },
    ]);
    expect(accounts.map((account) => [account.key, account.owners])).toEqual([
      ["account:a", ["Studio", "Build"]],
      ["account:b", ["Work"]],
    ]);
    expect(accounts[0].series[0].points.map((point) => point.usedPercent)).toEqual([8, 9]);
    const individual = sinceResetSeries(accounts[1])!;
    expect(individual.windowKey).toBe("individual");
    expect(accounts[1].credits).toEqual({ hasCredits: true, unlimited: undefined });
    // No stated window length: the credit limit's window is the month before its reset.
    expect(seriesStart(individual)).toBe(new Date(2026, 7, 30).getTime());
  });

  it("finds the 5-hour limit by its length, not its position", () => {
    // Codex reports an account whose only limit is weekly as its primary window.
    const [weeklyOnly] = buildLimitAccounts([{ owner: "Studio", current: { observedAt: t0, accountKey: "pro", limits: [
      { name: "Weekly limit", windowKey: "primary", usedPercent: 3, resetAt: t0 + 7 * 24 * HOUR, windowMinutes: 10_080 },
    ] } }]);
    expect(fiveHourSeries(weeklyOnly)).toBeUndefined();
    expect(sinceResetSeries(weeklyOnly)!.windowKey).toBe("primary");
    expect(limitLabel(sinceResetSeries(weeklyOnly)!)).toBe("Weekly limit");
    const [both] = buildLimitAccounts([{ owner: "Studio", current: { observedAt: t0, accountKey: "plus", limits: [
      { name: "5h limit", windowKey: "primary", usedPercent: 20, resetAt: t0 + 2 * HOUR, windowMinutes: 300 },
      { name: "Weekly limit", windowKey: "secondary", usedPercent: 9, resetAt: t0 + 4 * 24 * HOUR, windowMinutes: 10_080 },
    ] } }]);
    expect(fiveHourSeries(both)!.windowMinutes).toBe(300);
    expect(limitLabel(fiveHourSeries(both)!)).toBe("5-hour window");
    // An owner that never stated the length keeps the old reading of primary.
    const [unstated] = buildLimitAccounts([{ owner: "Studio", current: { observedAt: t0, accountKey: "old", limits: [
      { name: "Primary limit", windowKey: "primary", usedPercent: 20 },
    ] } }]);
    expect(fiveHourSeries(unstated)!.name).toBe("Primary limit");
  });

  it("projects the level at the reset when the pace cannot fill the window first", () => {
    const [account] = buildLimitAccounts([{ owner: "Studio", current: {
      observedAt: t0 + 3 * HOUR, accountKey: "a",
      limits: [{ name: "5h", windowKey: "primary", usedPercent: 30, resetAt: t0 + 5 * HOUR, windowMinutes: 300 }],
    } }]);
    expect(projectLimit(account.series[0])).toEqual({ kind: "atReset", percent: 50, resetAt: t0 + 5 * HOUR });
  });

  it("keeps each provider's account apart and labels Claude's weekly limits by name", () => {
    const claude: UsageLimitObservation = { observedAt: t0, provider: "anthropic", accountKey: "a", planType: "max", limits: [
      { name: "Weekly Opus limit", limitId: "seven_day_opus", usedPercent: 3, resetAt: t0 + 5 * 24 * HOUR, windowMinutes: 10_080 },
      { name: "Weekly limit", limitId: "seven_day", usedPercent: 30, resetAt: t0 + 5 * 24 * HOUR, windowMinutes: 10_080 },
      { name: "5-hour limit", limitId: "five_hour", usedPercent: 9, resetAt: t0 + HOUR, windowMinutes: 300 },
      { name: "Cloud session credits", limitId: "iguana_necktie", usedPercent: 30, resetAt: t0 + 9 * 24 * HOUR, expires: true },
    ] };
    // The same opaque key from two providers is two accounts.
    const accounts = buildLimitAccounts([{ owner: "Studio", current: [weekly(t0 + HOUR, 9), claude] }]);
    expect(accounts.map((account) => [account.key, account.provider])).toEqual([
      ["account:a", "openai"], ["account:anthropic:a", "anthropic"]]);
    const series = accounts[1].series;
    // The account-wide weekly limit leads, whatever order Claude sent.
    expect(series.map(limitLabel)).toEqual(["5-hour window", "Weekly limit", "Weekly Opus limit", "Cloud session credits"]);
    expect(fiveHourSeries(accounts[1])?.name).toBe("5-hour limit");
    expect(sinceResetSeries(accounts[1])?.limitId).toBe("seven_day");
    expect(series.at(-1)!.latest.expires).toBe(true);
  });
});
