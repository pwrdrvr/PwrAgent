import { describe, expect, it } from "vitest";

import { cssRuleBodies as ruleBodies, cssRuleBody as ruleBody } from "./css-rule-body";

/**
 * The Automations screen scrolls at `.automations-content`; everything inside
 * it must be free to exceed that box rather than be squeezed into it.
 *
 * `.automations-table` clips to its border radius with `overflow: hidden`, so
 * a shrunk table does not overflow visibly and does not scroll — it silently
 * eats its own content. Measured once at 179px tall holding 1309px of rows,
 * with no scrollbar anywhere on the page. jsdom has no layout engine, so the
 * invariant is pinned here in the stylesheet instead.
 */
describe("automations screen scrolling", () => {
  it("scrolls the content column", () => {
    expect(ruleBody(".automations-content")).toMatch(/overflow:\s*auto;/);
  });

  it("keeps the table at its natural height inside that column", () => {
    const body = ruleBody(".automations-table");
    expect(body).toMatch(/flex:\s*0\s+0\s+auto;/);
    // The pairing is the trap: shrinkable + clipped = unreachable content.
    expect(body).toMatch(/overflow:\s*clip;/);
  });

  it("clips with `clip` so sticky descendants still see the scroll container", () => {
    // `overflow: hidden` would make the table a scroll container of its own,
    // and every sticky header inside it would resolve against a box that
    // never scrolls — silently doing nothing.
    expect(ruleBody(".automations-table")).not.toMatch(/overflow:\s*hidden;/);
  });

  it("stacks the three sticky layers against the header height", () => {
    expect(ruleBody(".automations-table")).toMatch(
      /--automations-header-h:\s*\d+px;/,
    );
    expect(ruleBody(".automations-table__header")).toMatch(/top:\s*0;/);
    expect(ruleBody(".automations-table__row")).toMatch(
      /top:\s*var\(--automations-header-h\);/,
    );
    expect(
      ruleBody(".automations-table__history .automation-run-history__line"),
    ).toMatch(
      /top:\s*calc\(var\(--automations-header-h\)\s*\+\s*var\(--automation-row-h,\s*0px\)\);/,
    );
  });
});
