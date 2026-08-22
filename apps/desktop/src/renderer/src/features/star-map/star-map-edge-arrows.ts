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
 * the rail along the edge's normal. The glyph's OUTER EDGE sits on the
 * rail and the pill hangs off its inner side, so this is how far in the
 * pill's near edge lands. Mirrors `.star-map__edge-arrow` (18px head +
 * 4px gap).
 *
 * The drawn tip lands a few pixels inside the rail rather than exactly on
 * it — the glyph is centred 9px in and its tip is 7px from that centre,
 * so the tip's inset varies between 3px and 8.5px as the dart rotates.
 * That is inherent to rotating a glyph about a fixed point and is well
 * inside the rail's own inset; it is recorded here so nobody re-derives
 * the constant from a "tip exactly on the rail" reading that was never
 * true.
 */
export const STAR_MAP_EDGE_HEAD_SPAN = 22;

/**
 * Half-extent of a body's drawing, in CANVAS units.
 *
 * An arrow points at a body's centre, but a body is not a point: the hub
 * instance draws a 116px disc with a glow reaching 72px from centre and a
 * label pill hanging 73px below it. Culling on the bare centre therefore
 * calls a body off-screen while half of it is still in the window, and
 * the arrow is then drawn ON TOP of the body it points at — the dart
 * lands on the instance's own name pill.
 *
 * Worse, culling runs nearest-first: a straddling body is the nearest
 * candidate, so it is placed first and suppresses the arrow for a body
 * that really is invisible. That is the failure the feature exists to
 * prevent, caused by the feature itself.
 *
 * Sized to the largest body (the hub's 73px column half-height) so no
 * body is ever arrowed while a pixel of it is on screen. Erring large is
 * free: it only delays the arrow until the body has fully left.
 */
export const STAR_MAP_EDGE_BODY_HALF_EXTENT = 74;

/** Clear space demanded between two pills before the farther one is dropped. */
const LABEL_CLEARANCE = 6;

/**
 * A screen-space rectangle an arrow must not be drawn under.
 *
 * The map's own always-on readouts — the camera key hint bottom-left, the
 * selection bar bottom-centre — sit at a HIGHER layer than the arrows and
 * are translucent, so an arrow underneath one is a smudge behind the WASD
 * caps rather than a pointer. The rail's top inset already reserves room
 * for the top band; these are the same problem on the other three sides,
 * and they move, so they are passed in rather than baked into an inset.
 */
export type StarMapEdgeObstacle = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

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
  /**
   * The arrow's point on the rail, in viewport pixels: where the ray
   * leaves it, and where the head glyph's outer edge is placed.
   */
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
 * Advance width of one character at the pill's 11px / weight 500, in px.
 *
 * Per character class rather than one average, because the classes are
 * far apart and instance labels are hostnames — the case a flat average
 * is worst at. Measured against the rendered pill: lowercase runs ~5.8,
 * uppercase and digits 7.3-7.9, and a CJK or otherwise full-width glyph
 * is about one em, which is font-independent. A flat 6.4 under-measured
 * `WIN-EC2-SANDBOX` by 15px and a seven-character CJK label by 31px —
 * five times the clearance the culler works with.
 *
 * Every class rounds UP, which is the direction that matters: see
 * `estimateStarMapEdgeLabelWidth`.
 */
function glyphAdvance(codePoint: number): number {
  // The CJK/Hangul/Kana blocks plus the full-width forms — everything the
  // Unicode east-asian-width tables call W or F, coarsely. A codepoint
  // above the BMP is either an emoji or a rare ideograph; both draw wide.
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || codePoint > 0xffff
  ) {
    return 11.5;
  }
  // Uppercase and digits. `-`, `.` and `/` are narrow and fall through to
  // the lowercase figure, which over-counts them — deliberately.
  if (
    (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x30 && codePoint <= 0x39)
  ) {
    return 8;
  }
  return 6.6;
}

/**
 * Roughly how wide a pill will draw for a label.
 *
 * The estimate rounds up on purpose. Over-estimating drops an arrow that
 * would have fitted; under-estimating draws two pills on top of each
 * other, and only one of those is a bug you can see. Padding, border,
 * icon and gap mirror the pill's CSS — the border counts because the
 * renderer is `box-sizing: border-box` throughout, so the 1px on each
 * side is part of the width the culler has to reason about.
 *
 * Capped at the pill's own `max-width`: past that the label ellipsises
 * rather than growing, so a longer name is not a wider box.
 */
export function estimateStarMapEdgeLabelWidth(
  label: string,
  options?: { icon?: boolean },
): number {
  const padding = 20;
  const border = 2;
  const icon = options?.icon ? 20 : 0;
  let text = 0;
  // Iterated by code POINT: a surrogate pair is one wide glyph, and
  // `label.length` would count it as two narrow ones.
  for (const character of label) {
    text += glyphAdvance(character.codePointAt(0) ?? 0);
  }
  return Math.min(
    STAR_MAP_EDGE_LABEL_MAX_WIDTH,
    padding + border + icon + text,
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

/**
 * Slide a pill along its edge until it clears the map's own readouts.
 *
 * Slide rather than drop: an arrow that gives way to the key hint has
 * stopped doing its one job, and the operator is left with no cue for a
 * body they cannot see. Moving it a few tens of pixels along the same
 * edge keeps the cue and costs only that the dart no longer sits at the
 * pill's middle — which is already true near every corner, and is what
 * `labelShift` exists to express.
 *
 * Two passes, because clearing one readout can slide a pill into the
 * next; two is enough for the map's two, and a fixed bound cannot loop.
 * If neither side of an obstacle fits inside the rail the pill stays put
 * — a partly-covered arrow still beats no arrow.
 */
function slideClearOfObstacles(params: {
  /** Current pill centre along the edge's free axis. */
  center: number;
  /** Half the pill's extent along that axis. */
  half: number;
  /** The pill's fixed span on the other axis. */
  crossMin: number;
  crossMax: number;
  railMin: number;
  railMax: number;
  /** True when the free axis is x (the top and bottom edges). */
  horizontal: boolean;
  obstacles: readonly StarMapEdgeObstacle[];
}): number {
  if (params.obstacles.length === 0) return params.center;
  let center = params.center;
  for (let pass = 0; pass < 2; pass += 1) {
    let moved = false;
    for (const obstacle of params.obstacles) {
      const crossMin = params.horizontal ? obstacle.top : obstacle.left;
      const crossMax = params.horizontal ? obstacle.bottom : obstacle.right;
      // Clear on the fixed axis: this obstacle cannot cover this edge.
      if (crossMax <= params.crossMin || crossMin >= params.crossMax) continue;
      const obstacleMin = params.horizontal ? obstacle.left : obstacle.top;
      const obstacleMax = params.horizontal ? obstacle.right : obstacle.bottom;
      if (obstacleMax <= center - params.half) continue;
      if (obstacleMin >= center + params.half) continue;
      const before = obstacleMin - params.half - LABEL_CLEARANCE;
      const after = obstacleMax + params.half + LABEL_CLEARANCE;
      const beforeFits = before - params.half >= params.railMin;
      const afterFits = after + params.half <= params.railMax;
      const preferBefore =
        beforeFits
        && (!afterFits
          || Math.abs(before - center) <= Math.abs(after - center));
      if (preferBefore) {
        center = before;
        moved = true;
      } else if (afterFits) {
        center = after;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return clamp(center, params.railMin + params.half, params.railMax - params.half);
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
  /**
   * Screen-space rects the map's own readouts occupy. A pill that would
   * land on one slides along its edge to clear it rather than being drawn
   * underneath it.
   */
  obstacles?: readonly StarMapEdgeObstacle[];
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
  const obstacles = params.obstacles ?? [];

  type Candidate = Omit<StarMapEdgeArrow<T>, "labelShift">;
  const candidates: Candidate[] = [];
  for (const target of params.targets) {
    // `transform-origin: 0 0`, so a canvas point paints at
    // `point * scale + view` — the same mapping as `isPointInView`.
    const screenX = target.x * view.scale + view.x;
    const screenY = target.y * view.scale + view.y;
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) continue;
    // The body's DRAWING, not its centre: a body is arrowed only once
    // every pixel of it has left the window. The half-extent is in canvas
    // units, so it scales with the zoom exactly as the body does.
    const bodyMargin = STAR_MAP_EDGE_BODY_HALF_EXTENT * view.scale;
    if (
      screenX >= -bodyMargin
      && screenX <= viewport.width + bodyMargin
      && screenY >= -bodyMargin
      && screenY <= viewport.height + bodyMargin
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
      const inner =
        candidate.edge === "right"
          ? candidate.x - STAR_MAP_EDGE_HEAD_SPAN
          : candidate.x + STAR_MAP_EDGE_HEAD_SPAN;
      const left = candidate.edge === "right" ? inner - width : inner;
      const right = candidate.edge === "right" ? inner : inner + width;
      const centerY = slideClearOfObstacles({
        center: clamp(
          candidate.y,
          rail.top + halfHeight,
          rail.bottom - halfHeight,
        ),
        crossMax: right,
        crossMin: left,
        half: halfHeight,
        horizontal: false,
        obstacles,
        railMax: rail.bottom,
        railMin: rail.top,
      });
      labelShift = centerY - candidate.y;
      box = {
        left,
        right,
        top: centerY - halfHeight,
        bottom: centerY + halfHeight,
      };
    } else {
      const inner =
        candidate.edge === "bottom"
          ? candidate.y - STAR_MAP_EDGE_HEAD_SPAN
          : candidate.y + STAR_MAP_EDGE_HEAD_SPAN;
      const top =
        candidate.edge === "bottom" ? inner - STAR_MAP_EDGE_LABEL_HEIGHT : inner;
      const bottom =
        candidate.edge === "bottom" ? inner : inner + STAR_MAP_EDGE_LABEL_HEIGHT;
      const centerX = slideClearOfObstacles({
        center: clamp(
          candidate.x,
          rail.left + halfWidth,
          rail.right - halfWidth,
        ),
        crossMax: bottom,
        crossMin: top,
        half: halfWidth,
        horizontal: true,
        obstacles,
        railMax: rail.right,
        railMin: rail.left,
      });
      labelShift = centerX - candidate.x;
      box = {
        left: centerX - halfWidth,
        right: centerX + halfWidth,
        top,
        bottom,
      };
    }
    if (placed.some((other) => boxesCollide(other, box))) continue;
    placed.push(box);
    arrows.push({ ...candidate, labelShift });
  }
  return arrows;
}
