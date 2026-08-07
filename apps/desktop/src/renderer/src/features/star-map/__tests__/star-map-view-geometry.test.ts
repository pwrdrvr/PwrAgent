import { describe, expect, it } from "vitest";
import {
  centerStarMapView,
  clampStarMapView,
  MAX_ZOOM,
  MIN_ZOOM,
  type StarMapView,
} from "../star-map-view-geometry";

const VIEWPORT = { width: 1280, height: 800 };
const CANVAS = { width: 2400, height: 1800 };

/** The 15% strip the clamp guarantees, per axis. */
const MIN_VISIBLE_X = VIEWPORT.width * 0.15;
const MIN_VISIBLE_Y = VIEWPORT.height * 0.15;

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
