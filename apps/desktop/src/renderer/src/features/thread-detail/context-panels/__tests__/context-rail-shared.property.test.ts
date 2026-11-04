import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { elideMiddle } from "../context-rail-shared";
import {
  displayText,
  expectMiddleCut,
} from "../../../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

/**
 * Context rail tooltips show a value in at most `maxLength` characters,
 * eliding the middle with `…`. Callers use the default 72; below 9 the helper
 * keeps a floor of 8 visible characters on purpose.
 */
describe("context rail elideMiddle properties", () => {
  it("elides the middle on whole characters", () => {
    fc.assert(fc.property(displayText(), fc.integer({ min: 9, max: 80 }), (value, maxLength) => {
      expectMiddleCut(value, elideMiddle(value, maxLength), { ellipsis: "…", maxLength });
    }));
  });

  it("keeps an NFD accent with its letter", () => {
    const value = `${"a".repeat(9)}e\u0301${"b".repeat(20)}`;
    const shown = elideMiddle(value, 21);
    expect(shown).toBe(`${"a".repeat(9)}…${"b".repeat(10)}`);
  });

  it("keeps both accents of NFD déjàdéjà (shrunk counterexample)", () => {
    expect(elideMiddle("de\u0301ja\u0300de\u0301ja\u0300", 9)).toBe("de\u0301j…ja\u0300");
  });
});
