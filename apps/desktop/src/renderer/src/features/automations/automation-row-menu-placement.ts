/** Space kept between the menu and its trigger, and between it and the window edge. */
export const ROW_MENU_GAP = 4;
export const ROW_MENU_EDGE = 8;

type Rect = { top: number; bottom: number; right: number };

/**
 * Places a row's overflow menu in viewport coordinates, right-aligned with
 * its ⋮ trigger. Below is the first choice and above the second. When
 * neither side fits, the menu takes the side with more room and is clamped
 * into the window there.
 */
export function placeAutomationRowMenu(params: {
  trigger: Rect;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** The highest top a portal may use: below the custom title bar, if any. */
  viewportTop: number;
}): { left: number; top: number } {
  const { trigger, menuWidth, menuHeight, viewportWidth, viewportHeight, viewportTop } = params;
  const floor = viewportHeight - ROW_MENU_EDGE;
  const below = trigger.bottom + ROW_MENU_GAP;
  const above = trigger.top - ROW_MENU_GAP - menuHeight;
  const fitsBelow = below + menuHeight <= floor;
  const fitsAbove = above >= viewportTop;
  const top =
    fitsBelow
      ? below
      : fitsAbove
        ? above
        : floor - below >= trigger.top - ROW_MENU_GAP - viewportTop
          ? below
          : above;
  return {
    left: Math.max(
      ROW_MENU_EDGE,
      Math.min(trigger.right - menuWidth, viewportWidth - menuWidth - ROW_MENU_EDGE),
    ),
    top: Math.max(viewportTop, Math.min(top, floor - menuHeight)),
  };
}
