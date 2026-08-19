import { describe, expect, it } from "vitest";
import {
  easeStarMapFlight,
  interpolateStarMapView,
  starMapFlightIsNoop,
  starMapFlightScale,
  starMapViewFocusedOn,
  STAR_MAP_FLIGHT_SCALE,
} from "../star-map-flight";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  MIN_VISIBLE_FRACTION,
} from "../star-map-view-geometry";

const VIEWPORT = { width: 1280, height: 800 };

describe("starMapViewFocusedOn", () => {
  it("puts the middle of the card in the middle of the window", () => {
    const view = starMapViewFocusedOn({
      rect: { x: 2000, y: 1500, width: 200, height: 100 },
      canvas: { width: 6000, height: 4000 },
      viewport: VIEWPORT,
      scale: 1,
    });
    // Screen position of the card's centre = view.x + centre * scale.
    expect(view.x + 2100).toBeCloseTo(VIEWPORT.width / 2);
    expect(view.y + 1550).toBeCloseTo(VIEWPORT.height / 2);
    expect(view.scale).toBe(1);
  });

  it("centres in canvas units, so the zoom scales the travel", () => {
    const view = starMapViewFocusedOn({
      rect: { x: 2000, y: 1500, width: 200, height: 100 },
      canvas: { width: 6000, height: 4000 },
      viewport: VIEWPORT,
      scale: 2,
    });
    expect(view.x + 2100 * 2).toBeCloseTo(VIEWPORT.width / 2);
    expect(view.y + 1550 * 2).toBeCloseTo(VIEWPORT.height / 2);
  });

  it("keeps the canvas reachable when the rect is outside it", () => {
    // Deliberately out of bounds, because a card INSIDE the canvas can
    // never reach the clamp: centring one leaves at least
    // `viewport/2 - canvas` of overlap, which is always more than the
    // strip the clamp guarantees. The bound is a rail for the case where
    // a rect and the canvas extent disagree — a lens whose canvas shrank
    // under a rect measured against the previous one — and this pins that
    // the flight goes through it rather than flying the map out of reach.
    const canvas = { width: 6000, height: 4000 };
    const view = starMapViewFocusedOn({
      rect: { x: 12_000, y: 9_000, width: 200, height: 100 },
      canvas,
      viewport: VIEWPORT,
      scale: 1,
    });
    // Un-clamped this would be 640 - 12100 = -11460, 400 - 9050 = -8650:
    // the canvas entirely off the left and top of the window.
    expect(view.x).toBe(MIN_VISIBLE_FRACTION * VIEWPORT.width - canvas.width);
    expect(view.y).toBe(MIN_VISIBLE_FRACTION * VIEWPORT.height - canvas.height);
    // Which is to say: a strip of canvas is still on screen to grab.
    expect(view.x + canvas.width).toBeGreaterThan(0);
    expect(view.y + canvas.height).toBeGreaterThan(0);
  });
});

describe("starMapFlightScale", () => {
  it("zooms in when the operator is too far out to read a card", () => {
    // Below STAR_MAP_OVERVIEW_ZOOM the map draws no cards at all, so a
    // flight that kept this zoom would centre on empty sky.
    expect(starMapFlightScale(0.2)).toBe(STAR_MAP_FLIGHT_SCALE);
  });

  it("keeps a zoom the operator already flew in to", () => {
    expect(starMapFlightScale(1.8)).toBe(1.8);
  });

  it("stays inside the zoom range whatever it is handed", () => {
    expect(starMapFlightScale(99)).toBe(MAX_ZOOM);
    expect(starMapFlightScale(0)).toBe(STAR_MAP_FLIGHT_SCALE);
    expect(starMapFlightScale(Number.NaN)).toBe(STAR_MAP_FLIGHT_SCALE);
    expect(starMapFlightScale(MIN_ZOOM)).toBeGreaterThanOrEqual(MIN_ZOOM);
  });
});

describe("interpolateStarMapView", () => {
  const from = { x: 0, y: 0, scale: 0.25 };
  const to = { x: -400, y: -200, scale: 1 };

  it("starts at the origin and ends at the destination", () => {
    expect(interpolateStarMapView(from, to, 0)).toEqual(from);
    const landed = interpolateStarMapView(from, to, 1);
    expect(landed.x).toBeCloseTo(to.x);
    expect(landed.y).toBeCloseTo(to.y);
    expect(landed.scale).toBeCloseTo(to.scale);
  });

  it("moves zoom geometrically, so the halfway frame is the geometric mean", () => {
    // Halfway through the EASING, not halfway through time: 0.5 is the
    // ease's own fixed point.
    const middle = interpolateStarMapView(from, to, 0.5);
    expect(middle.scale).toBeCloseTo(Math.sqrt(from.scale * to.scale));
  });

  it("never leaves the segment it was given", () => {
    for (const progress of [0.1, 0.3, 0.7, 0.9]) {
      const frame = interpolateStarMapView(from, to, progress);
      expect(frame.x).toBeLessThanOrEqual(0);
      expect(frame.x).toBeGreaterThanOrEqual(to.x);
      expect(frame.scale).toBeGreaterThanOrEqual(from.scale);
      expect(frame.scale).toBeLessThanOrEqual(to.scale);
    }
  });
});

describe("easeStarMapFlight", () => {
  it("is pinned at both ends and clamps out-of-range progress", () => {
    expect(easeStarMapFlight(0)).toBe(0);
    expect(easeStarMapFlight(1)).toBe(1);
    expect(easeStarMapFlight(-1)).toBe(0);
    expect(easeStarMapFlight(2)).toBe(1);
  });

  it("accelerates away and settles rather than tracking time linearly", () => {
    expect(easeStarMapFlight(0.25)).toBeLessThan(0.25);
    expect(easeStarMapFlight(0.5)).toBeCloseTo(0.5);
    expect(easeStarMapFlight(0.75)).toBeGreaterThan(0.75);
  });
});

describe("starMapFlightIsNoop", () => {
  it("declines to animate a pick that is already centred", () => {
    const view = { x: -100, y: -50, scale: 1 };
    expect(starMapFlightIsNoop(view, { ...view })).toBe(true);
    expect(starMapFlightIsNoop(view, { ...view, x: -100.2 })).toBe(true);
  });

  it("animates anything the operator would actually see", () => {
    const view = { x: -100, y: -50, scale: 1 };
    expect(starMapFlightIsNoop(view, { ...view, x: -140 })).toBe(false);
    expect(starMapFlightIsNoop(view, { ...view, scale: 1.4 })).toBe(false);
  });
});
