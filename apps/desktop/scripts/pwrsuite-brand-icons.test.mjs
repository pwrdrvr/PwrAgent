// The PwrSuite connection cards in the New Thread view each draw the sister
// app's own application icon, copied verbatim from its repository — see the
// README beside each asset. The two were authored on different canvases, so
// `.mcp-connection__icon--inset-plate` in app.css scales one of them back up
// to the size the other paints at. Nothing about that ratio is visible from
// either file alone, so this measures the assets and the rule together: a
// refreshed asset whose margin differs fails here rather than shipping a
// mismatched pair of icons.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { opaqueBounds, readPixels } from "./lib/icon-pixels.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rendererSrc = resolve(here, "../src/renderer/src");
const appCssPath = resolve(rendererSrc, "styles/app.css");

const ASSETS = {
  PwrSnap: resolve(rendererSrc, "assets/pwrsnap/pwrsnap-app-icon.png"),
  PwrGit: resolve(rendererSrc, "assets/pwrgit/pwrgit-app-icon.png"),
};

/** The asset that carries Apple's legacy margin, and so wears the modifier. */
const INSET = "PwrGit";

/**
 * Measured once: the assets are committed files that cannot change mid-run, and
 * each measurement decodes a PNG and scans every pixel in it.
 */
let measured;

/**
 * What share of its own canvas each asset's opaque plate covers — the only
 * property of the artwork the card's sizing depends on — plus the plate box
 * and canvas the fraction came from, for the shape assertions.
 */
async function plates() {
  if (measured) return measured;
  measured = {};
  for (const [name, file] of Object.entries(ASSETS)) {
    const pixels = await readPixels(file);
    const plate = opaqueBounds(pixels);
    expect(plate, `${name} icon has no opaque pixels at all`).not.toBeNull();
    measured[name] = {
      plate,
      canvas: { width: pixels.width, height: pixels.height },
      fraction: plate.width / pixels.width,
    };
  }
  return measured;
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

/** The compensating `scale()`, read as the canvas-over-plate ratio it states. */
function insetPlateScale(css) {
  const match = matchCss(
    css,
    /\.mcp-connection__icon--inset-plate\s*\{[^}]*transform:\s*scale\(calc\((\d+)\s*\/\s*(\d+)\)\)/,
    "the inset-plate scale as a canvas-over-plate ratio",
  );
  return Number(match[1]) / Number(match[2]);
}

describe("PwrSuite brand icon assets", () => {
  it("holds a square plate centred on a square canvas", async () => {
    for (const [name, { plate, canvas }] of Object.entries(await plates())) {
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
    for (const [name, { fraction }] of Object.entries(await plates())) {
      if (name === INSET) {
        expect(fraction, `${name} sits on Apple's legacy 824-in-1024 template`)
          .toBeCloseTo(824 / 1024, 3);
      } else {
        expect(fraction, `${name} plate fills its canvas`).toBe(1);
      }
    }
  });
});

describe("PwrSuite connection card icon sizing", () => {
  it("paints both plates at the same size", async () => {
    const css = readAppCss();
    const box = iconBoxWidth(css);
    const scale = insetPlateScale(css);
    const painted = Object.entries(await plates()).map(
      ([name, { fraction }]) => [name, box * fraction * (name === INSET ? scale : 1)],
    );
    const [[firstName, first], ...rest] = painted;
    for (const [name, size] of rest) {
      // Half a CSS pixel: closer than the display can resolve the difference.
      expect(Math.abs(size - first), `${name} plate against ${firstName}`)
        .toBeLessThan(0.5);
    }
    // Not merely equal to each other: both fill the box the card reserves.
    expect(first).toBeCloseTo(box, 5);
  });
});
