import { describe, expect, it } from "vitest";

import { firstCssRuleBody as ruleBody } from "./css-rule-body";

/**
 * Locks what lets an element inside a Settings section stick to the pane.
 *
 * A sticky element sticks to its nearest scroll container. `overflow: hidden`
 * makes one even when nothing ever scrolls it, so while
 * `.settings-section__body-clip` was `hidden`, every sticky element in a
 * section body stuck to that never-scrolling box and never moved. The Codex
 * model provider form's Save bar ended 264px below an 800px pane, out of reach
 * from the top of the form, until the clip became `overflow: clip`, which
 * paints the same and is not a scroll container. jsdom does no layout, so
 * only the stylesheet can be asserted here; the geometry was measured in
 * headless Chromium.
 */
describe("settings sticky contract", () => {
  it("clips a section body without making it a scroll container", () => {
    const overflow = ruleBody(".settings-section__body-clip").match(/overflow:\s*([a-z-]+)/)?.[1];
    expect(overflow).toBe("clip");
  });

  it("lands the provider form's Save bar on the window edge of the scrolling pane", () => {
    const footer = ruleBody(".codex-provider-editor__footer");
    expect(footer).toMatch(/position:\s*sticky/);
    // The sticky edge is the scrollport's content box, so `bottom` must
    // cancel exactly the pane's bottom padding, as the section headers'
    // `--settings-section-sticky-top` cancels its top padding.
    const pane = ruleBody(".settings-content");
    const padding = pane.match(/padding:\s*([^;]+);/)?.[1]?.trim().split(/\s+/) ?? [];
    const paneBottom = padding[2] ?? padding[0];
    const paneTop = padding[0];
    expect(footer).toMatch(new RegExp(`bottom:\\s*-${paneBottom};`));
    expect(pane).toMatch(new RegExp(`--settings-section-sticky-top:\\s*-${paneTop};`));
    // Under the pinned section header, which is `z-index: 3`.
    const z = Number(footer.match(/z-index:\s*(\d+)/)?.[1]);
    const headerZ = Number(ruleBody(".settings-section__header-button").match(/z-index:\s*(\d+)/)?.[1]);
    expect(z).toBeLessThan(headerZ);
  });

  it("pins only pane-level section headers, never one nested in a section body", () => {
    // With the body no longer a scroll container, a nested header would
    // otherwise stick at the pane top beneath the outer one.
    expect(ruleBody(".settings-section__body .settings-section__header-button"))
      .toMatch(/position:\s*static/);
  });
});
