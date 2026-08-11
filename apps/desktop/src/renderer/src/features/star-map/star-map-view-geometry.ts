/**
 * Geometry for the star map's pan/zoom view.
 *
 * The orbit and projects lenses lay their bodies out on a canvas larger
 * than the window and move it under a `translate(x, y) scale(s)` with
 * `transform-origin: 0 0`, so the canvas occupies the viewport-pixel rect
 * `[x, x + width * scale] x [y, y + height * scale]`.
 *
 * Everything here is pure: the screen owns the state, this owns the rules.
 */

export type StarMapView = { x: number; y: number; scale: number };

export type StarMapViewBox = { width: number; height: number };

/**
 * How far out the map can be pulled.
 *
 * Well below the point where a card is readable, on purpose: past
 * `STAR_MAP_OVERVIEW_ZOOM` the map stops drawing cards at all and shows
 * named clouds instead, so the far end of the range is for answering
 * "which solar system am I in" rather than for reading anything.
 */
export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 2;

/**
 * Below this scale a thread card is a ~130px smudge of unreadable text
 * that still costs a full subtree to mount. The map trades all of them
 * for one label per cloud — the fleet stays legible AND the DOM shrinks
 * to a handful of nodes exactly when there would otherwise be hundreds.
 */
export const STAR_MAP_OVERVIEW_ZOOM = 0.5;

/** Whether the view is far enough out to drop to named clouds. */
export function isOverviewZoom(scale: number): boolean {
  return scale < STAR_MAP_OVERVIEW_ZOOM;
}

/**
 * Counter-scale for chrome that must stay readable while the canvas
 * shrinks under it. Capped so a label does not grow without bound as the
 * operator keeps pulling out — past the cap the labels shrink too, which
 * is the honest signal that there is more map than window.
 */
export function overviewChromeScale(scale: number): number {
  const safe = scale > 0 ? scale : 1;
  return Math.min(1 / safe, 1 / MIN_ZOOM / 1.6);
}

/**
 * How much of the canvas has to stay on screen, per axis, as a fraction of
 * the viewport.
 *
 * A pan/zoom surface with no bounds can be dragged until the populated area
 * is entirely outside the window, and an empty star field gives the operator
 * nothing to drag back — the map is only recoverable by closing it. Keeping
 * a strip of canvas in view on both axes means there is always something to
 * grab and always a direction that leads back to the bodies.
 *
 * Per-axis rather than by area: an area rule is satisfied by a one-pixel-tall
 * band across the window, which is not a usable handle.
 *
 * Exported so tests assert against this number rather than a copy of it.
 */
export const MIN_VISIBLE_FRACTION = 0.15;

/**
 * Clamp one axis so the canvas's overlap with the viewport stays at or above
 * the minimum.
 *
 * With canvas extent `content` placed at `position` against a viewport of
 * `viewportExtent`, the overlap is the least of `viewportExtent`, `content`,
 * `position + content`, and `viewportExtent - position`. The first two do
 * not depend on `position`, so requiring the overlap to be at least
 * `minVisible` reduces to the two bounds below.
 */
function clampAxis(params: {
  position: number;
  content: number;
  viewportExtent: number;
}): number {
  const { position, content, viewportExtent } = params;
  // A zero-sized canvas or an unmeasured viewport has no meaningful bounds;
  // leaving the position alone beats clamping it to an arbitrary origin.
  if (
    !Number.isFinite(position)
    || !(content > 0)
    || !(viewportExtent > 0)
  ) {
    return position;
  }
  // Never demand more overlap than the canvas can supply — a canvas smaller
  // than the demanded strip would otherwise have no legal position at all.
  const minVisible = Math.min(content, viewportExtent * MIN_VISIBLE_FRACTION);
  const min = minVisible - content;
  const max = viewportExtent - minVisible;
  return Math.min(Math.max(position, min), max);
}

/**
 * Keep a pan/zoom view within reach of its content.
 *
 * Applied to every operator-driven write of the view — wheel pan, pinch
 * zoom, and each animation frame of a pointer drag. Clamping the live drag
 * frames as well as the value committed on pointerup is what stops the
 * canvas visibly snapping back when the operator lets go.
 *
 * Deliberately NOT applied when the map's *contents* change. A cloud that
 * resizes must never move a view the operator positioned; that is the whole
 * point of the view-ownership rule, and re-clamping on a content change
 * would reintroduce exactly the jerk it removed.
 *
 * That leaves a real gap, and it is a reachable one rather than a corner
 * case: the bounds are a function of canvas size, so a canvas that SHRINKS
 * can strand a view that was legal when the operator placed it. Parked at
 * the left bound (`x = minVisible - canvasWidth`, looking at the canvas's
 * right edge) and then archiving enough cards to drop an orbit ring narrows
 * the canvas by roughly 2 * RING_STEP_RX — far more than the strip this
 * guarantees — and the content ends up off-screen entirely.
 *
 * So this bounds the operator's own movement and nothing else. Recovery
 * from a content-induced strand is "Reset view", which is a cheap in-app
 * action rather than the reopen-the-map it replaced, but it is still a
 * manual step. Closing that gap needs a rescue that fires only for an
 * already-out-of-bounds view; see the note on centerStarMapView.
 */
export function clampStarMapView(params: {
  view: StarMapView;
  /** Untransformed canvas size for the current lens. */
  canvas: StarMapViewBox;
  viewport: StarMapViewBox;
}): StarMapView {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, params.view.scale));
  return {
    scale,
    x: clampAxis({
      position: params.view.x,
      content: params.canvas.width * scale,
      viewportExtent: params.viewport.width,
    }),
    y: clampAxis({
      position: params.view.y,
      content: params.canvas.height * scale,
      viewportExtent: params.viewport.height,
    }),
  };
}

/**
 * The view that puts the middle of the canvas in the middle of the window
 * at 1:1. Used to place the map on open, on a lens switch, and by "Reset
 * view".
 *
 * This is also the manual half of the content-shrink gap described on
 * clampStarMapView. A rescue that re-placed the view automatically would
 * have to fire only when the current view is already out of bounds — a
 * no-op for every view the operator can still use — so that it never moves
 * a usable view and never reintroduces the jerk the ownership rule fixed.
 * Deliberately not attempted here: it changes when the map is allowed to
 * move itself, which wants its own change and its own tests.
 */
export function centerStarMapView(params: {
  canvas: StarMapViewBox;
  viewport: StarMapViewBox;
}): StarMapView {
  return {
    x: (params.viewport.width - params.canvas.width) / 2,
    y: (params.viewport.height - params.canvas.height) / 2,
    scale: 1,
  };
}

/**
 * Where a lens opens.
 *
 * Radial lenses centre their canvas: content radiates from the middle, so
 * the middle is the interesting part. A column lens anchors to the top
 * instead — its bodies sit on a fixed row and their columns grow downward,
 * so centring a tall canvas would open the map already scrolled past the
 * bodies with nothing but card tails on screen.
 *
 * Clamped, so a top anchor on a canvas that is shorter than the window
 * still lands somewhere legal rather than at a negative offset.
 */
export function placeStarMapView(params: {
  canvas: StarMapViewBox;
  viewport: StarMapViewBox;
  topAnchored?: boolean;
}): StarMapView {
  const centered = centerStarMapView({
    canvas: params.canvas,
    viewport: params.viewport,
  });
  if (!params.topAnchored) return centered;
  return clampStarMapView({
    view: { ...centered, y: 0 },
    canvas: params.canvas,
    viewport: params.viewport,
  });
}
