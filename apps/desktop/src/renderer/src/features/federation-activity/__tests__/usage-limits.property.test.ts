import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { UsageLimitObservation } from "@pwragent/shared/contracts/usage-activity";
import { buildLimitAccounts, fiveHourSeries, projectLimit, sinceResetSeries } from "../usage-limits";

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

  it("picks an anchored active 5h pool over an idle 5h pool without a reset regardless of pool order", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.integer({ min: 1, max: 99 }),
      fc.integer({ min: 1, max: 4 }),
      (idleFirst, activePercent, elapsedHours) => {
        const idle = { name: "5h Gemini limit", limitId: "gemini-5h", usedPercent: 0, windowMinutes: 300 };
        const active = {
          name: "5h Claude/GPT limit",
          limitId: "3p-5h",
          usedPercent: activePercent,
          resetAt: START + 5 * HOUR,
          windowMinutes: 300,
        };
        const limits = idleFirst ? [idle, active] : [active, idle];
        const [account] = buildLimitAccounts([{
          ...fixtureOwner,
          current: { observedAt: START + elapsedHours * HOUR, provider: "google", limits },
        }]);
        const selected = fiveHourSeries(account)!;
        expect(selected.limitId).toBe("3p-5h");
        expect(selected.windowStart).toBe(START);
      },
    ));
  });

  it("prefers a 5h pool with a live resetAt over an idle 5h pool that has a historical reset", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.integer({ min: 10, max: 95 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 6, max: 72 }),
      (geminiIdle, priorPercent, activePercent, hoursAgo) => {
        const idleMeta = geminiIdle
          ? { name: "5h Gemini limit", limitId: "gemini-5h" }
          : { name: "5h Claude/GPT limit", limitId: "3p-5h" };
        const activeMeta = geminiIdle
          ? { name: "5h Claude/GPT limit", limitId: "3p-5h" }
          : { name: "5h Gemini limit", limitId: "gemini-5h" };
        const priorAt = START - hoursAgo * HOUR;
        const priorResetAt = priorAt + 2 * HOUR;
        const [account] = buildLimitAccounts([{
          ...fixtureOwner,
          history: [
            {
              observedAt: priorAt,
              provider: "google",
              limits: [{ ...idleMeta, usedPercent: priorPercent, resetAt: priorResetAt, windowMinutes: 300 }],
            },
            {
              observedAt: priorResetAt + HOUR,
              provider: "google",
              limits: [{ ...idleMeta, usedPercent: 0, windowMinutes: 300 }],
            },
          ],
          current: {
            observedAt: START + HOUR,
            provider: "google",
            limits: [
              { ...idleMeta, usedPercent: 0, windowMinutes: 300 },
              { ...activeMeta, usedPercent: activePercent, resetAt: START + 5 * HOUR, windowMinutes: 300 },
            ],
          },
        }]);
        const selected = fiveHourSeries(account)!;
        expect(selected.limitId).toBe(activeMeta.limitId);
        expect(selected.latest.resetAt).toBe(START + 5 * HOUR);
        expect(selected.windowStart).toBe(START);
      },
    ));
  });

  it("keeps pre-reset percentages from changing the new window's start or pace", () => {
    fc.assert(fc.property(fc.record({
      beforeHours: fc.integer({ min: 1, max: 48 }),
      oldPercentA: fc.double({ min: 0, max: 95, noNaN: true }),
      oldPercentB: fc.double({ min: 0, max: 95, noNaN: true }),
      elapsedMinutes: fc.integer({ min: 1, max: 180 }),
      newPercent: fc.double({ min: 0, max: 90, noNaN: true }),
      skewMinutes: fc.integer({ min: -5, max: 20 }),
    }), ({ beforeHours, oldPercentA, oldPercentB, elapsedMinutes, newPercent, skewMinutes }) => {
      const oldReset = START + 3 * 24 * HOUR;
      const newReset = START + WEEK + skewMinutes * 60_000;
      const afterAt = START + elapsedMinutes * 60_000;
      const [acctA] = buildLimitAccounts([{
        ...fixtureOwner,
        history: [weekly(START - beforeHours * HOUR, oldPercentA, oldReset)],
        current: weekly(afterAt, newPercent, newReset),
      }]);
      const [acctB] = buildLimitAccounts([{
        ...fixtureOwner,
        history: [weekly(START - beforeHours * HOUR, oldPercentB, oldReset)],
        current: weekly(afterAt, newPercent, newReset),
      }]);
      const seriesA = sinceResetSeries(acctA)!;
      const seriesB = sinceResetSeries(acctB)!;
      expect(seriesA.windowStart).toBe(seriesB.windowStart);
      expect(seriesA.pacePerHour).toBe(seriesB.pacePerHour);
      expect(seriesA.resets).toHaveLength(1);
    }));
  });

  it("measures pace after a mid-window credit from the post-credit floor, never from zero", () => {
    fc.assert(fc.property(fc.record({
      beforePercent: fc.integer({ min: 20, max: 99 }),
      dropToPercent: fc.integer({ min: 1, max: 60 }),
      extraPercent: fc.integer({ min: 0, max: 35 }),
      spanHours: fc.integer({ min: 1, max: 24 }),
    }).filter(({ beforePercent, dropToPercent, extraPercent }) =>
      dropToPercent < beforePercent - 2 && dropToPercent + extraPercent <= 99,
    ), ({ beforePercent, dropToPercent, extraPercent, spanHours }) => {
      const resetAt = START + 4 * 24 * HOUR;
      const [account] = buildLimitAccounts([{
        ...fixtureOwner,
        history: [
          weekly(START - HOUR, beforePercent, resetAt),
          weekly(START + HOUR, dropToPercent, resetAt),
        ],
        current: weekly(START + (1 + spanHours) * HOUR, dropToPercent + extraPercent, resetAt),
      }]);
      const series = sinceResetSeries(account)!;
      if (extraPercent < 1) {
        expect(series.pacePerHour).toBeUndefined();
      } else {
        expect(series.pacePerHour).toBeCloseTo(extraPercent / spanHours);
      }
    }));
  });

  it("ignores lagging-owner window regressions regardless of source order", () => {
    fc.assert(fc.property(fc.record({
      oldPercent: fc.integer({ min: 10, max: 95 }),
      newPercent: fc.integer({ min: 1, max: 40 }),
      lagMinutes: fc.integer({ min: 0, max: 30 }),
    }), ({ oldPercent, newPercent, lagMinutes }) => {
      const oldReset = START + 3 * 24 * HOUR;
      const newReset = START + WEEK;
      const local = {
        ...fixtureOwner,
        history: [weekly(START - HOUR, oldPercent, oldReset)],
        current: weekly(START + 2 * HOUR, newPercent, newReset),
      };
      const remote = {
        owner: "Peer",
        target: { scope: "remote" as const, instanceId: "peer" },
        current: weekly(START + 2 * HOUR + lagMinutes * 60_000, oldPercent, oldReset),
      };
      const [fwd] = buildLimitAccounts([local, remote]);
      const [rev] = buildLimitAccounts([remote, local]);
      const sFwd = sinceResetSeries(fwd)!;
      const sRev = sinceResetSeries(rev)!;
      expect(sFwd.latest.resetAt).toBe(newReset);
      expect(sFwd.latest.usedPercent).toBe(newPercent);
      expect(sFwd.resets).toHaveLength(1);
      expect(sRev).toEqual(sFwd);
    }));
  });

  it("keeps projectLimit bounded and undefined when exhausted or expired", () => {
    fc.assert(fc.property(fc.record({
      usedPercent: fc.integer({ min: 1, max: 100 }),
      elapsedHours: fc.integer({ min: 1, max: 200 }),
    }), ({ usedPercent, elapsedHours }) => {
      const [account] = buildLimitAccounts([{
        ...fixtureOwner,
        current: weekly(START + elapsedHours * HOUR, usedPercent, START + WEEK),
      }]);
      const series = sinceResetSeries(account)!;
      const proj = projectLimit(series);
      if (usedPercent >= 100 || elapsedHours >= 168) {
        expect(proj).toBeUndefined();
      } else if (proj?.kind === "atReset") {
        expect(proj.percent).toBeGreaterThanOrEqual(usedPercent);
        expect(proj.percent).toBeLessThanOrEqual(100);
      } else if (proj?.kind === "full") {
        expect(proj.at).toBeGreaterThan(series.latest.at);
        expect(proj.at).toBeLessThanOrEqual(START + WEEK - 60_000);
      }
    }));
  });
});
