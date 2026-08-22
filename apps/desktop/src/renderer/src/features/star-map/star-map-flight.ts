/**
 * Flying the camera to one card.
 *
 * The map is a surface you fly over, and ⌘K is the way to reach a card
 * you cannot see: the palette names it, and the camera travels to it
 * rather than teleporting. The travel is the point — a cut would leave
 * the operator holding a map they no longer recognise, with no idea which
 * direction the card they picked was in. Watching the sky slide keeps the
 * spatial memory the whole lens is built on.
 *
 * Everything here is pure: the hook owns the timing and the DOM, this owns
 * the rules. Coordinates are the same ones `clampStarMapView` speaks —
 * untransformed canvas units for the rect, screen pixels for the view.
 */

import {
  clampStarMapView,
  MAX_ZOOM,
  MIN_ZOOM,
  type StarMapView,
  type StarMapViewBox,
} from "./star-map-view-geometry";

/** A card's footprint on the untransformed canvas. */
export type StarMapFlightRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * How long one flight takes.
 *
 * Long enough to read as travel across the map rather than a jump cut,
 * short enough that a run of ⌘K picks does not feel like waiting on an
 * animation. Roughly the length of a window-manager space switch, which
 * is the same "I moved, not the world" gesture.
 */
export const STAR_MAP_FLIGHT_DURATION_MS = 520;

/**
 * The zoom a flight lands at when the operator is pulled further out.
 *
 * Below `STAR_MAP_OVERVIEW_ZOOM` the map draws no cards at all, so a
 * flight that kept an overview zoom would centre the viewport on empty
 * sky and call it success. 1:1 is where the map opens and where "Reset
 * view" puts it, so it is the scale the operator already reads cards at.
 */
export const STAR_MAP_FLIGHT_SCALE = 1;

/**
 * The scale to arrive at: the operator's own zoom whenever it is already
 * close enough to read a card, and 1:1 when it is not. Deliberately never
 * zooms OUT — someone who flew in to 2x asked to be there.
 */
export function starMapFlightScale(current: number): number {
  if (!Number.isFinite(current) || current <= 0) return STAR_MAP_FLIGHT_SCALE;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.max(current, STAR_MAP_FLIGHT_SCALE)));
}

/**
 * The view that puts `rect` in the middle of the window at `scale`.
 *
 * Clamped through the same `clampStarMapView` as every other
 * operator-driven write, so a card at the very edge of the canvas lands as
 * close to centre as the bounds allow rather than dragging the map out of
 * reach.
 */
export function starMapViewFocusedOn(params: {
  rect: StarMapFlightRect;
  canvas: StarMapViewBox;
  viewport: StarMapViewBox;
  scale: number;
  /**
   * A column lens, whose canvas hangs from a fixed top edge.
   *
   * Centring the y of something near the TOP of such a canvas puts the
   * canvas origin below the window's, i.e. opens a band of empty sky
   * above the lane headers with the columns shoved down — the state
   * `placeStarMapView`'s own `topAnchored` exists to prevent. Lanes seats
   * every instance body on one fixed row at y=190, so flying to a body
   * there hits it every single time: ~210px of sky at 1:1, more as the
   * zoom drops, recoverable only through "Reset view".
   *
   * A cap rather than a pin, unlike placement: a flight to a card deep in
   * a column legitimately wants a negative y, and forcing zero would
   * simply not travel there.
   */
  topAnchored?: boolean;
}): StarMapView {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, params.scale));
  const centerX = params.rect.x + params.rect.width / 2;
  const centerY = params.rect.y + params.rect.height / 2;
  const y = params.viewport.height / 2 - centerY * scale;
  return clampStarMapView({
    view: {
      x: params.viewport.width / 2 - centerX * scale,
      y: params.topAnchored ? Math.min(0, y) : y,
      scale,
    },
    canvas: params.canvas,
    viewport: params.viewport,
  });
}

/**
 * Ease-in-out cubic: the map accelerates away, coasts, and settles. A
 * linear flight starts and stops dead, which reads as a scroll bar being
 * dragged by someone else rather than as a camera move.
 */
export function easeStarMapFlight(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * One frame of a flight.
 *
 * Pan interpolates linearly, zoom geometrically: scale is perceived
 * multiplicatively, so a linear ramp from 0.3 to 1 spends most of the
 * flight already zoomed in and then lurches at the end. Same reasoning as
 * the keyboard camera's octaves-per-second.
 */
export function interpolateStarMapView(
  from: StarMapView,
  to: StarMapView,
  progress: number,
): StarMapView {
  const eased = easeStarMapFlight(progress);
  const scale =
    from.scale > 0 && to.scale > 0
      ? from.scale * Math.pow(to.scale / from.scale, eased)
      : to.scale;
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
    scale,
  };
}

/**
 * Whether a flight is worth animating at all.
 *
 * A pick whose card is already centred (the operator searched for what
 * they were looking at) should not shudder the map half a pixel. The
 * threshold is in screen pixels, and the zoom check is a ratio because
 * scale is multiplicative.
 */
export function starMapFlightIsNoop(
  from: StarMapView,
  to: StarMapView,
): boolean {
  return (
    Math.abs(to.x - from.x) < 0.5
    && Math.abs(to.y - from.y) < 0.5
    && Math.abs(to.scale / (from.scale || 1) - 1) < 0.001
  );
}
