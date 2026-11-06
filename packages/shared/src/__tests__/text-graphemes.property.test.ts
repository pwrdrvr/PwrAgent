import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { graphemePrefix, graphemeSuffix, splitGraphemes } from "../text-graphemes";
import {
  clusterBoundaries,
  displayText,
  expectClusterPrefix,
  expectClusterSuffix,
} from "./display-text-arbitraries";

/**
 * The promise in `text-graphemes.ts`: a cut keeps its budget in code units
 * and lands on a grapheme cluster boundary. The oracle for "boundary" is
 * `Intl.Segmenter`, and for "longest" the slow version below: try every
 * boundary and keep the largest one that fits.
 */
function longestFittingBoundary(value: string, maxLength: number): number {
  return Math.max(...[...clusterBoundaries(value)].filter((offset) => offset <= maxLength));
}

const budget = fc.integer({ min: 0, max: 80 });

describe("text-graphemes properties", () => {
  it("splits into clusters that join back to the input", () => {
    fc.assert(fc.property(displayText(), (value) => {
      expect(splitGraphemes(value).join("")).toBe(value);
    }));
  });

  it("keeps the longest leading run of whole clusters that fits", () => {
    fc.assert(fc.property(displayText(), budget, (value, maxLength) => {
      const kept = graphemePrefix(value, maxLength);
      expect(kept.length).toBeLessThanOrEqual(maxLength);
      expectClusterPrefix(kept, value);
      expect(kept.length).toBe(longestFittingBoundary(value, maxLength));
    }));
  });

  it("keeps the longest trailing run of whole clusters that fits", () => {
    fc.assert(fc.property(displayText(), budget, (value, maxLength) => {
      const kept = graphemeSuffix(value, maxLength);
      expect(kept.length).toBeLessThanOrEqual(maxLength);
      expectClusterSuffix(kept, value);
      const starts = [...clusterBoundaries(value)].filter((offset) => value.length - offset <= maxLength);
      expect(value.length - kept.length).toBe(Math.min(...starts));
    }));
  });

  it("returns the input unchanged when it fits", () => {
    fc.assert(fc.property(displayText(), (value) => {
      expect(graphemePrefix(value, value.length)).toBe(value);
      expect(graphemeSuffix(value, value.length)).toBe(value);
    }));
  });

  it("never cuts inside a ZWJ emoji or an NFD accent", () => {
    expect(graphemePrefix("ok 👩\u200d💻", 5)).toBe("ok ");
    expect(graphemeSuffix("👩\u200d💻 ok", 5)).toBe(" ok");
    expect(graphemePrefix("de\u0301ja\u0300", 2)).toBe("d");
    expect(graphemePrefix("de\u0301ja\u0300", 3)).toBe("de\u0301");
  });
});
