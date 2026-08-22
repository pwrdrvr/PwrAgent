import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STAR_MAP_CARD_HOVER_Z,
  STAR_MAP_CARD_MAX_Z,
  STAR_MAP_CLOUD_CHROME_Z,
} from "../StarMapScreen";

/**
 * The cloud's paint order lives in two files — inline `zIndex` on the
 * cards (StarMapScreen) and `z-index` on the chrome and the hover raise
 * (app.css) — so nothing in either file can tell you the scale is
 * consistent. This test is that check.
 *
 * It exists because the hover raise was pinned just above a card cap that
 * later stopped bounding anything: a hovered card carrying stack index 60
 * was set to 49 and DROPPED BEHIND its neighbours. Hover is supposed to
 * surface the card under the pointer, so a value that can demote it is
 * not a tuning miss, it is the opposite behaviour.
 */
const CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../styles/app.css",
  ),
  "utf8",
);

function zIndexIn(selector: string): number {
  const block = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{([^}]*)\\}`,
  ).exec(CSS);
  if (!block) throw new Error(`No CSS block for ${selector}`);
  const declaration = /z-index:\s*(\d+)/.exec(block[1]);
  if (!declaration) throw new Error(`No z-index in ${selector}`);
  return Number(declaration[1]);
}

describe("star map cloud paint layers", () => {
  const CARD_MAX_Z = STAR_MAP_CARD_MAX_Z;

  it("raises a hovered card above every card the stack can produce", () => {
    expect(zIndexIn(".star-map-card-shell:hover")).toBe(STAR_MAP_CARD_HOVER_Z);
    expect(STAR_MAP_CARD_HOVER_Z).toBeGreaterThan(CARD_MAX_Z);
  });

  it("keeps the hover raise !important so an inline stack index cannot win", () => {
    // Every shell carries `style="z-index: <stack position>"`, which beats
    // an ordinary rule outright — the raise silently did nothing for the
    // whole life of the previous `z-index: 5`.
    expect(
      /\.star-map-card-shell:hover[^{]*\{[^}]*z-index:\s*\d+\s*!important/.test(
        CSS,
      ),
    ).toBe(true);
  });

  it("floats cloud chrome above the cards but below a hovered one", () => {
    expect(zIndexIn(".star-map__cluster-label")).toBe(STAR_MAP_CLOUD_CHROME_Z);
    expect(zIndexIn(".star-map__cluster-overflow")).toBe(
      STAR_MAP_CLOUD_CHROME_Z,
    );
    expect(STAR_MAP_CLOUD_CHROME_Z).toBeGreaterThan(CARD_MAX_Z);
    expect(STAR_MAP_CLOUD_CHROME_Z).toBeLessThan(STAR_MAP_CARD_HOVER_Z);
  });

  it("keeps the nebula smudge under its cards", () => {
    expect(zIndexIn(".star-map__cluster-halo")).toBe(0);
  });

  it("paints chat tethers under the clouds", () => {
    // The tether aims at its thread card's centre and relies on the card
    // to hide the stretch underneath it; above the clouds it crossed the
    // cards, their kebab menus and the cluster chrome as a dashed line
    // over the text.
    expect(zIndexIn(".star-map__tethers")).toBeLessThan(
      zIndexIn(".star-map__cloud"),
    );
  });
});
