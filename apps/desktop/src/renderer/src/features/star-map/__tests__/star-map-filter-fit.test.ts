import { describe, expect, it } from "vitest";
import { resolveFilterFit } from "../star-map-filter-fit";

/**
 * The arithmetic that decides how much of the filter strip the top band
 * shows. It has been wrong twice — once by wrapping instead of degrading,
 * once by a fixed 1120px breakpoint that collapsed the strip while there
 * was still room — so the widths below are the real measured ones rather
 * than round numbers: the seven chips are 642px at one-digit counts,
 * 668px at two and 732px at three, gaps included.
 */
const GAP = 6;

/** Seven chips with two-digit counts, as measured in the running app. */
const REAL_CHIPS = [79, 78, 95, 92, 95, 70, 73];
const REAL_ROW = REAL_CHIPS.reduce((a, b) => a + b, 0) + GAP * 6;

describe("resolveFilterFit", () => {
  it("shows every chip when the row fits", () => {
    expect(
      resolveFilterFit({
        available: REAL_ROW,
        chipWidths: REAL_CHIPS,
        droppable: new Set(),
        gap: GAP,
      }),
    ).toBe("full");
  });

  it("keeps the strip whole when nothing may be dropped", () => {
    // Every chip carries a count, so there is no cheap thing to lose and
    // the strip goes behind the one chip rather than losing a filter the
    // operator can still use.
    expect(
      resolveFilterFit({
        available: REAL_ROW - 1,
        chipWidths: REAL_CHIPS,
        droppable: new Set(),
        gap: GAP,
      }),
    ).toBe("collapsed");
  });

  it("drops the zero-count chips before collapsing", () => {
    // "Working 0" and "Needs input 0" in the screenshot that caught this:
    // a zero chip can only filter the map down to nothing, so it is what
    // leaves first. 668 - 78 - 95 - 12 of gap = 483.
    const droppable = new Set([1, 2]);
    const reduced = REAL_ROW - REAL_CHIPS[1]! - REAL_CHIPS[2]! - GAP * 2;
    expect(
      resolveFilterFit({
        available: reduced,
        chipWidths: REAL_CHIPS,
        droppable,
        gap: GAP,
      }),
    ).toBe("reduced");
    // One pixel under what even the reduced row needs, and the whole
    // thing goes behind the chip.
    expect(
      resolveFilterFit({
        available: reduced - 1,
        chipWidths: REAL_CHIPS,
        droppable,
        gap: GAP,
      }),
    ).toBe("collapsed");
  });

  it("does not reduce to an empty strip", () => {
    // Every chip is zero and unselected — dropping them all leaves a
    // labelled group with nothing in it, which is worse than the menu.
    expect(
      resolveFilterFit({
        available: 10,
        chipWidths: REAL_CHIPS,
        droppable: new Set(REAL_CHIPS.map((_, index) => index)),
        gap: GAP,
      }),
    ).toBe("collapsed");
  });

  it("shows the strip before it has been measured", () => {
    // First paint, and any state where the box has no width yet. The
    // strip is what the band is for, and one frame of overflow beats one
    // frame of a collapsed menu that immediately expands.
    expect(
      resolveFilterFit({
        available: 0,
        chipWidths: REAL_CHIPS,
        droppable: new Set(),
        gap: GAP,
      }),
    ).toBe("full");
    expect(
      resolveFilterFit({
        available: 400,
        chipWidths: [],
        droppable: new Set(),
        gap: GAP,
      }),
    ).toBe("full");
  });

  it("counts the gaps, not just the chips", () => {
    // Six gaps between seven chips. Sizing on chip widths alone is off by
    // 36px here — enough to overflow the row it just declared a fit.
    const chipsOnly = REAL_CHIPS.reduce((a, b) => a + b, 0);
    expect(
      resolveFilterFit({
        available: chipsOnly,
        chipWidths: REAL_CHIPS,
        droppable: new Set(),
        gap: GAP,
      }),
    ).not.toBe("full");
  });
});
