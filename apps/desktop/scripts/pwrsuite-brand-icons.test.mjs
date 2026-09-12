// Two surfaces draw these marks side by side: the PwrSuite connection cards in
// the New Thread view, styled by app.css, and the OAuth callback page the
// browser lands on, whose CSS is a template literal in the main process.
// Neither compensates for anything, and that only works because every asset is
// full-bleed — the plate covers its whole canvas, so a mark sized to its box
// paints at the same size as every mark beside it.
//
// That property is invisible from any one file, and the padded rendition is
// the easy one to reach for: `actool` derives a `.icns` from each sister's
// Icon Composer package, and its members carry Apple's 824-in-1024 margin. A
// mark taken from one of those paints at 80% of anything beside it, which is
// what three draw sites across these two stylesheets used to compensate for.
// So this measures the assets and the rules together: a refreshed asset that
// brought a margin back fails here rather than shipping a mismatched set.
// `scripts/sync-pwrsuite-brand-icon.mjs` is the refresh that cannot.
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

// PwrAgent's own mark included: the callback page draws it beside the sister
// app's, so it is held to the same `fraction === 1` below. It is the asset
// least likely to be checked — it is not a copy of anyone else's artwork, and
// it is the one already correct — which is exactly why a margin arriving there
// would move every mark on that page together and go unnoticed.
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

  it("leaves every asset full-bleed inside its canvas", async () => {
    // Fractions, not pixel counts: a vendor shipping the same artwork off a
    // larger canvas changes nothing about how a surface paints it. The exact
    // 1 is what lets both surfaces size a mark to its box and stop there.
    for (const [name, { fraction }] of Object.entries(await plates(CALLBACK_ASSETS))) {
      expect(fraction, `${name} plate fills its canvas`).toBe(1);
    }
  });
});

describe("PwrSuite connection card icon sizing", () => {
  it("paints every plate at the size the card reserves", async () => {
    const css = readAppCss();
    const box = iconBoxWidth(css);
    const painted = Object.entries(await plates()).map(
      ([name, { fraction }]) => [name, box * fraction],
    );
    const [[firstName, first], ...rest] = painted;
    for (const [name, size] of rest) {
      // Half a CSS pixel: closer than the display can resolve the difference.
      expect(Math.abs(size - first), `${name} plate against ${firstName}`)
        .toBeLessThan(0.5);
    }
    // Not merely equal to each other: every one fills the box the card
    // reserves, which is the property a margin on any asset would break.
    expect(first).toBeCloseTo(box, 5);
  });
});

/**
 * The callback page is checked by its rules rather than by a painted size,
 * because the size cannot be derived from them without parsing the `padding:`
 * and `border:` shorthands out of a single-line rule to find the content box
 * the mark actually fills. The half that can go wrong in the artwork — a
 * margin inside the canvas — is already asserted above, for these same three
 * assets. What is left is the page's side of the bargain: fill the tile, and
 * do not reach for a per-mark correction instead of fixing the asset.
 */
describe("OAuth callback page icon sizing", () => {
  it("sizes every mark to its tile, which is what makes full-bleed enough", () => {
    // Full-bleed assets only pay off if each mark fills its tile to begin
    // with. `place-items: center` centres what is already sized and does not
    // do this; without the explicit 100% the marks fall back to their
    // intrinsic 256 and 512px, a mismatch worse than the one this file exists
    // to catch, and every assertion about the artwork still passes.
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

/**
 * The failure mode this whole file exists for, stated directly. Both
 * compensations were added in good faith by someone looking at one mark that
 * painted small, and the second one landed months after the first — the fix
 * that scales the mark up is local, obvious, and reachable without knowing
 * the asset is the problem. It is also wrong twice over: it multiplies out of
 * a canvas the artwork never asked for, and it has to be repeated on every
 * surface that ever draws the pair.
 */
describe("PwrSuite brand mark compensation", () => {
  it("is stated by no surface, because no asset needs one", () => {
    const surfaces = [
      ["app.css", readAppCss()],
      [callbackPageName, readFileSync(callbackPagePath, "utf8")],
    ];
    for (const [where, source] of surfaces) {
      // Any transform on a mark, not just the `scale(calc(256 / 206))` that
      // was here: a correction written as a ratio of two other numbers, or as
      // a percentage, is the same mistake wearing different arithmetic.
      const rules = source.match(/\.(?:mcp-connection__icon|app-mark)[\w-]*\s*\{[^}]*\}/g) ?? [];
      for (const rule of rules) {
        expect(
          rule,
          `${where} scales a brand mark. An asset that paints small is a padded asset: `
          + `re-source it with scripts/sync-pwrsuite-brand-icon.mjs rather than correcting `
          + `for it here, which every other surface drawing these marks would have to repeat.`,
        ).not.toMatch(/transform:\s*scale/);
      }
    }
  });
});
