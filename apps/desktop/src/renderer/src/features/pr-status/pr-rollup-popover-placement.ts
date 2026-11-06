export const POPOVER_GAP = 6;
export const VIEWPORT_MARGIN = 8;
/** The list's tallest size, as `.pr-rollup-popover` caps it. */
export const POPOVER_MAX_HEIGHT = 320;

/**
 * Place the rollup's PR list against its chip in viewport coordinates.
 *
 * Below the chip, right edges aligned. It flips above only when it does not
 * fit below and the room above is larger. A list that fits neither way takes
 * the larger side and scrolls, so it never slides over the chip that opened it.
 */
export function placeRollupPopover(input: {
  chip: { top: number; bottom: number; right: number };
  width: number;
  /** The popover's full content height, before any cap. */
  contentHeight: number;
  viewport: { width: number; height: number };
}): { top: number; left: number; maxHeight: number } {
  const { chip, width, viewport } = input;
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, chip.right - width),
    viewport.width - width - VIEWPORT_MARGIN,
  );
  const below = viewport.height - VIEWPORT_MARGIN - chip.bottom - POPOVER_GAP;
  const above = chip.top - POPOVER_GAP - VIEWPORT_MARGIN;
  const wanted = Math.min(input.contentHeight, POPOVER_MAX_HEIGHT);
  const flipped = wanted > below && above > below;
  const maxHeight = Math.max(0, Math.min(POPOVER_MAX_HEIGHT, flipped ? above : below));
  const top = flipped
    ? chip.top - POPOVER_GAP - Math.min(wanted, maxHeight)
    : chip.bottom + POPOVER_GAP;
  return { top, left, maxHeight };
}
