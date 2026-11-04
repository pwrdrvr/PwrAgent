import { describe, expect, it } from "vitest";

import { firstCssRuleBody } from "./css-rule-body";

/**
 * Locks the lock card above every overlay in the chat column.
 *
 * The lock layer sat at z-index 4 while the to-do stack (29) and the find bar
 * (30) share its positioning context, `.thread-view__primary`. A tall open
 * to-do card reached the centered lock card and painted over it at the dim's
 * 45% opacity, so the card read as translucent. jsdom performs no layout or
 * stacking, so this suite pins the declarations.
 */
function zIndex(selector: string): number {
  const match = /z-index:\s*(-?\d+);/.exec(firstCssRuleBody(selector));
  if (!match) throw new Error(`Expected ${selector} to declare a z-index`);
  return Number(match[1]);
}

describe("thread lock layer contract", () => {
  it("stacks the lock layer above the column's overlays", () => {
    const lock = zIndex(".thread-lock-layer");
    for (const overlay of [".thread-todo-stack", ".thread-find"]) {
      expect(lock, `${overlay} must stay under the lock layer`).toBeGreaterThan(zIndex(overlay));
    }
  });

  it("isolates a locked column so the lock layer stays under the context rail", () => {
    // Without the isolation, a lock layer above the rail would also cover
    // the rail's flyout, which is a sibling of the column, not a child.
    expect(firstCssRuleBody(".thread-view__primary--locked")).toMatch(/isolation:\s*isolate;/);
  });
});
