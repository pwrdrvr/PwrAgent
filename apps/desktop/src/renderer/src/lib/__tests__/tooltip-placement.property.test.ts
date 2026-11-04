import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  anchoredTooltipPosition,
  TOOLTIP_GAP,
  type TooltipRect,
} from "../tooltip-placement";

/*
 * The rule an anchored hover card promises:
 *
 *   A card never covers the target that drew it while any side of the target
 *   (above, below, right, left) has room for the whole card. It stays inside
 *   its bounds whenever it is no larger than them. Above stays the first
 *   choice and below the second, as they always were.
 *
 * A tall PR status card on a sidebar chip near the bottom of the window broke
 * the first part: it fit neither above nor below, so it was clamped into the
 * window over the chip, though the window had room beside the chip.
 *
 * The oracle checks each side's room from the geometry alone.
 */
type Scene = {
  bounds: TooltipRect;
  target: TooltipRect;
  width: number;
  height: number;
};

const scene: fc.Arbitrary<Scene> = fc
  .record({
    boundsLeft: fc.integer({ min: 0, max: 120 }),
    boundsTop: fc.integer({ min: 0, max: 120 }),
    boundsWidth: fc.integer({ min: 120, max: 1800 }),
    boundsHeight: fc.integer({ min: 120, max: 1200 }),
    targetWidth: fc.integer({ min: 12, max: 240 }),
    targetHeight: fc.integer({ min: 12, max: 60 }),
    targetX: fc.double({ min: 0, max: 1, noNaN: true }),
    targetY: fc.double({ min: 0, max: 1, noNaN: true }),
    width: fc.integer({ min: 20, max: 900 }),
    height: fc.integer({ min: 10, max: 1400 }),
  })
  .filter((r) => r.targetWidth <= r.boundsWidth && r.targetHeight <= r.boundsHeight)
  .map((r) => {
    const bounds = {
      left: r.boundsLeft,
      top: r.boundsTop,
      right: r.boundsLeft + r.boundsWidth,
      bottom: r.boundsTop + r.boundsHeight,
    };
    const left = Math.round(bounds.left + r.targetX * (r.boundsWidth - r.targetWidth));
    const top = Math.round(bounds.top + r.targetY * (r.boundsHeight - r.targetHeight));
    return {
      bounds,
      target: { left, top, right: left + r.targetWidth, bottom: top + r.targetHeight },
      width: r.width,
      height: r.height,
    };
  });

function roomOnSomeSide({ bounds, target, width, height }: Scene): boolean {
  const fitsAcross = width <= bounds.right - bounds.left;
  const fitsTall = height <= bounds.bottom - bounds.top;
  return (
    (fitsAcross && target.top - TOOLTIP_GAP - height >= bounds.top)
    || (fitsAcross && target.bottom + TOOLTIP_GAP + height <= bounds.bottom)
    || (fitsTall && target.right + TOOLTIP_GAP + width <= bounds.right)
    || (fitsTall && target.left - TOOLTIP_GAP - width >= bounds.left)
  );
}

function placedRect(s: Scene): TooltipRect {
  const { left, top } = anchoredTooltipPosition(s);
  return { left, top, right: left + s.width, bottom: top + s.height };
}

function overlaps(a: TooltipRect, b: TooltipRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("anchoredTooltipPosition", () => {
  it("never covers its target while any side has room for the card", () => {
    fc.assert(
      fc.property(scene.filter(roomOnSomeSide), (s) => {
        expect(overlaps(placedRect(s), s.target)).toBe(false);
      }),
    );
  });

  it("stays inside its bounds whenever it is no larger than them", () => {
    fc.assert(
      fc.property(
        scene.filter((s) =>
          s.width <= s.bounds.right - s.bounds.left
          && s.height <= s.bounds.bottom - s.bounds.top),
        (s) => {
          const placed = placedRect(s);
          expect(placed.left).toBeGreaterThanOrEqual(s.bounds.left);
          expect(placed.right).toBeLessThanOrEqual(s.bounds.right);
          expect(placed.top).toBeGreaterThanOrEqual(s.bounds.top);
          expect(placed.bottom).toBeLessThanOrEqual(s.bounds.bottom);
        },
      ),
    );
  });

  it("prefers above, then below, as before", () => {
    fc.assert(
      fc.property(scene, (s) => {
        const { top } = anchoredTooltipPosition(s);
        const aboveTop = s.target.top - TOOLTIP_GAP - s.height;
        const belowTop = s.target.bottom + TOOLTIP_GAP;
        if (aboveTop >= s.bounds.top) {
          expect(top).toBe(aboveTop);
        } else if (belowTop + s.height <= s.bounds.bottom) {
          expect(top).toBe(belowTop);
        }
      }),
    );
  });

  it("goes beside a sidebar chip when the card is taller than the room above and below it", () => {
    // Close to the reported layout, in CSS pixels: a PR chip in the sidebar,
    // a 270 × 465 status card, and less than 465px above or below the chip.
    const target = { left: 380, top: 480, right: 460, bottom: 504 };
    const placed = anchoredTooltipPosition({
      target,
      width: 270,
      height: 465,
      bounds: { left: 12, top: 40, right: 1160, bottom: 565 },
    });
    expect(placed.left).toBe(target.right + TOOLTIP_GAP);
  });
});
