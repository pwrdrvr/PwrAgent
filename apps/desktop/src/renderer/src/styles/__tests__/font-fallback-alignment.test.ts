import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");
const renderer = path.resolve(testDir, "../..");

function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `app.css should declare ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
}

/**
 * Rows that put a bare glyph beside a label in a flex container.
 *
 * The app names four fonts it does not ship (`--font-sans` lists Geist, IBM
 * Plex Sans, SF Pro Text, Inter) and declares no `@font-face`, so on any
 * machine without them installed every glyph is drawn by an OS substitute —
 * and an arrow like `←` gets a DIFFERENT substitute from the letters beside
 * it, because the substitute chosen for a character is per-character.
 *
 * `align-items: center` equalises each flex item's box, so two fonts with
 * different ascent/descent put the glyph off the label's baseline. Measured in
 * headless Chromium at a 48px font across four substitutes: centre drifts up
 * to 6.5px, baseline is 0.00px for all of them. macOS substitutes something
 * metrically close, which is why this read level there and visibly tilted on a
 * stock Ubuntu — reported off a real Linux window, not caught by any suite.
 */
describe("glyph-beside-label rows align on the baseline", () => {
  it("aligns the Exit row on the baseline, not the box", () => {
    expect(ruleBody(".settings-nav__exit")).toContain("align-items: baseline;");
  });

  it("keeps both Exit rows on that one rule", () => {
    // Settings and Automations render the same class, so the fix covers both.
    // If one ever grows its own rule, this is the reminder to align it too.
    for (const file of [
      "features/settings/SettingsScreen.tsx",
      "features/automations/AutomationsScreen.tsx",
    ]) {
      const source = readFileSync(path.join(renderer, file), "utf8");
      expect(source, `${file} should use the shared exit row`).toContain(
        'className="settings-nav__exit"',
      );
    }
  });

  it("does not reintroduce a normalized glyph box", () => {
    // The obvious-looking fix — give the glyph a 1em box with line-height: 1
    // and centre it — measured FOUR TIMES WORSE than the bug (16.5px at 48px,
    // and on every substitute rather than just the mismatched ones), because
    // the glyph still sits on its own font's baseline inside that box.
    expect(css).not.toMatch(
      /\.settings-nav__exit\s*>\s*\[aria-hidden[^{]*\{[^}]*line-height:\s*1;/,
    );
  });
});
