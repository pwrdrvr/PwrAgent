import { describe, expect, it } from "vitest";
import {
  computeStarMapEdgeArrows,
  estimateStarMapEdgeLabelWidth,
  STAR_MAP_EDGE_BODY_HALF_EXTENT,
  STAR_MAP_EDGE_HEAD_SPAN,
  STAR_MAP_EDGE_INSET,
  STAR_MAP_EDGE_LABEL_HEIGHT,
  STAR_MAP_EDGE_LABEL_MAX_WIDTH,
  type StarMapEdgeObstacle,
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
  obstacles: StarMapEdgeObstacle[] = [],
) {
  return computeStarMapEdgeArrows({ obstacles, targets, view, viewport });
}

/**
 * The pill's box as the CSS actually draws it, from the returned arrow.
 *
 * The spec used to pin only the arrow's point on the rail, which left the
 * box the cull is decided from unpinned: the head span, the clearance and
 * whether the box follows the corner slide could each be set wrong with
 * every assertion still green. Deriving the box here the way the
 * stylesheet does is what lets a test speak about the thing that collides.
 */
function pillBox(arrow: {
  edge: string;
  x: number;
  y: number;
  labelShift: number;
  target: { labelWidth?: number };
}) {
  const width = arrow.target.labelWidth ?? STAR_MAP_EDGE_LABEL_MAX_WIDTH;
  const halfHeight = STAR_MAP_EDGE_LABEL_HEIGHT / 2;
  if (arrow.edge === "left" || arrow.edge === "right") {
    const inner =
      arrow.edge === "right"
        ? arrow.x - STAR_MAP_EDGE_HEAD_SPAN
        : arrow.x + STAR_MAP_EDGE_HEAD_SPAN;
    const centerY = arrow.y + arrow.labelShift;
    return {
      left: arrow.edge === "right" ? inner - width : inner,
      right: arrow.edge === "right" ? inner : inner + width,
      top: centerY - halfHeight,
      bottom: centerY + halfHeight,
    };
  }
  const inner =
    arrow.edge === "bottom"
      ? arrow.y - STAR_MAP_EDGE_HEAD_SPAN
      : arrow.y + STAR_MAP_EDGE_HEAD_SPAN;
  const centerX = arrow.x + arrow.labelShift;
  return {
    left: centerX - width / 2,
    right: centerX + width / 2,
    top: arrow.edge === "bottom" ? inner - STAR_MAP_EDGE_LABEL_HEIGHT : inner,
    bottom: arrow.edge === "bottom" ? inner : inner + STAR_MAP_EDGE_LABEL_HEIGHT,
  };
}

function overlaps(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
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

  it("waits until every pixel of a body has left before arrowing it", () => {
    // A body is a ~146px-tall drawing centred on the point the arrow aims
    // at, so culling on the bare centre draws the dart on top of a body
    // the operator can still see — and, because placement is nearest
    // first, that spurious arrow suppresses the arrow for a body that is
    // genuinely invisible.
    const stillVisible = fromCenter("straddling", 0, 0);
    stillVisible.x = VIEWPORT.width + STAR_MAP_EDGE_BODY_HALF_EXTENT - 1;
    stillVisible.y = 400;
    expect(arrowsFor([stillVisible])).toEqual([]);

    const fullyGone = { ...stillVisible, key: "gone" };
    fullyGone.x = VIEWPORT.width + STAR_MAP_EDGE_BODY_HALF_EXTENT + 1;
    expect(arrowsFor([fullyGone]).map((arrow) => arrow.target.key)).toEqual([
      "gone",
    ]);
  });

  it("scales the body's margin with the zoom, because the body scales too", () => {
    // The half-extent is in canvas units. At 2x a body draws twice as
    // large on screen, so it stays visible twice as far past the edge.
    const target = { key: "a", x: 0, y: 0, labelWidth: 80 };
    const justOutsideAt1x = {
      ...target,
      x: (VIEWPORT.width + STAR_MAP_EDGE_BODY_HALF_EXTENT + 1) / 2,
      y: 200,
    };
    expect(
      arrowsFor([justOutsideAt1x], { x: 0, y: 0, scale: 2 }),
    ).toEqual([]);
    expect(arrowsFor([justOutsideAt1x], { x: 0, y: 0, scale: 1 })).toHaveLength(
      0,
    );
    const wellOutside = { ...target, x: 2000, y: 200 };
    expect(arrowsFor([wellOutside], { x: 0, y: 0, scale: 2 })).toHaveLength(1);
  });

  it("does not let a straddling body suppress the arrow for an invisible one", () => {
    // The regression in full: both bodies are at nearly the same bearing,
    // and the nearer one is still on screen. Before the margin, the
    // visible body won the cull and the invisible one got nothing.
    const straddling = { key: "visible", x: VIEWPORT.width + 40, y: 400 };
    const gone = { key: "invisible", x: VIEWPORT.width + 900, y: 410 };
    expect(arrowsFor([straddling, gone]).map((arrow) => arrow.target.key))
      .toEqual(["invisible"]);
  });

  it("slides a pill along its edge to clear one of the map's readouts", () => {
    // The camera key hint's measured box, bottom-left.
    const keyHint: StarMapEdgeObstacle = {
      left: 16,
      top: VIEWPORT.height - 75,
      right: 364,
      bottom: VIEWPORT.height - 18,
    };
    // A body down and to the left: its ray leaves the bottom rail inside
    // the hint.
    const target = fromCenter("body", -1200, 1200, 120);
    const [unblocked] = arrowsFor([target]);
    expect(unblocked?.edge).toBe("bottom");
    expect(overlaps(pillBox(unblocked!), keyHint)).toBe(true);

    const [slid] = arrowsFor([target], IDENTITY, VIEWPORT, [keyHint]);
    // Same arrow, same rail point and same bearing — only the pill moved.
    expect(slid?.edge).toBe("bottom");
    expect(slid?.x).toBeCloseTo(unblocked!.x, 6);
    expect(slid?.angle).toBeCloseTo(unblocked!.angle, 6);
    expect(overlaps(pillBox(slid!), keyHint)).toBe(false);
    // And it is still on the map rather than dropped.
    expect(slid?.labelShift).not.toBe(0);
  });

  it("keeps a slid pill inside the rail rather than pushing it out of the window", () => {
    const wideObstacle: StarMapEdgeObstacle = {
      left: 0,
      top: VIEWPORT.height - 75,
      right: VIEWPORT.width,
      bottom: VIEWPORT.height - 18,
    };
    // Nothing can clear a full-width obstacle; the pill stays put rather
    // than being shoved off-screen or dropped, because a partly covered
    // arrow still beats no arrow.
    const [arrow] = arrowsFor(
      [fromCenter("body", -1200, 1200, 120)],
      IDENTITY,
      VIEWPORT,
      [wideObstacle],
    );
    expect(arrow).toBeDefined();
    const box = pillBox(arrow!);
    expect(box.left).toBeGreaterThanOrEqual(RAIL.left);
    expect(box.right).toBeLessThanOrEqual(RAIL.right);
  });

  it("only routes around an obstacle that actually covers that edge", () => {
    // A readout in the TOP-left cannot affect a bottom-rail pill, however
    // far along the edge it reaches.
    const topLeft: StarMapEdgeObstacle = {
      left: 0,
      top: 0,
      right: 400,
      bottom: 120,
    };
    const target = fromCenter("body", -1200, 1200, 120);
    const [plain] = arrowsFor([target]);
    const [withObstacle] = arrowsFor([target], IDENTITY, VIEWPORT, [topLeft]);
    expect(withObstacle?.labelShift).toBe(plain?.labelShift);
  });

  it("measures the collision box where the CSS draws the pill, head span included", () => {
    // Two arrows on adjacent edges whose rail points are far apart but
    // whose PILLS meet in the corner. Only a box built from the corner-slid
    // centre, hanging inward by the head span, sees the collision — the
    // three mutations that survived before (head span dropped, clearance
    // zeroed, box built from the unshifted exit point) all miss it.
    const top = fromCenter("top", 1180, -1000, 170);
    const side = fromCenter("side", 2000, -1080, 170);
    const both = arrowsFor([top, side]);
    const placed = both.map((arrow) => arrow.target.key);
    // Exactly one survives, and it is the nearer.
    expect(placed).toEqual(["top"]);
    // Proof the two really would have overlapped: place each alone and
    // compare the boxes the CSS would draw.
    const [topAlone] = arrowsFor([top]);
    const [sideAlone] = arrowsFor([side]);
    expect(topAlone?.edge).toBe("top");
    expect(sideAlone?.edge).toBe("right");
    expect(overlaps(pillBox(topAlone!), pillBox(sideAlone!))).toBe(true);
  });

  it("leaves room for the dart between the rail point and the pill, on every edge", () => {
    // Structural, not a restatement of the constant: the pill's near edge
    // must sit strictly inside the rail point with at least the drawn
    // glyph's width between them, or the dart is painted over its own
    // label. (The exact span is pinned against the stylesheet in
    // star-map-edge-arrows-css.test.ts, which is what stops the two
    // drifting.)
    const DART_WIDTH = 18;
    const cases = [
      { key: "r", dx: 3000, dy: 0, edge: "right" },
      { key: "l", dx: -3000, dy: 0, edge: "left" },
      { key: "u", dx: 0, dy: -3000, edge: "top" },
      { key: "d", dx: 0, dy: 3000, edge: "bottom" },
    ] as const;
    for (const probe of cases) {
      const [arrow] = arrowsFor([fromCenter(probe.key, probe.dx, probe.dy, 90)]);
      expect(arrow?.edge).toBe(probe.edge);
      const box = pillBox(arrow!);
      const gap =
        probe.edge === "right"
          ? arrow!.x - box.right
          : probe.edge === "left"
            ? box.left - arrow!.x
            : probe.edge === "bottom"
              ? arrow!.y - box.bottom
              : box.top - arrow!.y;
      expect(gap).toBeGreaterThanOrEqual(DART_WIDTH);
    }
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

  /**
   * The estimate drives the ONLY overlap test, so it has to err high.
   * These are measured rendered widths at the pill's real 11px/500 — the
   * flat 6.4-per-character estimate this replaced came in UNDER every one
   * of them, by up to 43px against a 6px clearance, and two arrows the
   * culler judged clear drew one on top of the other.
   */
  it("never under-measures a label the pill will actually draw", () => {
    const measured: [string, number][] = [
      ["mac-mini-m4", 114.59],
      ["WWW-BUILD-01", 130.63],
      ["WIN-EC2-SANDBOX", 151.41],
      ["DESKTOP-QJ7K2LM", 151.31],
      ["Harold-MBP-M5-Max", 156.84],
      ["1234567890", 110.91],
      ["开发服务器一号", 115.97],
      ["ビルドマシン", 106.89],
      ["PwrSnap", 89.55],
    ];
    for (const [label, rendered] of measured) {
      const estimate = estimateStarMapEdgeLabelWidth(label, { icon: true });
      // Capped labels are ellipsised rather than drawn wide, so the cap is
      // the honest answer for anything past it.
      const target = Math.min(rendered, STAR_MAP_EDGE_LABEL_MAX_WIDTH);
      expect(
        estimate,
        `${label}: estimated ${estimate}, renders ${rendered}`,
      ).toBeGreaterThanOrEqual(target);
    }
  });

  it("counts a surrogate pair as one wide glyph, not two narrow ones", () => {
    // `label.length` counts UTF-16 units, so an emoji or an astral
    // ideograph used to be measured as two separate narrow characters.
    // Iterating by code point makes it one wide one — the same width as
    // any other wide glyph.
    expect(estimateStarMapEdgeLabelWidth("𝟘")).toBe(
      estimateStarMapEdgeLabelWidth("一"),
    );
    expect(estimateStarMapEdgeLabelWidth("𝟘")).toBeGreaterThan(
      estimateStarMapEdgeLabelWidth("a"),
    );
  });
});
