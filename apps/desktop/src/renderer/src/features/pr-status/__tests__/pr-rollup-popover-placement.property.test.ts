import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  placeRollupPopover,
  POPOVER_GAP,
  VIEWPORT_MARGIN,
} from "../pr-rollup-popover-placement";

/*
 * The rule the rollup's PR list promises:
 *
 *   The list never covers the chip that opened it, and stays inside the
 *   window. When it is taller than the room on either side of the chip, it
 *   takes the larger side and scrolls. It opens below whenever it fits there.
 *
 * Before, a list that fit neither side was clamped to the top margin, which
 * slid it down over the chip in a short window.
 */
const scene = fc
  .record({
    viewportWidth: fc.integer({ min: 360, max: 2000 }),
    viewportHeight: fc.integer({ min: 120, max: 1400 }),
    chipY: fc.double({ min: 0, max: 1, noNaN: true }),
    chipHeight: fc.integer({ min: 16, max: 32 }),
    chipRight: fc.integer({ min: 40, max: 2000 }),
    contentHeight: fc.integer({ min: 40, max: 900 }),
  })
  .filter((s) =>
    s.chipRight <= s.viewportWidth
    && s.chipHeight + 2 * (VIEWPORT_MARGIN + POPOVER_GAP) < s.viewportHeight)
  .map((s) => {
    const room = s.viewportHeight - 2 * VIEWPORT_MARGIN - s.chipHeight;
    const top = Math.round(VIEWPORT_MARGIN + s.chipY * room);
    return {
      chip: { top, bottom: top + s.chipHeight, right: s.chipRight },
      width: 340,
      contentHeight: s.contentHeight,
      viewport: { width: s.viewportWidth, height: s.viewportHeight },
    };
  });

describe("placeRollupPopover", () => {
  it("never covers its chip and stays inside the window", () => {
    fc.assert(
      fc.property(scene, (s) => {
        const { top, maxHeight } = placeRollupPopover(s);
        const bottom = top + Math.min(s.contentHeight, 320, maxHeight);
        const clearsChip = bottom <= s.chip.top || top >= s.chip.bottom;
        expect(clearsChip).toBe(true);
        expect(top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(bottom).toBeLessThanOrEqual(s.viewport.height - VIEWPORT_MARGIN);
      }),
    );
  });

  it("scrolls below a chip at the top of a short window instead of covering it", () => {
    // The counterexample the no-cover property shrank to on the old code,
    // which clamped the list to the top margin, over the chip.
    expect(placeRollupPopover({
      chip: { top: 8, bottom: 24, right: 40 },
      width: 340,
      contentHeight: 83,
      viewport: { width: 360, height: 120 },
    })).toMatchObject({ top: 24 + POPOVER_GAP, maxHeight: 82 });
  });

  it("opens below whenever the whole list fits there", () => {
    fc.assert(
      fc.property(scene, (s) => {
        const wanted = Math.min(s.contentHeight, 320);
        const below = s.chip.bottom + POPOVER_GAP;
        if (below + wanted <= s.viewport.height - VIEWPORT_MARGIN) {
          expect(placeRollupPopover(s).top).toBe(below);
        }
      }),
    );
  });
});
