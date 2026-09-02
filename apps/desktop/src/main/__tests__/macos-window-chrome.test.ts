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
 * Every top-level declaration block for a selector, in source order. Several
 * of these bars are declared twice (once grouped for the drag region, once
 * for layout), so a single-block lookup would read the wrong half — and
 * because CSS resolves them by source order, the helpers below have to walk
 * all of them rather than stopping at the first hit.
 */
function ruleFor(selector: string): string[] {
  const blocks: string[] = [];
  const needle = `\n${selector} {`;
  for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
    blocks.push(css.slice(i, css.indexOf("\n}", i)));
  }
  if (blocks.length === 0) throw new Error(`app.css has no ${selector} rule`);
  return blocks;
}

/** Whether `selector` declares `declaration` in any of its blocks. */
function declares(blocks: string[], declaration: string): boolean {
  return blocks.some((block) => block.includes(declaration));
}

/** The value a rule ends up with for one property: the last one declared wins. */
function lastValueOf(blocks: string[], property: string): string | undefined {
  let value: string | undefined;
  for (const block of blocks) {
    const pattern = new RegExp(`\\n\\s*${property}:\\s*([^;]+);`, "g");
    for (const match of block.matchAll(pattern)) value = match[1].trim();
  }
  return value;
}

const PADDING_SIDES = ["top", "right", "bottom", "left"] as const;
type PaddingSide = (typeof PADDING_SIDES)[number];

/**
 * The padding a rule ends up with on one side, resolved the way the cascade
 * resolves it: a later shorthand overrides an earlier longhand and vice
 * versa. One-sided top padding is what pushed these bars below their own
 * centre, so reading it correctly is the whole point of the band test.
 */
function paddingOf(blocks: string[], side: PaddingSide): string {
  const index = PADDING_SIDES.indexOf(side);
  let value = "0";
  for (const block of blocks) {
    const pattern = /\n\s*padding(-top|-right|-bottom|-left)?:\s*([^;]+);/g;
    for (const match of block.matchAll(pattern)) {
      const declared = match[2].trim();
      if (match[1]) {
        if (match[1] === `-${side}`) value = declared;
        continue;
      }
      // Shorthand fill order: 1 value is every side, 2 is vertical then
      // horizontal, 3 adds a separate bottom, 4 is top/right/bottom/left.
      const parts = declared.split(/\s+/);
      value = [
        parts[0],
        parts[1] ?? parts[0],
        parts[2] ?? parts[0],
        parts[3] ?? parts[1] ?? parts[0],
      ][index];
    }
  }
  return value;
}

function px(value: string): number {
  return Number.parseFloat(value) || 0;
}

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

/**
 * Every bar that sits on the band, with the flex axis that carries its
 * vertical centring: a row centres on the cross axis, a column on the main
 * one. `.thread-header` is the column.
 */
const CHROME_BARS = [
  ".sidebar__masthead",
  ".thread-header",
  ".activity-titlebar",
  ".settings-nav__masthead",
  ".settings-titlebar",
  ".star-map__top-band",
] as const;

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

/**
 * The stoplight inset is derived from the sidebar masthead it sits in, not
 * eyeballed — so these tests pin the derivation, not just the number. If a
 * layout change moves the rail or the masthead height, the failing test is
 * the prompt to re-derive `MACOS_TRAFFIC_LIGHT_POSITION` in the same commit.
 */
describe("macOS window chrome", () => {
  afterEach(() => {
    restorePlatform();
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
    for (const bar of CHROME_BARS) {
      const blocks = ruleFor(bar);
      expect(
        declares(blocks, "min-height: var(--chrome-band-h);"),
        `${bar} should declare the shared band`,
      ).toBe(true);
      expect(
        paddingOf(blocks, "top"),
        `${bar} should not pad its content off centre`,
      ).toBe("0");
    }
  });

  it("centres every chrome bar's content in the band", () => {
    // The band alone does not put anything on the centreline; the centring
    // does. `.sidebar__masthead, .thread-header` is declared `flex-start`
    // for the drag region, and only each bar's own block overrides that —
    // drop the override and the band stays 40px while the content pins to
    // its top edge, 20px above the stoplights.
    for (const bar of CHROME_BARS) {
      const blocks = ruleFor(bar);
      // In a row the vertical axis is the cross axis; in a column it is
      // the main one. Read the direction rather than listing exceptions.
      const axis =
        lastValueOf(blocks, "flex-direction") === "column"
          ? "justify-content"
          : "align-items";
      expect(
        lastValueOf(blocks, axis),
        `${bar} should centre its content with ${axis}`,
      ).toBe("center");
    }
  });

  it("keeps every masthead's stoplight reservation clear of the buttons", () => {
    // Three 14px buttons on a 23px pitch: the group ends at x=76.
    const groupEnd =
      MACOS_TRAFFIC_LIGHT_POSITION.x + 2 * BUTTON_PITCH + BUTTON_SIZE;
    expect(groupEnd).toBe(76);

    // Every bar that shares its top row with the stoplights lands its brand
    // at x=96 from the window edge, each through its own container's inset:
    // the sidebar's 16px rail, the Settings nav's tighter 8px lane, the
    // Activity title bar flat against the edge, and the Star Map band's own
    // 16px padding. The reservations differ; the resulting x must not.
    const brandX: Array<[string, number]> = [
      [".sidebar__masthead", 16 + px(paddingOf(ruleFor(".sidebar__masthead"), "left"))],
      [
        ".settings-nav__masthead",
        8 + px(paddingOf(ruleFor(".settings-nav__masthead"), "left")),
      ],
      [".activity-titlebar", px(paddingOf(ruleFor(".activity-titlebar"), "left"))],
      [
        ".star-map__chrome",
        px(paddingOf(ruleFor(".star-map__top-band"), "left"))
          + px(
            paddingOf(
              ruleFor(':root[data-platform="darwin"] .star-map__chrome'),
              "left",
            ),
          ),
      ],
    ];

    for (const [bar, x] of brandX) {
      expect(x, `${bar} should put its brand at x=96`).toBe(96);
      expect(x, `${bar} should clear the button group`).toBeGreaterThan(groupEnd);
    }
  });

  it("keeps the Windows caption strip taller than its OS overlay", () => {
    // On win32 `.activity-titlebar` IS the Window Controls Overlay strip,
    // and this change moved its height onto `--chrome-band-h`. The OS draws
    // the caption buttons at `TITLE_BAR_OVERLAY_HEIGHT` (native-appearance.ts,
    // mirrored by `--win-titlebar-h`), so a shorter band would leave them
    // hanging past the strip's bottom border and its --bg-sidebar blend.
    const overlay = /--win-titlebar-h:\s*(\d+)px;/.exec(css);
    expect(overlay, "app.css should declare --win-titlebar-h").not.toBeNull();
    const band = /--chrome-band-h:\s*(\d+)px;/.exec(css);
    expect(band, "app.css should declare --chrome-band-h").not.toBeNull();
    expect(Number(band?.[1])).toBeGreaterThanOrEqual(Number(overlay?.[1]));
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
    // literal here is how the two windows drifted apart before. Match the
    // assignment, not the word, so a comment pointing at the helper is
    // still allowed to name it.
    expect(windowSource).not.toMatch(/trafficLightPosition\s*:/);
    expect(windowSource).toContain("macosTitleBarChrome()");
  });
});
