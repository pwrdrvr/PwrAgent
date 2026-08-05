/**
 * Pure layout for the Star Map. Positions are percentages of the map
 * viewport (0–100) so every window size renders the same shape; thread-card
 * slots are pixel offsets from their instance anchor, clamped to the
 * instance's cloud radius at render time.
 */

export type StarMapInstanceNode = {
  instanceId: string;
  isHub: boolean;
};

export type StarMapInstancePosition = {
  instanceId: string;
  /** Percent of viewport width. */
  x: number;
  /** Percent of viewport height. */
  y: number;
};

export type StarMapLink = {
  fromInstanceId: string;
  toInstanceId: string;
};

export type StarMapLayout = {
  positions: StarMapInstancePosition[];
  links: StarMapLink[];
};

const HUB_X = 50;
const HUB_Y = 38;
const RING_RADIUS_X = 34;
const RING_RADIUS_Y = 26;

/**
 * Hub-and-spoke: the hub sits center-top, peers spread on an ellipse
 * around it in deterministic instance-id order so every federation member
 * renders the same shape without coordination.
 */
export function computeStarMapLayout(
  nodes: readonly StarMapInstanceNode[],
): StarMapLayout {
  const hub = nodes.find((node) => node.isHub) ?? nodes[0];
  if (!hub) {
    return { positions: [], links: [] };
  }
  const spokes = nodes
    .filter((node) => node.instanceId !== hub.instanceId)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));

  const positions: StarMapInstancePosition[] = [
    { instanceId: hub.instanceId, x: HUB_X, y: HUB_Y },
  ];
  const links: StarMapLink[] = [];
  spokes.forEach((node, index) => {
    // Start at the top and walk clockwise; a lone peer sits to the right
    // rather than stacked on top of the hub's own thread cloud.
    const offset = spokes.length === 1 ? Math.PI / 2 : -Math.PI / 2;
    const angle = offset + (index * 2 * Math.PI) / spokes.length;
    positions.push({
      instanceId: node.instanceId,
      x: HUB_X + RING_RADIUS_X * Math.cos(angle),
      y: HUB_Y + RING_RADIUS_Y * Math.sin(angle),
    });
    links.push({ fromInstanceId: hub.instanceId, toInstanceId: node.instanceId });
  });
  return { positions, links };
}

export type StarMapCardSlot = {
  /** Pixel offset from the instance anchor. */
  dx: number;
  dy: number;
};

const SLOT_COLUMNS = 3;
const SLOT_WIDTH = 232;
const SLOT_HEIGHT = 76;
const SLOT_TOP = 84;

/**
 * Default position of the i-th thread card in an instance's cloud: rows of
 * three centered under the instance card. Arrangement sync (drag offsets)
 * layers on top of these slots.
 */
export function starMapCardSlot(index: number): StarMapCardSlot {
  const column = index % SLOT_COLUMNS;
  const row = Math.floor(index / SLOT_COLUMNS);
  return {
    dx: (column - (SLOT_COLUMNS - 1) / 2) * SLOT_WIDTH,
    dy: SLOT_TOP + row * SLOT_HEIGHT,
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
