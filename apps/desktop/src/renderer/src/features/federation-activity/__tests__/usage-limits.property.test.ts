import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { UsageLimitObservation } from "@pwragent/shared";
import { buildLimitAccounts, projectLimit, sinceResetSeries } from "../usage-limits";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 8, 27, 21);
const WEEK = 168 * HOUR;

function weekly(at: number, usedPercent: number, resetAt: number, provider = "openai"): UsageLimitObservation {
  return { observedAt: at, provider, accountKey: "fixture-account", limits: [
    { name: "Weekly limit", windowKey: "secondary", usedPercent, resetAt, windowMinutes: 10_080 },
  ] };
}

describe("usage limit schedule properties", () => {
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
      const [account] = buildLimitAccounts([{ owner: "Fixture", history: [
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
        const [expected] = buildLimitAccounts([{ owner: "Fixture", current: codex }]);
        const accounts = buildLimitAccounts([{ owner: "Fixture", history: [claude], current: codex }]);
        expect(accounts.find((account) => account.provider === "openai")).toEqual(expected);
      },
    ));
  });
});
