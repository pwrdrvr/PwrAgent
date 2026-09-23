import { describe, expect, it } from "vitest";

import {
  appCss,
  cssRuleBody as ruleBody,
  firstCssRuleBody,
} from "./css-rule-body";

/** A `<prop>: <n>px;` declaration's value, anchored so `top` never reads `margin-top`. */
function pxDeclaration(body: string, property: string): number {
  const match = body.match(
    new RegExp(`(?:^|\\n)\\s*${property}:\\s*(-?\\d+(?:\\.\\d+)?)px\\b`),
  );
  if (!match) {
    throw new Error(`Expected a px ${property} declaration in ${body}`);
  }
  return Number(match[1]);
}

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
    // column that had none to give. Longhands too: matching only the
    // shorthand would wave through a `margin-top` that reintroduces exactly
    // that.
    expect(firstCssRuleBody(".mcp-connection")).not.toMatch(
      /\n\s*margin(?:-top|-block|-block-start)?:/,
    );
  });

  it("keeps the scrolling list's centred column aligned with the composer's", () => {
    // `align-items: center` and the cards' `calc(100% - 32px)` resolve
    // against the content box, which a space-taking scrollbar narrows — the
    // Windows and Linux default. Without a symmetric gutter the card column
    // sits half a scrollbar left of the composer column below it, and the
    // headless shell cannot catch it because it only ever draws overlay
    // scrollbars.
    expect(ruleBody(".thread-view__connections")).toMatch(
      /scrollbar-gutter:\s*stable\s+both-edges;/,
    );
  });

  it("bounds the composer's attachment strip so pasted images cannot grow it without limit", () => {
    const body = ruleBody(".composer__attachments");
    // The strip wraps, so every additional row of pasted images added its
    // full height to a composer that is `flex: 0 0 auto`.
    expect(body).toMatch(/max-height:/);
    expect(body).toMatch(/overflow-y:\s*auto;/);
    // Window-relative, or the cap stops shrinking with the pane it has to
    // fit inside and the strip reclaims the send row at short windows.
    expect(body).toMatch(/max-height:[^;]*\d+vh/);
  });

  it("keeps the attachment scroller from clipping each thumbnail's remove control", () => {
    // `.composer__attachment-remove` is positioned at `top: -6px;
    // right: -6px` — outside its own thumbnail's box — so the scroller the
    // cap above introduced would cut the top row's remove buttons and the
    // last column's off. The padding buys the two edges it overhangs and the
    // negative margin puts the strip back where it was, which is why the
    // pair only ever makes sense together.
    //
    // The overhang is the cookie's offset plus its focus ring, and the ring
    // lives in the shared focus rule, not beside the offset. This test used
    // to pin `8px`, which covered the offset alone: the ring's top was sliced
    // flat while every assertion here passed. So it is derived, and a wider
    // ring or a bigger offset fails here instead of on screen. Matched out of
    // the raw stylesheet because the focus rule is a twenty-selector group.
    const remove = firstCssRuleBody(".composer__attachment-remove");
    const focus = appCss.match(
      /\n[^{}]*\.composer__attachment-remove:focus-visible\s*[,{][^{}]*\{(?<body>[^}]*)\}/,
    )?.groups?.body;
    expect(focus).toBeDefined();
    const ring = pxDeclaration(focus!, "outline") + pxDeclaration(focus!, "outline-offset");
    expect(ring).toBeGreaterThan(0);

    const body = ruleBody(".composer__attachments");
    const padding = body.match(/\n\s*padding:\s*(\d+)px\s+(\d+)px\s+0\s+0;/);
    expect(padding).not.toBeNull();
    const [padTop, padRight] = [Number(padding![1]), Number(padding![2])];
    expect(padTop).toBeGreaterThanOrEqual(-pxDeclaration(remove, "top") + ring);
    expect(padRight).toBeGreaterThanOrEqual(-pxDeclaration(remove, "right") + ring);
    expect(pxDeclaration(body, "margin-top")).toBe(-padTop);

    // The fixed half of the cap is two rows through the border box, so it
    // moves with the top padding. It was derived at 232px once and clipped
    // the second row by exactly the padding it forgot.
    const row =
      pxDeclaration(firstCssRuleBody(".composer__attachment-thumb"), "height")
      + pxDeclaration(firstCssRuleBody(".composer__attachment"), "gap")
      + pxDeclaration(firstCssRuleBody(".composer__attachment-chip"), "height");
    const cap = body.match(/max-height:\s*min\((\d+)px,/);
    expect(cap).not.toBeNull();
    expect(Number(cap![1])).toBe(
      2 * row + pxDeclaration(body, "gap") + padTop,
    );
  });
});
