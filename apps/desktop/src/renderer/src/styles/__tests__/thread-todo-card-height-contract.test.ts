import { describe, expect, it } from "vitest";

import { cssRuleBody } from "./css-rule-body";

/**
 * Locks the to-do card's resting and opened heights.
 *
 * The card in the transcript's top-right corner had no height limit: a
 * 7-line description and eight steps came to about 830px and covered the
 * transcript and the composer. A resting card clamps its description to
 * three lines; an opened card scrolls its body inside a cap rather than
 * growing. The step window is component logic and is tested beside the
 * card. jsdom performs no layout, so this suite pins the declarations.
 */
describe("to-do card height contract", () => {
  it("clamps a resting card's description to three lines", () => {
    const body = cssRuleBody(".thread-todo-card__detail.is-clamped");
    expect(body).toMatch(/display:\s*-webkit-box;/);
    expect(body).toMatch(/overflow:\s*hidden;/);
    expect(body).toMatch(/-webkit-box-orient:\s*vertical;/);
    expect(body).toMatch(/-webkit-line-clamp:\s*3;/);
  });

  it("scrolls an opened card's body inside a cap", () => {
    const body = cssRuleBody(".thread-todo-card__body.is-expanded");
    expect(body).toMatch(/max-height:\s*min\(440px,\s*55vh\);/);
    expect(body).toMatch(/overflow-y:\s*auto;/);
    // A scroll box clips at its padding edge; a checkbox ring (2px outline,
    // 1px offset) at the top or bottom needs room, pulled back out by the
    // margin so the text does not move.
    expect(body).toMatch(/padding-block:\s*4px;/);
    expect(body).toMatch(/margin-block:\s*-4px;/);
  });
});
