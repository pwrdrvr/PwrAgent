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

/* Cards are wide and short (~2:1), so their rings are ellipses rather than
   circles: horizontal spacing is the binding constraint at the top and
   bottom of a ring, while the sides only need to clear a card's height.
   Squashing the ring to match the card's shape pulls everything closer to
   the body than a circle of the same capacity would. */
const RING_BASE_RX = 178;
const RING_BASE_RY = 130;
/* Successive rings step out far enough that a card on one clears the card
   height of the ring inside it. */
const RING_STEP_RX = 228;
const RING_STEP_RY = 124;
/* Cards may crowd to 82% of their width at the tightest point on a ring:
   they are opaque and hover raises the one under the pointer, so a little
   shingling buys a much denser map. */
const RING_PACKING = 0.82;
const CANVAS_PADDING = 160;
/** Floor on how close two instance bodies may sit, before ring clearance. */
const INSTANCE_RING_MIN_RADIUS = 430;

export type CardRing = { rx: number; ry: number; capacity: number };

function ringAt(index: number, cardWidth: number): CardRing {
  const rx = RING_BASE_RX + index * RING_STEP_RX;
  const ry = RING_BASE_RY + index * RING_STEP_RY;
  return {
    rx,
    ry,
    capacity: Math.max(
      3,
      Math.floor((2 * Math.PI * rx) / (cardWidth * RING_PACKING)),
    ),
  };
}

/** Rings needed to seat `count` cards, innermost first. */
export function cardRings(count: number, cardWidth: number): CardRing[] {
  const rings: CardRing[] = [];
  let seated = 0;
  for (let index = 0; seated < Math.max(count, 1); index += 1) {
    const ring = ringAt(index, cardWidth);
    rings.push(ring);
    seated += ring.capacity;
  }
  return rings;
}

/** Outermost extent of an instance's card rings, for spacing and bounds. */
export function cardRingExtent(
  count: number,
  cardWidth: number,
): { rx: number; ry: number } {
  const rings = cardRings(count, cardWidth);
  const outer = rings[rings.length - 1];
  return { rx: outer.rx, ry: outer.ry };
}

/**
 * Slot per card, filling each ring before stepping outward. Alternate
 * rings are rotated half a step so cards do not line up radially.
 */
export function cardRingSlots(
  count: number,
  cardWidth: number,
): StarMapCardSlot[] {
  const rings = cardRings(count, cardWidth);
  const slots: StarMapCardSlot[] = [];
  let remaining = count;
  rings.forEach((ring, ringIndex) => {
    if (remaining <= 0) return;
    const onThisRing = Math.min(remaining, ring.capacity);
    remaining -= onThisRing;
    for (let index = 0; index < onThisRing; index += 1) {
      // Start below the body so the first card lands where the lane
      // layout would have put it, then walk clockwise.
      const angle =
        Math.PI / 2
        + (index * 2 * Math.PI) / onThisRing
        + (ringIndex % 2 === 1 ? Math.PI / onThisRing : 0);
      slots.push({
        dx: Math.cos(angle) * ring.rx,
        dy: Math.sin(angle) * ring.ry,
      });
    }
  });
  return slots;
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
  const extentFor = (instanceId: string) =>
    cardRingExtent(params.cardCounts.get(instanceId) ?? 0, params.cardWidth);
  const radiusFor = (instanceId: string) => extentFor(instanceId).rx;

  const raw = new Map<string, { x: number; y: number }>();
  raw.set(root.instanceId, { x: 0, y: 0 });

  const children = params.nodes
    .filter((node) => node.parentId === root.instanceId)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));

  // Space children so the widest pair of adjacent card rings still clears.
  const widestChildRing = children.reduce(
    (widest, node) => Math.max(widest, radiusFor(node.instanceId)),
    RING_BASE_RX,
  );
  const ringRadius = Math.max(
    INSTANCE_RING_MIN_RADIUS,
    radiusFor(root.instanceId) + widestChildRing + 80,
    children.length > 1
      ? (children.length * (widestChildRing * 2 + 60)) / (2 * Math.PI)
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
    const distance = radiusFor(node.parentId) + radiusFor(node.instanceId) + 80;
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
    const extent = extentFor(node.instanceId);
    minX = Math.min(minX, point.x - extent.rx - params.cardWidth / 2);
    maxX = Math.max(maxX, point.x + extent.rx + params.cardWidth / 2);
    minY = Math.min(minY, point.y - extent.ry - 80);
    maxY = Math.max(maxY, point.y + extent.ry + 80);
  }
  const offsetX = CANVAS_PADDING - minX;
  const offsetY = CANVAS_PADDING - minY;

  const instances: OrbitInstancePlacement[] = params.nodes.flatMap((node) => {
    const point = raw.get(node.instanceId);
    if (!point) return [];
    const count = params.cardCounts.get(node.instanceId) ?? 0;
    const cardSlots = cardRingSlots(count, params.cardWidth);
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

/**
 * Whether a pointerdown on the map should start a canvas pan.
 *
 * Anything interactive owns its own gesture — cards drag themselves,
 * bodies open, chrome clicks — so a pan only begins on bare sky.
 */
export function shouldStartCanvasPan(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !target.closest(
    "button, a, input, label, .star-map__chrome, .star-map__filters",
  );
}
