import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatRuntimeBranch } from "../runtime-identity";
import {
  displayText,
  expectMiddleCut,
  hasLoneSurrogate,
} from "../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

/**
 * The runtime badge shows a branch in at most 34 characters, eliding the
 * middle with `...` so both the prefix and the distinguishing end survive.
 */
describe("formatRuntimeBranch properties", () => {
  it("elides the middle on whole characters within 34", () => {
    fc.assert(fc.property(displayText(), (branch) => {
      expectMiddleCut(branch, formatRuntimeBranch(branch), { ellipsis: "...", maxLength: 34 });
    }));
  });

  it("does not tear an emoji at either cut", () => {
    const branch = `${"a".repeat(15)}😀${"b".repeat(20)}`;
    const label = formatRuntimeBranch(branch);
    expect(hasLoneSurrogate(label)).toBe(false);
    expect(label).toBe(`${"a".repeat(15)}...${"b".repeat(15)}`);
  });
});
