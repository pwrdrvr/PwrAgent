import { describe, expect, it } from "vitest";

import { cssRuleBody as ruleBody } from "./css-rule-body";

/**
 * The model panel with a provider rail keeps one height whatever provider is
 * chosen. Above the composer it is anchored at its foot, so a body that took
 * each provider's height moved the panel's top edge with every pick: 189px
 * for a provider with two models, 397px for one with nine. jsdom has no
 * layout, so the declarations that hold the height are pinned here.
 */
describe("model settings panel height", () => {
  it("gives the rail layout's body a fixed height", () => {
    const grid = ruleBody(".model-settings__grid");
    expect(grid).toMatch(/(^|[;\s])height:\s*\d+px;/);
    expect(grid).not.toMatch(/(^|[;\s])height:\s*(auto|fit-content|max-content)/);
  });

  it("scrolls the model list inside that body and keeps Effort and Speed at its foot", () => {
    const main = ruleBody(".model-settings__grid .model-settings__main");
    expect(main).toMatch(/display:\s*flex;/);
    expect(main).toMatch(/flex-direction:\s*column;/);
    expect(main).toMatch(/min-height:\s*0;/);
    expect(ruleBody(".model-settings__grid .model-settings__section")).toMatch(/flex:\s*none;/);
    const models = ruleBody(".model-settings__grid .model-settings__models");
    expect(models).toMatch(/flex:\s*1\s+1\s+auto;/);
    expect(models).toMatch(/min-height:\s*0;/);
    expect(models).toMatch(/overflow-y:\s*auto;/);
  });

  it("scrolls a long provider list in its rail rather than growing the body", () => {
    const rail = ruleBody(".model-settings__rail");
    expect(rail).toMatch(/min-height:\s*0;/);
    expect(rail).toMatch(/overflow-y:\s*auto;/);
  });
});
