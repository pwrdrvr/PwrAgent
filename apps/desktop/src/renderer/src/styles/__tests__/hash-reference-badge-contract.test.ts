import { describe, expect, it } from "vitest";

import { cssRuleBody } from "./css-rule-body";

/**
 * Pins the `#` picker's THREAD / PR kind badge to the row's right edge.
 *
 * The badge follows the title label inside one flex row, and the label is
 * `flex: 0 1 auto` so it can shrink to an ellipsis. That made the badge's
 * position depend on the title's length: a title long enough to clamp
 * filled the row and left the badge flush right, while a short one
 * shrink-wrapped and left the badge one gap after its last word. In a list
 * that mixes the two, the badges zig-zag down the popover.
 *
 * The auto margin absorbs whatever space the label leaves, and resolves to
 * zero when the label overflows, so the clamped rows are unchanged.
 *
 * jsdom performs no layout, so this asserts the declarations. The measured
 * edge is asserted in `e2e/composer-chip-alignment.spec.ts`, against a
 * fixture thread whose title is too short to clamp.
 */
describe("hash reference badge contract", () => {
  it("pushes the kind badge to the end of the title row", () => {
    const badge = cssRuleBody(
      ".composer__autocomplete--hash-references .composer__autocomplete-source",
    );
    expect(badge).toMatch(/margin-left:\s*auto\s*;/);
    // The badge is the row's only classifier, so the label still absorbs
    // any shortfall rather than the badge.
    expect(badge).toMatch(/flex:\s*none\s*;/);
  });

  it("still has a shrink-wrapping label for the badge to follow", () => {
    // The premise: a label that grew to fill the row would also pin the
    // badge. If that ever changes, revisit the margin rather than keep both.
    const title = cssRuleBody(".composer__autocomplete-title");
    expect(title).toMatch(/display:\s*inline-flex\s*;/);
    const label = cssRuleBody(".composer__autocomplete-label");
    expect(label).toMatch(/flex:\s*0 1 auto\s*;/);
  });
});
