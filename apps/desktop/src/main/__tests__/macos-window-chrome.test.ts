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

const originalPlatform = process.platform;

/**
 * macOS stoplight metrics, measured off a live screen capture: each button
 * occupies a 14px frame and the three sit on a 23px pitch, so the group is
 * 60px wide. These are the OS's numbers, not ours — they are here so the
 * derivations below read as arithmetic rather than as magic constants.
 */
const BUTTON_SIZE = 14;
const BUTTON_PITCH = 23;

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

  it("centres the stoplights on the wordmark's cap height", () => {
    // The masthead is 10px of top padding above a 34px icon-button row, so
    // the 17px/700 wordmark's cap centre lands at y=23. A 14px button at
    // y=16 centres at 23 too.
    expect(css).toContain("padding: 10px 0 0 80px;");
    const buttonCentre = MACOS_TRAFFIC_LIGHT_POSITION.y + BUTTON_SIZE / 2;
    expect(buttonCentre).toBe(23);
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
