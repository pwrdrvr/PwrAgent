/**
 * Pure layout for the Star Map, in pixels of the measured viewport.
 *
 * The map is a constellation: every instance body sits on one orbital row
 * (the hub centered among its spokes), hub-spoke links arc through the sky
 * ABOVE the bodies, and each instance owns a vertical lane whose thread
 * cards flow downward in a single column. Lanes make cross-instance
 * overlap and off-screen clipping structurally impossible instead of
 * tuning-dependent.
 */

export type StarMapInstanceNode = {
  instanceId: string;
  isHub: boolean;
};

export type StarMapInstancePosition = {
  instanceId: string;
  isHub: boolean;
  /** Pixel center of the instance body. */
  x: number;
  y: number;
  /** Width of this instance's exclusive lane. */
  laneWidth: number;
};

export type StarMapLink = {
  fromInstanceId: string;
  toInstanceId: string;
  /** Quadratic Bézier through the sky above the orbital row. */
  path: { x1: number; y1: number; cx: number; cy: number; x2: number; y2: number };
};

export type StarMapLayout = {
  positions: StarMapInstancePosition[];
  links: StarMapLink[];
  /** Card width that fits the narrowest lane, for dense federations. */
  cardWidth: number;
};

/** Vertical center of the orbital row the instance bodies sit on. */
export const STAR_MAP_BODY_ROW_Y = 190;
const MIN_LANE_WIDTH = 248;
const MAX_CARD_WIDTH = 220;
const CARD_LANE_GUTTER = 28;
const ARC_MIN_LIFT = 60;
/** Extra arc lift per pixel of horizontal distance - long links fly higher. */
const ARC_LIFT_RATIO = 0.14;

/**
 * Free reach past the outermost card of a cloud, before a drag meets the
 * detent.
 *
 * The detent is measured from the instance body, not from the card's own
 * slot, so every card in a cloud shares one region — that is what lets any
 * card be dropped where any other card already sits. The outermost slot has
 * to fall inside it, and this is the free travel the card sitting there
 * gets on top of that. Cards nearer the body get more, which is the point.
 */
export const STAR_MAP_CLOUD_DETENT_SLACK = 340;

/**
 * Overshoot the detent absorbs before a drag breaks through, in px.
 *
 * Past the detent a card is out on its own — that is a real thing to want
 * (ten cards pulled aside into an island for one project), so this resists
 * the drag rather than stopping it.
 */
const DETENT_WIDTH = 120;
/** Share of the overshoot inside the detent the card actually travels. */
const DETENT_TRAVEL = 0.3;

/**
 * Deterministic constellation: spokes sorted by instance id with the hub
 * inserted at the middle lane, so every federation member renders the
 * same shape without coordination.
 */
export function computeStarMapLayout(
  nodes: readonly StarMapInstanceNode[],
  viewportWidth: number,
): StarMapLayout {
  if (nodes.length === 0) {
    return { positions: [], links: [], cardWidth: MAX_CARD_WIDTH };
  }
  const hub = nodes.find((node) => node.isHub) ?? nodes[0];
  const spokes = nodes
    .filter((node) => node.instanceId !== hub.instanceId)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const ordered = [...spokes];
  ordered.splice(Math.floor(spokes.length / 2), 0, hub);

  const laneWidth = Math.max(
    MIN_LANE_WIDTH,
    viewportWidth / Math.max(ordered.length, 1),
  );
  // When lanes would overflow the viewport (many instances on a narrow
  // window), the row is wider than the screen; the map viewport pans via
  // CSS overflow rather than squeezing cards into unreadability.
  const rowWidth = laneWidth * ordered.length;
  const rowLeft = Math.max(0, (viewportWidth - rowWidth) / 2);

  const positions: StarMapInstancePosition[] = ordered.map((node, index) => ({
    instanceId: node.instanceId,
    isHub: node.instanceId === hub.instanceId,
    x: rowLeft + laneWidth * (index + 0.5),
    y: STAR_MAP_BODY_ROW_Y,
    laneWidth,
  }));

  const hubPosition = positions.find((position) => position.isHub)!;
  const links: StarMapLink[] = positions
    .filter((position) => !position.isHub)
    .map((position) => {
      const lift =
        ARC_MIN_LIFT + Math.abs(position.x - hubPosition.x) * ARC_LIFT_RATIO;
      return {
        fromInstanceId: hubPosition.instanceId,
        toInstanceId: position.instanceId,
        path: {
          x1: hubPosition.x,
          y1: hubPosition.y - 44,
          cx: (hubPosition.x + position.x) / 2,
          cy: STAR_MAP_BODY_ROW_Y - 44 - lift,
          x2: position.x,
          y2: position.y - 36,
        },
      };
    });

  return {
    positions,
    links,
    cardWidth: Math.min(MAX_CARD_WIDTH, laneWidth - CARD_LANE_GUTTER),
  };
}

export type StarMapCardSlot = {
  /** Pixel offset from the instance anchor. */
  dx: number;
  dy: number;
};

/** Gap between stacked cards in a lane. */
export const STAR_MAP_CARD_GAP = 12;
/** Distance from the instance anchor to the first card. */
export const STAR_MAP_CLOUD_TOP = 100;
/** Height assumed for a card that has not been measured yet. */
export const STAR_MAP_ESTIMATED_CARD_HEIGHT = 112;
/** Room kept below the last card for the "+N more" affordance. */
const CLOUD_BOTTOM_RESERVE = 40;

/**
 * Stack a lane's cards from measured heights.
 *
 * Card height varies with how many chip rows a thread carries (a PR chip
 * plus a branch chip wraps to three rows), so a fixed pitch either
 * overlaps tall cards - clipping them mid-glyph - or wastes space under
 * short ones. Positions are cumulative instead, and the caller re-measures
 * when content changes.
 */
export function computeCardSlots(
  heights: readonly number[],
  options?: { top?: number; gap?: number },
): StarMapCardSlot[] {
  const top = options?.top ?? STAR_MAP_CLOUD_TOP;
  const gap = options?.gap ?? STAR_MAP_CARD_GAP;
  const slots: StarMapCardSlot[] = [];
  let y = top;
  for (const height of heights) {
    slots.push({ dx: 0, dy: y });
    y += height + gap;
  }
  return slots;
}

/**
 * How many cards fit between the instance anchor and the bottom of the
 * viewport. Always yields at least one so a lane never renders empty when
 * it has something to show.
 */
export function visibleCardCount(params: {
  heights: readonly number[];
  availableHeight: number;
  max: number;
}): number {
  const limit = Math.min(params.heights.length, params.max);
  let used = STAR_MAP_CLOUD_TOP;
  let count = 0;
  for (let index = 0; index < limit; index += 1) {
    const next = used + params.heights[index];
    if (count > 0 && next + CLOUD_BOTTOM_RESERVE > params.availableHeight) {
      break;
    }
    used = next + STAR_MAP_CARD_GAP;
    count += 1;
  }
  return Math.max(count, Math.min(1, params.heights.length));
}

/**
 * Distance from the body at which a cloud's drags meet the detent.
 *
 * Read off the drawn slots rather than a per-lens constant: lanes stack
 * downward from the body while orbit and projects ring it, and both have to
 * yield a region that already contains every card the cloud drew — a detent
 * tighter than that would fight a far-out card the moment its drag began.
 * (`cardRingExtent` in star-map-orbit.ts measures the same placed slots for
 * body spacing, in the two lenses that ring.)
 */
export function cloudDetentRadius(slots: readonly StarMapCardSlot[]): number {
  let outermost = 0;
  for (const slot of slots) {
    outermost = Math.max(outermost, Math.hypot(slot.dx, slot.dy));
  }
  return outermost + STAR_MAP_CLOUD_DETENT_SLACK;
}

/**
 * How far from the body a card actually travels when the pointer has taken
 * it `distance` out. Continuous and monotonic, so the card never jumps.
 */
function detentTravel(distance: number, radius: number): number {
  const overshoot = distance - radius;
  if (overshoot <= 0) return distance;
  if (overshoot <= DETENT_WIDTH) {
    return radius + overshoot * DETENT_TRAVEL;
  }
  // Through the detent: the card tracks the pointer one-for-one again,
  // keeping the travel it gave up as a constant lag.
  return radius + DETENT_WIDTH * DETENT_TRAVEL + (overshoot - DETENT_WIDTH);
}

/**
 * Resolve a dragged card's pointer position against its cloud's detent, and
 * hand back the offset to commit.
 *
 * A card sits at `baseSlot + offset` in body-relative pixels and the detent
 * is a radius around the body, so the resistance has to be applied to that
 * position and the offset derived back out. Resisting the offset alone
 * would centre a separate region on every card's own slot: a card to the
 * left of the body could not reach the positions cards on the right already
 * occupy, and each card's freedom would depend on where its slot happened
 * to land. The committed value stays an offset because arrangements persist
 * and sync across the federation in that shape.
 *
 * Apply this to the live pointer position only. The result is what gets
 * stored, so running it over a stored offset again would compress a card
 * that is deliberately parked out past the detent.
 */
/**
 * Convert a pointer movement into canvas movement.
 *
 * Cards live inside `.star-map__canvas`, which the orbit and projects
 * lenses render under `scale(view.scale)`. A pointer that travels N screen
 * pixels therefore crosses N / scale canvas pixels — and a card moved by a
 * raw screen delta renders as delta * scale on screen, so zoomed in the
 * card outruns the pointer and slides out from under the cursor. Lanes
 * never scales, so there the conversion is the identity.
 */
export function pointerDeltaToCanvas(params: {
  dx: number;
  dy: number;
  /** Current canvas scale; values <= 0 are treated as unscaled. */
  scale: number;
}): { dx: number; dy: number } {
  const scale = params.scale > 0 ? params.scale : 1;
  return { dx: params.dx / scale, dy: params.dy / scale };
}

export function resolveCardDragOffset(params: {
  baseSlot: StarMapCardSlot;
  offset: StarMapCardSlot;
  detentRadius: number;
}): StarMapCardSlot {
  const x = params.baseSlot.dx + params.offset.dx;
  const y = params.baseSlot.dy + params.offset.dy;
  const distance = Math.hypot(x, y);
  const travel = detentTravel(distance, params.detentRadius);
  // Inside the detent the pointer is followed exactly; hand the offset
  // straight back rather than round-tripping it through the arithmetic.
  if (travel === distance) return params.offset;
  const scale = travel / distance;
  return {
    dx: x * scale - params.baseSlot.dx,
    dy: y * scale - params.baseSlot.dy,
  };
}

export type StarMapStar = {
  /** Percent coordinates of the star field. */
  x: number;
  y: number;
  radius: number;
  opacity: number;
  /** Twinkle phase offset in seconds. */
  twinkleDelay: number;
};

/**
 * Deterministic pseudo-random star field (mulberry32). Seeded so the sky
 * is stable across renders and identical on every instance - the map
 * should feel like a place, not a screensaver reshuffle.
 */
export function generateStarField(count: number, seed = 7): StarMapStar[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const stars: StarMapStar[] = [];
  for (let index = 0; index < count; index += 1) {
    const brightness = next();
    stars.push({
      x: next() * 100,
      y: next() * 100,
      radius: 0.5 + brightness * 1.1,
      opacity: 0.25 + brightness * 0.65,
      twinkleDelay: next() * 6,
    });
  }
  return stars;
}
