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
    const composer = ruleBody(".thread-view__primary > .composer");
    expect(composer).toMatch(/flex:\s*0 1 auto/);
    expect(composer).toMatch(/min-height:\s*0/);
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
      ".thread-view__primary:has(> .composer .environment-setup-row) > .transcript-panel:has(.transcript-error)",
    );
    expect(combinedFailure).toMatch(/flex-basis:\s*132px/);
    expect(combinedFailure).toMatch(/min-height:\s*132px/);
  });

  it("insets a history error even when no transcript list was created", () => {
    expect(ruleBody(".transcript-panel > .transcript-error")).toMatch(
      /margin:\s*12px 16px/,
    );
  });
});
