// Pins the macOS icon inputs generate-macos-app-icon.swift derives from the
// authored build/icon.png. The opt-in native integration suite compiles the
// Icon Composer package through the same electron-builder helper as packaging.
// See docs/macos-app-icons.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileAppIcon } from "./lib/compile-app-icon.mjs";
import { opaqueBounds, pixelAt, readPixels } from "./lib/icon-pixels.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, "../build");
const macOSIcon = resolve(buildDir, "icon-macos.png");
const iconPackage = resolve(buildDir, "icon.icon");

/** #e8743a — the app-icon orange the mark is drawn in. */
const ACCENT = [232, 116, 58];

/**
 * Read inside each test, not at describe scope: a missing or malformed
 * icon.json should fail the tests written to report it, not turn the whole
 * file into a collection error that registers no tests at all.
 */
function readManifest() {
  return JSON.parse(readFileSync(join(iconPackage, "icon.json"), "utf8"));
}

describe("macOS app icon", () => {
  it("keeps the development Dock icon inside Apple's legacy safe area", async () => {
    expect(opaqueBounds(await readPixels(macOSIcon))).toEqual({
      x: 100,
      y: 100,
      width: 824,
      height: 824,
    });
  });
});

/**
 * The tile gradient, top then bottom, as `tileTop` / `tileBottom` in
 * generate-macos-app-icon.swift. macOS 26 paints the package fill as the
 * tile, so the stops are pinned to the palette, not just to the `srgb:` shape.
 */
const TILE_GRADIENT_RGB = [
  [30, 25, 20],
  [10, 9, 8],
];

/** `srgb:r,g,b,1.00000` → 8-bit `[r, g, b]`, or null when malformed. */
function parseSrgbStop(stop) {
  const match = /^srgb:(\d\.\d{5}),(\d\.\d{5}),(\d\.\d{5}),1\.00000$/.exec(stop);
  if (match === null) return null;
  return match.slice(1, 4).map((channel) => Math.round(Number(channel) * 255));
}

describe("build/icon.icon (Icon Composer package)", () => {
  it("carries the tile gradient as the package fill", () => {
    const manifest = readManifest();
    expect(manifest.fill["linear-gradient"].map(parseSrgbStop)).toEqual(TILE_GRADIENT_RGB);
    expect(manifest["supported-platforms"]).toEqual({ circles: ["watchOS"], squares: "shared" });
  });

  it("references layer images that exist in Assets/", () => {
    const layers = readManifest().groups.flatMap((group) => group.layers);
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) {
      expect(existsSync(join(iconPackage, "Assets", layer["image-name"]))).toBe(true);
    }
  });

  it("holds the mark alone: no tile baked into the layer", async () => {
    const glyph = await readPixels(join(iconPackage, "Assets", "glyph.png"));
    expect([glyph.width, glyph.height]).toEqual([1024, 1024]);
    // Corners, edge midpoints, and the tile area around the mark are all clear.
    for (const [x, y] of [
      [0, 0], [1023, 0], [0, 1023], [1023, 1023],
      [512, 0], [512, 1023], [0, 512], [1023, 512],
      [512, 60], [512, 960], [60, 512], [960, 512],
    ]) {
      expect(pixelAt(glyph, x, y)[3], `alpha at ${x},${y}`).toBe(0);
    }
    // The four bars of logo-pwragnt.svg at 8x: x 28..100, y 32..96 in a
    // 128 viewBox. Antialiased corners may shade one pixel either way.
    const bounds = opaqueBounds(glyph, 1);
    expect(bounds).not.toBeNull();
    expect(Math.abs(bounds.x - 224), `left edge ${bounds.x}`).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.y - 256), `top edge ${bounds.y}`).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.width - 576), `width ${bounds.width}`).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds.height - 512), `height ${bounds.height}`).toBeLessThanOrEqual(2);
  });

  it("keeps the four bars in the accent color at their authored opacities", async () => {
    const glyph = await readPixels(join(iconPackage, "Assets", "glyph.png"));
    // Bar centers in the 1024px canvas and the 100/65/40/25% tiers the
    // mark is authored at.
    const bars = [
      { x: 464, y: 296, alpha: 255 },
      { x: 512, y: 440, alpha: 166 },
      { x: 400, y: 584, alpha: 102 },
      { x: 448, y: 728, alpha: 64 },
    ];
    for (const bar of bars) {
      const [r, g, b, a] = pixelAt(glyph, bar.x, bar.y);
      expect(Math.abs(a - bar.alpha), `alpha at ${bar.x},${bar.y}`).toBeLessThanOrEqual(3);
      // getImageData un-premultiplies, which rounds the low-alpha tiers a little.
      expect(Math.abs(r - ACCENT[0]), `red at ${bar.x},${bar.y}`).toBeLessThanOrEqual(4);
      expect(Math.abs(g - ACCENT[1]), `green at ${bar.x},${bar.y}`).toBeLessThanOrEqual(4);
      expect(Math.abs(b - ACCENT[2]), `blue at ${bar.x},${bar.y}`).toBeLessThanOrEqual(4);
    }
  });
});

// CI and release set this after selecting Xcode. The first native operation
// belongs to the integration hook, where electron-builder checks actool 26+
// asynchronously and propagates any failure to the required suite.
describe.runIf(process.env.PWRAGENT_REQUIRE_ACTOOL === "1")("actool compile of build/icon.icon", () => {
  let tempDir;

  // In beforeAll, not the describe body: vitest runs a skipped suite's body
  // at collection but never its hooks.
  beforeAll(async () => {
    if (process.platform !== "darwin") throw new Error("PWRAGENT_REQUIRE_ACTOOL=1 requires macOS");
    tempDir = mkdtempSync(join(tmpdir(), "pwragent-icon-"));
    await compileAppIcon(iconPackage, tempDir, 115_000);
  }, 120_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits Assets.car and the legacy Icon.icns", () => {
    expect(statSync(join(tempDir, "Assets.car")).size).toBeGreaterThan(0);
    expect(readFileSync(join(tempDir, "Icon.icns")).subarray(0, 4).toString("latin1")).toBe("icns");
  });

  it("derives a legacy .icns on Apple's padded template for macOS 15", async () => {
    // actool writes four reps (16, 16@2x, 128, 128@2x); 256px is its
    // ceiling. Measure the largest PNG iconutil extracts.
    const iconset = join(tempDir, "Icon.iconset");
    execFileSync("iconutil", ["-c", "iconset", join(tempDir, "Icon.icns"), "-o", iconset]);
    let largest = null;
    for (const name of readdirSync(iconset)) {
      if (!name.endsWith(".png")) continue;
      const pixels = await readPixels(join(iconset, name));
      if (largest === null || pixels.width > largest.width) largest = pixels;
    }
    expect(largest).not.toBeNull();
    const bounds = opaqueBounds(largest);
    expect(bounds).not.toBeNull();
    const fill = bounds.width / largest.width;
    // Apple's template is 824/1024 = 80.5%; actool lands at ~80.9% (Ghostty's
    // actool-made .icns measures the same). Full-bleed would be 100%.
    expect(fill).toBeGreaterThan(0.78);
    expect(fill).toBeLessThan(0.83);
  });
});
