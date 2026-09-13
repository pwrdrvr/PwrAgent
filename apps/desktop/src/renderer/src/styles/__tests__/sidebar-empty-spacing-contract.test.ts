import { describe, expect, it } from "vitest";

import { appCss, cssRuleBody } from "./css-rule-body";

/**
 * Locks the spacing above an expanded-but-empty directory's status line
 * ("No threads in this directory yet." / "Loading directory counts…").
 *
 * The bug this exists for was never a missing declaration. `margin-top: 0`
 * was present and correct; it was written as `.directory-row__empty`, which
 * ties with `.sidebar-empty` on specificity — and `.sidebar-empty` sits
 * further down `app.css` re-asserting the top margin through the `margin`
 * shorthand, so the later rule won. An expanded empty directory carried 16px
 * of air above the message against 6px below it, and the message read as
 * belonging to nothing. A `toContain("margin-top: 0")` assertion would have
 * passed the whole time it was broken, which is why this test asserts the
 * SELECTOR instead: the override only does anything if it out-specifies the
 * rule it has to beat.
 *
 * Not asserted through `getComputedStyle`, even though this suite runs in
 * jsdom and the outcome would be the better thing to check: jsdom resolves a
 * later SHORTHAND over an earlier longhand regardless of specificity (an
 * `#id` rule loses to a later `.class` one), so it reports 12px for a
 * stylesheet Chromium — the renderer's actual engine — resolves to 0px.
 */
describe("directory empty-state spacing", () => {
  it("out-specifies the sidebar-level rule it has to beat", () => {
    // Both classes (0-2-0) beat `.sidebar-empty` (0-1-0) wherever either rule
    // moves to in the file. Demoting this back to the single-class form is
    // the regression; the file order that punishes it is not local to either
    // rule, so nothing at the edit site would show it.
    expect(cssRuleBody(".sidebar-empty.directory-row__empty")).toMatch(
      /\bmargin-top:\s*0\s*;/,
    );
    expect(appCss).not.toMatch(/(?:^|\n)\.directory-row__empty\s*\{/);
  });

  it("still has a shorthand to beat", () => {
    // The premise. If `.sidebar-empty` ever stops setting the whole `margin`
    // shorthand, the override above is belt-and-braces rather than
    // load-bearing — worth knowing here rather than rediscovering.
    expect(cssRuleBody(".sidebar-empty,\n.context-empty,\n.transcript-empty")).toMatch(
      /\bmargin:\s*12px\s+0\s+0\s*;/,
    );
  });
});
