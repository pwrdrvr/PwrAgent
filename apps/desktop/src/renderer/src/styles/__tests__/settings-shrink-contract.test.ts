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
    // The leaf, not just the containers. This is the one actually holding
    // a nowrap run — a container that can shrink around a child that
    // cannot has not solved anything. Both path call sites compose this
    // class, so asserting it here covers them without each re-declaring
    // the property.
    ".settings-splitpath",
  ])("lets %s shrink below its content", (selector) => {
    // A flex child's `min-width: auto` is its content size, so dropping any
    // one of these puts the nowrap paths and buttons back in charge of the
    // card's width and the clip starts eating them again.
    expect(ruleBody(selector)).toMatch(/min-width:\s*0/);
  });

  it("clips the split path rather than letting it size the row", () => {
    // `min-width: 0` alone is not enough for a nowrap run: without the
    // clip the head span still paints past the box it was shrunk into.
    const body = ruleBody(".settings-splitpath");
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(ruleBody(".settings-splitpath__head")).toMatch(
      /text-overflow:\s*ellipsis/,
    );
    // The tail is pinned — that is the whole point of the split.
    expect(ruleBody(".settings-splitpath__tail")).toMatch(/flex:\s*0 0 auto/);
  });

  it("keeps the codex auth select legible when the row cannot wrap further", () => {
    // `.settings-select` sets `min-width: 0`; this rule is the floor that
    // stops the control shrinking past a usable width in a narrow window.
    expect(ruleBody(".settings-codex-profile-select__control")).toMatch(
      /min-width:\s*(?!0)\d+px/,
    );
  });
});

/**
 * `button { font: inherit }` with no root `font-size` lands every `.button`
 * on the 16px UA default. Every other button in Settings sets its own size;
 * the profile row's three never did, so they rendered at 16px in a pane
 * whose largest body text is 13.5px. That is the "chonky" half of the same
 * report.
 *
 * The real fix is a `font-size` on `.button` itself; until that lands, this
 * asserts the local override is present. It deliberately pins only rules
 * this pane owns — a neighbouring button's size is not this contract's to
 * hold.
 */
describe("settings button scale", () => {
  it("sizes the profile card's actions to the pane, not the UA default", () => {
    const body = ruleBody(".settings-profile-card__button");
    expect(body).toMatch(/font-size:\s*12px/);
    expect(body).toMatch(/min-height:\s*28px/);
  });
});
