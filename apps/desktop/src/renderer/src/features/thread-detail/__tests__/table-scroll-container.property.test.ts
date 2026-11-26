import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeHorizontalScrollEdges } from "../TableScrollContainer";

describe("computeHorizontalScrollEdges properties", () => {
  it("never shows edge fades when content fits within the 1px sub-pixel tolerance", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000 }),
        fc.integer({ min: -50, max: 1 }),
        fc.integer({ min: 0, max: 200 }),
        (clientWidth, extra, scrollLeft) => {
          const scrollWidth = Math.max(0, clientWidth + extra);
          expect(
            computeHorizontalScrollEdges({ clientWidth, scrollLeft, scrollWidth }),
          ).toEqual({ left: false, right: false });
        },
      ),
    );
  });

  it("tracks left and right overflow monotonically across the full scroll range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_600 }),
        fc.integer({ min: 2, max: 2_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (clientWidth, overflow, fracA, fracB) => {
          const scrollWidth = clientWidth + overflow;
          const low = Math.min(fracA, fracB) * overflow;
          const high = Math.max(fracA, fracB) * overflow;

          const startEdges = computeHorizontalScrollEdges({
            clientWidth,
            scrollLeft: 0,
            scrollWidth,
          });
          expect(startEdges).toEqual({ left: false, right: true });

          const endEdges = computeHorizontalScrollEdges({
            clientWidth,
            scrollLeft: overflow,
            scrollWidth,
          });
          expect(endEdges).toEqual({ left: true, right: false });

          const lowEdges = computeHorizontalScrollEdges({
            clientWidth,
            scrollLeft: low,
            scrollWidth,
          });
          const highEdges = computeHorizontalScrollEdges({
            clientWidth,
            scrollLeft: high,
            scrollWidth,
          });
          if (lowEdges.left) {
            expect(highEdges.left).toBe(true);
          }
          if (!lowEdges.right) {
            expect(highEdges.right).toBe(false);
          }
        },
      ),
    );
  });

  it("handles macOS rubber-band overscroll and non-finite layout metrics without flipping edges", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_600 }),
        fc.integer({ min: 10, max: 1_200 }),
        fc.integer({ min: 1, max: 200 }),
        (clientWidth, overflow, overshoot) => {
          const scrollWidth = clientWidth + overflow;
          expect(
            computeHorizontalScrollEdges({
              clientWidth,
              scrollLeft: -overshoot,
              scrollWidth,
            }),
          ).toEqual({ left: false, right: true });
          expect(
            computeHorizontalScrollEdges({
              clientWidth,
              scrollLeft: overflow + overshoot,
              scrollWidth,
            }),
          ).toEqual({ left: true, right: false });
        },
      ),
    );

    expect(
      computeHorizontalScrollEdges({
        clientWidth: Number.NaN,
        scrollLeft: 0,
        scrollWidth: 400,
      }),
    ).toEqual({ left: false, right: false });
  });
});
