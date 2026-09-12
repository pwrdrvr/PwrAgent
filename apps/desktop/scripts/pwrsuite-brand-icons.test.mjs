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
const callbackPageName = "local-mcp-connection-service.ts";
const callbackPagePath = resolve(here, `../src/main/mcp-connections/${callbackPageName}`);

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

/**
 * Reports the rule that went missing, rather than throwing on a null match.
 * `where` names the file it was looked for in: the callback page's CSS lives
 * in a template literal in the main process, and a failure there that blamed
 * app.css would send the next reader to a stylesheet that never held the rule.
 */
function matchCss(css, pattern, what, where = "app.css") {
  const match = pattern.exec(css);
  expect(match, `${where} no longer states ${what}`).not.toBeNull();
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
  // The lookbehind keeps `width:` from matching the tail of a `max-width:` or
  // `min-width:` declaration and silently measuring the wrong number.
  return Number(matchCss(rule[1], /(?<![-\w])width:\s*(\d+)px/, "that box's width")[1]);
}

/**
 * The compensating `scale()` one stylesheet states, read as the
 * canvas-over-plate ratio it spells out. `className` is the modifier's class,
 * without the leading dot; `where` is the file, for the failure message.
 */
function insetPlateScale(css, className, where) {
  const match = matchCss(
    css,
    new RegExp(`\\.${className}\\s*\\{[^}]*transform:\\s*scale\\(calc\\((\\d+)\\s*/\\s*(\\d+)\\)\\)`),
    `.${className} as a canvas-over-plate ratio`,
    where,
  );
  return Number(match[1]) / Number(match[2]);
}

// PwrAgent's own mark included: the callback page sizes the sister app against
// it, so the exact `fraction === 1` below is what lets the sizing tests treat
// it as the reference. A margin appearing there would otherwise move both
// sides of that comparison together and go unnoticed.
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

describe("PwrSuite connection card icon sizing", () => {
  it("paints both plates at the same size", async () => {
    const css = readAppCss();
    const box = iconBoxWidth(css);
    const scale = insetPlateScale(css, "mcp-connection__icon--inset-plate");
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

/**
 * The callback page is measured by its ratio rather than by its box, because
 * its box cannot fail: every painted size there is `box × k`, so comparing
 * them to `box` reduces to `box × |k − 1| < tolerance` and the tile geometry
 * only scales the tolerance. Asserting `fraction × scale` directly says the
 * one thing that is actually true or false, and says it without parsing a
 * `border:` shorthand out of a single-line rule to get there.
 */
describe("OAuth callback page icon sizing", () => {
  it("compensates the inset asset back to the size of the marks beside it", async () => {
    const source = readFileSync(callbackPagePath, "utf8");
    const scale = insetPlateScale(source, "app-mark--inset-plate", callbackPageName);
    for (const [name, { fraction }] of Object.entries(await plates(CALLBACK_ASSETS))) {
      // Four decimals: a whole pixel out at the 104px tile is 1e-2 here, so
      // this is far tighter than the display, and tighter than the card's.
      expect(fraction * (name === INSET ? scale : 1), `${name} plate against its tile`)
        .toBeCloseTo(1, 4);
    }
  });

  it("sizes every mark to its tile, which is what makes the ratio enough", () => {
    // The ratio above only holds if each mark fills the tile to begin with.
    // `place-items: center` centres what is already sized and does not do
    // this; without the explicit 100% the marks fall back to their intrinsic
    // 256 and 512px, a mismatch worse than the one this file exists to catch,
    // and every ratio assertion still passes.
    const source = readFileSync(callbackPagePath, "utf8");
    const rule = matchCss(
      source,
      /^\s*\.app-mark\s*\{([^}]*)\}/m,
      "an .app-mark rule sizing the mark to its tile",
      callbackPageName,
    )[1];
    for (const declaration of ["width: 100%", "height: 100%", "object-fit: contain"]) {
      expect(rule, `.app-mark no longer states ${declaration}`).toContain(declaration);
    }
  });
});
