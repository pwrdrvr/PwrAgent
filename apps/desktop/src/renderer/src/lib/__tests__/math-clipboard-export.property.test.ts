import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formulaPngDimensions } from "../math-clipboard-export";
import type { MathExportScale } from "../math-export-options";

describe("formula PNG allocation", () => {
  it("always fits the pixel and edge budgets without enlarging beyond the requested scale", () => {
    fc.assert(fc.property(
      fc.double({ min: 1, max: 1e9, noNaN: true }),
      fc.double({ min: 1, max: 1e9, noNaN: true }),
      fc.constantFrom<MathExportScale>(1, 2, 4),
      (width, height, scale) => {
        const size = formulaPngDimensions(width, height, scale);
        expect(Number.isInteger(size.width) && Number.isInteger(size.height)).toBe(true);
        expect(size.width).toBeGreaterThanOrEqual(1);
        expect(size.height).toBeGreaterThanOrEqual(1);
        expect(size.width).toBeLessThanOrEqual(Math.min(8192, width * scale));
        expect(size.height).toBeLessThanOrEqual(Math.min(8192, height * scale));
        expect(size.width * size.height).toBeLessThanOrEqual(16_000_000);
      },
    ));
  });

  it("renders uncapped formulas at exactly the requested pixel scale", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 800 }), fc.integer({ min: 1, max: 800 }),
      fc.constantFrom<MathExportScale>(1, 2, 4),
      (width, height, scale) => {
        expect(formulaPngDimensions(width, height, scale)).toEqual({ width: width * scale, height: height * scale });
      },
    ));
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid dimensions: %s", (value) => {
    expect(() => formulaPngDimensions(value, 20)).toThrow("invalid dimensions");
    expect(() => formulaPngDimensions(20, value)).toThrow("invalid dimensions");
  });

  it.each([0, -1, NaN, Infinity, 3])("rejects invalid scales: %s", (value) => {
    expect(() => formulaPngDimensions(20, 20, value as MathExportScale)).toThrow("invalid scale");
  });

  it("keeps the ordinary 2x resolution and exercises the allocation limits", () => {
    expect(formulaPngDimensions(100, 25)).toEqual({ width: 200, height: 50 });
    expect(formulaPngDimensions(100_000, 1)).toEqual({ width: 8192, height: 1 });
    expect(formulaPngDimensions(100_000, 100_000)).toEqual({ width: 4000, height: 4000 });
  });
});
