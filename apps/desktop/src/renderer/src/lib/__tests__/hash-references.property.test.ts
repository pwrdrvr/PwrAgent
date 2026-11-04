import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  formatHashReferenceThreadLabel,
  formatHashReferenceThreadTooltip,
} from "../hash-references";
import {
  displayText,
  expectEndCut,
  hasLoneSurrogate,
  whitespaceText,
} from "../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

const THREAD_LABEL_LENGTH_LIMIT = 72;
const THREAD_TOOLTIP_LENGTH_LIMIT = 300;

/**
 * `formatHashReferenceThreadLabel`'s comment: collapse the title to one line
 * and cut it at a word boundary. The kept text is the collapsed title's
 * prefix, at most the limit, followed by `…` only when text was removed.
 */
const collapse = (title: string) => title.replace(/\s+/g, " ").trim();

describe("hash reference label properties", () => {
  it("falls back to the thread id for a blank title", () => {
    fc.assert(fc.property(whitespaceText, (title) => {
      expect(formatHashReferenceThreadLabel({ id: "thread-1", title })).toBe("thread-1");
    }));
  });

  it("keeps a whole-character prefix of the collapsed title", () => {
    fc.assert(fc.property(displayText(80), (title) => {
      const source = collapse(title);
      fc.pre(source.length > 0);
      expectEndCut(source, formatHashReferenceThreadLabel({ id: "thread-1", title }), {
        ellipsis: "…",
        maxLength: THREAD_LABEL_LENGTH_LIMIT,
        ellipsisOutsideBudget: true,
      });
    }));
  });

  it("keeps a whole-character prefix in the tooltip", () => {
    fc.assert(fc.property(displayText(240), (title) => {
      const source = collapse(title);
      fc.pre(source.length > 0);
      expectEndCut(source, formatHashReferenceThreadTooltip({ id: "thread-1", title }), {
        ellipsis: "…",
        maxLength: THREAD_TOOLTIP_LENGTH_LIMIT,
        ellipsisOutsideBudget: true,
      });
    }));
  });

  it("does not tear an emoji at the hard cut", () => {
    const label = formatHashReferenceThreadLabel({ id: "thread-1", title: `ab ${"x".repeat(68)}😀z` });
    expect(hasLoneSurrogate(label)).toBe(false);
    expect(label).toBe(`ab ${"x".repeat(68)}…`);
  });
});
