/**
 * Edge arrows: where the rest of the map is.
 *
 * The pan clamp keeps a strip of canvas in the window, but a strip of
 * canvas is not a body. The operator can park the window on empty sky
 * between two clouds with every instance off-screen and nothing to say
 * which way to drag — the map is recoverable, it just gives no hint. So
 * for every body the window is not showing, the screen draws a pointer
 * on the edge of the window where a line from the middle of the window
 * to that body would leave it, turned to the bearing of that line. A pan
 * that swings the body round swings its arrow round the edge with it; a
 * pan toward it walks the arrow inward until the body itself comes on
 * and the arrow goes away. Clicking one flies the camera there.
 *
 * Everything here is pure: the component owns the DOM and the timing,
 * this owns the rules. Coordinates are the ones the rest of the view
 * geometry speaks — canvas units for a target, viewport pixels for
 * everything returned.
 */

import type { StarMapView, StarMapViewBox } from "./star-map-view-geometry";

export type StarMapEdge = "top" | "right" | "bottom" | "left";

export type StarMapEdgeInset = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

/**
 * How far in from the window the arrows sit, per side — the "rail" they
 * ride along.
 *
 * The top is deeper than the rest because the top of the map is not sky.
 * The top band (wordmark, Find, View, the filter chips) owns the first
 * ~40px, and on macOS the window's glass drag strip covers 52px: an arrow
 * drawn under either is an arrow nobody can click. The other three sides
 * only clear the window edge by enough to read as "at the edge" rather
 * than "cut off by it"; the bottom matches the key hint's own inset so the
 * two line up when they share the row.
 */
export const STAR_MAP_EDGE_INSET: StarMapEdgeInset = {
  top: 56,
  right: 16,
  bottom: 18,
  left: 16,
};

/**
 * The label pill's height, in viewport px — a filter chip's height,
 * because it is drawn with the chip's tokens. Used here only to keep the
 * pill inside the rail and to keep two pills off each other; the CSS owns
 * the real box.
 */
export const STAR_MAP_EDGE_LABEL_HEIGHT = 25;

/** The pill's `max-width` in CSS; a longer name is ellipsised inside it. */
export const STAR_MAP_EDGE_LABEL_MAX_WIDTH = 180;

/**
 * Head glyph plus the gap between it and the pill, measured inward from
 * the rail along the edge's normal. The glyph's tip sits ON the rail and
 * the pill hangs off the glyph's inner side, so this is how far in the
 * pill's near edge lands. Mirrors `.star-map__edge-arrow` (18px head +
 * 4px gap).
 */
export const STAR_MAP_EDGE_HEAD_SPAN = 22;

/** Clear space demanded between two pills before the farther one is dropped. */
const LABEL_CLEARANCE = 6;

/** What a target must carry: a point on the canvas and a stable identity. */
export type StarMapEdgeTarget = {
  key: string;
  /** Canvas-space point the arrow aims at — the body's centre. */
  x: number;
  y: number;
  /**
   * Estimated width of this target's pill. Arrows are culled nearest-first
   * by whether their pills would overlap, so this decides how tightly two
   * arrows on one edge can pack. Absent, the pill is assumed to be as wide
   * as it can be, which over-culls and never overdraws.
   */
  labelWidth?: number;
};

export type StarMapEdgeArrow<T extends StarMapEdgeTarget = StarMapEdgeTarget> = {
  target: T;
  /** Which side of the rail the arrow sits on. */
  edge: StarMapEdge;
  /** Where the glyph's tip sits, in viewport pixels: on the rail. */
  x: number;
  y: number;
  /**
   * Bearing from the middle of the window to the target, in degrees,
   * clockwise from +x the way CSS `rotate()` reads them (the screen's y
   * points down). 0 is straight right, -90 straight up.
   */
  angle: number;
  /** Viewport-pixel distance from the middle of the window to the target. */
  distance: number;
  /**
   * How far the pill is slid along its edge, away from the glyph, to stay
   * inside the rail. Zero except near a corner, where a pill centred on
   * the glyph would hang out of the window.
   */
  labelShift: number;
};

/**
 * Roughly how wide a pill will draw for a label.
 *
 * 11px text in the UI sans averages a little over 6px a glyph; the
 * estimate rounds up on purpose. Over-estimating drops an arrow that
 * would have fitted, under-estimating draws two pills on top of each
 * other, and only one of those is a bug you can see. Padding, icon and
 * gap mirror the pill's CSS.
 */
export function estimateStarMapEdgeLabelWidth(
  label: string,
  options?: { icon?: boolean },
): number {
  const padding = 20;
  const icon = options?.icon ? 20 : 0;
  return Math.min(
    STAR_MAP_EDGE_LABEL_MAX_WIDTH,
    padding + icon + label.length * 6.4,
  );
}

type Rail = { left: number; top: number; right: number; bottom: number };

type Box = { left: number; top: number; right: number; bottom: number };

function clamp(value: number, min: number, max: number): number {
  // A pill wider than the rail has no legal position; the middle is the
  // least wrong one.
  if (min > max) return (min + max) / 2;
  return Math.min(Math.max(value, min), max);
}

function boxesCollide(a: Box, b: Box): boolean {
  return (
    a.left < b.right + LABEL_CLEARANCE
    && b.left < a.right + LABEL_CLEARANCE
    && a.top < b.bottom + LABEL_CLEARANCE
    && b.top < a.bottom + LABEL_CLEARANCE
  );
}

/**
 * The arrows to draw for a view.
 *
 * For each target outside the WINDOW — not outside the rail: a body under
 * the top band is still a body the operator can see — cast a ray from the
 * middle of the window through the target and take the point where it
 * leaves the rail. That point is the arrow; the ray's bearing is its
 * angle. Then place nearest-first, and drop any arrow whose pill would
 * land on one already placed, on any edge: two bodies in nearly the same
 * direction share one arrow — the nearer — rather than two unreadable
 * ones, and a pill sliding into a corner cannot cover the pill that
 * arrived from the adjacent edge.
 */
export function computeStarMapEdgeArrows<T extends StarMapEdgeTarget>(params: {
  targets: readonly T[];
  view: StarMapView;
  viewport: StarMapViewBox;
  inset?: StarMapEdgeInset;
}): StarMapEdgeArrow<T>[] {
  const { view, viewport } = params;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return [];
  const inset = params.inset ?? STAR_MAP_EDGE_INSET;
  let rail: Rail = {
    left: inset.left,
    top: inset.top,
    right: viewport.width - inset.right,
    bottom: viewport.height - inset.bottom,
  };
  // A window too small for its insets has no rail; the window's own edges
  // are better than none.
  if (rail.right <= rail.left || rail.bottom <= rail.top) {
    rail = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  }
  // The ray leaves from the middle of the window. Clamped into the rail so
  // the exit below is always ahead of the source — only a window shorter
  // than the top inset can put the middle outside it.
  const sourceX = clamp(viewport.width / 2, rail.left, rail.right);
  const sourceY = clamp(viewport.height / 2, rail.top, rail.bottom);

  type Candidate = Omit<StarMapEdgeArrow<T>, "labelShift">;
  const candidates: Candidate[] = [];
  for (const target of params.targets) {
    // `transform-origin: 0 0`, so a canvas point paints at
    // `point * scale + view` — the same mapping as `isPointInView`.
    const screenX = target.x * view.scale + view.x;
    const screenY = target.y * view.scale + view.y;
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) continue;
    if (
      screenX >= 0
      && screenX <= viewport.width
      && screenY >= 0
      && screenY <= viewport.height
    ) {
      continue;
    }
    const dx = screenX - sourceX;
    const dy = screenY - sourceY;
    const distance = Math.hypot(dx, dy);
    if (!(distance > 0)) continue;
    // The exit is the nearest rail side ahead of the ray: the smallest
    // positive multiple of the direction that lands on a side. Only the
    // side the ray is heading for on each axis can be ahead of it. The
    // source is inside the rail, so at least one side is.
    let t = Number.POSITIVE_INFINITY;
    let edge: StarMapEdge = "right";
    if (dx > 0) {
      const tx = (rail.right - sourceX) / dx;
      if (tx < t) {
        t = tx;
        edge = "right";
      }
    } else if (dx < 0) {
      const tx = (rail.left - sourceX) / dx;
      if (tx < t) {
        t = tx;
        edge = "left";
      }
    }
    if (dy > 0) {
      const ty = (rail.bottom - sourceY) / dy;
      if (ty < t) {
        t = ty;
        edge = "bottom";
      }
    } else if (dy < 0) {
      const ty = (rail.top - sourceY) / dy;
      if (ty < t) {
        t = ty;
        edge = "top";
      }
    }
    if (!Number.isFinite(t)) continue;
    candidates.push({
      target,
      edge,
      x: sourceX + dx * t,
      y: sourceY + dy * t,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
      distance,
    });
  }

  // Nearest first, and a stable tie-break so two bodies at one distance do
  // not trade places between frames.
  candidates.sort(
    (left, right) =>
      left.distance - right.distance
      || (left.target.key < right.target.key
        ? -1
        : left.target.key > right.target.key
          ? 1
          : 0),
  );

  const placed: Box[] = [];
  const arrows: StarMapEdgeArrow<T>[] = [];
  for (const candidate of candidates) {
    const width = Math.min(
      STAR_MAP_EDGE_LABEL_MAX_WIDTH,
      candidate.target.labelWidth ?? STAR_MAP_EDGE_LABEL_MAX_WIDTH,
    );
    const halfWidth = width / 2;
    const halfHeight = STAR_MAP_EDGE_LABEL_HEIGHT / 2;
    let labelShift: number;
    let box: Box;
    if (candidate.edge === "left" || candidate.edge === "right") {
      const centerY = clamp(
        candidate.y,
        rail.top + halfHeight,
        rail.bottom - halfHeight,
      );
      labelShift = centerY - candidate.y;
      const inner =
        candidate.edge === "right"
          ? candidate.x - STAR_MAP_EDGE_HEAD_SPAN
          : candidate.x + STAR_MAP_EDGE_HEAD_SPAN;
      box = {
        left: candidate.edge === "right" ? inner - width : inner,
        right: candidate.edge === "right" ? inner : inner + width,
        top: centerY - halfHeight,
        bottom: centerY + halfHeight,
      };
    } else {
      const centerX = clamp(
        candidate.x,
        rail.left + halfWidth,
        rail.right - halfWidth,
      );
      labelShift = centerX - candidate.x;
      const inner =
        candidate.edge === "bottom"
          ? candidate.y - STAR_MAP_EDGE_HEAD_SPAN
          : candidate.y + STAR_MAP_EDGE_HEAD_SPAN;
      box = {
        left: centerX - halfWidth,
        right: centerX + halfWidth,
        top: candidate.edge === "bottom" ? inner - STAR_MAP_EDGE_LABEL_HEIGHT : inner,
        bottom:
          candidate.edge === "bottom" ? inner : inner + STAR_MAP_EDGE_LABEL_HEIGHT,
      };
    }
    if (placed.some((other) => boxesCollide(other, box))) continue;
    placed.push(box);
    arrows.push({ ...candidate, labelShift });
  }
  return arrows;
}
