import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatCopyTooltip } from "../copy-text";
import {
  displayText,
  expectMiddleCut,
  hasLoneSurrogate,
} from "../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

const COPY_HINT = "\nClick to copy to clipboard";

/**
 * A copy tooltip shows the path in at most `maxLength` characters, eliding
 * the middle with `…`, then the copy hint. Callers use the default 72; below
 * 9 the helper keeps a floor of 8 visible characters on purpose.
 */
describe("formatCopyTooltip properties", () => {
  it("elides the middle of the path on whole characters", () => {
    fc.assert(fc.property(displayText(), fc.integer({ min: 9, max: 80 }), (path, maxLength) => {
      const tooltip = formatCopyTooltip(path, maxLength);
      expect(tooltip.endsWith(COPY_HINT)).toBe(true);
      expectMiddleCut(path, tooltip.slice(0, -COPY_HINT.length), { ellipsis: "…", maxLength });
    }));
  });

  it("does not tear an emoji at either cut", () => {
    const path = `/${"a".repeat(8)}😀${"b".repeat(20)}`;
    const shown = formatCopyTooltip(path, 21).slice(0, -COPY_HINT.length);
    expect(hasLoneSurrogate(shown)).toBe(false);
    expect(shown).toBe(`/${"a".repeat(8)}…${"b".repeat(10)}`);
  });

  it("drops a family emoji whole when it does not fit (shrunk counterexample)", () => {
    expect(formatCopyTooltip("👨\u200d👩\u200d👧\u200d👦", 9)).toBe(`…${COPY_HINT}`);
  });
});
