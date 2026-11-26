import { describe, expect, it } from "vitest";
import type { UsageLimitObservation } from "@pwragent/shared/contracts/usage-activity";
import { buildLimitAccounts, fiveHourSeries, limitLabel, projectLimit, seriesStart, sinceResetSeries } from "./usage-limits";

const HOUR = 3_600_000;
const studio = { owner: "Studio", target: { scope: "local" as const } };
const t0 = new Date(2026, 8, 28, 9).getTime();
const weekly = (at: number, usedPercent: number, resetAt = t0 + 7 * 24 * HOUR): UsageLimitObservation => ({
  observedAt: at, accountKey: "a", planType: "plus",
  limits: [{ name: "Weekly limit", windowKey: "secondary", usedPercent, resetAt, windowMinutes: 10_080 }],
});

describe("usage limit history", () => {
  it("measures pace from the scheduled window start when readings are sparse", () => {
    const [account] = buildLimitAccounts([{ ...studio, current: weekly(t0 + 3 * HOUR, 9) }]);
    const series = sinceResetSeries(account)!;
    expect(series.windowStart).toBe(t0);
    expect(series.pacePerHour).toBeCloseTo(3);
    expect(projectLimit(series)).toEqual({ kind: "full", at: t0 + 3 * HOUR + 91 / 3 * HOUR });
  });

  it("treats an unexplained drop as a reset and measures pace from the post-reset reading", () => {
    // The schedule says the window began days ago; an unscheduled drop was first
    // observed at 9:30 at 1%, then reached 7% two hours later (+3%/h).
    const resetAt = t0 + 4 * 24 * HOUR;
    const history = [weekly(t0 - HOUR, 62, resetAt), weekly(t0 + 30 * 60_000, 1, resetAt), weekly(t0 + 2.5 * HOUR, 7, resetAt)];
    const [account] = buildLimitAccounts([{ ...studio, history }]);
    const series = sinceResetSeries(account)!;
    expect(series.resets).toEqual([{ at: t0 + 30 * 60_000, kind: "unscheduled", after: t0 - HOUR, before: t0 + 30 * 60_000 }]);
    expect(series.windowStart).toBe(t0 + 30 * 60_000);
    expect(series.pacePerHour).toBeCloseTo(3);
    expect(projectLimit(series)).toEqual({ kind: "full", at: t0 + 2.5 * HOUR + 93 / 3 * HOUR });
  });

  it("does not inflate pace from the post-credit floor when usage stays flat after a mid-window reset", () => {
    const resetAt = t0 + 4 * 24 * HOUR;
    const creditHistory = [
      weekly(t0 - HOUR, 60, resetAt),
      weekly(t0 + 10 * 60_000, 35, resetAt),
      weekly(t0 + 2 * HOUR, 35, resetAt),
    ];
    const [creditAccount] = buildLimitAccounts([{ ...studio, history: creditHistory }]);
    expect(sinceResetSeries(creditAccount)!.pacePerHour).toBeUndefined();

    const resetHistory = [
      weekly(t0 - HOUR, 20, resetAt),
      weekly(t0 + 10 * 60_000, 0.7, resetAt),
      weekly(t0 + 70 * 60_000, 0.7, resetAt),
    ];
    const [resetAccount] = buildLimitAccounts([{ ...studio, history: resetHistory }]);
    expect(sinceResetSeries(resetAccount)!.pacePerHour).toBeUndefined();

    // A later coarse Claude stream reading rounding resetAt up to the hour must
    // not shift scheduledStart past the mid-window credit and re-count the floor.
    const claudeReset = t0 + 5 * HOUR;
    const claudeObs = (at: number, usedPercent: number, reset: number): UsageLimitObservation => ({
      observedAt: at, provider: "anthropic", accountKey: "a",
      limits: [{ name: "5-hour limit", limitId: "five_hour", usedPercent, resetAt: reset, windowMinutes: 300 }],
    });
    const [claudeAccount] = buildLimitAccounts([{
      ...studio,
      history: [claudeObs(t0 + 20 * 60_000, 25, claudeReset), claudeObs(t0 + 30 * 60_000, 8, claudeReset)],
      current: claudeObs(t0 + 90 * 60_000, 8, claudeReset + 45 * 60_000),
    }]);
    expect(sinceResetSeries(claudeAccount)!.pacePerHour).toBeUndefined();
  });

  it("detects an early reset when the deadline advances even without a usage drop", () => {
    const before = weekly(t0 - 2 * HOUR, 0.3, t0 + 3 * 24 * HOUR);
    const after = weekly(t0 + 20 * 60_000, 1.3, t0 + 7 * 24 * HOUR);
    const [account] = buildLimitAccounts([{ ...studio, history: [before], current: after }]);
    const series = sinceResetSeries(account)!;
    expect(series.resets).toEqual([{ at: t0, kind: "unscheduled", after: before.observedAt, before: after.observedAt }]);
    expect(series.windowStart).toBe(t0);
    // Only 20 minutes into a fresh weekly window: never fall back to pre-reset readings.
    expect(series.pacePerHour).toBeUndefined();
  });

  it("never falls back to pre-reset readings when a fresh window has clock-skewed resetAt", () => {
    const before = weekly(t0 - 4 * HOUR, 0.5, t0 + 3 * 24 * HOUR);
    // Provider clock is 15 minutes ahead of local observedAt on a fresh reset.
    const after = weekly(t0 + 5 * 60_000, 1.5, t0 + 20 * 60_000 + 7 * 24 * HOUR);
    const [account] = buildLimitAccounts([{ ...studio, history: [before], current: after }]);
    const series = sinceResetSeries(account)!;
    expect(series.resets).toHaveLength(1);
    expect(series.windowStart).toBe(after.observedAt);
    expect(series.pacePerHour).toBeUndefined();
  });

  it("withholds pace on a freshly reset weekly window with sub-percent usage or under an hour elapsed", () => {
    // 0.7% used 32 minutes after a weekly reset must not project +1.3%/h.
    const [tooEarly] = buildLimitAccounts([{ ...studio, current: weekly(t0 + 32 * 60_000, 0.7) }]);
    expect(sinceResetSeries(tooEarly)!.pacePerHour).toBeUndefined();

    // Even after 70 minutes, 0.7% is still sub-percent noise on a weekly window.
    const [subPercent] = buildLimitAccounts([{ ...studio, current: weekly(t0 + 70 * 60_000, 0.7) }]);
    expect(sinceResetSeries(subPercent)!.pacePerHour).toBeUndefined();

    // 1.5% after 45 minutes on a 7-day window waits for a full hour.
    const [underHour] = buildLimitAccounts([{ ...studio, current: weekly(t0 + 45 * 60_000, 1.5) }]);
    expect(sinceResetSeries(underHour)!.pacePerHour).toBeUndefined();
  });

  it("keeps a scheduled renewal classified as scheduled under minor deadline jitter", () => {
    const first = weekly(t0 - 2 * HOUR, 88, t0);
    const second = weekly(t0 + 2 * HOUR, 5, t0 + 7 * 24 * HOUR + 3 * 60_000);
    const [account] = buildLimitAccounts([{ ...studio, history: [first], current: second }]);
    expect(sinceResetSeries(account)!.resets).toEqual([
      { at: t0 + 3 * 60_000, kind: "scheduled", after: first.observedAt, before: second.observedAt },
    ]);
  });

  it("ignores stale-window relays from lagging owners and resolves same-timestamp ties deterministically", () => {
    const remote = { owner: "Mini", target: { scope: "remote" as const, instanceId: "mini" } };
    const oldReset = t0 + 3 * 24 * HOUR;
    const newReset = t0 + 7 * 24 * HOUR;
    const localHistory = [
      weekly(t0 - 2 * HOUR, 20, oldReset),
      weekly(t0 + HOUR, 2, newReset),
    ];
    // Lagging peer relays the superseded old window 5 minutes later, and also
    // collides with local at the exact same timestamp with a lower reading.
    const remoteHistory = [
      weekly(t0 + HOUR, 1, newReset),
      weekly(t0 + HOUR + 5 * 60_000, 20, oldReset),
    ];
    const [forward] = buildLimitAccounts([
      { ...studio, history: localHistory, current: weekly(t0 + 2 * HOUR, 4, newReset) },
      { ...remote, history: remoteHistory },
    ]);
    const [reversed] = buildLimitAccounts([
      { ...remote, history: remoteHistory },
      { ...studio, history: localHistory, current: weekly(t0 + 2 * HOUR, 4, newReset) },
    ]);
    const seriesFwd = sinceResetSeries(forward)!;
    const seriesRev = sinceResetSeries(reversed)!;
    expect(seriesFwd.latest.resetAt).toBe(newReset);
    expect(seriesFwd.resets).toHaveLength(1);
    expect(seriesFwd.windowStart).toBe(t0);
    expect(seriesFwd.pacePerHour).toBeCloseTo(2);
    expect(seriesRev).toEqual(seriesFwd);
  });

  it("refuses to project exhausted, expired, or sub-minute-before-reset limits", () => {
    const [exhausted] = buildLimitAccounts([{ ...studio, current: weekly(t0 + 10 * HOUR, 100) }]);
    expect(projectLimit(sinceResetSeries(exhausted)!)).toBeUndefined();

    const [expired] = buildLimitAccounts([{ ...studio, current: weekly(t0 + 8 * 24 * HOUR, 40, t0 + 7 * 24 * HOUR) }]);
    expect(projectLimit(sinceResetSeries(expired)!)).toBeUndefined();

    // Pace hits 100% 20 seconds before reset: report 100% at reset, never "0 m before the reset".
    const resetAt = t0 + 5 * HOUR;
    const [atBoundary] = buildLimitAccounts([{ ...studio, current: {
      observedAt: t0 + 2.5 * HOUR, accountKey: "a",
      limits: [{ name: "5h", windowKey: "primary", usedPercent: 50.06, resetAt, windowMinutes: 300 }],
    } }]);
    expect(projectLimit(sinceResetSeries(atBoundary)!)).toEqual({ kind: "atReset", percent: 100, resetAt });
  });

  it("starts an early reset's window from its new schedule when no reading saw it happen", () => {
    // The provider reset the week early at 9:00 and moved the reset to a week
    // later; this instance's next reading came six hours after.
    const before = weekly(t0 - 20 * HOUR, 64, t0 + 3 * 24 * HOUR);
    const after = weekly(t0 + 6 * HOUR, 22, t0 + 7 * 24 * HOUR);
    const [account] = buildLimitAccounts([{ ...studio, history: [before], current: after }]);
    const series = sinceResetSeries(account)!;
    expect(series.resets).toEqual([{ at: t0, kind: "unscheduled", after: t0 - 20 * HOUR, before: t0 + 6 * HOUR }]);
    expect(seriesStart(series)).toBe(t0);
    expect(series.pacePerHour).toBeCloseTo(22 / 6);
  });

  it("does not charge a whole week's usage to the half hour since an obsolete deadline", () => {
    const before = weekly(t0 - 28 * HOUR, 47, t0 + 41 * HOUR);
    const after = weekly(t0 + 41.5 * HOUR, 53);
    const [account] = buildLimitAccounts([{ ...studio, history: [before], current: after }]);
    const series = sinceResetSeries(account)!;
    expect(series.windowStart).toBe(t0);
    expect(series.resets).toEqual([{ at: t0, kind: "unscheduled", after: before.observedAt, before: after.observedAt }]);
    expect(series.pacePerHour).toBeCloseTo(53 / 41.5);
    expect(projectLimit(series)).toEqual({ kind: "full", at: after.observedAt + 47 / (53 / 41.5) * HOUR });
  });

  it("restarts where an early reset was first seen when its new schedule began before the previous reading", () => {
    // The new schedule claims a start three hours ago, but a reading an hour
    // ago was still in the old window, so the reset came after that reading.
    const before = weekly(t0 - HOUR, 62, t0 + 3 * 24 * HOUR);
    const after = weekly(t0 + HOUR, 5, t0 + 7 * 24 * HOUR - 3 * HOUR);
    const [account] = buildLimitAccounts([{ ...studio, history: [before], current: after }]);
    const series = sinceResetSeries(account)!;
    expect(series.resets).toEqual([{ at: t0 + HOUR, kind: "unscheduled", after: t0 - HOUR, before: t0 + HOUR }]);
    expect(seriesStart(series)).toBe(t0 + HOUR);
  });

  it("marks a reset scheduled when the previous window had elapsed", () => {
    const first = weekly(t0 - 2 * HOUR, 88, t0);
    const second = weekly(t0 + HOUR, 2, t0 + 7 * 24 * HOUR);
    const [account] = buildLimitAccounts([{ ...studio, history: [first, second] }]);
    expect(sinceResetSeries(account)!.resets).toEqual([{ at: t0, kind: "scheduled", after: t0 - 2 * HOUR, before: t0 + HOUR }]);
  });

  it("keeps the 15:00 renewal scheduled after a five-hour window's 10:00 deadline was missed", () => {
    const reading = (at: number, usedPercent: number, resetAt: number): UsageLimitObservation => ({
      observedAt: at, accountKey: "a", limits: [
        { name: "5-hour limit", windowKey: "primary", usedPercent, resetAt, windowMinutes: 300 },
      ],
    });
    const [account] = buildLimitAccounts([{ ...studio, history: [
      reading(t0, 88, t0 + HOUR),
    ], current: reading(t0 + 7 * HOUR, 12, t0 + 11 * HOUR) }]);
    const series = fiveHourSeries(account)!;
    expect(series.resets).toEqual([{ at: t0 + 6 * HOUR, kind: "scheduled", after: t0, before: t0 + 7 * HOUR }]);
    expect(series.windowStart).toBe(t0 + 6 * HOUR);
    expect(series.pacePerHour).toBeCloseTo(12);
  });

  it("keeps accounts apart and merges owners that share one", () => {
    const credit: UsageLimitObservation = { observedAt: t0 + HOUR, accountKey: "b", planType: "business", limits: [
      { name: "Individual limit", windowKey: "individual", usedPercent: 37.2, used: 37_223, limit: 100_000, resetAt: new Date(2026, 8, 30).getTime() },
      { name: "Credits", windowKey: "credits", hasCredits: true },
    ] };
    const accounts = buildLimitAccounts([
      { ...studio, current: weekly(t0 + 2 * HOUR, 9) },
      { owner: "Build", target: { scope: "remote", instanceId: "build" }, current: weekly(t0 + HOUR, 8) },
      { owner: "Work", target: { scope: "remote", instanceId: "work" }, current: credit },
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
    const [weeklyOnly] = buildLimitAccounts([{ ...studio, current: { observedAt: t0, accountKey: "pro", limits: [
      { name: "Weekly limit", windowKey: "primary", usedPercent: 3, resetAt: t0 + 7 * 24 * HOUR, windowMinutes: 10_080 },
    ] } }]);
    expect(fiveHourSeries(weeklyOnly)).toBeUndefined();
    expect(sinceResetSeries(weeklyOnly)!.windowKey).toBe("primary");
    expect(limitLabel(sinceResetSeries(weeklyOnly)!)).toBe("Weekly limit");
    const [both] = buildLimitAccounts([{ ...studio, current: { observedAt: t0, accountKey: "plus", limits: [
      { name: "5h limit", windowKey: "primary", usedPercent: 20, resetAt: t0 + 2 * HOUR, windowMinutes: 300 },
      { name: "Weekly limit", windowKey: "secondary", usedPercent: 9, resetAt: t0 + 4 * 24 * HOUR, windowMinutes: 10_080 },
    ] } }]);
    expect(fiveHourSeries(both)!.windowMinutes).toBe(300);
    expect(limitLabel(fiveHourSeries(both)!)).toBe("5-hour window");
    // An owner that never stated the length keeps the old reading of primary.
    const [unstated] = buildLimitAccounts([{ ...studio, current: { observedAt: t0, accountKey: "old", limits: [
      { name: "Primary limit", windowKey: "primary", usedPercent: 20 },
    ] } }]);
    expect(fiveHourSeries(unstated)!.name).toBe("Primary limit");
  });

  it("projects the level at the reset when the pace cannot fill the window first", () => {
    const [account] = buildLimitAccounts([{ ...studio, current: {
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
    const accounts = buildLimitAccounts([{ ...studio, current: [weekly(t0 + HOUR, 9), claude] }]);
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
