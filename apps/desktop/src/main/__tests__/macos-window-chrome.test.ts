import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MACOS_TRAFFIC_LIGHT_POSITION,
  macosTitleBarChrome,
} from "../macos-window-chrome";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  path.resolve(testDir, "../../renderer/src/styles/app.css"),
  "utf8",
);
const windowSource = readFileSync(path.resolve(testDir, "../window.ts"), "utf8");

/**
 * Every top-level declaration block for a selector, concatenated. Several of
 * these bars are declared twice (once grouped for the drag region, once for
 * layout), so a single-block lookup would read the wrong half.
 */
function ruleFor(selector: string): string {
  const blocks: string[] = [];
  const needle = `\n${selector} {`;
  for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
    blocks.push(css.slice(i, css.indexOf("\n}", i)));
  }
  if (blocks.length === 0) throw new Error(`app.css has no ${selector} rule`);
  return blocks.join("\n");
}

/**
 * The top padding a rule sets, via either the longhand or the shorthand's
 * first value. One-sided top padding is what pushed these bars below their
 * own centre, so the band test asserts every one of them leaves it at 0.
 */
function topPaddingOf(rule: string): string {
  const longhand = /padding-top:\s*([^;]+);/.exec(rule);
  if (longhand) return longhand[1].trim();
  const shorthand = /\n\s*padding:\s*([^;]+);/.exec(rule);
  if (shorthand) return shorthand[1].trim().split(/\s+/)[0];
  return "0";
}

const originalPlatform = process.platform;

/**
 * macOS stoplight metrics, measured off a live screen capture: each button
 * occupies a 14px frame and the three sit on a 23px pitch, so the group is
 * 60px wide. These are the OS's numbers, not ours — they are here so the
 * derivations below read as arithmetic rather than as magic constants.
 */
const BUTTON_SIZE = 14;
const BUTTON_PITCH = 23;

/** `--chrome-band-h` in app.css — the band every top-of-window bar centres in. */
const CHROME_BAND = 40;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

/**
 * The stoplight inset is derived from the sidebar masthead it sits in, not
 * eyeballed — so these tests pin the derivation, not just the number. If a
 * layout change moves the rail or the masthead height, the failing test is
 * the prompt to re-derive `MACOS_TRAFFIC_LIGHT_POSITION` in the same commit.
 */
describe("macOS window chrome", () => {
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("starts the stoplights on the sidebar's own rail", () => {
    // `--sidebar-rail-inset` is the left edge every sidebar element sits
    // on. The stoplights are the first item in the masthead row, so x is
    // that inset — not a separate number.
    expect(css).toContain("--sidebar-rail-inset: 16px;");
    expect(MACOS_TRAFFIC_LIGHT_POSITION.x).toBe(16);
  });

  it("centres the stoplights in the shared chrome band", () => {
    // Every top-of-window bar centres its content in `--chrome-band-h`, so
    // the stoplights centre in it too and land on the same y=20 centreline
    // as the wordmark, the thread title, and the breadcrumbs.
    expect(css).toContain("--chrome-band-h: 40px;");
    const bandCentre = CHROME_BAND / 2;
    const buttonCentre = MACOS_TRAFFIC_LIGHT_POSITION.y + BUTTON_SIZE / 2;
    expect(buttonCentre).toBe(bandCentre);
    expect(buttonCentre).toBe(20);
  });

  it("keeps every chrome bar on that one band", () => {
    // A bar that opts out of the band, or re-introduces one-sided padding
    // to position its content, silently drops off the shared centreline —
    // which is exactly how these four drifted to 24 / 24 / 26.5 / 27.
    for (const bar of [
      ".sidebar__masthead",
      ".thread-header",
      ".activity-titlebar",
      ".settings-nav__masthead",
      ".settings-titlebar",
    ]) {
      const rule = ruleFor(bar);
      expect(rule, `${bar} should declare the shared band`).toContain(
        "min-height: var(--chrome-band-h);",
      );
      expect(topPaddingOf(rule), `${bar} should not pad its content off centre`)
        .toBe("0");
    }
  });

  it("keeps the 80px masthead reservation clear of the button group", () => {
    // Three 14px buttons on a 23px pitch: the group ends at x=76, inside
    // the 80px every masthead reserves for it.
    const groupEnd =
      MACOS_TRAFFIC_LIGHT_POSITION.x + 2 * BUTTON_PITCH + BUTTON_SIZE;
    expect(groupEnd).toBe(76);
    expect(css).toContain("padding-left: 80px;");
  });

  it("gives auxiliary windows the same chrome as the main window", async () => {
    setPlatform("darwin");
    const { auxiliaryWindowChromeOptions } = await import(
      "../auxiliary-window-chrome"
    );

    expect(auxiliaryWindowChromeOptions()).toMatchObject(macosTitleBarChrome());
  });

  it("keeps the main window off a hardcoded position", () => {
    // window.ts must reach the position through the shared helper; a
    // literal here is how the two windows drifted apart before.
    expect(windowSource).not.toContain("trafficLightPosition");
    expect(windowSource).toContain("macosTitleBarChrome()");
  });
});
