import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MODEL_DEFAULT_EFFORT,
  effortMeterHeights,
  effortStopAtPointer,
  effortStopForKey,
  effortStopLabelled,
  modelSettingsSummary,
  placeModelSettingsPanel,
  splitEffortChoices,
} from "../model-settings-picker-model";

const SLIDER_KEYS = ["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "PageUp", "PageDown", "Home", "End"];
const FORWARD = new Set(["ArrowRight", "ArrowUp", "PageUp"]);

/**
 * The model pill's effort bar and panel follow small rules that example
 * tests pinned only at a few points. These state them for every input.
 */
describe("model settings picker rules", () => {
  it("splits the model default out of an effort list and keeps every level in order", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom("low", "medium", "high", "xhigh", "max", MODEL_DEFAULT_EFFORT), { maxLength: 8 }),
      (efforts) => {
        const { stops, hasModelDefault } = splitEffortChoices(efforts);
        expect(stops).toEqual(efforts.filter((effort) => effort !== MODEL_DEFAULT_EFFORT));
        expect(hasModelDefault).toBe(efforts.includes(MODEL_DEFAULT_EFFORT));
      },
    ));
  });

  it("maps a pointer to the segment under it, holding the end stop past either end", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 9 }),
      fc.integer({ min: -500, max: 500 }),
      fc.integer({ min: 1, max: 600 }),
      fc.double({ min: -1000, max: 2000, noNaN: true }),
      (count, left, width, x) => {
        const stop = effortStopAtPointer(x, left, width, count);
        expect(stop).toBeGreaterThanOrEqual(0);
        expect(stop).toBeLessThan(count);
        if (x < left) expect(stop).toBe(0);
        if (x >= left + width) expect(stop).toBe(count - 1);
        if (x >= left && x < left + width) {
          // The segment [left + stop·w/count, left + (stop+1)·w/count) holds x.
          const segment = width / count;
          expect(x).toBeGreaterThanOrEqual(left + stop * segment - 1e-9);
          expect(x).toBeLessThan(left + (stop + 1) * segment + 1e-9);
        }
      },
    ));
    expect(effortStopAtPointer(10, 0, 0, 4)).toBe(0);
    expect(effortStopAtPointer(10, 0, 100, 0)).toBe(-1);
  });

  it("moves the slider one way per key, never off the bar, and never back into the default", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 9 }).chain((count) => fc.tuple(
        fc.constant(count),
        fc.integer({ min: -1, max: count - 1 }),
        fc.constantFrom(...SLIDER_KEYS, "Enter", "a"),
      )),
      ([count, index, key]) => {
        const next = effortStopForKey(key, index, count);
        if (!SLIDER_KEYS.includes(key)) {
          expect(next).toBeUndefined();
          return;
        }
        if (key === "Home") {
          expect(next).toBe(0);
          return;
        }
        if (key === "End") {
          expect(next).toBe(count - 1);
          return;
        }
        if (index < 0) {
          // From the model default, forward lands on the first level and
          // backward stays put: the default is its own chip.
          expect(next).toBe(FORWARD.has(key) ? 0 : undefined);
          return;
        }
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(count);
        if (FORWARD.has(key)) expect(next).toBeGreaterThanOrEqual(index);
        else expect(next).toBeLessThanOrEqual(index);
        const step = key.startsWith("Page") ? 2 : 1;
        expect(Math.abs(next! - index)).toBeLessThanOrEqual(step);
        // It moves unless it already sits at the end it moves toward.
        const atEnd = FORWARD.has(key) ? index === count - 1 : index === 0;
        expect(next === index).toBe(atEnd);
      },
    ));
    expect(effortStopForKey("ArrowRight", 0, 0)).toBeUndefined();
  });

  it("labels every stop while they fit, then the ends and the chosen stop", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 12 }).chain((count) => fc.tuple(
        fc.constant(count),
        fc.integer({ min: -1, max: count - 1 }),
      )),
      ([count, chosen]) => {
        const labelled = Array.from({ length: count }, (_, stop) => effortStopLabelled(stop, count, chosen));
        if (count <= 6) {
          expect(labelled.every(Boolean)).toBe(true);
          return;
        }
        expect(labelled[0]).toBe(true);
        expect(labelled[count - 1]).toBe(true);
        if (chosen >= 0) expect(labelled[chosen]).toBe(true);
        expect(labelled.filter(Boolean).length).toBeLessThanOrEqual(3);
      },
    ));
  });

  it("draws meter ticks that rise with the level and end at full height", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), (count) => {
      const heights = effortMeterHeights(count);
      expect(heights).toHaveLength(count);
      for (let index = 1; index < count; index += 1) {
        expect(heights[index]!).toBeGreaterThanOrEqual(heights[index - 1]!);
      }
      expect(heights[count - 1]).toBe(11);
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(5);
    }));
  });

  it("names the pill by its label and the values it shows, and Standard adds nothing", () => {
    expect(modelSettingsSummary({ label: "Model settings", model: "Opus 5.5", effort: "high", speed: "standard" }))
      .toBe("Model settings: Opus 5.5, high effort");
    expect(modelSettingsSummary({
      label: "Model for the new thread", provider: "Codex", model: "GPT-6.1-Sol", effort: "xhigh", speed: "ultrafast",
    })).toBe("Model for the new thread: Codex, GPT-6.1-Sol, xhigh effort, Ultrafast");
    expect(modelSettingsSummary({ label: "Helper model", model: "" })).toBe("Helper model");
  });

  it("keeps a portalled panel inside the window, beside its trigger, never over it", () => {
    fc.assert(fc.property(
      fc.record({
        viewportWidth: fc.integer({ min: 360, max: 2400 }),
        viewportHeight: fc.integer({ min: 300, max: 1600 }),
        width: fc.integer({ min: 200, max: 520 }),
        height: fc.integer({ min: 40, max: 900 }),
        prefer: fc.constantFrom<"above" | "below">("above", "below"),
        triggerHeight: fc.integer({ min: 16, max: 40 }),
      }).chain((base) => fc.record({
        base: fc.constant(base),
        triggerTop: fc.integer({ min: 0, max: base.viewportHeight - base.triggerHeight }),
        triggerLeft: fc.integer({ min: 0, max: base.viewportWidth - 20 }),
      })),
      ({ base, triggerTop, triggerLeft }) => {
        const padding = 8;
        const gap = 8;
        const trigger = { left: triggerLeft, top: triggerTop, bottom: triggerTop + base.triggerHeight };
        const placed = placeModelSettingsPanel({ ...base, trigger, gap, padding });
        const shown = Math.min(base.height, placed.maxHeight);
        // Inside the window horizontally whenever it can fit at all.
        if (base.width + 2 * padding <= base.viewportWidth) {
          expect(placed.left).toBeGreaterThanOrEqual(padding);
          expect(placed.left + base.width).toBeLessThanOrEqual(base.viewportWidth - padding);
        }
        const below = placed.top >= trigger.bottom;
        if (below) {
          expect(placed.top).toBe(trigger.bottom + gap);
          expect(placed.top + shown).toBeLessThanOrEqual(base.viewportHeight - padding + 1e-9);
        } else {
          // Above: it ends a gap over the trigger and never covers it.
          expect(placed.top + shown).toBeLessThanOrEqual(Math.max(padding, trigger.top - gap));
          expect(placed.top).toBeGreaterThanOrEqual(padding);
        }
        // It takes the preferred side when the panel fits there.
        const room = base.prefer === "below"
          ? base.viewportHeight - trigger.bottom - gap - padding
          : trigger.top - gap - padding;
        if (room >= base.height) expect(below).toBe(base.prefer === "below");
      },
    ));
  });
});
