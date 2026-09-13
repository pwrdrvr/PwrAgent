import { describe, expect, it } from "vitest";

import { appCss, cssRuleBody } from "./css-rule-body";

/**
 * Locks the spacing of a directory's in-lane status line — "No threads in this
 * directory yet.", "Loading directory counts…", "Loading threads…".
 *
 * The bug this exists for was never a missing declaration. `margin-top: 0` was
 * present and correct; it was written as `.directory-row__empty`, which ties
 * with `.sidebar-empty` on specificity — and `.sidebar-empty` sits further
 * down `app.css` re-asserting the top margin through the `margin` shorthand,
 * so the later rule won. An expanded empty directory carried 16px of air above
 * the message against 6px below it, and the message read as belonging to
 * nothing. A `toContain("margin-top: 0")` assertion would have passed the
 * whole time it was broken, which is why this file asserts the SELECTOR
 * instead: the override only does anything if it out-specifies the rule it has
 * to beat.
 *
 * Not asserted through `getComputedStyle`, even though this suite runs in
 * jsdom and the outcome would be the better thing to check: jsdom resolves a
 * later SHORTHAND over an earlier longhand regardless of specificity (an `#id`
 * rule loses to a later `.class` one), so it reports 12px for a stylesheet
 * Chromium — the renderer's actual engine — resolves to 0px.
 */
describe("directory empty-state spacing", () => {
  // Both classes (0-2-0) beat `.sidebar-empty` (0-1-0) wherever either rule
  // moves to in the file. Demoting this to the single-class form is the
  // regression, and the file order that punishes it is not local to either
  // rule, so nothing at the edit site would show it. Absent entirely, the
  // helper throws naming the selector it could not find.
  const override = cssRuleBody(".sidebar-empty.directory-row__empty");

  it("out-specifies the sidebar-level rule it has to beat", () => {
    expect(override).toMatch(/\bmargin-top:\s*0(?:px)?\s*[;}]?/);
  });

  it("keeps the lane inset that aligns the line with the thread titles", () => {
    // The override's other half, and the half that never broke — which is
    // exactly why it needs asserting: it went on working while `margin-top`
    // silently did not, so nothing about the rule looked wrong.
    expect(override).toMatch(/\bpadding-left:\s*8px\s*[;}]?/);
  });

  it("still has a shorthand to beat", () => {
    // The premise. If `.sidebar-empty` ever stops setting the whole `margin`
    // shorthand, the override above is belt-and-braces rather than
    // load-bearing — worth knowing here rather than rediscovering.
    //
    // Matched out of the raw stylesheet rather than through `cssRuleBody`,
    // which keys on an exact selector line: `.sidebar-empty` ships inside a
    // three-selector group, so naming it there means hard-coding that group's
    // current line breaks and getting a "no such selector" throw the day
    // someone reflows it or adds a fourth.
    const sidebarEmptyRule = appCss.match(
      /\n\.sidebar-empty\s*[,{][\s\S]*?\{(?<body>[\s\S]*?)\n\}/,
    );

    expect(sidebarEmptyRule?.groups?.body).toMatch(/\bmargin:\s*[^;]+;/);
  });
});
