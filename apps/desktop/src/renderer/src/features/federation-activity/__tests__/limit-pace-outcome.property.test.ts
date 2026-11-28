import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  limitPaceOutcome,
  limitPaceOutcomePhrases,
} from "../usage-activity-presentation";
import type { LimitProjection } from "../usage-limits";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 27, 15, 3);

const projection: fc.Arbitrary<LimitProjection> = fc.oneof(
  fc.record({
    kind: fc.constant("atReset" as const),
    percent: fc.double({ min: 0, max: 100, noNaN: true }),
    resetAt: fc.integer({ min: NOW + HOUR / 6, max: NOW + 8 * 24 * HOUR }),
  }),
  fc.record({
    kind: fc.constant("full" as const),
    at: fc.integer({ min: NOW + 60_000, max: NOW + 30 * 24 * HOUR }),
  }),
);

describe("limitPaceOutcomePhrases", () => {
  // The peek breaks a pace line only between these phrases, so a time or a
  // duration must never span two of them ("Mon 10 / AM", "19 h / 26 m").
  it("reads exactly as limitPaceOutcome, split only between units", () => {
    fc.assert(fc.property(
      projection,
      fc.option(fc.integer({ min: NOW + HOUR / 6, max: NOW + 8 * 24 * HOUR }), { nil: undefined }),
      fc.integer({ min: 0, max: 2 * HOUR }),
      (projected, resetAt, age) => {
        const latest = { at: NOW - age, usedPercent: 40, ...(resetAt === undefined ? {} : { resetAt }) };
        const phrases = limitPaceOutcomePhrases(projected, latest, NOW);
        expect(phrases.join(" ")).toBe(limitPaceOutcome(projected, latest, NOW));
        for (let index = 1; index < phrases.length; index++) {
          const last = phrases[index - 1]!.split(" ").at(-1)!;
          const first = phrases[index]!.split(" ")[0]!;
          // A unit never starts a phrase ("PM", "m", "days")...
          expect(first).not.toMatch(/^(AM|PM|h|m|days?)$/);
          // ...and a day or a bare number never ends one before a number.
          if (/^\d/.test(first)) expect(last).not.toMatch(/^(\d[\d:.]*|[A-Z][a-z]{2})$/);
        }
      },
    ));
  });

  it("keeps each unit whole in the shapes the peek shows", () => {
    const at = (hours: number) => NOW + hours * HOUR;
    expect(limitPaceOutcomePhrases({ kind: "full", at: at(19) }, { at: NOW, usedPercent: 53, resetAt: at(38.5) }, NOW))
      .toEqual(["hits 100%", expect.stringMatching(/^\S+ \d+ (AM|PM),$/), "19 h 30 m", "before the reset"]);
    expect(limitPaceOutcomePhrases({ kind: "atReset", percent: 64.6, resetAt: at(40) }, { at: NOW, usedPercent: 36 }, NOW))
      .toEqual(["on pace for", "about 65%", "at the reset"]);
    expect(limitPaceOutcomePhrases({ kind: "full", at: at(3.25) }, { at: NOW, usedPercent: 10 }, NOW))
      .toEqual(["100% in about", "3 h 15 m", expect.stringMatching(/^\(.+\)$/)]);
  });
});
