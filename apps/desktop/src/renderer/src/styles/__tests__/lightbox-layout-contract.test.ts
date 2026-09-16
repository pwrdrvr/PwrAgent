import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * Comments come out before anything is matched, because every assertion here is
 * a claim about a declaration and the regexes that read one anchor on `;` or a
 * newline — which a commented-out `cursor: zoom-out;` satisfies exactly as well
 * as a live rule. Measured against this stylesheet: with a two-line comment
 * naming the old value above the new one, `declaration` returned `zoom-out`
 * while the browser saw `default`. The dangerous direction is the mirror image
 * — prose naming the wanted value above a rule that sets the wrong one — and it
 * passes. Stripping first is what makes this file read what Chromium reads.
 */
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

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

const escapeSelector = (selector: string) => selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function declaration(source: string, selector: string, property: string): string {
  const block = source.match(new RegExp(`(?:^|\\n)\\s*${escapeSelector(selector)}\\s*\\{(?<body>[^}]*)\\}`));
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

  it("keeps the bottom band taller than the cluster that floats in it", () => {
    const bottom = pixels(region.base, ".image-lightbox", "--lightbox-band-bottom");
    const floor = pixels(region.base, ".image-lightbox__chrome", "padding-bottom");
    const tool = pixels(region.base, ".image-lightbox__tool", "height");
    const padding = pixels(region.base, ".image-lightbox__toolbar", "padding");
    expect(floor + tool + padding * 2).toBeLessThan(bottom);
    // The captioned variant carries the meta plate above the pill, so its
    // floor has to be taller than the pill-only one.
    expect(pixels(region.base, '.image-lightbox[data-meta="true"]', "--lightbox-band-bottom"))
      .toBeGreaterThan(bottom);
  });

  it("leaves both top corners to the operating system", () => {
    // This dialog covers the whole renderer, and the window controls are drawn
    // OVER the web contents, so nothing here can move them out of the way.
    //
    // Top-left is macOS's: `hiddenInset` floats the stoplights inside the
    // renderer. The rule is the absence of anything there — the position
    // indicator and the caption ride the bottom cluster — so what is checked
    // is that the top band holds exactly one thing, the close cookie, and that
    // it is anchored to the right.
    expect(region.base).not.toContain(".image-lightbox__band");
    expect(declaration(region.base, ".image-lightbox__meta", "margin")).toBe("0");
    expect(region.base.indexOf(".image-lightbox__meta"))
      .toBeGreaterThan(region.base.indexOf(".image-lightbox__chrome"));
    expect(declaration(region.base, ".image-lightbox__close", "right")).toBe("16px");

    // Top-right is win32's and linux's: a `titleBarOverlay` strip whose caption
    // buttons the close cookie has to clear.
    expect(declaration(region.base, ".image-lightbox__close", "top"))
      .toBe("calc(var(--lightbox-os-chrome-h) + 8px)");
    expect(declaration(region.base, ".image-lightbox", "--lightbox-band-top"))
      .toBe("calc(var(--lightbox-os-chrome-h) + 56px)");
    expect(declaration(region.base, ".image-lightbox", "--lightbox-os-chrome-h")).toBe("0px");
    expect(
      declaration(
        region.base,
        ':root:is([data-platform="win32"], [data-platform="linux"]) .image-lightbox',
        "--lightbox-os-chrome-h",
      ),
    ).toBe("var(--win-titlebar-h)");
  });

  it("puts grab on the image and a plain arrow on the surfaces that dismiss", () => {
    // The affordance and the behavior have to agree. The image says "grab" and
    // is the only surface that pans; the dialog and the letterbox around the
    // image are scrim, and a click on either closes. `zoom-out` in particular
    // is the wrong thing to say there — it predicts the picture shrinking,
    // which is what the pill's minus-magnifier button does and what dismissing
    // never does. The viewport declares nothing and inherits the arrow.
    expect(declaration(region.base, ".image-lightbox", "cursor")).toBe("default");
    expect(declaration(region.base, ".image-lightbox__image", "cursor")).toBe("grab");
    expect(declaration(region.base, '.image-lightbox__image[data-panning="true"]', "cursor")).toBe("grabbing");
    expect(region.base).not.toMatch(/\.image-lightbox__viewport\s*\{[^}]*cursor:/);
  });

  it("keeps zoom-in on the thumbnails, which really do expand", () => {
    // The other half of the pair, and the reason the scrim is allowed to say
    // nothing: clicking one of these opens the dialog above. They sit in three
    // unrelated regions of a 35,000-line stylesheet, and since the scrim
    // stopped saying `zoom-out` they are the only `zoom` cursors left in the
    // repository — so nothing but this connects them to the decision they
    // justify, which `app.css` states in prose beside the rule above.
    for (const thumbnail of [
      ".transcript-activity__image-button",
      ".composer__attachment-open",
      ".mermaid-diagram__viewport img",
    ]) {
      expect(css, `${thumbnail} no longer opens with zoom-in`).toMatch(
        new RegExp(`(?:^|\\n)\\s*${escapeSelector(thumbnail)}\\s*\\{[^}]*cursor:\\s*zoom-in`),
      );
    }
  });

  it("leaves the dialog's chrome unselectable, the way the app shell does", () => {
    // `ImageLightbox` portals to `<body>`, so it is not inside `.app-shell` and
    // inherits none of its rules — including the one that keeps chrome from
    // being selected. Without this, a press-and-drag on the bottom cluster (the
    // gesture the dismiss handler already expects, and forgives within 4px)
    // paints a text selection across the position readout and the caption, and
    // the arrow asserted above sits over text that turns out to be selectable.
    expect(declaration(region.base, ".image-lightbox", "user-select")).toBe("none");
    expect(declaration(region.base, ".image-lightbox", "-webkit-user-select")).toBe("none");
  });

  it("lets a click pass through the bottom cluster's empty stretch", () => {
    // The cluster spans the full window width so the meta plate and the pill
    // centre on one axis. Everything beside them is scrim.
    expect(declaration(region.base, ".image-lightbox__chrome", "pointer-events")).toBe("none");
    expect(declaration(region.base, ".image-lightbox__chrome > *", "pointer-events")).toBe("auto");
  });
});
