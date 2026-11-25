import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pointerAimsAtRect, type AimPoint } from "../pointer-aim";
import type { TooltipRect } from "../tooltip-placement";

/**
 * Oracle, by ray rather than by triangle: extend the move from `from`
 * through `to` to the line of the rectangle's edge facing `from`. The move
 * aims at the rectangle when `to` is strictly between `from` and that line
 * and the ray meets the line strictly inside the edge. Integer arithmetic,
 * so a point exactly on a boundary is decided exactly.
 */
function oracle(from: AimPoint, to: AimPoint, rect: TooltipRect): boolean {
  let axis: "x" | "y";
  let line: number;
  if (from.x < rect.left) [axis, line] = ["x", rect.left];
  else if (from.x > rect.right) [axis, line] = ["x", rect.right];
  else if (from.y < rect.top) [axis, line] = ["y", rect.top];
  else if (from.y > rect.bottom) [axis, line] = ["y", rect.bottom];
  else return false;
  const other = axis === "x" ? "y" : "x";
  const [low, high] = axis === "x" ? [rect.top, rect.bottom] : [rect.left, rect.right];
  const travelled = to[axis] - from[axis];
  const remaining = line - from[axis];
  if (travelled === 0 || Math.sign(travelled) !== Math.sign(remaining)) return false;
  if (Math.abs(travelled) >= Math.abs(remaining)) return false;
  // hit = from.other + (to.other - from.other) * remaining / travelled,
  // compared with low and high after multiplying through by travelled.
  const scaled = from[other] * travelled + (to[other] - from[other]) * remaining;
  const sign = Math.sign(travelled);
  return sign * (scaled - low * travelled) > 0 && sign * (high * travelled - scaled) > 0;
}

const coordinate = fc.integer({ min: -400, max: 400 });
const point = fc.record({ x: coordinate, y: coordinate });
const rect = fc.tuple(coordinate, coordinate, fc.integer({ min: 0, max: 300 }), fc.integer({ min: 0, max: 300 }))
  .map(([left, top, width, height]) => ({ left, top, right: left + width, bottom: top + height }));

describe("pointerAimsAtRect", () => {
  it("agrees with a ray cast to the facing edge", () => {
    fc.assert(fc.property(point, point, rect, (from, to, box) => {
      expect(pointerAimsAtRect(from, to, box)).toBe(oracle(from, to, box));
    }), { numRuns: 5000 });
  });

  it("is false for a move straight across the direction of the card", () => {
    const card = { left: 358, right: 630, top: 660, bottom: 1130 };
    // Up or down a list beside the card, and standing still.
    expect(pointerAimsAtRect({ x: 300, y: 724 }, { x: 300, y: 772 }, card)).toBe(false);
    expect(pointerAimsAtRect({ x: 300, y: 724 }, { x: 300, y: 724 }, card)).toBe(false);
    // Away from it.
    expect(pointerAimsAtRect({ x: 300, y: 724 }, { x: 280, y: 760 }, card)).toBe(false);
    // Toward it, diagonally.
    expect(pointerAimsAtRect({ x: 300, y: 724 }, { x: 320, y: 760 }, card)).toBe(true);
  });
});
