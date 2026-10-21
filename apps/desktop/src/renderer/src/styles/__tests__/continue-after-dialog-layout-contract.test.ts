import { describe, expect, it } from "vitest";

import { cssRuleBody } from "./css-rule-body";

/**
 * Locks the Continue After dialog against a horizontal scroll and against
 * clipping its own focus rings.
 *
 * Both bugs shipped in the first version, and both came from the scroll box.
 * The form scrolls vertically, and `overflow-y: auto` makes the other axis
 * `auto` too, so anything wider than the dialog scrolled it sideways instead
 * of wrapping. A grid with an `auto` track sizes that track to its widest
 * item's min-content, and a prerequisite's title is `nowrap`. One long title
 * (about 80 characters) needed 546px in a 322px column. The search results
 * list had the same flaw. And with no top padding, the search box's ring
 * (a 2px outline at a 2px offset) sat 4px above the box and was cut off.
 *
 * Measured in Chromium off the real stylesheet at 540 to 900px wide, with a
 * long title in both the results and a prerequisite row: before, the form
 * scrolled 782px in 562px and the ring top was 4px above the scroll box.
 * After, every scroll width equals its client width and no ring is clipped.
 * jsdom performs no layout, so this suite pins the declarations instead.
 */
describe("Continue After dialog layout contract", () => {
  it.each([
    ".continue-after-dialog__pick, .continue-after-dialog__setup",
    ".thread-dependencies__row",
    ".thread-dependencies__results",
  ])("lets %s shrink below an unbreakable title", (selector) => {
    expect(cssRuleBody(selector)).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  });

  it("pads the scroll box by the focus ring's reach on every side", () => {
    const body = cssRuleBody(".continue-after-dialog__body, .thread-dependencies__form.continue-after-dialog__form");
    // The premise: the box scrolls, so it clips at its padding edge.
    expect(body).toMatch(/overflow-y:\s*auto;/);
    expect(body).toMatch(/padding:\s*4px;/);
    // The same 4px pulled back out keeps controls aligned with the title.
    expect(body).toMatch(/margin:\s*\d+px\s+-4px\s+0;/);
    expect(cssRuleBody(".thread-dependencies__search:focus-visible, .thread-dependencies__form textarea:focus-visible"))
      .toMatch(/outline:\s*2px[^;]*;\s*outline-offset:\s*2px;/);
  });

  it("wraps a choice's buttons below its label instead of widening the column", () => {
    expect(cssRuleBody(".thread-dependencies__choice")).toMatch(/flex-wrap:\s*wrap;/);
  });
});
