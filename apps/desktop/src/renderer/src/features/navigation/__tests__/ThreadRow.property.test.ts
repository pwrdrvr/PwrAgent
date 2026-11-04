import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { elide } from "../ThreadRow";
import {
  displayText,
  expectEndCut,
  hasLoneSurrogate,
} from "../../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

/**
 * The messaging chip elides its leaf segment (a topic, thread or channel
 * name) to about 20 characters so a long name cannot widen the row. The
 * budget includes the `…`.
 */
describe("thread row chip leaf elision properties", () => {
  it("keeps a whole-character prefix of the trimmed name within budget", () => {
    fc.assert(fc.property(displayText(), fc.integer({ min: 2, max: 40 }), (name, max) => {
      expectEndCut(name.trim(), elide(name, max), { ellipsis: "…", maxLength: max });
    }));
  });

  it("does not tear an emoji at the cut", () => {
    const label = elide(`${"x".repeat(18)}😀 standup`);
    expect(hasLoneSurrogate(label)).toBe(false);
    expect(label).toBe(`${"x".repeat(18)}…`);
  });

  it("does not keep half of an astral letter (shrunk counterexample)", () => {
    expect(elide("𝒳a", 2)).toBe("…");
  });

  it("leaves no space before the ellipsis", () => {
    expect(elide("Weekly sync digest for Q4")).toBe("Weekly sync digest…");
  });
});
