import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_VISIBLE_FRACTION,
  MIN_ZOOM,
  STAR_MAP_IN_VIEW_MARGIN,
  STAR_MAP_OVERVIEW_ZOOM,
  STAR_MAP_SKY_PARALLAX,
  centerStarMapView,
  clampStarMapView,
  isOverviewZoom,
  isPointInView,
  overviewChromeScale,
  placeStarMapView,
  starMapSkyOffset,
  type StarMapView,
} from "../star-map-view-geometry";

const VIEWPORT = { width: 1280, height: 800 };
const CANVAS = { width: 2400, height: 1800 };

/** The strip the clamp guarantees, per axis. */
const MIN_VISIBLE_X = VIEWPORT.width * MIN_VISIBLE_FRACTION;
const MIN_VISIBLE_Y = VIEWPORT.height * MIN_VISIBLE_FRACTION;

function clamp(view: StarMapView, canvas = CANVAS, viewport = VIEWPORT) {
  return clampStarMapView({ view, canvas, viewport });
}

/** Overlap between the placed canvas and the window, on one axis. */
function overlap(position: number, content: number, viewportExtent: number) {
  return Math.max(
    0,
    Math.min(viewportExtent, position + content) - Math.max(0, position),
  );
}

describe("clampStarMapView", () => {
  it("leaves a view that is already within bounds alone", () => {
    const view = { x: -400, y: -300, scale: 1 };
    expect(clamp(view)).toEqual(view);
  });

  it("stops the canvas being dragged off the right and bottom edges", () => {
    const clamped = clamp({ x: 9000, y: 9000, scale: 1 });
    expect(clamped.x).toBe(VIEWPORT.width - MIN_VISIBLE_X);
    expect(clamped.y).toBe(VIEWPORT.height - MIN_VISIBLE_Y);
  });

  it("stops the canvas being dragged off the left and top edges", () => {
    const clamped = clamp({ x: -9000, y: -9000, scale: 1 });
    expect(clamped.x).toBe(MIN_VISIBLE_X - CANVAS.width);
    expect(clamped.y).toBe(MIN_VISIBLE_Y - CANVAS.height);
  });

  it("keeps the guaranteed strip on screen from any starting position", () => {
    for (const x of [-1e6, -5000, -2208, -900, 0, 640, 1088, 5000, 1e6]) {
      const clamped = clamp({ x, y: 0, scale: 1 });
      expect(
        overlap(clamped.x, CANVAS.width, VIEWPORT.width),
      ).toBeGreaterThanOrEqual(MIN_VISIBLE_X);
    }
  });

  it("scales the bounds with the zoom level", () => {
    // At MIN_ZOOM the canvas is far smaller than its untransformed box, so
    // the left bound has to move in by the same factor or the operator can
    // still push the shrunken map clean off the window.
    const clamped = clamp({ x: -9000, y: -9000, scale: MIN_ZOOM });
    expect(clamped.x).toBe(MIN_VISIBLE_X - CANVAS.width * MIN_ZOOM);
    expect(clamped.y).toBe(MIN_VISIBLE_Y - CANVAS.height * MIN_ZOOM);
    expect(
      overlap(clamped.x, CANVAS.width * MIN_ZOOM, VIEWPORT.width),
    ).toBeCloseTo(MIN_VISIBLE_X);
  });

  it("never demands more overlap than a small canvas can supply", () => {
    // A canvas narrower than the 15% strip would otherwise have no legal
    // position at all; it simply may not leave the window.
    const canvas = { width: 80, height: 60 };
    expect(clamp({ x: -9000, y: -9000, scale: 1 }, canvas)).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(clamp({ x: 9000, y: 9000, scale: 1 }, canvas)).toMatchObject({
      x: VIEWPORT.width - canvas.width,
      y: VIEWPORT.height - canvas.height,
    });
  });

  it("holds the scale inside the zoom range", () => {
    expect(clamp({ x: 0, y: 0, scale: 12 }).scale).toBe(MAX_ZOOM);
    expect(clamp({ x: 0, y: 0, scale: 0.01 }).scale).toBe(MIN_ZOOM);
  });

  it("leaves the position alone when a box has not been measured yet", () => {
    const view = { x: -700, y: -500, scale: 1 };
    expect(clamp(view, { width: 0, height: 0 })).toEqual(view);
    expect(clamp(view, CANVAS, { width: 0, height: 0 })).toEqual(view);
  });
});

describe("centerStarMapView", () => {
  it("puts the middle of the canvas in the middle of the window at 1:1", () => {
    expect(centerStarMapView({ canvas: CANVAS, viewport: VIEWPORT })).toEqual({
      x: (VIEWPORT.width - CANVAS.width) / 2,
      y: (VIEWPORT.height - CANVAS.height) / 2,
      scale: 1,
    });
  });

  it("produces a view the clamp accepts unchanged", () => {
    // Reset view must not itself be corrected by the bounds it restores to.
    for (const canvas of [CANVAS, { width: 400, height: 300 }]) {
      const centered = centerStarMapView({ canvas, viewport: VIEWPORT });
      expect(clamp(centered, canvas)).toEqual(centered);
    }
  });
});

describe("placeStarMapView", () => {
  /**
   * The canvas is the bounding box of what a lens laid out, shifted into
   * positive space, so it grows on whichever side the new content landed
   * and its middle slides by half of that. An anchor is a body, and it
   * moves with the box — which is why the anchored view is the one that
   * holds a loading map still.
   */
  const before = {
    canvas: { width: 900, height: 700 },
    anchor: { x: 450, y: 350 },
  };
  const after = {
    canvas: { width: 1600, height: 1100 },
    anchor: { x: 900, y: 620 },
  };

  /** Where the anchor lands in the window under a placed view. */
  function anchorOnScreen(step: typeof before) {
    const view = placeStarMapView({
      anchor: step.anchor,
      canvas: step.canvas,
      viewport: VIEWPORT,
    });
    return {
      x: view.x + step.anchor.x * view.scale,
      y: view.y + step.anchor.y * view.scale,
    };
  }

  it("opens on the anchor rather than on the middle of the canvas", () => {
    expect(anchorOnScreen(before)).toEqual({
      x: VIEWPORT.width / 2,
      y: VIEWPORT.height / 2,
    });
  });

  it("leaves the anchor where it was when the canvas grows around it", () => {
    expect(anchorOnScreen(after)).toEqual(anchorOnScreen(before));
    // The view itself must move to do that — an unchanged view here would
    // mean the test was passing on a canvas that never grew.
    expect(placeStarMapView({ ...after, viewport: VIEWPORT })).not.toEqual(
      placeStarMapView({ ...before, viewport: VIEWPORT }),
    );
  });

  it("centres the canvas when there is no body to open on", () => {
    // An empty map, before health has landed: no anchor exists yet, and
    // the middle of the canvas is the only point there is.
    expect(
      placeStarMapView({ canvas: CANVAS, viewport: VIEWPORT }),
    ).toEqual(centerStarMapView({ canvas: CANVAS, viewport: VIEWPORT }));
  });

  it("keeps a column lens at the top edge, anchor or not", () => {
    // Lanes bodies sit on a fixed row with their columns growing downward,
    // so the anchor governs x only; centring its y would open the map
    // already scrolled past the bodies.
    const view = placeStarMapView({
      anchor: { x: 900, y: 620 },
      canvas: after.canvas,
      viewport: VIEWPORT,
      topAnchored: true,
    });
    expect(view.y).toBe(0);
    expect(view.x + 900).toBe(VIEWPORT.width / 2);
  });

  it("produces a view the clamp accepts unchanged", () => {
    // Any anchor inside the canvas, including one hard against an edge.
    for (const anchor of [
      { x: 0, y: 0 },
      { x: 450, y: 350 },
      { x: 900, y: 700 },
    ]) {
      const placed = placeStarMapView({
        anchor,
        canvas: before.canvas,
        viewport: VIEWPORT,
      });
      expect(clamp(placed, before.canvas)).toEqual(placed);
    }
  });

  it("falls back to the canvas centre for a nonsense anchor", () => {
    expect(
      placeStarMapView({
        anchor: { x: Number.NaN, y: 0 },
        canvas: CANVAS,
        viewport: VIEWPORT,
      }),
    ).toEqual(centerStarMapView({ canvas: CANVAS, viewport: VIEWPORT }));
  });
});

describe("overview zoom", () => {
  it("lets the operator pull out well past card legibility", () => {
    // The galaxy outgrew the old floor: a fleet of clouds did not fit on
    // screen at 0.35, so there was no view that answered "where am I".
    expect(MIN_ZOOM).toBeLessThan(0.35);
    expect(MIN_ZOOM).toBeLessThan(STAR_MAP_OVERVIEW_ZOOM);
  });

  it("switches to named clouds below the threshold, not at reading zoom", () => {
    expect(isOverviewZoom(MIN_ZOOM)).toBe(true);
    expect(isOverviewZoom(STAR_MAP_OVERVIEW_ZOOM - 0.01)).toBe(true);
    expect(isOverviewZoom(STAR_MAP_OVERVIEW_ZOOM)).toBe(false);
    expect(isOverviewZoom(1)).toBe(false);
  });

  it("counter-scales chrome so a label survives the shrinking canvas", () => {
    // A 13px label at 0.2 scale paints at 2.6px without this.
    expect(overviewChromeScale(0.5)).toBeCloseTo(2, 5);
    expect(overviewChromeScale(0.25)).toBeCloseTo(4, 5);
  });

  it("caps the counter-scale rather than growing labels without bound", () => {
    const atFloor = overviewChromeScale(MIN_ZOOM);
    expect(atFloor).toBeLessThan(1 / MIN_ZOOM);
    // Past the cap labels shrink with the map, which is the honest signal
    // that there is more map than window.
    expect(overviewChromeScale(MIN_ZOOM / 2)).toBe(atFloor);
  });

  it("treats a nonsense scale as unzoomed rather than dividing by zero", () => {
    expect(Number.isFinite(overviewChromeScale(0))).toBe(true);
    expect(overviewChromeScale(0)).toBe(1);
  });
});

describe("starMapSkyOffset", () => {
  function sky(view: Partial<StarMapView>, viewport = VIEWPORT) {
    return starMapSkyOffset({
      view: { x: 0, y: 0, scale: 1, ...view },
      viewport,
    });
  }

  it("moves the sky a small fraction of the way the map moved", () => {
    // Subtle by design: the map should read as sitting in front of the
    // sky, not as dragging it along.
    expect(STAR_MAP_SKY_PARALLAX).toBeGreaterThan(0);
    expect(STAR_MAP_SKY_PARALLAX).toBeLessThanOrEqual(0.2);
    expect(sky({ x: -400, y: -300 })).toEqual({
      x: -400 * STAR_MAP_SKY_PARALLAX,
      y: -300 * STAR_MAP_SKY_PARALLAX,
    });
  });

  it("does not move for zoom alone", () => {
    expect(sky({ scale: 0.25 })).toEqual({ x: 0, y: 0 });
    expect(sky({ x: -400, y: -300, scale: 2 })).toEqual(
      sky({ x: -400, y: -300, scale: 0.5 }),
    );
  });

  it("keeps the offset within one tile so the 2x2 sky always covers the window", () => {
    // Any legal pan, at any zoom, in either direction, far beyond one tile.
    for (const x of [-1e6, -25600, -12801, -12800, -1, 0, 1, 640, 12800, 1e6]) {
      for (const y of [-1e6, -8001, -8000, 0, 800, 8000, 1e6]) {
        const offset = sky({ x, y });
        expect(offset.x).toBeGreaterThan(-VIEWPORT.width);
        expect(offset.x).toBeLessThanOrEqual(0);
        expect(offset.y).toBeGreaterThan(-VIEWPORT.height);
        expect(offset.y).toBeLessThanOrEqual(0);
      }
    }
  });

  it("wraps by whole tiles, so the sky it shows is unchanged", () => {
    // One tile of parallax is one viewport of pan divided by the factor.
    const tilePan = VIEWPORT.width / STAR_MAP_SKY_PARALLAX;
    const base = sky({ x: -400 });
    expect(sky({ x: -400 - tilePan }).x).toBeCloseTo(base.x, 6);
    expect(sky({ x: -400 + 3 * tilePan }).x).toBeCloseTo(base.x, 6);
  });

  it("wraps a positive pan below the origin rather than above it", () => {
    // The sky starts at the window's origin and extends right and down, so
    // a positive offset would uncover the window's left or top edge.
    const offset = sky({ x: 500, y: 300 });
    expect(offset.x).toBe(500 * STAR_MAP_SKY_PARALLAX - VIEWPORT.width);
    expect(offset.y).toBe(300 * STAR_MAP_SKY_PARALLAX - VIEWPORT.height);
  });

  it("lands on a plain zero at a tile boundary, never -0", () => {
    const tilePan = VIEWPORT.width / STAR_MAP_SKY_PARALLAX;
    expect(Object.is(sky({ x: -tilePan }).x, 0)).toBe(true);
    expect(Object.is(sky({ x: 0 }).x, 0)).toBe(true);
  });

  it("stays still against an unmeasured viewport", () => {
    expect(sky({ x: -400, y: -300 }, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("isPointInView", () => {
  const centred: StarMapView = { x: 0, y: 0, scale: 1 };

  it("maps a canvas point through translate-then-scale", () => {
    // transform-origin is 0 0, so the point paints at
    // `canvas * scale + view`, not `(canvas + view) * scale`. Getting the
    // order backwards only shows up away from the origin.
    const view: StarMapView = { x: 100, y: 50, scale: 0.5 };
    // 2000 * 0.5 + 100 = 1100, inside a 1280-wide window.
    expect(
      isPointInView({
        point: { x: 2000, y: 200 },
        view,
        viewport: VIEWPORT,
        margin: 0,
      }),
    ).toBe(true);
    // The other order would be (2000 + 100) * 0.5 = 1050 — also inside,
    // so pin a point the two readings disagree about: 2400 * 0.5 + 100 =
    // 1300 is outside, while (2400 + 100) * 0.5 = 1250 would be inside.
    expect(
      isPointInView({
        point: { x: 2400, y: 200 },
        view,
        viewport: VIEWPORT,
        margin: 0,
      }),
    ).toBe(false);
  });

  it("accepts an anchor just outside the window", () => {
    // A card is anchored by its top-centre, so the anchor leaves the
    // window before the card does. The margin is what keeps a half-visible
    // card in the entrance.
    expect(
      isPointInView({
        point: { x: -STAR_MAP_IN_VIEW_MARGIN + 1, y: 400 },
        view: centred,
        viewport: VIEWPORT,
      }),
    ).toBe(true);
    expect(
      isPointInView({
        point: { x: -STAR_MAP_IN_VIEW_MARGIN - 1, y: 400 },
        view: centred,
        viewport: VIEWPORT,
      }),
    ).toBe(false);
  });

  it("rejects a point past the far edge on either axis", () => {
    expect(
      isPointInView({
        point: { x: VIEWPORT.width + 400, y: 400 },
        view: centred,
        viewport: VIEWPORT,
      }),
    ).toBe(false);
    expect(
      isPointInView({
        point: { x: 400, y: VIEWPORT.height + 400 },
        view: centred,
        viewport: VIEWPORT,
      }),
    ).toBe(false);
  });

  it("pulls far more of the canvas into view as the map zooms out", () => {
    const point = { x: 4000, y: 3000 };
    expect(
      isPointInView({ point, view: centred, viewport: VIEWPORT }),
    ).toBe(false);
    expect(
      isPointInView({
        point,
        view: { x: 0, y: 0, scale: MIN_ZOOM },
        viewport: VIEWPORT,
      }),
    ).toBe(true);
  });
});
