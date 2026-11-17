import { describe, expect, it } from "vitest";

import { cssRuleBody } from "./css-rule-body";

/**
 * Locks the archive-group confirmation against two layout bugs found in UX
 * review of its first version.
 *
 * The member list gave no sign that it scrolled. At the minimum 960x640
 * window, 40 threads showed 4 rows. The list had no frame, macOS hides
 * overlay scrollbars at rest, and the clip landed on a row divider, so the
 * list read as complete. The dialog exists to show what will be archived.
 *
 * At high zoom the buttons left the window. The minimum window at 300% zoom
 * is a 320x213 CSS viewport. The dialog had no height cap and the shared
 * fixed backdrop did not scroll, so Archive ended at y=274 and could not be
 * seen or clicked (WCAG 1.4.10).
 *
 * The oracle is real Chromium: a fast-check sweep over viewports from 320x200
 * to 1400x900, groups of 1 to 120 threads and both schemes. It held that both
 * buttons can always be scrolled into view and clicked, that they are in view
 * on open whenever the dialog's chrome plus a 40px list peek fits, that the
 * heading never opens above the top edge, that the list never collapses below
 * that peek, and that an overflowing list is bounded and shaded. Against the
 * pre-fix stylesheet it failed on its first input (320x200, one thread: both
 * buttons unreachable) and at 960x640 with 40 threads (unbounded list). A
 * first version of this fix, a height cap with no list minimum, squeezed the
 * list to an empty 2px frame at 320x213; the peek rule caught it. jsdom
 * performs no layout, so this suite pins the declarations, and
 * `e2e/archive-group-dialog-layout.spec.ts` checks those rules in the app.
 */
describe("archive group dialog layout contract", () => {
  it("caps the dialog to the backdrop's padded height so the list shrinks first", () => {
    const dialog = cssRuleBody(".archive-group-dialog");
    expect(dialog).toMatch(/display:\s*flex;/);
    expect(dialog).toMatch(/flex-direction:\s*column;/);
    // The cap and the backdrop's padding read one inset, so they cannot drift.
    expect(cssRuleBody(".rename-thread-backdrop")).toMatch(/padding:\s*var\(--dialog-backdrop-inset\);/);
    expect(dialog).toMatch(/max-height:\s*calc\(100vh - 2 \* var\(--dialog-backdrop-inset\)\);/);
    // Below the list's peek the dialog itself scrolls; the shared backdrop
    // is fixed, and the rename and lock dialogs keep it as it was.
    expect(dialog).toMatch(/overflow-y:\s*auto;/);
    expect(cssRuleBody(".rename-thread-backdrop")).not.toMatch(/overflow/);
    const list = cssRuleBody(".archive-group-dialog__members");
    expect(list).toMatch(/flex:\s*0 1 auto;/);
    // Shrinks, but keeps a peek at the first thread rather than an empty frame.
    expect(list).toMatch(/min-height:\s*40px;/);
  });

  it("frames the member list and shades each edge that still has rows beyond it", () => {
    const list = cssRuleBody(".archive-group-dialog__members");
    expect(list).toMatch(/overflow:\s*auto;/);
    expect(list).toMatch(/border:\s*1px solid var\(--border-subtle\);/);
    // A `local` cover rides with the rows and hides the `scroll` shade at
    // its end, so a shade shows only where more rows remain.
    const layers = list.match(/background:([\s\S]*?);/)?.[1] ?? "";
    expect(layers.match(/no-repeat local/g)).toHaveLength(2);
    expect(layers.match(/no-repeat scroll/g)).toHaveLength(2);
    expect(layers).toMatch(/var\(--bg-panel\)\s*$/);
  });
});
