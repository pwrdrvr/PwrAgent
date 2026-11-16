import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_MATH_EXPORT_OPTIONS, parseMathExportOptions } from "../math-export-options";
import type { MathExportColor, MathExportScale } from "../math-export-options";

describe("formula export preferences", () => {
  it("round-trips every supported combination", () => {
    fc.assert(fc.property(
      fc.constantFrom<MathExportColor>("dark", "light", "theme"),
      fc.constantFrom<MathExportScale>(1, 2, 4),
      (color, scale) => {
        const options = { color, scale };
        expect(parseMathExportOptions(JSON.parse(JSON.stringify(options)))).toEqual(options);
      },
    ));
  });

  it("accepts only recognized fields from arbitrary stored values", () => {
    fc.assert(fc.property(fc.anything(), (value) => {
      const options = parseMathExportOptions(value);
      expect(["dark", "light", "theme"]).toContain(options.color);
      expect([1, 2, 4]).toContain(options.scale);
      expect(Object.keys(options).sort()).toEqual(["color", "scale"]);
    }));
  });

  it("defaults invalid fields independently", () => {
    expect(parseMathExportOptions({ color: "light", scale: 1000 })).toEqual({ color: "light", scale: 2 });
    expect(parseMathExportOptions({ color: "invalid", scale: 4 })).toEqual({ color: "dark", scale: 4 });
    expect(parseMathExportOptions(null)).toEqual(DEFAULT_MATH_EXPORT_OPTIONS);
  });
});
