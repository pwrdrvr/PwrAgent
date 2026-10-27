/** Menu border, padding and row padding before a row's check column. */
const ROW_CHECK_INSET = 13;

/**
 * Prefer below the chip, then the roomier side; keep offscreen triggers from
 * hiding the menu. With `alignLeft` (the card's facts edge), the rows' check
 * column lines up with that edge, so the menu sits under the card rather than
 * hanging off the chip past the card's right side.
 */
export function placeTodoModelMenu(params: {
  trigger: { left: number; top: number; bottom: number };
  alignLeft?: number;
  menuHeight: number;
  menuWidth: number;
  viewportHeight: number;
  viewportWidth: number;
}): { left: number; top: number; maxHeight: number } {
  const margin = 8;
  const gap = 6;
  const viewportSpace = Math.max(0, params.viewportHeight - margin * 2);
  const below = Math.max(0, Math.min(viewportSpace, params.viewportHeight - margin - params.trigger.bottom - gap));
  const above = Math.max(0, Math.min(viewportSpace, params.trigger.top - gap - margin));
  const opensBelow = params.menuHeight <= below || below >= above;
  const sideSpace = opensBelow ? below : above;
  const minimumVisibleHeight = Math.min(params.menuHeight, 120, viewportSpace);
  const maxHeight = sideSpace >= minimumVisibleHeight ? sideSpace : viewportSpace;
  const height = Math.min(params.menuHeight, maxHeight);
  const preferredLeft = params.alignLeft === undefined ? params.trigger.left : params.alignLeft - ROW_CHECK_INSET;
  const preferredTop = opensBelow ? params.trigger.bottom + gap : params.trigger.top - gap - height;
  return {
    left: Math.max(margin, Math.min(preferredLeft, params.viewportWidth - params.menuWidth - margin)),
    top: Math.max(margin, Math.min(preferredTop, params.viewportHeight - margin - height)),
    maxHeight,
  };
}
