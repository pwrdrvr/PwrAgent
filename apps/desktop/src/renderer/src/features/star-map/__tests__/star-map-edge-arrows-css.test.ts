import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STAR_MAP_EDGE_HEAD_SPAN,
  STAR_MAP_EDGE_LABEL_HEIGHT,
  STAR_MAP_EDGE_LABEL_MAX_WIDTH,
} from "../star-map-edge-arrows";

/**
 * The edge arrows decide which pills to draw by boxing them in TypeScript
 * and testing those boxes for overlap — but the boxes only describe the
 * real thing while the numbers agree with the stylesheet that draws it.
 * Nothing in the build ties them together, and the failure mode is silent
 * in both directions: retune the pill in CSS and the culler keeps measuring
 * the old box, so two arrows are placed and drawn on top of each other;
 * change the constant and every dart detaches from its pill. Both ship with
 * a green geometry suite, because that suite is pure arithmetic over these
 * same constants.
 *
 * Same shape as star-map-satellite-css.test.ts and star-map-z-layers.test.ts:
 * read app.css and pin the contract, so it cannot disappear quietly.
 */
const CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../styles/app.css",
  ),
  "utf8",
);

/** The body of one rule, by exact selector. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`No CSS rule for ${selector}`);
  return match[1];
}

describe("star map edge arrow CSS contract", () => {
  it("keeps the pill's drawn height and max width in sync with the collision box", () => {
    const pill = ruleBody(".star-map__edge-arrow");
    expect(/height:\s*(\d+)px/.exec(pill)?.[1]).toBe(
      String(STAR_MAP_EDGE_LABEL_HEIGHT),
    );
    expect(/max-width:\s*(\d+)px/.exec(pill)?.[1]).toBe(
      String(STAR_MAP_EDGE_LABEL_MAX_WIDTH),
    );
  });

  it("pulls the pill inward from the rail by exactly the head span, on all four edges", () => {
    // The geometry hangs the collision box `STAR_MAP_EDGE_HEAD_SPAN`
    // inside the rail point; these transforms are what put the drawn pill
    // there. A mismatch means the culler is reasoning about a rectangle
    // the browser does not paint.
    for (const edge of ["right", "left", "top", "bottom"] as const) {
      const body = ruleBody(`.star-map__edge-arrow--${edge}`);
      // The per-edge rules carry nothing but the transform, so every
      // pixel length in them is a head span — `calc(-100% - 22px)` on the
      // far edges, a bare `22px` on the near ones.
      const spans = [...body.matchAll(/(\d+)px/g)].map((match) =>
        Number(match[1]),
      );
      expect(
        spans,
        `${edge} pill transform should pull in by ${STAR_MAP_EDGE_HEAD_SPAN}px`,
      ).toContain(STAR_MAP_EDGE_HEAD_SPAN);
    }
  });

  it("sizes the pill's padding and border the way the width estimate assumes", () => {
    // `estimateStarMapEdgeLabelWidth` adds 20px of padding and 2px of
    // border to the measured text. Under the renderer's global
    // `box-sizing: border-box` the border is part of the width, so an
    // estimate that skipped it under-measured every pill by 2px.
    const pill = ruleBody(".star-map__edge-arrow");
    expect(/padding:\s*0\s+(\d+)px/.exec(pill)?.[1]).toBe("10");
    expect(/border:\s*(\d+)px\s+solid/.exec(pill)?.[1]).toBe("1");
  });

  it("keeps the overlay under every readout it has to slide clear of", () => {
    // The arrows route AROUND the key hint and the selection bar rather
    // than fighting them for the layer, so those two must keep painting
    // above. If that ever inverts, the sliding is dead weight and an
    // arrow would cover a control instead.
    const layerOf = (selector: string) => {
      const declaration = /z-index:\s*(\d+)/.exec(ruleBody(selector));
      if (!declaration) throw new Error(`No z-index in ${selector}`);
      return Number(declaration[1]);
    };
    const arrows = layerOf(".star-map__edge-arrows");
    expect(arrows).toBeLessThan(layerOf(".star-map__key-hint"));
    expect(arrows).toBeLessThan(layerOf(".star-map__selection"));
    // And below the top band, which the rail's top inset reserves for.
    expect(arrows).toBeLessThan(layerOf(".star-map__top-band"));
  });
});
