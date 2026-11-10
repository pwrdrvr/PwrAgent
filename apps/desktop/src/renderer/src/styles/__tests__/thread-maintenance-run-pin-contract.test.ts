import { describe, expect, it } from "vitest";

import { cssRuleBody as ruleBody } from "./css-rule-body";

/**
 * While a run works, its items in progress stay at the top of the dialog's
 * body and the results scroll under them. jsdom has no layout, so the rule
 * is pinned in the stylesheet; the harness measures the real geometry.
 */
describe("thread maintenance run: items in progress stay in view", () => {
  it("pins the in-progress group to the top of the body scroller", () => {
    const body = ruleBody(".thread-maintenance__run-group.is-active");
    expect(body).toMatch(/position:\s*sticky;/);
    expect(body).toMatch(/top:\s*-?\d+px;/);
    expect(body).toMatch(/z-index:\s*\d+;/);
    // Opaque: a result scrolling under it never shows through, in any theme.
    expect(body).toMatch(/background:[^;]*var\(--bg-panel-elevated\);/);
  });

  it("keeps the body the one scroller, so the pin resolves against it", () => {
    expect(ruleBody(".thread-maintenance__body")).toMatch(/overflow-y:\s*auto;/);
    expect(ruleBody(".thread-maintenance__run")).not.toMatch(/overflow/);
  });

  it("scrolls focus clear of the pinned rows", () => {
    // A result's Open thread button reached by Tab must land below the pin,
    // not under it. The dialog sets the variable from the pin's height.
    expect(ruleBody(".thread-maintenance__body"))
      .toMatch(/scroll-padding-top:\s*var\(--thread-maintenance-pinned,\s*0px\);/);
  });

  it("caps the pinned rows so they never fill a short window", () => {
    expect(ruleBody(".thread-maintenance__run-group.is-active .thread-maintenance__run-rows"))
      .toMatch(/max-height:\s*\d+vh;[\s\S]*overflow-y:\s*auto;/);
  });
});
