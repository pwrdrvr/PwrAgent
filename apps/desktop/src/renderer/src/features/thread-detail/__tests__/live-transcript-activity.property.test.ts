import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { truncateActivityText } from "../live-transcript-activity";
import {
  displayText,
  expectEndCut,
  hasLoneSurrogate,
} from "../../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

/**
 * A live activity's prompt or message is collapsed to one line and kept to
 * `maxLength` characters, `...` included.
 */
describe("truncateActivityText properties", () => {
  it("keeps a whole-character prefix of the collapsed text within budget", () => {
    fc.assert(fc.property(displayText(), fc.integer({ min: 4, max: 100 }), (text, maxLength) => {
      const source = text.replace(/\s+/g, " ").trim();
      expectEndCut(source, truncateActivityText(text, maxLength), { ellipsis: "...", maxLength });
    }));
  });

  it("does not tear an emoji at the cut", () => {
    const shown = truncateActivityText(`${"x".repeat(16)}😀 and the rest`, 20);
    expect(hasLoneSurrogate(shown)).toBe(false);
    expect(shown).toBe(`${"x".repeat(16)}...`);
  });

  it("drops a family emoji whole when it does not fit (shrunk counterexample)", () => {
    expect(truncateActivityText("👨\u200d👩\u200d👧\u200d👦", 4)).toBe("...");
  });
});
