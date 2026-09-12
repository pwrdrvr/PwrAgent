// Copies a sister PwrSuite app's brand mark into this repository at the size
// the connection surfaces draw it.
//
// The source is the sister's `apps/desktop/build/icon.png`: the full-bleed
// master its own `apps/desktop/AGENTS.md` documents as its Windows/Linux
// source, and the same artifact PwrAgent serves for its own mark on the OAuth
// callback page. It is
// deliberately NOT the `.icns` member `actool` derives from `build/icon.icon`
// — that member is padded to Apple's 824-in-1024 template, so a mark taken
// from it paints at 80% of anything full-bleed beside it, and every surface
// that draws the pair has to know. Three draw sites across two stylesheets
// compensated for exactly that before this script existed.
//
// The only transformation is a downsample of the vendor's own artwork to a
// single square canvas. Nothing is redrawn, recolored, cropped, or padded, so
// the plate keeps the full canvas and the copy stays reproducible from the
// sister repository at any time.
//
//   node apps/desktop/scripts/sync-pwrsuite-brand-icon.mjs --app pwrgit
//   node apps/desktop/scripts/sync-pwrsuite-brand-icon.mjs --app pwrsnap --repo ~/src/PwrSnap
//
// `--out` writes somewhere other than the committed asset, to look at what a
// refresh would produce before it overwrites anything.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { opaqueBounds, readPixels } from "./lib/icon-pixels.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");

/** The canvas the committed copies are drawn on, in pixels. */
const SIZE = 256;

/**
 * Every sister app this repository draws a mark for. `defaultRepo` is resolved
 * against `apps/desktop`, so it means a checkout sitting beside this one.
 */
const APPS = {
  pwrgit: { displayName: "PwrGit", defaultRepo: "../../../PwrGit" },
  pwrsnap: { displayName: "PwrSnap", defaultRepo: "../../../PwrSnap" },
};

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--app" && flag !== "--repo" && flag !== "--out") {
      throw new Error(`Unrecognized argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    parsed[flag.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

/**
 * Fails on a padded or off-centre source rather than writing it. The whole
 * point of this script is that the copy it produces needs no compensation
 * downstream, and a source that is already inset cannot produce one.
 */
function assertFullBleed(pixels, what) {
  const plate = opaqueBounds(pixels);
  if (plate === null) {
    throw new Error(`${what} has no opaque pixels at all`);
  }
  if (pixels.width !== pixels.height) {
    throw new Error(`${what} is ${pixels.width}x${pixels.height}, not square`);
  }
  if (plate.width !== pixels.width || plate.height !== pixels.height) {
    const fraction = (plate.width / pixels.width).toFixed(4);
    throw new Error(
      `${what} holds a ${plate.width}x${plate.height} plate on a ${pixels.width}px canvas `
      + `(${fraction} of it). Expected a full-bleed master — an inset source is the padded `
      + `macOS rendition (build/icon-macos.png, or the .icns actool derives), not build/icon.png.`,
    );
  }
}

async function main() {
  const { app, repo, out } = parseArguments(process.argv.slice(2));
  if (app === undefined) {
    throw new Error(`--app is required, one of: ${Object.keys(APPS).join(", ")}`);
  }
  const target = APPS[app];
  if (target === undefined) {
    throw new Error(`Unknown app "${app}". Expected one of: ${Object.keys(APPS).join(", ")}`);
  }

  const repoRoot = resolve(repo === undefined ? resolve(desktop, target.defaultRepo) : repo);
  const sourceFile = resolve(repoRoot, "apps/desktop/build/icon.png");
  const destination = out === undefined
    ? resolve(desktop, `src/renderer/src/assets/${app}/${app}-app-icon.png`)
    : resolve(out);

  assertFullBleed(await readPixels(sourceFile), sourceFile);

  const image = await loadImage(sourceFile);
  const canvas = createCanvas(SIZE, SIZE);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, image.width, image.height, 0, 0, SIZE, SIZE);
  writeFileSync(destination, canvas.toBuffer("image/png"));

  // Re-measure what landed on disk: a resample that rounded the plate in from
  // the canvas edge would reintroduce the margin this exists to avoid, and it
  // would do it silently.
  assertFullBleed(await readPixels(destination), destination);

  console.log(
    `${target.displayName}: ${image.width}px → ${SIZE}px, full-bleed\n`
    + `  from ${sourceFile}\n`
    + `  to   ${destination}`,
  );
}

await main();
