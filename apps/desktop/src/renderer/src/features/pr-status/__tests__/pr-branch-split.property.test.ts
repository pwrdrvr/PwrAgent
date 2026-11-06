import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BRANCH_TAIL_CHARS, splitPrBranch } from "../pr-branch-split";
import {
  clusterBoundaries,
  displayText,
  whitespaceText,
} from "../../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const clusterCount = (value: string) => [...segmenter.segment(value)].length;

/**
 * The PR card's branch row promises, from `splitPrBranch`'s comments:
 * `head + tail` is the whole (trimmed) name, the cut never splits a
 * grapheme cluster, and the tail is at most half the name and at most
 * `BRANCH_TAIL_CHARS` clusters.
 */
describe("splitPrBranch properties", () => {
  it("has no branch row for a missing or blank name", () => {
    fc.assert(fc.property(fc.option(whitespaceText, { nil: undefined }), (name) => {
      expect(splitPrBranch(name)).toBeUndefined();
    }));
  });

  it("keeps the whole name, cut between clusters, with a bounded tail", () => {
    fc.assert(fc.property(displayText(), (name) => {
      const trimmed = name.trim();
      fc.pre(trimmed.length > 0);
      const split = splitPrBranch(name)!;
      expect(split.full).toBe(trimmed);
      expect(split.head + split.tail).toBe(trimmed);
      expect(clusterBoundaries(trimmed).has(split.head.length)).toBe(true);
      const tailClusters = clusterCount(split.tail);
      expect(tailClusters).toBe(Math.min(BRANCH_TAIL_CHARS, Math.floor(clusterCount(trimmed) / 2)));
    }));
  });

  it("keeps an NFD accent and a ZWJ emoji whole", () => {
    // NFD, as macOS stores a loose ref: `e` + U+0301, `a` + U+0300.
    const nfd = "chore/de\u0301ja\u0300-vu-dedupe";
    expect(splitPrBranch(nfd)).toEqual({
      full: nfd,
      head: "chore/de\u0301ja\u0300",
      tail: "-vu-dedupe",
    });
    expect(splitPrBranch("👩\u200d💻👩\u200d💻")).toEqual({ full: "👩\u200d💻👩\u200d💻", head: "👩\u200d💻", tail: "👩\u200d💻" });
  });
});
