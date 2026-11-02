import { describe, expect, it } from "vitest";

import { cssRuleBody as ruleBody } from "./css-rule-body";

/**
 * The To-dos rail tab keeps its lens switch fixed and scrolls only its list,
 * and each group's header holds the top of that list while its rows scroll
 * past — the way the sidebar's project headers and the Edits tab's groups do.
 *
 * Before this, the whole section scrolled inside `.context-panel__scroll`:
 * the lens switch scrolled off the top, and the All lens's project headings
 * scrolled away with their rows, so a long list lost track of which project
 * a row belonged to. jsdom has no layout, so the invariant is pinned here.
 */
describe("to-do panel scrolling", () => {
  it("fills the rail tab, so the outer scroller never scrolls it", () => {
    const body = ruleBody(".context-panel__section.context-panel__section--todos");
    expect(body).toMatch(/display:\s*flex;/);
    expect(body).toMatch(/flex-direction:\s*column;/);
    expect(body).toMatch(/height:\s*100%;/);
    expect(body).toMatch(/min-height:\s*0;/);
    expect(body).toMatch(/padding:\s*0;/);
  });

  it("keeps the title and lens switch out of the scrolling body", () => {
    expect(ruleBody(".thread-todos-panel__header")).toMatch(/flex:\s*0\s+0\s+auto;/);
    const body = ruleBody(".thread-todos-panel__body");
    expect(body).toMatch(/flex:\s*1(\s+1\s+0(px|%)?)?;/);
    expect(body).toMatch(/min-height:\s*0;/);
    expect(body).toMatch(/overflow-y:\s*auto;/);
  });

  it("pins each group's header to the top of the body", () => {
    const header = ruleBody(".thread-todos-panel__group-title");
    expect(header).toMatch(/position:\s*sticky;/);
    expect(header).toMatch(/top:\s*0;/);
    expect(header).toMatch(/z-index:\s*\d+;/);
    // Opaque, or rows show through the pinned header.
    expect(header).toMatch(/background:\s*var\(--bg-panel\);/);
  });

  it("does not clip a group, which would stop its header sticking", () => {
    // `overflow: hidden` makes the group its own scroll container, and the
    // sticky header would then resolve against a box that never scrolls.
    expect(ruleBody(".thread-todos-panel__group")).not.toMatch(/overflow:\s*(hidden|auto|scroll);/);
  });
});
