// The PwrSuite connection cards in the New Thread view each draw the sister
// app's own application icon, copied verbatim from its repository — see the
// README beside each asset. The two were authored on different canvases, so
// `.mcp-connection__icon--inset-plate` in app.css scales one of them back up
// to the size the other paints at. Nothing about that ratio is visible from
// either file alone, so this measures the assets and the rule together: a
// refreshed asset whose margin differs fails here rather than shipping a
// mismatched pair of icons.
//
// Two surfaces draw these marks side by side, and each states the ratio in its
// own stylesheet: the card in app.css, and the OAuth callback page the browser
// lands on, whose CSS is a template literal in the main process. The callback
// page shipped without the compensation and drew PwrGit at 80% of PwrAgent
// beside it, so both are measured here against the same assets.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { opaqueBounds, readPixels } from "./lib/icon-pixels.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rendererSrc = resolve(here, "../src/renderer/src");
const appCssPath = resolve(rendererSrc, "styles/app.css");
const callbackPagePath = resolve(
  here,
  "../src/main/mcp-connections/local-mcp-connection-service.ts",
);

const ASSETS = {
  PwrSnap: resolve(rendererSrc, "assets/pwrsnap/pwrsnap-app-icon.png"),
  PwrGit: resolve(rendererSrc, "assets/pwrgit/pwrgit-app-icon.png"),
};

/**
 * The callback page pairs the sister app with PwrAgent's own mark rather than
 * with the other sister, and serves that one from `build/icon.png` — the
 * full-bleed master, shipped as the `pwragent-app-icon.png` resource.
 */
const CALLBACK_ASSETS = {
  ...ASSETS,
  PwrAgent: resolve(here, "../build/icon.png"),
};

/** The asset that carries Apple's legacy margin, and so wears the modifier. */
const INSET = "PwrGit";

/**
 * Measured once per file: the assets are committed files that cannot change
 * mid-run, and each measurement decodes a PNG and scans every pixel in it.
 */
const measured = new Map();

/**
 * What share of its own canvas an asset's opaque plate covers — the only
 * property of the artwork the sizing depends on — plus the plate box and
 * canvas the fraction came from, for the shape assertions.
 */
async function plate(name, file) {
  if (!measured.has(file)) {
    const pixels = await readPixels(file);
    const bounds = opaqueBounds(pixels);
    expect(bounds, `${name} icon has no opaque pixels at all`).not.toBeNull();
    measured.set(file, {
      plate: bounds,
      canvas: { width: pixels.width, height: pixels.height },
      fraction: bounds.width / pixels.width,
    });
  }
  return measured.get(file);
}

/** The measurements above, keyed by app name, for a set of assets. */
async function plates(assets = ASSETS) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(assets).map(async ([name, file]) => [name, await plate(name, file)]),
    ),
  );
}

/**
 * Read inside each test, not at module scope: a moved or unreadable app.css
 * should fail the tests written to report it, not turn the whole file into a
 * collection error that registers no tests at all.
 */
function readAppCss() {
  return readFileSync(appCssPath, "utf8");
}

/** Reports the rule that went missing, rather than throwing on a null match. */
function matchCss(css, pattern, what) {
  const match = pattern.exec(css);
  expect(match, `app.css no longer states ${what}`).not.toBeNull();
  return match;
}

/**
 * The `width` of the shared `.mcp-connection__icon` box, in CSS pixels. Read
 * from the unconditional rule: app.css states the same selector again inside
 * two media queries, and a match that silently landed on one of those would
 * measure a breakpoint while reporting the base size.
 */
function iconBoxWidth(css) {
  // Anchored to column 0: the overrides are indented inside their `@media`
  // block, so only the top-level rule can match.
  const rule = matchCss(
    css,
    /^\.mcp-connection__icon\s*\{([^}]*)\}/m,
    "an unconditional .mcp-connection__icon box",
  );
  return Number(matchCss(rule[1], /width:\s*(\d+)px/, "that box's width")[1]);
}

/**
 * The compensating `scale()` one stylesheet states, read as the
 * canvas-over-plate ratio it spells out. `className` is the modifier's class,
 * without the leading dot.
 */
function insetPlateScale(css, className) {
  const match = matchCss(
    css,
    new RegExp(`\\.${className}\\s*\\{[^}]*transform:\\s*scale\\(calc\\((\\d+)\\s*/\\s*(\\d+)\\)\\)`),
    `.${className} as a canvas-over-plate ratio`,
  );
  return Number(match[1]) / Number(match[2]);
}

/**
 * The box the callback page's mark fills, in CSS pixels. Unlike the card, that
 * page frames each mark in a padded, bordered tile and sizes the image to the
 * tile's content box, so the padding and border are part of the answer —
 * `* { box-sizing: border-box }` puts them inside the stated width.
 *
 * Anchored to the start of a line: the page states `.app-icon` a second time
 * inside a `@media` block, mid-line after another rule's closing brace, and a
 * match that landed there would measure the narrow phone tile instead.
 */
function callbackMarkBox(source) {
  const rule = matchCss(
    source,
    /^\s*\.app-icon\s*\{([^}]*)\}/m,
    "an unconditional .app-icon tile on the callback page",
  );
  const value = (pattern, what) => Number(matchCss(rule[1], pattern, what)[1]);
  return (
    value(/width:\s*(\d+)px/, "that tile's width")
    - 2 * value(/padding:\s*(\d+)px/, "that tile's padding")
    - 2 * value(/border:\s*(\d+)px/, "that tile's border width")
  );
}

// PwrAgent's own mark included: the callback page sizes the sister app against
// it, so `fraction === 1` below is what makes the half-pixel tolerance there
// enough — a margin appearing in the reference would otherwise move both sides
// of that comparison together and go unnoticed.
describe("PwrSuite brand icon assets", () => {
  it("holds a square plate centred on a square canvas", async () => {
    for (const [name, { plate, canvas }] of Object.entries(await plates(CALLBACK_ASSETS))) {
      expect(canvas.width, `${name} canvas is square`).toBe(canvas.height);
      expect(plate.width, `${name} plate is square`).toBe(plate.height);
      // Equal margins: a plate drawn off-centre would still measure the right
      // size and land off-centre in the card.
      expect(plate.x, `${name} plate is centred`).toBe(canvas.width - plate.x - plate.width);
      expect(plate.y, `${name} plate is centred`).toBe(canvas.height - plate.y - plate.height);
    }
  });

  it("leaves exactly one asset inset inside its canvas", async () => {
    // Fractions, not pixel counts: a vendor shipping the same artwork off a
    // larger canvas member changes nothing about how the card paints it.
    for (const [name, { fraction }] of Object.entries(await plates(CALLBACK_ASSETS))) {
      if (name === INSET) {
        expect(fraction, `${name} sits on Apple's legacy 824-in-1024 template`)
          .toBeCloseTo(824 / 1024, 3);
      } else {
        expect(fraction, `${name} plate fills its canvas`).toBe(1);
      }
    }
  });
});

/**
 * Every plate the surface draws, at the size it lands on screen, given the box
 * the surface reserves and the compensation it applies to the inset asset.
 */
function paintedSizes(measurements, box, scale) {
  return Object.entries(measurements).map(
    ([name, { fraction }]) => [name, box * fraction * (name === INSET ? scale : 1)],
  );
}

/** Each plate fills `box`, and so also matches every other plate beside it. */
function expectPaintedTogether(painted, box) {
  for (const [name, size] of painted) {
    // Half a CSS pixel: closer than the display can resolve the difference.
    expect(Math.abs(size - box), `${name} plate against its ${box}px box`)
      .toBeLessThan(0.5);
  }
}

describe("PwrSuite connection card icon sizing", () => {
  it("paints both plates at the same size", async () => {
    const css = readAppCss();
    const box = iconBoxWidth(css);
    const scale = insetPlateScale(css, "mcp-connection__icon--inset-plate");
    expectPaintedTogether(paintedSizes(await plates(), box, scale), box);
  });
});

describe("OAuth callback page icon sizing", () => {
  it("paints the sister app's plate at the size of PwrAgent's beside it", async () => {
    const source = readFileSync(callbackPagePath, "utf8");
    const box = callbackMarkBox(source);
    const scale = insetPlateScale(source, "app-mark--inset-plate");
    expectPaintedTogether(paintedSizes(await plates(CALLBACK_ASSETS), box, scale), box);
  });

  it("wears the modifier on the inset asset and on nothing else", () => {
    const source = readFileSync(callbackPagePath, "utf8");
    // The page draws one sister app per render and picks the class from the
    // connection id, so the guard is on that condition rather than on markup:
    // dropping it would leave PwrGit inset again, and widening it to every
    // connection would scale PwrSnap's already full-bleed plate past its tile.
    const match = matchCss(
      source,
      /const insetPlate = connectionId === "(\w+)";/,
      "which connection the callback page treats as inset",
    );
    expect(match[1], "the inset asset the measurements above identified")
      .toBe(INSET.toLowerCase());
  });
});
