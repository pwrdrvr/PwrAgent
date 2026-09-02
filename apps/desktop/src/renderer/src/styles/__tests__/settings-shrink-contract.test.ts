import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Locks the declarations that let a settings panel narrow to its column.
 *
 * The bug this exists to prevent: `.settings-section__body-clip` is a grid
 * with `overflow: hidden`, and with no `grid-template-columns` its implicit
 * `auto` track's minimum is the body's min-content width. A panel holding a
 * nowrap run — a filesystem path, a row of nowrap buttons — therefore sized
 * the track to its own content and the clip ate the tail. The Profiles pane
 * rendered its row at 1261px inside a 1202px column at 1440, 1200, 1000 and
 * 880px windows alike, which left 5 of the Delete button's 69px on screen.
 * The docs screenshot recapture is what caught it.
 *
 * `minmax(0, 1fr)` is identical to `auto` whenever the content fits (both
 * stretch to the column), so this only changes the over-wide case — but
 * nothing in a render test can see it, because jsdom does no layout. Only
 * the stylesheet can be asserted here.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

/** Body of the first top-level CSS rule whose selector matches exactly. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`),
  );
  if (!match?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return match.groups.body;
}

describe("settings panel shrink contract", () => {
  it("gives the collapsible body a column track with no min-content floor", () => {
    const body = ruleBody(".settings-section__body-clip");
    // The `overflow: hidden` is what makes the track floor destructive
    // rather than merely wide — if it ever goes away this assertion has
    // lost its subject and should be revisited, not deleted.
    expect(body).toContain("overflow: hidden");
    expect(body).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it.each([
    ".settings-profile-card",
    ".settings-profile-card__head",
    ".settings-profile-card__ident",
    ".settings-profile-card__where",
    ".settings-profile-card__codex",
  ])("lets %s shrink below its content", (selector) => {
    // A flex child's `min-width: auto` is its content size, so dropping any
    // one of these puts the nowrap paths and buttons back in charge of the
    // card's width and the clip starts eating them again.
    expect(ruleBody(selector)).toMatch(/min-width:\s*0/);
  });
});

/**
 * `button { font: inherit }` with no root `font-size` lands every `.button`
 * on the 16px UA default. Every other button in Settings sets its own size;
 * the profile row's three never did, so they rendered at 16px in a pane
 * whose largest body text is 13.5px. That is the "chonky" half of the same
 * report.
 */
describe("settings button scale", () => {
  it("sizes the profile card's actions to the pane, not the UA default", () => {
    const body = ruleBody(".settings-profile-card__button");
    expect(body).toMatch(/font-size:\s*12px/);
    expect(body).toMatch(/min-height:\s*28px/);
  });

  it("keeps the settings bulk controls at their own smaller scale", () => {
    // The neighbour this is measured against. If someone normalizes the two
    // to one size, that is a deliberate design change and both rows of this
    // contract should move together.
    expect(ruleBody(".settings-section-controls__button")).toMatch(
      /font-size:\s*11px/,
    );
  });
});
