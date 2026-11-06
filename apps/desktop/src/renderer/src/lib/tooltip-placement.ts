/** Gap between a tooltip and its placement anchor. */
export const TOOLTIP_GAP = 10;

export type TooltipRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

/**
 * Where an anchored tooltip goes: above its target, else below, else beside
 * it, and only when none of those fits, clamped into the bounds. A hover card
 * describes its target, so covering the target is the last resort, not the
 * fallback for a card taller than the room above and below.
 */
export function anchoredTooltipPosition(params: {
  target: TooltipRect;
  width: number;
  height: number;
  /** The area the tooltip may occupy: the viewport, less padding and any
   *  title-bar floor, narrowed by a caller's horizontal bounds. */
  bounds: TooltipRect;
}): { left: number; top: number } {
  const { target, width, height, bounds } = params;
  const maxLeft = Math.max(bounds.left, bounds.right - width);
  const centerLeft = Math.min(
    maxLeft,
    Math.max(bounds.left, (target.left + target.right) / 2 - width / 2),
  );
  const aboveTop = target.top - height - TOOLTIP_GAP;
  const belowTop = target.bottom + TOOLTIP_GAP;
  if (aboveTop >= bounds.top) {
    return { left: centerLeft, top: aboveTop };
  }
  if (belowTop + height <= bounds.bottom) {
    return { left: centerLeft, top: belowTop };
  }
  // Beside the target, level with its top and slid up or down to stay in
  // bounds. A sidebar chip has the whole window to its right.
  const besideTop = Math.max(
    bounds.top,
    Math.min(target.top, bounds.bottom - height),
  );
  const rightLeft = target.right + TOOLTIP_GAP;
  if (rightLeft + width <= bounds.right) {
    return { left: rightLeft, top: besideTop };
  }
  const leftLeft = target.left - TOOLTIP_GAP - width;
  if (leftLeft >= bounds.left) {
    return { left: leftLeft, top: besideTop };
  }
  const availableAbove = Math.max(0, target.top - TOOLTIP_GAP - bounds.top);
  const availableBelow = Math.max(0, bounds.bottom - target.bottom - TOOLTIP_GAP);
  const preferredTop = availableAbove >= availableBelow ? aboveTop : belowTop;
  const maximumTop = Math.max(bounds.top, bounds.bottom - height);
  return {
    left: centerLeft,
    top: Math.min(maximumTop, Math.max(bounds.top, preferredTop)),
  };
}
