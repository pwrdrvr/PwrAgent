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

/** How far a dragged card may stray from its instance anchor. */
export const STAR_MAP_CLOUD_RADIUS = 340;

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

const CLOUD_TOP = 116;
const CARD_PITCH = 84;

/**
 * Default position of the i-th thread card in an instance's cloud: a
 * single column flowing down the instance's lane. Arrangement sync (drag
 * offsets) layers on top of these slots.
 */
export function starMapCardSlot(index: number): StarMapCardSlot {
  return {
    dx: 0,
    dy: CLOUD_TOP + index * CARD_PITCH,
  };
}

/** Clamp an offset to the cloud radius around the instance anchor. */
export function clampToCloudRadius(
  dx: number,
  dy: number,
  radius: number,
): StarMapCardSlot {
  const distance = Math.hypot(dx, dy);
  if (distance <= radius || distance === 0) {
    return { dx, dy };
  }
  const scale = radius / distance;
  return { dx: dx * scale, dy: dy * scale };
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
