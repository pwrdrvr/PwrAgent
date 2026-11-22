import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { UsageLimitObservation } from "@pwragent/shared/contracts/usage-activity";
import { buildLimitAccounts, projectLimit, sinceResetSeries } from "../usage-limits";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 8, 27, 21);
const WEEK = 168 * HOUR;
const fixtureOwner = { owner: "Fixture", target: { scope: "local" as const } };

function weekly(at: number, usedPercent: number, resetAt: number, provider = "openai"): UsageLimitObservation {
  return { observedAt: at, provider, accountKey: "fixture-account", limits: [
    { name: "Weekly limit", windowKey: "secondary", usedPercent, resetAt, windowMinutes: 10_080 },
  ] };
}

describe("usage limit schedule properties", () => {
  it("groups keyless limits by instance identity even when display names match or change", () => {
    fc.assert(fc.property(fc.stringMatching(/^Host[A-Z]{0,6}$/), fc.integer({ min: 1, max: 99 }), (owner, percent) => {
      const keyless = (at: number, used: number) => ({ ...weekly(at, used, START + WEEK), accountKey: undefined });
      const local = { scope: "local" as const };
      const remote = { scope: "remote" as const, instanceId: "studio" };
      const sources = [
        { owner, target: local, current: keyless(START + HOUR, percent) },
        { owner, target: remote, current: keyless(START + HOUR, percent + 1) },
        { owner: `${owner} renamed`, target: remote, current: keyless(START + 2 * HOUR, percent + 1) },
      ];
      const accounts = buildLimitAccounts(sources);
      expect(accounts.map(({ series }) => series[0]?.points.map((point) => point.usedPercent)))
        .toEqual([[percent + 1, percent + 1], [percent]]);
      expect(accounts.map(({ key }) => key)).toEqual(buildLimitAccounts(sources.map((source) => ({
        ...source, owner: `${source.owner} renamed again`,
      }))).map(({ key }) => key));
    }));
  });

  it("keeps regular renewals scheduled across any number of skipped windows", () => {
    fc.assert(fc.property(fc.record({
      windowMinutes: fc.constantFrom(300, 10_080),
      skippedWindows: fc.integer({ min: 0, max: 12 }),
      oldPercent: fc.integer({ min: 0, max: 100 }),
      usedPercent: fc.integer({ min: 1, max: 99 }),
    }), ({ windowMinutes, skippedWindows, oldPercent, usedPercent }) => {
      const duration = windowMinutes * 60_000;
      const windowStart = START + skippedWindows * duration;
      const reading = (at: number, percent: number, resetAt: number): UsageLimitObservation => ({
        observedAt: at, accountKey: "fixture-account", limits: [
          { name: "Limit", windowKey: "primary", usedPercent: percent, resetAt, windowMinutes },
        ],
      });
      const [account] = buildLimitAccounts([{ ...fixtureOwner, history: [
        reading(START - HOUR, oldPercent, START),
      ], current: reading(windowStart + HOUR, usedPercent, windowStart + duration) }]);
      const series = sinceResetSeries(account)!;
      expect(series.resets).toEqual([{
        at: windowStart, kind: "scheduled", after: START - HOUR, before: windowStart + HOUR,
      }]);
      expect(series.windowStart).toBe(windowStart);
      expect(series.pacePerHour).toBeCloseTo(usedPercent);
    }));
  });

  it("uses the current window's schedule even when an older deadline has since passed", () => {
    // The new schedule places a reset inside the gap between readings. An
    // obsolete deadline later in that gap cannot move its zero-usage origin.
    fc.assert(fc.property(fc.record({
      beforeHours: fc.integer({ min: 1, max: 72 }),
      elapsedMinutes: fc.integer({ min: 60, max: 72 * 60 }),
      oldPercent: fc.integer({ min: 0, max: 100 }),
      usedPercent: fc.integer({ min: 1, max: 99 }),
    }), ({ beforeHours, elapsedMinutes, oldPercent, usedPercent }) => {
      const elapsed = elapsedMinutes * 60_000;
      const [account] = buildLimitAccounts([{ ...fixtureOwner, history: [
        weekly(START - beforeHours * HOUR, oldPercent, START + elapsed / 2),
      ], current: weekly(START + elapsed, usedPercent, START + WEEK) }]);
      const series = sinceResetSeries(account)!;
      expect(series.windowStart).toBe(START);
      expect(series.resets).toEqual([{
        at: START, kind: "unscheduled", after: START - beforeHours * HOUR, before: START + elapsed,
      }]);
      expect(series.pacePerHour).toBeCloseTo(usedPercent / (elapsed / HOUR));
      const fullAt = START + elapsed * 100 / usedPercent;
      const projection = projectLimit(series)!;
      if (fullAt <= START + WEEK) {
        expect(projection.kind).toBe("full");
        if (projection.kind === "full") expect(projection.at).toBeCloseTo(fullAt, 0);
      } else {
        expect(projection.kind).toBe("atReset");
        if (projection.kind === "atReset") expect(projection.percent).toBeCloseTo(usedPercent * WEEK / elapsed);
      }
    }));
  });

  it("keeps another provider's percentages and deadlines out of the Codex series", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }),
      (codexPercent, claudePercent) => {
        const codex = weekly(START + 48 * HOUR, codexPercent, START + WEEK);
        const claude = weekly(START + 49 * HOUR, claudePercent, START + 2 * WEEK, "anthropic");
        const [expected] = buildLimitAccounts([{ ...fixtureOwner, current: codex }]);
        const accounts = buildLimitAccounts([{ ...fixtureOwner, history: [claude], current: codex }]);
        expect(accounts.find((account) => account.provider === "openai")).toEqual(expected);
      },
    ));
  });
});
