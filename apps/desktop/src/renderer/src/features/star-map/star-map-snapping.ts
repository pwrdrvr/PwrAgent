/**
 * Snapping for hand-arranged star map cards.
 *
 * Two kinds, both computed in absolute canvas coordinates so cards from
 * different clouds can align with each other:
 *
 * - **Alignment** — a dragged card's left / centre / right (and top /
 *   middle / bottom) latching onto the same edge of a nearby card.
 * - **Spacing** — once cards are stacked, matching a gap that already
 *   exists in the arrangement rather than a fixed ladder of pixel values.
 *   An arbitrary 2/5/10px ladder fights the operator; a spacing they
 *   already chose is one they meant.
 */

export type SnapRect = {
  /** Top-left corner, absolute canvas coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SnapAxis = "x" | "y";

/**
 * A line to draw so the operator can see WHY the card latched. Without it
 * a snap reads as the card sticking for no reason.
 */
export type AlignmentGuide = {
  axis: SnapAxis;
  /** Canvas coordinate of the line on its own axis. */
  at: number;
  /** Extent along the other axis, so the line spans both cards. */
  start: number;
  end: number;
};

export type SnapResult = {
  dx: number;
  dy: number;
  guides: AlignmentGuide[];
  /** Set when a spacing detent claimed an axis, for an optional readout. */
  spacing?: { axis: SnapAxis; gap: number };
};

export type ResizeSnapResult = {
  dw: number;
  dh: number;
  guides: AlignmentGuide[];
};

/** Gaps below this are treated as "touching" rather than a real interval. */
const MIN_MEANINGFUL_GAP = 4;
/** Two cards count as stacked when they overlap this much across the axis. */
const CROSS_AXIS_OVERLAP = 8;

function edgesFor(rect: SnapRect, axis: SnapAxis): number[] {
  return axis === "x"
    ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
    : [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
}

function spanStart(rect: SnapRect, axis: SnapAxis): number {
  return axis === "x" ? rect.y : rect.x;
}

function spanEnd(rect: SnapRect, axis: SnapAxis): number {
  return axis === "x" ? rect.y + rect.height : rect.x + rect.width;
}

/**
 * Best edge alignment on one axis: the smallest adjustment that brings any
 * of the moving card's three edges onto any of a neighbour's three.
 */
function alignAxis(params: {
  axis: SnapAxis;
  moving: SnapRect;
  others: readonly SnapRect[];
  threshold: number;
}): { delta: number; guide: AlignmentGuide } | undefined {
  const movingEdges = edgesFor(params.moving, params.axis);
  let best: { delta: number; guide: AlignmentGuide } | undefined;

  for (const other of params.others) {
    for (const otherEdge of edgesFor(other, params.axis)) {
      for (const movingEdge of movingEdges) {
        const delta = otherEdge - movingEdge;
        if (Math.abs(delta) > params.threshold) continue;
        if (best && Math.abs(delta) >= Math.abs(best.delta)) continue;
        best = {
          delta,
          guide: {
            axis: params.axis,
            at: otherEdge,
            start: Math.min(
              spanStart(params.moving, params.axis),
              spanStart(other, params.axis),
            ),
            end: Math.max(
              spanEnd(params.moving, params.axis),
              spanEnd(other, params.axis),
            ),
          },
        };
      }
    }
  }
  return best;
}

/** Do two rects overlap enough across `axis` to be considered a stack? */
function overlapsAcross(
  a: SnapRect,
  b: SnapRect,
  axis: SnapAxis,
): boolean {
  const aStart = spanStart(a, axis);
  const aEnd = spanEnd(a, axis);
  const bStart = spanStart(b, axis);
  const bEnd = spanEnd(b, axis);
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) >= CROSS_AXIS_OVERLAP;
}

/**
 * Gaps the arrangement already contains along `axis`, between cards that
 * are stacked on it. These become the detents, which is why the snapping
 * gets tighter the more the operator has already arranged.
 */
export function observedGaps(
  rects: readonly SnapRect[],
  axis: SnapAxis,
): number[] {
  const gaps = new Set<number>();
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (!overlapsAcross(a, b, axis)) continue;
      const aStart = axis === "x" ? a.x : a.y;
      const aSize = axis === "x" ? a.width : a.height;
      const bStart = axis === "x" ? b.x : b.y;
      const bSize = axis === "x" ? b.width : b.height;
      const gap =
        aStart < bStart ? bStart - (aStart + aSize) : aStart - (bStart + bSize);
      if (gap >= MIN_MEANINGFUL_GAP) gaps.add(Math.round(gap));
    }
  }
  return [...gaps].sort((left, right) => left - right);
}

/**
 * Snap the moving card so it sits a known gap from a stacked neighbour.
 * Only considered on an axis alignment did not already claim.
 */
function spaceAxis(params: {
  axis: SnapAxis;
  defaultGap: number;
  moving: SnapRect;
  others: readonly SnapRect[];
  threshold: number;
}): { delta: number; gap: number } | undefined {
  const gaps = [...observedGaps(params.others, params.axis)];
  if (!gaps.includes(params.defaultGap)) gaps.push(params.defaultGap);

  const movingStart = params.axis === "x" ? params.moving.x : params.moving.y;
  const movingSize =
    params.axis === "x" ? params.moving.width : params.moving.height;

  let best: { delta: number; gap: number } | undefined;
  for (const other of params.others) {
    if (!overlapsAcross(params.moving, other, params.axis)) continue;
    const otherStart = params.axis === "x" ? other.x : other.y;
    const otherSize = params.axis === "x" ? other.width : other.height;
    for (const gap of gaps) {
      // Sitting after the neighbour, and sitting before it.
      const candidates = [
        otherStart + otherSize + gap,
        otherStart - gap - movingSize,
      ];
      for (const candidate of candidates) {
        const delta = candidate - movingStart;
        if (Math.abs(delta) > params.threshold) continue;
        if (best && Math.abs(delta) >= Math.abs(best.delta)) continue;
        best = { delta, gap };
      }
    }
  }
  return best;
}

/**
 * Resolve a drag position into a snapped one.
 *
 * Alignment wins an axis over spacing: latching an edge is the stronger,
 * more legible cue, and the two commonly apply to different axes anyway —
 * stacking a card under another aligns X and spaces Y, which is exactly
 * the arrangement this exists to make easy.
 */
export function resolveSnap(params: {
  defaultGap: number;
  moving: SnapRect;
  others: readonly SnapRect[];
  /** Canvas-space tolerance; callers convert from a screen-space value. */
  threshold: number;
}): SnapResult {
  if (params.threshold <= 0 || params.others.length === 0) {
    return { dx: 0, dy: 0, guides: [] };
  }

  const result: SnapResult = { dx: 0, dy: 0, guides: [] };
  for (const axis of ["x", "y"] as const) {
    const aligned = alignAxis({
      axis,
      moving: params.moving,
      others: params.others,
      threshold: params.threshold,
    });
    if (aligned) {
      if (axis === "x") result.dx = aligned.delta;
      else result.dy = aligned.delta;
      result.guides.push(aligned.guide);
      continue;
    }
    const spaced = spaceAxis({
      axis,
      defaultGap: params.defaultGap,
      moving: params.moving,
      others: params.others,
      threshold: params.threshold,
    });
    if (!spaced) continue;
    if (axis === "x") result.dx = spaced.delta;
    else result.dy = spaced.delta;
    result.spacing = { axis, gap: spaced.gap };
  }
  return result;
}

/**
 * Snap a bottom-right resize. Unlike movement, the top-left stays pinned:
 * candidates change width/height to align the moving right/bottom edge or to
 * match a neighbour's dimension. This is the missing half of making chat
 * cards form deliberate rows and columns rather than merely aligning their
 * origins.
 */
export function resolveResizeSnap(params: {
  moving: SnapRect;
  others: readonly SnapRect[];
  threshold: number;
}): ResizeSnapResult {
  const result: ResizeSnapResult = { dw: 0, dh: 0, guides: [] };
  if (params.threshold <= 0 || params.others.length === 0) return result;

  for (const axis of ["x", "y"] as const) {
    const movingStart = axis === "x" ? params.moving.x : params.moving.y;
    const movingSize = axis === "x" ? params.moving.width : params.moving.height;
    const movingEnd = movingStart + movingSize;
    let best:
      | { delta: number; guide: AlignmentGuide }
      | undefined;
    for (const other of params.others) {
      const otherSize = axis === "x" ? other.width : other.height;
      const targets = [
        ...edgesFor(other, axis),
        movingStart + otherSize,
      ];
      for (const target of targets) {
        const delta = target - movingEnd;
        if (Math.abs(delta) > params.threshold) continue;
        if (best && Math.abs(delta) >= Math.abs(best.delta)) continue;
        best = {
          delta,
          guide: {
            axis,
            at: target,
            start: Math.min(
              spanStart(params.moving, axis),
              spanStart(other, axis),
            ),
            end: Math.max(
              spanEnd(params.moving, axis),
              spanEnd(other, axis),
            ),
          },
        };
      }
    }
    if (!best) continue;
    if (axis === "x") result.dw = best.delta;
    else result.dh = best.delta;
    result.guides.push(best.guide);
  }
  return result;
}

/**
 * Whether a rect intersects a marquee, for rubber-band selection.
 *
 * An empty rect intersects nothing, so a marquee the operator never
 * dragged out selects nothing — rather than quietly claiming whatever
 * card happened to sit under the press.
 */
export function rectIntersects(a: SnapRect, b: SnapRect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
    return false;
  }
  return (
    a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y
  );
}

/** Normalise a drag between two points into a positive-extent rect. */
export function marqueeRect(
  from: { x: number; y: number },
  to: { x: number; y: number },
): SnapRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}
