import { describe, expect, it } from "vitest";
import { cssRuleBody } from "./css-rule-body";

function ruleBody(selector: string): string {
  return cssRuleBody(selector).replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The project header card's text must stay inside the card for any folder
 * name, however long.
 *
 * It did not. The path line middle-truncates by letting only the head shrink;
 * the folder name (`__path-tail`) was `flex: 0 0 auto` + `nowrap` with no
 * width cap, so once the head had shrunk to nothing a long worktree name kept
 * its full width. Measured in headless Chromium against this stylesheet in the
 * 272px card, `pr4358-claude-noisy--codex-native-FkaqMR` ran 22px past the
 * card's content edge and over its border. The title had the matching gap for
 * a name with no break opportunity: it was clipped mid-glyph instead of
 * wrapping inside its two lines.
 *
 * jsdom has no layout engine, so the invariant is pinned in the stylesheet.
 */
describe("project header card path", () => {
  it("caps the folder name at the card's width and ellipsizes it there", () => {
    const body = ruleBody(".project-card__path-tail");
    expect(body).toMatch(/max-width:\s*100%;/);
    expect(body).toMatch(/overflow:\s*hidden;/);
    expect(body).toMatch(/text-overflow:\s*ellipsis;/);
  });

  it("still shrinks the head before the folder name", () => {
    expect(ruleBody(".project-card__path-head")).toMatch(/flex:\s*1 1 12ch;/);
    expect(ruleBody(".project-card__path-tail")).toMatch(/flex:\s*0 0 auto;/);
  });

  /*
   * A folder name wider than the card used to squeeze the head to 0px, so the
   * line showed only the truncated name: a copy of the title that no longer
   * said where the project lives. The line now wraps the name onto its own
   * row whenever it cannot share one with 12ch of the head. The head's
   * `max-width: max-content` is what keeps a short path on one line with the
   * name beside it: without it the head's flex-grow fills the row and pushes
   * the name to the right edge.
   */
  it("wraps a long folder name below the head so the location stays visible", () => {
    expect(ruleBody(".project-card__path")).toMatch(/flex-wrap:\s*wrap;/);
    const head = ruleBody(".project-card__path-head");
    expect(head).toMatch(/max-width:\s*max-content;/);
    expect(head).toMatch(/min-width:\s*0;/);
  });

  it("wraps a title with no break opportunity inside the card", () => {
    expect(ruleBody(".pr-status-card__title")).toMatch(/overflow-wrap:\s*anywhere;/);
  });
});
