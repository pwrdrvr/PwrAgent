import { describe, expect, it } from "vitest";
import {
  computeStarMapEdgeArrows,
  estimateStarMapEdgeLabelWidth,
  STAR_MAP_EDGE_INSET,
  STAR_MAP_EDGE_LABEL_MAX_WIDTH,
  type StarMapEdgeTarget,
} from "../star-map-edge-arrows";

/**
 * The geometry behind the edge arrows: which bodies get one, which side of
 * the window it sits on, where on that side, which way it points, and
 * which arrows give way when two would land on each other. The screen's
 * wiring — that the overlay moves with every painted frame and that a
 * click flies there — is `star-map-edge-arrows.test.tsx`.
 */

const VIEWPORT = { width: 1280, height: 800 };
const IDENTITY = { x: 0, y: 0, scale: 1 };
const CENTER = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
const RAIL = {
  left: STAR_MAP_EDGE_INSET.left,
  top: STAR_MAP_EDGE_INSET.top,
  right: VIEWPORT.width - STAR_MAP_EDGE_INSET.right,
  bottom: VIEWPORT.height - STAR_MAP_EDGE_INSET.bottom,
};

function target(
  key: string,
  x: number,
  y: number,
  labelWidth?: number,
): StarMapEdgeTarget {
  return { key, x, y, labelWidth };
}

/** A body at a screen offset from the middle of the window, at 1:1. */
function fromCenter(key: string, dx: number, dy: number, labelWidth?: number) {
  return target(key, CENTER.x + dx, CENTER.y + dy, labelWidth);
}

function arrowsFor(
  targets: StarMapEdgeTarget[],
  view = IDENTITY,
  viewport = VIEWPORT,
) {
  return computeStarMapEdgeArrows({ targets, view, viewport });
}

describe("computeStarMapEdgeArrows", () => {
  it("draws nothing for a body the window is showing", () => {
    expect(arrowsFor([target("a", 100, 100)])).toEqual([]);
    // The window's edge is inclusive: a body centred exactly on it is
    // still half on screen.
    expect(arrowsFor([target("b", VIEWPORT.width, 400)])).toEqual([]);
    expect(arrowsFor([target("c", 640, 0)])).toEqual([]);
  });

  it("sits on the rail where the line from the middle of the window leaves it, pointing at the body", () => {
    const [arrow] = arrowsFor([fromCenter("right", 3000, 0)]);
    expect(arrow?.edge).toBe("right");
    expect(arrow?.x).toBe(RAIL.right);
    expect(arrow?.y).toBe(CENTER.y);
    expect(arrow?.angle).toBe(0);
    expect(arrow?.distance).toBe(3000);
    expect(arrow?.labelShift).toBe(0);
  });

  it("picks the side the ray leaves through and turns the arrow to its bearing", () => {
    // Steep: the ray reaches the top before the right side. 45° up-right
    // from the middle, so the exit is as far right of centre as the top
    // rail is above it.
    const [steep] = arrowsFor([fromCenter("steep", 1000, -1000)]);
    const rise = CENTER.y - RAIL.top;
    expect(steep?.edge).toBe("top");
    expect(steep?.y).toBe(RAIL.top);
    expect(steep?.x).toBeCloseTo(CENTER.x + rise, 6);
    expect(steep?.angle).toBeCloseTo(-45, 6);

    // Shallow: the ray reaches the right side first.
    const [shallow] = arrowsFor([fromCenter("shallow", 2000, -200)]);
    const run = RAIL.right - CENTER.x;
    expect(shallow?.edge).toBe("right");
    expect(shallow?.x).toBe(RAIL.right);
    expect(shallow?.y).toBeCloseTo(CENTER.y - (200 * run) / 2000, 6);
    expect(shallow?.angle).toBeCloseTo((Math.atan2(-200, 2000) * 180) / Math.PI, 6);
  });

  it("keeps the top rail below the top band and the rest at the window edge", () => {
    const arrows = arrowsFor([
      fromCenter("up", 0, -900),
      fromCenter("down", 0, 900),
      fromCenter("left", -2000, 0),
    ]);
    const byKey = new Map(arrows.map((arrow) => [arrow.target.key, arrow]));
    expect(byKey.get("up")).toMatchObject({ edge: "top", y: RAIL.top, angle: -90 });
    expect(byKey.get("down")).toMatchObject({ edge: "bottom", y: RAIL.bottom, angle: 90 });
    expect(byKey.get("left")).toMatchObject({ edge: "left", x: RAIL.left, angle: 180 });
    // The band is the reason the top is deeper; the rest only clear the
    // window edge. Pinned so a change here is made on purpose.
    expect(STAR_MAP_EDGE_INSET.top).toBeGreaterThan(STAR_MAP_EDGE_INSET.bottom);
  });

  it("maps the body through the view before deciding anything", () => {
    // A canvas point the window would show at rest is off to the right
    // once the map is panned 2000px that way.
    const panned = arrowsFor([target("a", 100, 100)], { x: 2000, y: 0, scale: 1 });
    expect(panned.map((arrow) => arrow.edge)).toEqual(["right"]);
    // And a body far out on the canvas is inside the window at a zoom
    // that pulls it in.
    expect(arrowsFor([target("b", 3000, 400)], { x: 0, y: 0, scale: 0.2 })).toEqual([]);
    // The bearing is of the SCREEN offset: zoom shrinks the canvas about
    // the origin, so the same canvas point reads at a different angle.
    const [zoomed] = arrowsFor(
      [target("c", 4000, 4000)],
      { x: 0, y: 0, scale: 0.5 },
    );
    expect(zoomed?.angle).toBeCloseTo(
      (Math.atan2(2000 - CENTER.y, 2000 - CENTER.x) * 180) / Math.PI,
      6,
    );
  });

  it("orders nearest first and drops an arrow whose pill would land on one already placed", () => {
    // Two bodies in almost the same direction share the near one's arrow.
    const shared = arrowsFor([
      fromCenter("far", 4500, 20),
      fromCenter("near", 2500, 0),
    ]);
    expect(shared.map((arrow) => arrow.target.key)).toEqual(["near"]);

    // Two bodies on the same side but well apart each keep theirs, the
    // nearer listed first.
    const apart = arrowsFor([
      fromCenter("low", 2360, 1200),
      fromCenter("level", 2360, 0),
    ]);
    expect(apart.map((arrow) => arrow.target.key)).toEqual(["level", "low"]);
    expect(apart.every((arrow) => arrow.edge === "right")).toBe(true);
  });

  it("lets narrower pills pack tighter than the worst case", () => {
    // Their rays leave the bottom rail about 160px apart. Assumed as wide
    // as a pill can be, the two collide; told they are short names, both
    // fit.
    const wide = arrowsFor([
      fromCenter("a", -250, 1200),
      fromCenter("b", 250, 1200),
    ]);
    expect(wide).toHaveLength(1);
    const narrow = arrowsFor([
      fromCenter("a", -250, 1200, 50),
      fromCenter("b", 250, 1200, 50),
    ]);
    expect(narrow).toHaveLength(2);
  });

  it("slides a pill along the edge to stay inside the rail near a corner, leaving the head on the ray", () => {
    // Leaves through the top rail close to its right end.
    const [arrow] = arrowsFor([fromCenter("corner", 1700, -1000)]);
    expect(arrow?.edge).toBe("top");
    const exitX = CENTER.x + (1700 * (CENTER.y - RAIL.top)) / 1000;
    expect(arrow?.x).toBeCloseTo(exitX, 6);
    // A full-width pill centred there would overhang the rail; it slides
    // left by exactly the overhang.
    const farthestCenter = RAIL.right - STAR_MAP_EDGE_LABEL_MAX_WIDTH / 2;
    expect(arrow?.labelShift).toBeCloseTo(farthestCenter - exitX, 6);
    expect(arrow!.labelShift).toBeLessThan(0);
    // A pill narrow enough to fit needs no slide.
    const [narrow] = arrowsFor([fromCenter("corner", 1700, -1000, 60)]);
    expect(narrow?.labelShift).toBe(0);
  });

  it("keeps a pill sliding into a corner off the pill arriving from the adjacent side", () => {
    // One leaves through the top near the right corner, one through the
    // right side near the top corner; their pills would meet in the
    // corner. The nearer body keeps its arrow.
    const arrows = arrowsFor([
      fromCenter("side", 2000, -1000),
      fromCenter("top", 1700, -1000),
    ]);
    expect(arrows.map((arrow) => arrow.target.key)).toEqual(["top"]);
  });

  it("breaks a distance tie by key so two bodies never trade places between frames", () => {
    const arrows = arrowsFor([
      fromCenter("b", 3000, 0),
      fromCenter("a", 3000, 0),
    ]);
    expect(arrows.map((arrow) => arrow.target.key)).toEqual(["a"]);
  });

  it("returns nothing for an unmeasured window", () => {
    expect(
      arrowsFor([fromCenter("a", 3000, 0)], IDENTITY, { width: 0, height: 0 }),
    ).toEqual([]);
  });

  it("falls back to the window's own edges when it is too small for the rail", () => {
    const viewport = { width: 300, height: 60 };
    const [arrow] = arrowsFor([target("a", 150, -500)], IDENTITY, viewport);
    expect(arrow?.edge).toBe("top");
    expect(arrow?.y).toBe(0);
  });
});

describe("estimateStarMapEdgeLabelWidth", () => {
  it("grows with the label, adds room for an icon, and caps at the pill's max width", () => {
    const short = estimateStarMapEdgeLabelWidth("ab");
    const longer = estimateStarMapEdgeLabelWidth("abcdef");
    expect(longer).toBeGreaterThan(short);
    expect(estimateStarMapEdgeLabelWidth("ab", { icon: true })).toBeGreaterThan(
      short,
    );
    expect(
      estimateStarMapEdgeLabelWidth("a".repeat(200), { icon: true }),
    ).toBe(STAR_MAP_EDGE_LABEL_MAX_WIDTH);
  });
});
