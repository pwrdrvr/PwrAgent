import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { truncate } from "../operator-waits";
import {
  displayTextAround,
  expectEndCut,
  hasLoneSurrogate,
} from "../../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

const MAX_TITLE_LENGTH = 160;

/** An operator wait's title is at most 160 characters, `…` included. */
describe("operator wait title properties", () => {
  it("keeps a whole-character prefix within 160", () => {
    fc.assert(fc.property(displayTextAround(MAX_TITLE_LENGTH, 120), (text) => {
      expectEndCut(text, truncate(text), { ellipsis: "…", maxLength: MAX_TITLE_LENGTH });
    }));
  });

  it("does not tear an emoji at the cut", () => {
    const title = truncate(`${"x".repeat(158)}😀 approve?`);
    expect(hasLoneSurrogate(title)).toBe(false);
    expect(title).toBe(`${"x".repeat(158)}…`);
  });

  it("does not keep half of an astral letter (shrunk counterexample)", () => {
    expect(truncate(`${"a".repeat(158)}𝒳a`)).toBe(`${"a".repeat(158)}…`);
  });
});
