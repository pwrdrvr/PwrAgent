import type { StarMapCardSlot } from "./star-map-layout";
import type { StarMapTopologyNode } from "./star-map-topology";

export type OrbitInstancePlacement = {
  instanceId: string;
  isHub: boolean;
  x: number;
  y: number;
  /** Slots for this instance's cards, relative to its body. */
  cardSlots: StarMapCardSlot[];
};

export type OrbitPlacement = {
  instances: OrbitInstancePlacement[];
  links: { fromInstanceId: string; toInstanceId: string }[];
  canvasWidth: number;
  canvasHeight: number;
};

const CARD_RING_MIN_RADIUS = 190;
const CANVAS_PADDING = 160;
/** Depth-1 instances need room for their own card ring plus breathing space. */
const INSTANCE_RING_MIN_RADIUS = 520;

/**
 * Radius that fits `count` cards around a body without them colliding:
 * the ring's circumference has to cover every card's width plus a gap.
 */
export function cardRingRadius(count: number, cardWidth: number): number {
  if (count <= 1) return CARD_RING_MIN_RADIUS;
  const needed = (count * (cardWidth + 26)) / (2 * Math.PI);
  return Math.max(CARD_RING_MIN_RADIUS, needed);
}

/**
 * Hub-and-spoke placement: every instance is a body with its threads
 * orbiting it, and children orbit their parent. Bodies are spaced so
 * neighbouring card rings cannot touch, which makes the canvas larger
 * than the window by design — the surface pans and zooms instead of
 * compressing the map into unreadability.
 */
export function computeOrbitPlacement(params: {
  nodes: readonly StarMapTopologyNode[];
  /** Visible card count per instance. */
  cardCounts: ReadonlyMap<string, number>;
  cardWidth: number;
}): OrbitPlacement {
  const root = params.nodes.find((node) => node.depth === 0);
  if (!root) {
    return { instances: [], links: [], canvasWidth: 0, canvasHeight: 0 };
  }
  const radiusFor = (instanceId: string) =>
    cardRingRadius(params.cardCounts.get(instanceId) ?? 0, params.cardWidth);

  const raw = new Map<string, { x: number; y: number }>();
  raw.set(root.instanceId, { x: 0, y: 0 });

  const children = params.nodes
    .filter((node) => node.parentId === root.instanceId)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));

  // Space children so the widest pair of adjacent card rings still clears.
  const widestChildRing = children.reduce(
    (widest, node) => Math.max(widest, radiusFor(node.instanceId)),
    CARD_RING_MIN_RADIUS,
  );
  const ringRadius = Math.max(
    INSTANCE_RING_MIN_RADIUS,
    radiusFor(root.instanceId) + widestChildRing + 120,
    children.length > 1
      ? (children.length * (widestChildRing * 2 + 80)) / (2 * Math.PI)
      : 0,
  );

  children.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / children.length;
    raw.set(node.instanceId, {
      x: Math.cos(angle) * ringRadius,
      y: Math.sin(angle) * ringRadius,
    });
  });

  // Anything deeper orbits its own parent, in the wedge pointing outward.
  for (const node of params.nodes) {
    if (node.depth < 2 || !node.parentId) continue;
    const parent = raw.get(node.parentId);
    if (!parent) continue;
    const siblings = params.nodes.filter(
      (candidate) => candidate.parentId === node.parentId,
    );
    const position = siblings.findIndex(
      (candidate) => candidate.instanceId === node.instanceId,
    );
    const outward = Math.atan2(parent.y, parent.x);
    const spread = Math.PI / 2;
    const step = siblings.length > 1 ? spread / (siblings.length - 1) : 0;
    const angle = outward - spread / 2 + position * step;
    const distance = radiusFor(node.parentId) + radiusFor(node.instanceId) + 120;
    raw.set(node.instanceId, {
      x: parent.x + Math.cos(angle) * distance,
      y: parent.y + Math.sin(angle) * distance,
    });
  }

  // Shift into positive canvas space with room for the outermost rings.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of params.nodes) {
    const point = raw.get(node.instanceId);
    if (!point) continue;
    const reach = radiusFor(node.instanceId) + params.cardWidth / 2;
    minX = Math.min(minX, point.x - reach);
    maxX = Math.max(maxX, point.x + reach);
    minY = Math.min(minY, point.y - reach);
    maxY = Math.max(maxY, point.y + reach);
  }
  const offsetX = CANVAS_PADDING - minX;
  const offsetY = CANVAS_PADDING - minY;

  const instances: OrbitInstancePlacement[] = params.nodes.flatMap((node) => {
    const point = raw.get(node.instanceId);
    if (!point) return [];
    const count = params.cardCounts.get(node.instanceId) ?? 0;
    const radius = radiusFor(node.instanceId);
    const cardSlots: StarMapCardSlot[] = Array.from(
      { length: count },
      (_unused, index) => {
        // Start below the body and walk clockwise, so the first card sits
        // where the lane layout would have put it.
        const angle = Math.PI / 2 + (index * 2 * Math.PI) / Math.max(count, 1);
        return {
          dx: Math.cos(angle) * radius,
          dy: Math.sin(angle) * radius,
        };
      },
    );
    return [
      {
        instanceId: node.instanceId,
        isHub: node.depth === 0,
        x: point.x + offsetX,
        y: point.y + offsetY,
        cardSlots,
      },
    ];
  });

  return {
    instances,
    links: params.nodes
      .filter((node) => node.parentId)
      .map((node) => ({
        fromInstanceId: node.parentId!,
        toInstanceId: node.instanceId,
      })),
    canvasWidth: maxX - minX + CANVAS_PADDING * 2,
    canvasHeight: maxY - minY + CANVAS_PADDING * 2,
  };
}
