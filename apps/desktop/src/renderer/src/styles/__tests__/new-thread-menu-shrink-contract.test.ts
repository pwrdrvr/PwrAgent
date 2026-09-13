import { describe, expect, it } from "vitest";

import { cssRuleBody } from "./css-rule-body";

/**
 * Locks the separators in the New Thread flyout against flex shrink.
 *
 * The bug this exists for was never a missing declaration, and that is what
 * made it read as arbitrary. `.new-thread-menu__separator` said `height: 1px`
 * the whole time. But `.new-thread-menu__card` is a flex column with a
 * `max-height` and `overflow-y: auto`, and a flex column spends negative free
 * space on its children FIRST, scrolling only what it cannot squeeze out.
 * Every row carries `min-height: 36px` and can refuse; the separators had no
 * floor, so an overflowing card took its entire deficit out of them and
 * computed both to `height: 0`.
 *
 * Measured in Chromium off the real stylesheet: directory-less, the card was
 * 385px of 385px content and both rules painted. Add a directory context —
 * one more 36px row, content 421px against the 420px cap — and both computed
 * to 0px while every row kept its size. The operator saw rules in one menu
 * and none in the other and could not have guessed why; neither could the
 * stylesheet, read on its own.
 *
 * Not asserted through `getComputedStyle`, even though the computed height is
 * the real subject: jsdom performs no layout, so it reports the declared 1px
 * for a stylesheet Chromium — the renderer's actual engine — resolves to 0px.
 * The declarations that produce the outcome are all this suite can see.
 */
describe("new thread menu shrink contract", () => {
  it("stops the card shrinking any child", () => {
    // On the children, not the card: the federation group grows one row per
    // enrolled machine, so what overflows here is unbounded by design and
    // anything added to this menu later needs the same guarantee.
    expect(cssRuleBody(".new-thread-menu__card > *")).toMatch(
      /flex-shrink:\s*0\s*[;}]?/,
    );
  });

  it("still has a scrolling, height-capped flex column to guard", () => {
    // The premise, and every part of it is load-bearing. Drop the cap or the
    // column and there is no negative free space to spend; drop the scroll
    // and the overflow stops being deliberate. If any of these go away the
    // guard above has lost its subject and should be revisited, not deleted.
    const card = cssRuleBody(".new-thread-menu__card");
    expect(card).toMatch(/flex-direction:\s*column/);
    expect(card).toMatch(/max-height:\s*min\(/);
    expect(card).toMatch(/overflow-y:\s*auto/);
  });

  it("keeps the separator a hairline with no floor of its own", () => {
    // Why the separators were what flex took the deficit out of: a 1px box
    // whose min-content height is 0. Giving them a `min-height` instead of
    // the shrink guard would also work, but the guard is what is asserted
    // above — this pins the shape that made them the cheapest thing in the
    // card, so a future edit cannot quietly recreate the victim elsewhere.
    const separator = cssRuleBody(".new-thread-menu__separator");
    expect(separator).toMatch(/height:\s*1px/);
    expect(separator).not.toMatch(/min-height:/);
  });
});
