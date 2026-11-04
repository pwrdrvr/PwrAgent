import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clipText } from "../WaitingForPanel";
import {
  displayText,
  expectEndCut,
  hasLoneSurrogate,
} from "../../../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

/**
 * Waiting For quotes a wake's text or a hold's note in at most `max`
 * characters, `…` included, with no space left before the `…`.
 */
describe("WaitingForPanel clipText properties", () => {
  it("keeps a whole-character prefix within budget", () => {
    fc.assert(fc.property(displayText(), fc.integer({ min: 2, max: 100 }), (text, max) => {
      const clipped = clipText(text, max);
      expectEndCut(text, clipped, { ellipsis: "…", maxLength: max });
      if (clipped !== text) {
        expect(clipped).not.toMatch(/\s…$/u);
      }
    }));
  });

  it("does not tear an emoji at the cut", () => {
    const clipped = clipText(`${"x".repeat(58)}😀 deploy finished`, 60);
    expect(hasLoneSurrogate(clipped)).toBe(false);
    expect(clipped).toBe(`${"x".repeat(58)}…`);
  });
});
