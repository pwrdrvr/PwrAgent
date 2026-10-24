import { describe, expect, it } from "vitest";

import {
  appCss,
  cssRuleBody,
  firstCssRuleBody as ruleBody,
} from "./css-rule-body";

/**
 * Locks the order in which the chat column gives up height, so that nothing
 * can push the composer's input or toolbar off the window.
 *
 * The bug this exists to prevent: choosing an environment on an existing
 * thread mounted the full setup panel above the transcript in a bare
 * wrapper. Its output box was sized to its content, the composer could not
 * shrink, and the failure was also reported as an open error row inside the
 * composer, adding up to 320px more. The column ran past `.thread-view`'s
 * `overflow: hidden` edge and the composer's toolbar was simply gone. An
 * earlier fix bounded the new-thread failure panel on its own; every other
 * box in the column stayed free to repeat the bug.
 *
 * The rule now is structural. The transcript gives first (zero basis), the
 * composer band gives second (capped, scrolling, the composer's one
 * shrinkable row), and the input, attachments tray and toolbar never give.
 * Environment setup is a row in that band. jsdom does no layout, so the
 * invariant is pinned in the stylesheet; the row's placement in the band is
 * asserted against the rendered DOM in `thread-view.test.tsx`.
 */
describe("composer band bounds", () => {
  it("keeps the pane that clips the column clipped", () => {
    // The subject of the whole contract: `.thread-view` shows no scrollbar,
    // so anything pushed past its bottom edge is unreachable. If this ever
    // becomes a scroll container the assertions below have lost their reason
    // and should be revisited, not deleted.
    expect(ruleBody(".thread-view")).toMatch(/overflow:\s*hidden;/);
  });

  it("gives the transcript only the height that is left", () => {
    const transcript = ruleBody(".transcript-panel");
    expect(transcript).toMatch(/flex:\s*1;/);
    expect(transcript).toMatch(/min-height:\s*0/);
  });

  it("lets the composer shrink in the thread column", () => {
    // Without `min-height: 0` the composer keeps its content height however
    // short the window is, and its toolbar lands past the clip.
    const composer = ruleBody(".thread-view__composer-slot > .composer");
    expect(composer).toMatch(/flex:\s*0 1 auto/);
    expect(composer).toMatch(/min-height:\s*0/);
    // The slot must generate no box, or the composer stops being a flex item
    // of the column and the rule above shrinks nothing.
    expect(ruleBody(".thread-view__composer-slot")).toMatch(/display:\s*contents/);
  });

  it("never shrinks the input, attachments tray or toolbar", () => {
    expect(ruleBody(".composer > .composer__pending-controls > *")).toMatch(
      /flex-shrink:\s*0/,
    );
  });

  it("makes the band the composer's one shrinkable, scrolling row", () => {
    const band = ruleBody(".composer > .composer__pending-controls > .composer__band");
    expect(band).toMatch(/flex:\s*0 1 auto/);
    // `overflow-y: auto` alone cannot shrink past the content floor.
    expect(band).toMatch(/min-height:\s*0/);
    // A bound with no scroller just moves the clip into the band.
    expect(band).toMatch(/overflow-y:\s*auto/);
    // Window-relative, in any syntax. A percentage would resolve against the
    // composer's auto height, which means not at all.
    expect(band).toMatch(/max-height:[^;]*\d+vh/);
    expect(band).not.toMatch(/max-height:[^;]*\d+%/);
  });

  it("hides an empty band so it costs the composer no gap", () => {
    expect(
      ruleBody(".composer > .composer__pending-controls > .composer__band:empty"),
    ).toMatch(/display:\s*none/);
  });

  it("no longer defines the content-sized setup panel the band replaced", () => {
    expect(appCss).not.toMatch(/\.environment-setup-choice\b/);
  });

  it("bounds the forking placeholder's output", () => {
    // The one place the full setup panel still renders has no composer below
    // it, but a log longer than the column still ran past the clip.
    expect(cssRuleBody(".launchpad-pending__output pre")).toMatch(
      /max-height:[^;]*\d+vh/,
    );
  });

  it("reserves a readable, internally scrolling history error lane", () => {
    const error = cssRuleBody(".transcript-error");
    expect(error).toMatch(/min-height:\s*0/);
    expect(error).toMatch(/overflow-y:\s*auto/);

    const combinedFailure = ruleBody(
      ".thread-view__primary:has(> .thread-view__composer-slot > .composer .environment-setup-row) > .transcript-panel:has(.transcript-error)",
    );
    expect(combinedFailure).toMatch(/flex-basis:\s*132px/);
    expect(combinedFailure).toMatch(/min-height:\s*132px/);
  });

  it("bounds the Star Map chat card's band the same way", () => {
    // The floating chat stacked its queued turns as loose children of a body
    // that clips, so a long queue pushed the compact composer out of the card.
    const band = cssRuleBody(".star-map-chat-card__band");
    expect(band).toMatch(/flex:\s*0 1 auto/);
    expect(band).toMatch(/min-height:\s*0/);
    expect(band).toMatch(/overflow-y:\s*auto/);
    // Unlike the composer's, a percentage is right here: the card's height is
    // inline, so the body it resolves against is definite.
    expect(band).toMatch(/max-height:\s*\d+%/);
    expect(ruleBody(".star-map-chat-card__band:empty")).toMatch(
      /display:\s*none/,
    );
    // The composer itself never gives up height to the rows above it.
    expect(ruleBody(".compact-composer")).toMatch(/flex:\s*0 0 auto/);
    // The transcript takes the remainder. An `auto` basis made it shrink in
    // proportion to its content, which held a long thread's band to a few
    // rows no matter how far under its cap the band was.
    expect(cssRuleBody(".star-map-chat-card__transcript")).toMatch(
      /flex:\s*1 1 0;/,
    );
  });

  it("fades a band's edges only while content lies past them", () => {
    // macOS hides overlay scrollbars, so without this a band of twenty queued
    // turns reads as a band of three.
    for (const band of [
      ".composer > .composer__pending-controls > .composer__band",
      ".star-map-chat-card__band",
    ]) {
      expect(cssRuleBody(band)).toMatch(/container-type:\s*scroll-state/);
    }
    expect(appCss).toMatch(/@container scroll-state\(scrollable: top\)/);
    expect(appCss).toMatch(/@container scroll-state\(scrollable: bottom\)/);
    // A scroll-driven animation keeps the last value of a timeline that goes
    // inactive, which left a top fade over a band that had drained below its
    // cap while scrolled to the end.
    expect(cssRuleBody(".composer > .composer__pending-controls > .composer__band"))
      .not.toMatch(/animation-timeline/);
    expect(cssRuleBody(".star-map-chat-card__band")).not.toMatch(
      /animation-timeline/,
    );
  });

  it("keeps an open row's header in view while its body scrolls", () => {
    // An open env action row (command, Output label, a 28vh box) is taller
    // than the 300px band, so scrolling to read the output took the action's
    // name, exit code, Dismiss and Show in sidebar out of view with it. The
    // setup and error rows share the band and the chrome, so they pin too.

    const header =
      ".composer__band .composer__queued--env-action:is([open], [data-open=\"true\"]) > .composer__queued-env-action-header";
    const sticky = ruleBody(header);
    expect(sticky).toMatch(/position:\s*sticky;/);
    // Flush with the band's edge: the band pads 3px for focus rings and
    // Chromium pins inside that padding, so `top: 0` left a strip of output
    // visible above the header.
    expect(sticky).toMatch(/top:\s*-3px;/);
    // Over the band's top fade (z-index 2), so the fade never covers the
    // action's name.
    const fades = [
      ".composer__band::before",
      ".composer__band::after",
      ".star-map-chat-card__band::before",
      ".star-map-chat-card__band::after",
    ].join(",\n");
    expect(ruleBody(fades)).toMatch(/z-index:\s*2;/);
    expect(sticky).toMatch(/z-index:\s*3;/);
    expect(sticky).toMatch(/container-type:\s*scroll-state;/);

    // The surface must be opaque. A failed row's tint mixes in the
    // translucent `--danger-soft`, so inheriting it would let scrolled output
    // show through the pinned header.
    expect(ruleBody(`${header}::before`)).toMatch(
      /background:\s*var\(--env-action-header-surface\);/,
    );
    expect(ruleBody(".composer__band .composer__queued--env-action")).toMatch(
      /--env-action-header-surface:\s*var\(--bg-panel-elevated\);/,
    );
    expect(ruleBody(".composer__band .composer__queued--env-action-failed")).toMatch(
      /--env-action-header-surface:\s*linear-gradient\(var\(--env-action-failed-bg\) 0 0\),\s*var\(--rail-band-fade-color\);/,
    );
    expect(
      ruleBody(".composer__queued--env-action.composer__queued--env-action-failed"),
    ).toMatch(/background:\s*var\(--env-action-failed-bg\);/);

    // Stuck, the row's top border is gone: rounded corners would show output
    // through them, and the rule closes the header.
    const stuck = appCss.match(
      /@container scroll-state\(stuck: top\) \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body ?? "";
    expect(stuck).toContain(`${header}::before`);
    expect(stuck).toMatch(/border-radius:\s*0;/);
    expect(stuck).toMatch(/box-shadow:\s*0 1px 0 var\(--env-action-header-rule\);/);

    // The band's 28px focus margin clears its fade, not a ~36px header, so a
    // control Tab scrolls to the top would sit under the pinned header.
    const focusMargin = cssRuleBody(
      [
        ".composer__band .composer__queued--env-action:is([open], [data-open=\"true\"]) > :not(.composer__queued-env-action-header) :where(:focus-visible)",
        ".composer__band .composer__queued--env-action:is([open], [data-open=\"true\"]) > :not(.composer__queued-env-action-header):where(:focus-visible)",
      ].join(",\n"),
    );
    expect(focusMargin).toMatch(/scroll-margin-top:\s*44px;/);
  });

  it("insets a history error even when no transcript list was created", () => {
    expect(ruleBody(".transcript-panel > .transcript-error")).toMatch(
      /margin:\s*12px 16px/,
    );
  });
});
