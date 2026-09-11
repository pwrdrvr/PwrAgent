// The PwrSuite connection cards in the New Thread view each draw the sister
// app's own application icon, copied verbatim from its repository — see the
// README beside each asset. The two were authored on different canvases, so
// `.mcp-connection__icon--inset-plate` in app.css scales one of them back up
// to the size the other paints at. Nothing about that ratio is visible from
// either file alone, so this measures the assets and the rule together: a
// refreshed asset whose margin differs fails here rather than shipping a
// mismatched pair of icons.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const rendererSrc = resolve(here, "../src/renderer/src");
const appCss = readFileSync(resolve(rendererSrc, "styles/app.css"), "utf8");

const ASSETS = {
  PwrSnap: resolve(rendererSrc, "assets/pwrsnap/pwrsnap-app-icon.png"),
  PwrGit: resolve(rendererSrc, "assets/pwrgit/pwrgit-app-icon.png"),
};

/** The asset that carries Apple's legacy margin, and so wears the modifier. */
const INSET = "PwrGit";

async function readPixels(source) {
  const image = await loadImage(source);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: canvas.getContext("2d").getImageData(0, 0, image.width, image.height).data,
  };
}

/** Bounding box of the pixels at or above the alpha threshold. */
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

/**
 * The share of its own canvas each asset's opaque plate covers — the only
 * property of the artwork the card's sizing depends on.
 */
async function plateFractions() {
  const fractions = {};
  for (const [name, file] of Object.entries(ASSETS)) {
    const pixels = await readPixels(file);
    const plate = opaqueBounds(pixels);
    fractions[name] = { plate, canvas: pixels.width, fraction: plate.width / pixels.width };
  }
  return fractions;
}

/** Reports the rule that went missing, rather than throwing on a null match. */
function matchCss(pattern, what, css = appCss) {
  const match = pattern.exec(css);
  expect(match, `app.css no longer states ${what}`).not.toBeNull();
  return match;
}

/** The `width` of the shared `.mcp-connection__icon` box, in CSS pixels. */
function iconBoxWidth() {
  const rule = matchCss(
    /\.mcp-connection__icon\s*\{([^}]*)\}/,
    "the .mcp-connection__icon box",
  );
  return Number(matchCss(/width:\s*(\d+)px/, "that box's width", rule[1])[1]);
}

/** The compensating `scale()`, read as the canvas-over-plate ratio it states. */
function insetPlateScale() {
  const match = matchCss(
    /\.mcp-connection__icon--inset-plate\s*\{[^}]*transform:\s*scale\(calc\((\d+)\s*\/\s*(\d+)\)\)/,
    "the inset-plate scale as a canvas-over-plate ratio",
  );
  return Number(match[1]) / Number(match[2]);
}

describe("PwrSuite brand icon assets", () => {
  it("holds a square plate centred on a square canvas", async () => {
    for (const [name, { plate, canvas }] of Object.entries(await plateFractions())) {
      expect(plate.width, `${name} plate is square`).toBe(plate.height);
      expect(canvas, `${name} canvas is 256px`).toBe(256);
      // Equal margins: a plate drawn off-centre would still measure the right
      // size and land off-centre in the card.
      expect(plate.x, `${name} plate is centred`).toBe(canvas - plate.x - plate.width);
      expect(plate.y, `${name} plate is centred`).toBe(canvas - plate.y - plate.height);
    }
  });

  it("leaves exactly one asset inset inside its canvas", async () => {
    const fractions = await plateFractions();
    for (const [name, { fraction }] of Object.entries(fractions)) {
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
    const box = iconBoxWidth();
    const scale = insetPlateScale();
    const painted = Object.entries(await plateFractions()).map(
      ([name, { fraction }]) => [name, box * fraction * (name === INSET ? scale : 1)],
    );
    const [[, first], ...rest] = painted;
    for (const [name, size] of rest) {
      // Half a CSS pixel: closer than the display can resolve the difference.
      expect(Math.abs(size - first), `${name} plate against ${painted[0][0]}`)
        .toBeLessThan(0.5);
    }
    expect(first).toBeCloseTo(box, 5);
  });

  it("compensates only the inset asset", () => {
    const modifier = "mcp-connection__icon--inset-plate";
    for (const name of Object.keys(ASSETS)) {
      const component = readFileSync(
        resolve(rendererSrc, `features/thread-detail/${name}ConnectionPrompt.tsx`),
        "utf8",
      );
      const icons = component.match(/className="mcp-connection__icon[^"]*"/g) ?? [];
      // Both the local card and the remote-owner card draw one.
      expect(icons.length, `${name} card icons`).toBe(2);
      for (const icon of icons) {
        expect(icon.includes(modifier), `${name}: ${icon}`).toBe(name === INSET);
      }
    }
  });
});
