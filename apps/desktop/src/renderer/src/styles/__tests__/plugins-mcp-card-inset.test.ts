import { describe, expect, it } from "vitest";

import { appCss, cssRuleBodies, cssRuleBody } from "./css-rule-body";

/**
 * Locks the two things that made Settings → Plugins read as unfinished.
 *
 * `.settings-section__body` has no padding of its own. Every card in Settings
 * relies on its children to carry `14px 18px` — `.settings-field` declares it,
 * and the two body children that are not fields (`.settings-paths`,
 * `.settings-comp-opts`) each have a rule restating it. The MCP card had four
 * unpadded body children, so its constraint line, its Name label and its
 * connection rows all sat on the card's left border and the Check button on
 * its right one, 18px outside the gateway switch directly above them.
 *
 * Nothing about that is visible at the edit site: the rules that get it right
 * live hundreds of lines away under other selectors, and a new body child
 * added to this card inherits the bug by default. Hence a contract rather than
 * a comment.
 *
 * Asserted against the stylesheet, not `getComputedStyle`: jsdom performs no
 * layout, and it resolves a later shorthand over an earlier longhand
 * regardless of specificity, so a computed-style reading here can disagree
 * with Chromium on a correct stylesheet.
 */
describe("Plugins MCP card", () => {
  const manage = cssRuleBody(".settings-mcp-manage");

  it("insets its body children the way every other Settings card does", () => {
    // The same pair `.settings-field` uses. A different inset here would put
    // the connection rows on a different left edge from the gateway switch
    // they sit under, which is the arrangement this replaced.
    expect(manage).toMatch(/\bpadding:\s*14px\s+18px\s*[;}]?/);
  });

  it("owns the rhythm between those children", () => {
    // The children dropped their own `margin-bottom` when they moved in here.
    // Without the gap they butt together.
    expect(manage).toMatch(/\bgap:\s*14px\s*[;}]?/);
    expect(cssRuleBody(".settings-mcp-probe")).toMatch(/\bmargin:\s*0\s*[;}]?/);
    expect(cssRuleBody(".settings-mcp-manage > .settings-plugin-notice"))
      .toMatch(/\bmargin:\s*0\s*[;}]?/);
  });

  /**
   * The add form is the one block in the card that is not a thing the operator
   * has. Rendered at the same weight as the rows, an empty Name field directly
   * above `PwrSnap` read as a connection that had lost its name.
   */
  it("draws the add form unlike the connections it sits beside", () => {
    const create = cssRuleBody(".settings-mcp-create");
    const row = cssRuleBodies(".settings-mcp-row")[0]!;
    expect(create).toMatch(/\bborder:\s*1px\s+dashed\b/);
    expect(row).toMatch(/\bborder:\s*1px\s+solid\b/);
    // The rows are elevated off the card; the slot is not. Matching this to
    // the row background is the regression, and it makes the two blocks
    // indistinguishable again. Both spellings are rejected: `background:`
    // alone would let `background-color` restore the collision while this
    // test stayed green.
    expect(row).toMatch(/\bbackground:\s*var\(--bg-panel-elevated\)/);
    expect(create).not.toMatch(/\bbackground(-color)?:/);
  });

  /**
   * The three-column grid belongs to the fields, not to the `<form>`. Moved
   * back up a level it captures the form's heading and constraint line as grid
   * items, which silently lays them out as the first two of three columns.
   */
  it("keeps the field grid below the form's heading and help line", () => {
    expect(cssRuleBody(".settings-mcp-create__fields")).toMatch(
      /\bgrid-template-columns:\s*minmax\(140px,\s*\.6fr\)\s+minmax\(240px,\s*1\.4fr\)\s+auto/,
    );
    expect(cssRuleBody(".settings-mcp-create")).not.toMatch(
      /\bgrid-template-columns:/,
    );
    // And the narrow-window collapse has to follow it down. Left on
    // `.settings-mcp-create` it re-columnises the block that now holds the
    // heading, so it is checked where it lives -- inside the `@media`, which
    // `cssRuleBodies` does not reach.
    expect(appCss).toMatch(
      /@media \(max-width: 820px\) \{\s*\.settings-mcp-create__fields \{\s*grid-template-columns: 1fr;/,
    );
  });
});
