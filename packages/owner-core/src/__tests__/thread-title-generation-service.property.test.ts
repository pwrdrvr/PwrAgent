import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { truncateThreadTitle } from "../thread-title-generation-service";
import {
  displayTextAround,
  expectClusterPrefix,
} from "../../../shared/src/__tests__/display-text-arbitraries";

// The prompt asks for 6 words and 50 characters; a generated title is
// accepted up to 30% over either limit and cut to fit beyond that.
const ACCEPTED_MAX_TITLE_WORDS = 7;
const ACCEPTED_MAX_TITLE_CHARACTERS = 65;

/**
 * The caller passes a trimmed title. The generated pieces hold no quotes, so
 * `cleanThreadTitle`'s quote stripping never applies and the result is a
 * prefix of the title with its whitespace runs collapsed.
 */
describe("truncateThreadTitle properties", () => {
  it("keeps a whole-character prefix within the word and character limits", () => {
    fc.assert(fc.property(displayTextAround(ACCEPTED_MAX_TITLE_CHARACTERS, 60, ["a", "b"]), (raw) => {
      const title = raw.trim();
      fc.pre(title.length > 0);
      const collapsed = title.split(/\s+/u).join(" ");
      const result = truncateThreadTitle(title);
      expect(Array.from(result).length).toBeLessThanOrEqual(ACCEPTED_MAX_TITLE_CHARACTERS);
      expect(result.split(/\s+/u).filter(Boolean).length).toBeLessThanOrEqual(ACCEPTED_MAX_TITLE_WORDS);
      expectClusterPrefix(result, collapsed);
      const words = collapsed.split(" ");
      if (words.length <= ACCEPTED_MAX_TITLE_WORDS && Array.from(collapsed).length <= ACCEPTED_MAX_TITLE_CHARACTERS) {
        expect(result).toBe(collapsed);
      }
    }));
  });

  it("does not cut a ZWJ emoji to its first person", () => {
    // 63 code points, then a 3-code-point emoji that crosses the limit.
    const title = `${"x".repeat(63)}👩\u200d💻`;
    expect(truncateThreadTitle(title)).toBe("x".repeat(63));
  });
});
