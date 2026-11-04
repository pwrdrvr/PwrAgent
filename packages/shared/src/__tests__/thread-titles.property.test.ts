import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { shortenDerivedThreadTitle } from "../thread-titles";
import { displayText, expectEndCut, hasLoneSurrogate } from "./display-text-arbitraries";

const MAX_DERIVED_THREAD_TITLE_LENGTH = 72;

/**
 * A derived title is the first prompt, collapsed to one line, cut to 72
 * characters with `...` when it is longer. The generated pieces hold no
 * request prefix ("please", "can you") and no skill token, so the text the
 * helper shortens is the collapsed prompt without its trailing punctuation.
 */
function derivedSource(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().replace(/[\s,;:.-]+$/g, "").trim();
}

describe("shortenDerivedThreadTitle properties", () => {
  it("keeps a whole-character prefix of the prompt within 72 characters", () => {
    fc.assert(fc.property(displayText(80), (prompt) => {
      const source = derivedSource(prompt);
      fc.pre(source.length > 0);
      const title = shortenDerivedThreadTitle(prompt)!;
      expectEndCut(source, title, {
        ellipsis: "...",
        maxLength: MAX_DERIVED_THREAD_TITLE_LENGTH,
        ellipsisOutsideBudget: true,
      });
    }));
  });

  it("does not tear an emoji at the hard cut", () => {
    const prompt = `${"x".repeat(71)}😀 and more words after it`;
    const title = shortenDerivedThreadTitle(prompt)!;
    expect(hasLoneSurrogate(title)).toBe(false);
    expect(title).toBe(`${"x".repeat(71)}...`);
  });
});
