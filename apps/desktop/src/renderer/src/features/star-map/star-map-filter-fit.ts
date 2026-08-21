/**
 * How much of the filter strip the top band can show.
 *
 * The band is one row and the map window goes down to 800px, so at some
 * width the chips stop fitting beside the chrome — six of them today, each
 * as wide as its label and live count (or, for the Attention chip, its
 * readouts) make it. Two earlier answers were both wrong in ways worth
 * recording:
 *
 * - Wrapping to a second row put chips over the star field and doubled
 *   the height of the band to show information already on it.
 * - A fixed `@media` breakpoint collapsed the whole strip at 1120px, well
 *   before it had to. The chips carry live counts, so how much room they
 *   need is a property of the data, not of the window: 642px with
 *   one-digit counts, 668px with two, 732px with three. No constant is
 *   right for all three, and the constant that is safe for the widest
 *   case throws the strip away in the common one.
 *
 * So measure, and degrade in priority order rather than all at once:
 *
 * - `full` — every chip.
 * - `reduced` — chips whose count is zero are dropped first. A zero chip
 *   can only ever filter the map down to nothing, so it is the one that
 *   costs least to lose. A chip the operator has actually selected is
 *   never dropped, whatever its count, or the filter it is applying
 *   becomes unreachable.
 * - `collapsed` — everything behind one "Filters" chip.
 *
 * This is a pure function of measurements so the arithmetic is testable
 * without a layout engine; the component owns the observer.
 */
export type StarMapFilterFit = "full" | "reduced" | "collapsed";

/** Row width for `count` chips of these widths, separated by `gap`. */
function rowWidth(widths: readonly number[], gap: number): number {
  if (widths.length === 0) return 0;
  return (
    widths.reduce((total, width) => total + width, 0)
    + gap * (widths.length - 1)
  );
}

export function resolveFilterFit(params: {
  /** Space the strip may occupy, in px. */
  available: number;
  /** Natural width of every chip, in render order. */
  chipWidths: readonly number[];
  /** Indexes of the chips that may be dropped, i.e. zero and unselected. */
  droppable: ReadonlySet<number>;
  /** Flex gap between chips, in px. */
  gap: number;
  /**
   * Everything else in the row, plus one gap each: the "Clear" button,
   * which appears the moment anything is filtered and never leaves with
   * the chips. Measuring only the chips reports a row 56px narrower than
   * it is, and the strip's clip then slices the trailing chip in half
   * with nothing to say it did.
   */
  reserved?: number;
}): StarMapFilterFit {
  const { available, chipWidths, droppable, gap, reserved = 0 } = params;
  // A measurement that has not happened yet reads as zero. Showing
  // everything is the honest starting state: the strip is what the band
  // is for, and one frame of overflow beats one frame of a collapsed
  // menu that then expands.
  if (available <= 0 || chipWidths.length === 0) return "full";
  if (rowWidth(chipWidths, gap) + reserved <= available) return "full";

  const kept = chipWidths.filter((_, index) => !droppable.has(index));
  // Dropping every chip is not "reduced", it is an empty strip wearing
  // the strip's label — collapse instead, so the control is still there.
  if (kept.length > 0 && rowWidth(kept, gap) + reserved <= available) {
    return "reduced";
  }

  return "collapsed";
}
