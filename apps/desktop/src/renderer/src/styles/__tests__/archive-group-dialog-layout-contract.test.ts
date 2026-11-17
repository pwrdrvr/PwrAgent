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
 * buttons can always be scrolled into view and clicked, that the heading never
 * opens above the top edge, and that an overflowing list is bounded and
 * shaded. Against the pre-fix stylesheet it failed on its first input (320x200,
 * one thread: both buttons unreachable) and at 960x640 with 40 threads
 * (unbounded list). jsdom performs no layout, so this suite pins the
 * declarations instead.
 */
describe("archive group dialog layout contract", () => {
  it("lets only the archive dialog's backdrop scroll, without centering the heading off the top", () => {
    const body = cssRuleBody(".rename-thread-backdrop:has(> .archive-group-dialog)");
    expect(body).toMatch(/overflow:\s*auto;/);
    expect(body).toMatch(/place-items:\s*safe center;/);
    // The rename and lock dialogs keep the shared backdrop as it was.
    expect(cssRuleBody(".rename-thread-backdrop")).not.toMatch(/overflow:/);
  });

  it("caps the dialog to the backdrop's padded height so the list shrinks first", () => {
    const dialog = cssRuleBody(".archive-group-dialog");
    expect(dialog).toMatch(/display:\s*flex;/);
    expect(dialog).toMatch(/flex-direction:\s*column;/);
    // 48px is the backdrop's 24px padding on both edges.
    expect(cssRuleBody(".rename-thread-backdrop")).toMatch(/padding:\s*24px;/);
    expect(dialog).toMatch(/max-height:\s*calc\(100vh - 48px\);/);
    const list = cssRuleBody(".archive-group-dialog__members");
    expect(list).toMatch(/flex:\s*0 1 auto;/);
    expect(list).toMatch(/min-height:\s*0;/);
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
