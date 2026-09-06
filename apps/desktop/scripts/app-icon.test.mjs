// Pins the macOS icon inputs generate-macos-app-icon.swift derives from the
// authored build/icon.png and, on a Mac with Xcode 26, compiles the Icon
// Composer package through electron-builder's own helper so a package that
// passes here is what packages at release time. See AGENTS.md "macOS app icon".
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

async function readPixels(source) {
  const image = await loadImage(source);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: context.getImageData(0, 0, image.width, image.height).data,
  };
}

function pixelAt(pixels, x, y) {
  const offset = (y * pixels.width + x) * 4;
  return Array.from(pixels.data.subarray(offset, offset + 4));
}

/** Bounding box of pixels at or above the alpha threshold, or null when none is. */
function opaqueBounds(pixels, threshold = 128) {
  let left = pixels.width;
  let top = pixels.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      if (pixels.data[(y * pixels.width + x) * 4 + 3] < threshold) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Major version of the selected Xcode's actool (0 when unavailable) and why,
 * so a lane that requires it can report the probe failure instead of a bare
 * 0. electron-builder refuses to compile a .icon with anything below 26.
 */
function probeActool() {
  if (process.platform !== "darwin") return { major: 0, reason: `no actool on ${process.platform}` };
  try {
    const plist = execFileSync("xcrun", ["actool", "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const json = JSON.parse(
      execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
        input: plist,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const version = String(json["com.apple.actool.version"]["short-bundle-version"]);
    return { major: Number.parseInt(version.split(".")[0], 10) || 0, reason: `actool ${version}` };
  } catch (error) {
    return { major: 0, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * electron-builder's own compile step, reached through its dependency graph
 * so this test cannot drift from what packages at release time. app-builder-lib
 * copies the package to `Icon.icon` (actool resolves `--app-icon Icon` by the
 * basename and silently writes no icns otherwise), creates the --compile
 * directory, runs its actool invocation, refuses actool < 26, and returns
 * Assets.car plus the derived legacy icns. The Info.plist keys are set by its
 * macPackager at package time (CFBundleIconName = Icon, CFBundleIconFile =
 * icon.icns), not by actool's partial plist, so they are not asserted here.
 */
function loadIconComposer() {
  const fromHere = createRequire(import.meta.url);
  const fromElectronBuilder = createRequire(fromHere.resolve("electron-builder"));
  return fromElectronBuilder("app-builder-lib/out/util/macosIconComposer");
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

const actool = probeActool();
const requireActool = process.env.PWRAGENT_REQUIRE_ACTOOL === "1";

// The skip below is a convenience for Linux, Windows, and Macs without Xcode
// 26 — not for the release lane, which exists to compile the package.
// release.yml sets PWRAGENT_REQUIRE_ACTOOL=1 on its unit-test step so a probe
// failure or a wrong Xcode selection fails here, with the reason, instead of
// surfacing as the first actool error inside the sign job.
it.runIf(requireActool)("finds actool 26+ when PWRAGENT_REQUIRE_ACTOOL=1", () => {
  expect(actool.major, actool.reason).toBeGreaterThanOrEqual(26);
});

describe.skipIf(actool.major < 26)("actool compile of build/icon.icon", () => {
  let tempDir;
  let compiled;

  // In beforeAll, not the describe body: vitest runs a skipped suite's body
  // at collection but never its hooks.
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pwragent-icon-"));
    compiled = await loadIconComposer().generateAssetCatalogForIcon(iconPackage);
    writeFileSync(join(tempDir, "Icon.icns"), compiled.icnsFile);
  }, 120_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits Assets.car and the legacy Icon.icns", () => {
    expect(compiled.assetCatalog.byteLength).toBeGreaterThan(0);
    expect(compiled.icnsFile.subarray(0, 4).toString("latin1")).toBe("icns");
  });

  it("derives a legacy .icns on Apple's padded template for macOS 15", async () => {
    // actool writes four reps (16, 16@2x, 128, 128@2x); 256px is its
    // ceiling — see AGENTS.md. Measure the largest PNG iconutil extracts.
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
