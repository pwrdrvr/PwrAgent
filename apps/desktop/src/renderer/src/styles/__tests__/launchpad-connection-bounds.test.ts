import { describe, expect, it } from "vitest";

import { cssRuleBody as ruleBody, firstCssRuleBody } from "./css-rule-body";

/**
 * Locks the declarations that keep the launchpad's send controls on screen.
 *
 * The bug this exists to prevent: the two PwrSuite connection cards were
 * direct children of `.thread-view__primary`, a flex column in which
 * nothing could shrink — each card sized to its own content, and the
 * composer was pinned beneath them at `flex: 0 0 auto`. `.thread-view`
 * clips with `overflow: hidden` and shows no scrollbar, so once the cards
 * plus a composer holding pasted images exceeded the pane, the composer
 * walked off the bottom edge and "Start thread" could not be reached by
 * any means. Measured on the macOS CI lane against the shipped layout:
 * 125px past the clip at a 600px-tall window, the button's centre
 * hit-testing to nothing. (56px past at 800px and 142px at 700px in a
 * headless-Chromium harness over this stylesheet.)
 *
 * jsdom performs no layout, so the invariant is pinned here as the
 * declarations that produce it. `launchpad-composer-bounds.spec.ts`
 * asserts the rendered result.
 */
describe("launchpad connection card bounds", () => {
  it("keeps the pane that clips the launchpad clipped", () => {
    // The premise of the whole fix: nothing pushed past this box's bottom
    // edge is reachable. If this ever becomes a scroll container the
    // assertions below have lost their reason and should be revisited,
    // not deleted.
    expect(firstCssRuleBody(".thread-view")).toMatch(/overflow:\s*hidden;/);
  });

  it("makes the card list the one box in the column that absorbs a deficit", () => {
    const body = ruleBody(".thread-view__connections");
    // `0 1 auto`: never grows into the space the composer wants, always
    // shrinks before the composer has to.
    expect(body).toMatch(/flex:\s*0\s+1\s+auto;/);
    // Without this the flex item's `auto` min-height floor holds it at its
    // content height and the shrink above never happens.
    expect(body).toMatch(/min-height:\s*0;/);
    // A shrink with no scroller just moves the clip inside the list.
    expect(body).toMatch(/overflow-y:\s*auto;/);
  });

  it("keeps the composer at its natural height so the send row never shrinks", () => {
    expect(ruleBody(".thread-view__launchpad-composer")).toMatch(
      /flex:\s*0\s+0\s+auto;/,
    );
  });

  it("keeps each card at its natural height inside the scrolling list", () => {
    // Shrinkable cards inside a scroller squeeze rather than scroll, which
    // is the same unreachable-content trap one level down.
    expect(ruleBody(".thread-view__connections > .mcp-connection")).toMatch(
      /flex:\s*0\s+0\s+auto;/,
    );
  });

  it("pays the list's outer air once, on the list, not once per card", () => {
    // Each card used to carry `margin: clamp(28px, 7vh, 72px) 16px 0`, so
    // two cards bought two lots of it — up to 144px of air stacked into a
    // column that had none to give.
    expect(firstCssRuleBody(".mcp-connection")).not.toMatch(/\n\s*margin:/);
  });

  it("bounds the composer's attachment strip so pasted images cannot grow it without limit", () => {
    const body = ruleBody(".composer__attachments");
    // The strip wraps, so every additional row of pasted images added its
    // full height to a composer that is `flex: 0 0 auto`.
    expect(body).toMatch(/max-height:/);
    expect(body).toMatch(/overflow-y:\s*auto;/);
  });
});
