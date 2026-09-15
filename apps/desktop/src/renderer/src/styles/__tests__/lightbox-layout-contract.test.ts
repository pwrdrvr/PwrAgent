import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

/**
 * `ImageLightbox` is three boxes that used to be one, and nothing else in the
 * suite can see the difference: jsdom computes no layout, and the renderer
 * tests assert behavior, not geometry. What went wrong the first time was a
 * single `1100px × (100dvh - 180px)` box that clipped the image, measured the
 * fit, and ate the dismiss click — so these assertions are about which box
 * does which job, and about the arithmetic two comments in `app.css` state.
 *
 * Derived numbers rot silently: the chrome bands elsewhere in this file each
 * drifted off their own centerline after a button was resized and nobody
 * re-derived the padding. The edge-control offsets here are the same shape of
 * claim, so they are checked rather than written down.
 */

/** The lightbox rules, base and narrow, as two searchable strings. */
const region = (() => {
  const start = css.indexOf(".image-lightbox {");
  const narrow = css.indexOf("@media (max-width: 760px) {", start);
  const end = css.indexOf("\n}\n", css.indexOf(".image-lightbox__nav--next {", narrow));
  expect(start).toBeGreaterThan(-1);
  expect(narrow).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(narrow);
  return { base: css.slice(start, narrow), narrow: css.slice(narrow, end) };
})();

function declaration(source: string, selector: string, property: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{(?<body>[^}]*)\\}`));
  expect(block?.groups?.body, `${selector} is missing from app.css`).toBeDefined();
  const found = block!.groups!.body.match(new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*(?<value>[^;\\n]+)`));
  expect(found?.groups?.value, `${selector} declares no ${property}`).toBeDefined();
  return found!.groups!.value.trim();
}

const pixels = (source: string, selector: string, property: string) =>
  Number.parseFloat(declaration(source, selector, property).replace("px", ""));

describe("image lightbox layout contract", () => {
  it("clips at the dialog and never at the viewport", () => {
    // The dialog is the window, so whatever a zoomed image loses, it loses at
    // an edge the operator can see. Moving `hidden` back onto the viewport is
    // exactly the regression: an invisible box cropping the image.
    expect(declaration(region.base, ".image-lightbox", "overflow")).toBe("hidden");
    expect(declaration(region.base, ".image-lightbox__viewport", "overflow")).toBe("visible");
    // `hidden` is still a scroll container, which is what keeps a wheel that
    // outruns the image from chaining into the transcript behind it.
    expect(declaration(region.base, ".image-lightbox", "overscroll-behavior")).toBe("none");
  });

  it("measures the fit against the dialog inset by the chrome bands", () => {
    // The fit scale comes off this box, so an image at "Fit to window" cannot
    // land under the toolbar, the top band, or an edge control.
    for (const [side, token] of [
      ["top", "top"],
      ["right", "side"],
      ["bottom", "bottom"],
      ["left", "side"],
    ] as const) {
      expect(declaration(region.base, ".image-lightbox__viewport", side))
        .toBe(`var(--lightbox-band-${token})`);
    }
  });

  it("gives a gallery's edge controls a band wide enough to stand in", () => {
    const nav = pixels(region.base, ".image-lightbox__nav", "width");
    const band = pixels(region.base, '.image-lightbox[data-gallery="true"]', "--lightbox-band-side");
    expect(band).toBeGreaterThan(nav);
    // Centered in the band, which is what both `app.css` comments claim.
    expect(pixels(region.base, ".image-lightbox__nav--previous", "left")).toBe((band - nav) / 2);
    expect(pixels(region.base, ".image-lightbox__nav--next", "right")).toBe((band - nav) / 2);

    const narrowNav = pixels(region.narrow, ".image-lightbox__nav", "width");
    const narrowBand = pixels(region.narrow, '.image-lightbox[data-gallery="true"]', "--lightbox-band-side");
    expect(narrowBand).toBeGreaterThan(narrowNav);
    expect(pixels(region.narrow, ".image-lightbox__nav--previous", "left")).toBe((narrowBand - narrowNav) / 2);
    expect(pixels(region.narrow, ".image-lightbox__nav--next", "right")).toBe((narrowBand - narrowNav) / 2);
  });

  it("keeps the bottom band taller than the control pill that floats in it", () => {
    const bottom = pixels(region.base, ".image-lightbox", "--lightbox-band-bottom");
    const offset = pixels(region.base, ".image-lightbox__toolbar", "bottom");
    const tool = pixels(region.base, ".image-lightbox__tool", "height");
    const padding = pixels(region.base, ".image-lightbox__toolbar", "padding");
    expect(offset + tool + padding * 2).toBeLessThan(bottom);
  });

  it("puts the pan cursor on the image and the dismiss cursor everywhere else", () => {
    // The affordance and the behavior have to agree: the surface that says
    // "grab" is the only surface that pans, and the rest says "zoom-out"
    // because the rest dismisses.
    expect(declaration(region.base, ".image-lightbox", "cursor")).toBe("zoom-out");
    expect(declaration(region.base, ".image-lightbox__image", "cursor")).toBe("grab");
    expect(declaration(region.base, '.image-lightbox__image[data-panning="true"]', "cursor")).toBe("grabbing");
    expect(region.base).not.toMatch(/\.image-lightbox__viewport\s*\{[^}]*cursor:/);
  });

  it("lets a click pass through the top band's empty stretch", () => {
    // The band spans the full window width to place the caption and the close
    // cookie at opposite ends. Everything between them is scrim.
    expect(declaration(region.base, ".image-lightbox__band", "pointer-events")).toBe("none");
    expect(declaration(region.base, ".image-lightbox__band > *", "pointer-events")).toBe("auto");
  });
});
