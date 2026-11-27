import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createFiveHourLatchStore,
  type FiveHourSample,
} from "../context-panels/five-hour-latch";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const KEY = "scope";

/**
 * The promise, as the operator stated it, step by step: show at 80% used or
 * projected, hide below 60% projected, keep the state between them and while
 * the projection is unknown, and start each new window hidden. A reset that
 * moves 2 hours or less is the same window restated (Claude rounds to the hour).
 */
function reference(samples: readonly FiveHourSample[]): boolean[] {
  let shown = false;
  let window: number | undefined;
  return samples.map((sample) => {
    if (sample.resetAt !== undefined) {
      if (window !== undefined && Math.abs(sample.resetAt - window) > 2 * HOUR) shown = false;
      window = sample.resetAt;
    }
    const at = (value: number | undefined, bound: number) => value !== undefined && value >= bound;
    if (at(sample.usedPercent, 80) || at(sample.projectedPercent, 80)) shown = true;
    else if (sample.projectedPercent !== undefined && sample.projectedPercent < 60) shown = false;
    return shown;
  });
}

function run(samples: readonly FiveHourSample[]): boolean[] {
  const store = createFiveHourLatchStore();
  return samples.map((sample) => store.observe(KEY, sample));
}

const projected = (...values: Array<number | undefined>): FiveHourSample[] =>
  values.map((value) => ({ usedPercent: 10, resetAt: T0, ...(value === undefined ? {} : { projectedPercent: value }) }));

// Readings as a provider sends them: the same window (sometimes rounded a
// few minutes off, sometimes with no reset at all) or the next windows.
const sample: fc.Arbitrary<FiveHourSample> = fc.record({
  usedPercent: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
  projectedPercent: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
  resetAt: fc.constantFrom(undefined, T0, T0 + 5 * 60_000, T0 + 53 * 60_000, T0 + 5 * HOUR, T0 + 10 * HOUR),
}, { requiredKeys: [] });

describe("the 5h row's latch", () => {
  it("agrees with the stated rules after every reading", () => {
    fc.assert(fc.property(fc.array(sample, { maxLength: 40, size: "max" }), (samples) => {
      const shown = run(samples);
      expect(shown).toEqual(reference(samples));
      let window: number | undefined;
      let before = false;
      samples.forEach((reading, index) => {
        const newWindow = reading.resetAt !== undefined && window !== undefined
          && Math.abs(reading.resetAt - window) > 2 * HOUR;
        if (reading.resetAt !== undefined) window = reading.resetAt;
        const after = shown[index]!;
        const risk = (reading.usedPercent ?? 0) >= 80 || (reading.projectedPercent ?? 0) >= 80;
        // On only at 80% used or projected.
        if (after && !before) expect(risk).toBe(true);
        // Off only below 60% projected, or in a new window.
        if (before && !after) expect(newWindow || (reading.projectedPercent ?? 100) < 60).toBe(true);
        // An unknown projection in the same window never changes it.
        if (reading.projectedPercent === undefined && !risk && !newWindow) expect(after).toBe(before);
        before = after;
      });
    }));
  });

  it("toggles at each crossing of both bounds: 59 → 81 → 59 → 81", () => {
    expect(run(projected(59, 81, 59, 81))).toEqual([false, true, false, true]);
  });

  it("never toggles between the bounds: 70 ↔ 75", () => {
    const band = projected(...Array.from({ length: 20 }, (_, index) => (index % 2 ? 75 : 70)));
    expect(run(band).every((shown) => !shown)).toBe(true);
    expect(run([...projected(85), ...band]).every((shown) => shown)).toBe(true);
  });

  it("stays shown at 85, then unknown", () => {
    expect(run(projected(85, undefined, undefined))).toEqual([true, true, true]);
    // A reading that omits its reset is not a new window.
    expect(run([...projected(85), { usedPercent: 20 }])).toEqual([true, true]);
  });

  it("hides a shown row when the window resets", () => {
    expect(run([...projected(85), { usedPercent: 2, projectedPercent: 70, resetAt: T0 + 5 * HOUR }]))
      .toEqual([true, false]);
    // A reset rounded a few minutes off is the same window.
    expect(run([...projected(85), { usedPercent: 12, projectedPercent: 70, resetAt: T0 + 5 * 60_000 }]))
      .toEqual([true, true]);
    // So is Claude's stream rounding the snapshot's 14:07 up to 15:00.
    expect(run([...projected(85), { usedPercent: 12, projectedPercent: 70, resetAt: T0 + 53 * 60_000 }]))
      .toEqual([true, true]);
  });

  it("keeps each scope's state apart", () => {
    const store = createFiveHourLatchStore();
    store.observe("gemini", { usedPercent: 85, resetAt: T0 });
    expect(store.observe("claude", { usedPercent: 70, resetAt: T0 })).toBe(false);
    expect(store.shown("gemini")).toBe(true);
  });
});
