import { describe, expect, it } from "vitest";
import type { UsageLimitObservation } from "@pwragent/shared";
import { buildLimitAccounts, projectLimit, seriesStart, sinceResetSeries } from "./usage-limits";

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

  it("projects the level at the reset when the pace cannot fill the window first", () => {
    const [account] = buildLimitAccounts([{ owner: "Studio", current: {
      observedAt: t0 + 3 * HOUR, accountKey: "a",
      limits: [{ name: "5h", windowKey: "primary", usedPercent: 30, resetAt: t0 + 5 * HOUR, windowMinutes: 300 }],
    } }]);
    expect(projectLimit(account.series[0])).toEqual({ kind: "atReset", percent: 50, resetAt: t0 + 5 * HOUR });
  });
});
