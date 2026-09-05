import { createCanvas, loadImage } from "@napi-rs/canvas";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function actoolMajorVersion() {
  if (process.platform !== "darwin") return 0;
  try {
    const plist = execFileSync("xcrun", ["actool", "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const json = JSON.parse(
      execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: plist, encoding: "utf8" }),
    );
    const version = String(json["com.apple.actool.version"]["short-bundle-version"]);
    return Number.parseInt(version.split(".")[0], 10) || 0;
  } catch {
    return 0;
  }
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

describe("build/icon.icon (Icon Composer package)", () => {
  const manifest = JSON.parse(readFileSync(join(iconPackage, "icon.json"), "utf8"));

  it("carries the tile gradient as the package fill", () => {
    const stops = manifest.fill["linear-gradient"];
    expect(stops).toHaveLength(2);
    for (const stop of stops) {
      expect(stop).toMatch(/^srgb:\d\.\d{5},\d\.\d{5},\d\.\d{5},1\.00000$/);
    }
    expect(manifest["supported-platforms"]).toEqual({ circles: ["watchOS"], squares: "shared" });
  });

  it("references layer images that exist in Assets/", () => {
    const layers = manifest.groups.flatMap((group) => group.layers);
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
    const bounds = opaqueBounds(glyph, 1);
    expect(bounds.x).toBeGreaterThanOrEqual(200);
    expect(bounds.y).toBeGreaterThanOrEqual(200);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(824);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(824);
  });

  it("keeps the four bars in the accent color at their authored opacities", async () => {
    const glyph = await readPixels(join(iconPackage, "Assets", "glyph.png"));
    // Bar centers in the 1024px canvas (2x the 512px master) and the
    // 100/65/40/25% tiers the mark is authored at.
    const bars = [
      { x: 464, y: 297, alpha: 255 },
      { x: 512, y: 441, alpha: 166 },
      { x: 400, y: 585, alpha: 102 },
      { x: 448, y: 729, alpha: 64 },
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

// What electron-builder does at package time (app-builder-lib's
// macosIconComposer): copy the package to Icon.icon, compile it with actool,
// read CFBundleIconName + CFBundleIconFile out of the partial plist, and
// derive the legacy .icns. Needs Xcode 26; release.yml selects it before
// `pnpm test` so this runs on the release runner instead of skipping.
const actoolMajor = actoolMajorVersion();
describe.skipIf(actoolMajor < 26)("actool compile of build/icon.icon", () => {
  let tempDir;
  let outputDir;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pwragent-icon-"));
    // actool resolves `--app-icon Icon` by the package's basename; fed
    // `icon.icon` it exits 0 and silently writes no .icns.
    const packageCopy = join(tempDir, "Icon.icon");
    cpSync(iconPackage, packageCopy, { recursive: true });
    outputDir = join(tempDir, "out");
    mkdirSync(outputDir);
    execFileSync(
      "xcrun",
      [
        "actool",
        packageCopy,
        "--compile", outputDir,
        "--output-format", "human-readable-text",
        "--notices", "--warnings",
        "--output-partial-info-plist", join(outputDir, "assetcatalog_generated_info.plist"),
        "--app-icon", "Icon",
        "--include-all-app-icons",
        "--accent-color", "AccentColor",
        "--enable-on-demand-resources", "NO",
        "--development-region", "en",
        "--target-device", "mac",
        "--minimum-deployment-target", "26.0",
        "--platform", "macosx",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }, 120_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits Assets.car, the legacy Icon.icns, and both Info.plist keys", () => {
    expect(existsSync(join(outputDir, "Assets.car"))).toBe(true);
    expect(existsSync(join(outputDir, "Icon.icns"))).toBe(true);
    const plist = JSON.parse(
      execFileSync(
        "plutil",
        ["-convert", "json", "-o", "-", join(outputDir, "assetcatalog_generated_info.plist")],
        { encoding: "utf8" },
      ),
    );
    expect(plist).toMatchObject({ CFBundleIconName: "Icon", CFBundleIconFile: "Icon" });
  });

  it("derives a legacy .icns on Apple's padded template for macOS 15", async () => {
    const iconset = join(tempDir, "Icon.iconset");
    execFileSync("iconutil", ["-c", "iconset", join(outputDir, "Icon.icns"), "-o", iconset]);
    let largest = null;
    for (const name of readdirSync(iconset)) {
      if (!name.endsWith(".png")) continue;
      const pixels = await readPixels(join(iconset, name));
      if (largest === null || pixels.width > largest.width) largest = pixels;
    }
    expect(largest).not.toBeNull();
    const fill = opaqueBounds(largest).width / largest.width;
    // Apple's template is 824/1024 = 80.5%; actool lands at ~80.9% (Ghostty's
    // actool-made .icns measures the same). Full-bleed would be 100%.
    expect(fill).toBeGreaterThan(0.78);
    expect(fill).toBeLessThan(0.83);
  });
});
