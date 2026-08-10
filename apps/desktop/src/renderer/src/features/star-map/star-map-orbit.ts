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
/* Keep-out around an instance's own chrome. Cards may crowd right up to
   this box but must never cover it: the body, its name pill, and the [+]
   intake button are how you act on the instance, so a card sitting on top
   of them takes the surface away. Measured from `.star-map-instance` in
   app.css — hub body 116px tall, name pill 150px wide plus a 22px intake
   button and their 6px gap, stacked under the body with an 8px gap and up
   to two label lines. */
const INSTANCE_KEEPOUT_HALF_WIDTH = 92;
const INSTANCE_KEEPOUT_BELOW = 100;
/* Half of STAR_MAP_ESTIMATED_CARD_HEIGHT: cards are placed by their
   centre, so half a card overhangs the ring toward the body. */
const CARD_HALF_HEIGHT = 56;
/* Deliberately small — "very close to them" — but non-zero so a card edge
   never visually touches the pill it is clearing. */
const KEEPOUT_GAP = 10;

/** Above the body centre there is only the icon; the chrome hangs below. */
const INSTANCE_KEEPOUT_ABOVE = 58;

/**
 * The keep-out box shared with the cluster layout, so project clouds clear
 * the same chrome the ring slots do.
 */
export const STAR_MAP_INSTANCE_KEEPOUT = {
  halfWidth: INSTANCE_KEEPOUT_HALF_WIDTH,
  above: INSTANCE_KEEPOUT_ABOVE,
  below: INSTANCE_KEEPOUT_BELOW,
} as const;

/**
 * Does a card centred here clear the instance's own chrome?
 *
 * Only the handful of slots that actually collide get pushed out (see
 * `pushOutOfKeepout`). Inflating every ring instead would shove the whole
 * cloud away from its body to protect a box most cards never touch — the
 * opposite of keeping cards close to the sun.
 */
function clearsKeepout(dx: number, dy: number, cardWidth: number): boolean {
  const overlapsX =
    Math.abs(dx) < INSTANCE_KEEPOUT_HALF_WIDTH + cardWidth / 2 + KEEPOUT_GAP;
  const overlapsY =
    dy + CARD_HALF_HEIGHT > -INSTANCE_KEEPOUT_ABOVE
    && dy - CARD_HALF_HEIGHT < INSTANCE_KEEPOUT_BELOW + KEEPOUT_GAP;
  return !(overlapsX && overlapsY);
}

/** Slide a colliding slot straight out along its own radius until it clears. */
function pushOutOfKeepout(
  slot: StarMapCardSlot,
  cardWidth: number,
): StarMapCardSlot {
  const length = Math.hypot(slot.dx, slot.dy);
  if (length < 1) return slot;
  const ux = slot.dx / length;
  const uy = slot.dy / length;
  let scale = 1;
  let dx = slot.dx;
  let dy = slot.dy;
  // Bounded: a slot never needs more than a few card-widths of relief.
  while (!clearsKeepout(dx, dy, cardWidth) && scale < 4) {
    scale += 0.04;
    dx = ux * length * scale;
    dy = uy * length * scale;
  }
  return { dx, dy };
}

function ringBase(_cardWidth: number): { rx: number; ry: number } {
  return { rx: RING_BASE_RX, ry: RING_BASE_RY };
}
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

/* A galaxy is not a compass rose. Instances get a base rotation off the
   cardinal axes plus a deterministic per-instance nudge, so four peers
   never land exactly N/E/S/W at exactly 90 degrees apart. */
const GALAXY_BASE_ROTATION = 0.22;
/** Max angular nudge either way, in radians (~7.5 degrees). */
const GALAXY_ANGLE_JITTER = 0.13;
/** Max outward-only radius nudge. Outward-only so ring clearance holds. */
const GALAXY_RADIUS_JITTER = 0.12;

/**
 * Stable [0,1) from an instance id. Deterministic so a body does not hop
 * to a new spot on every render or reconnect.
 */
function instanceNoise(instanceId: string, salt: number): number {
  let hash = 0x811c9dc5 ^ salt;
  for (let index = 0; index < instanceId.length; index += 1) {
    hash ^= instanceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

/* Arm shape. The angular sweep is mostly back-loaded: a small linear term
   gives the line a visible lean as it leaves the body, and the quintic-ish
   term makes it bend hard only as it nears the hub. */
const ARM_SWEEP = -0.62;
const ARM_LINEAR_SHARE = 0.25;
const ARM_EASE_POWER = 2.5;
const ARM_SAMPLES = 28;

/**
 * A sweeping spiral-arm path from an instance in to the hub, the way a
 * transfer orbit falls inward rather than a straight tether.
 *
 * Polar around the hub: radius shrinks linearly while the angle sweeps by
 * `ARM_SWEEP`, weighted so most of the turn happens near the centre. For a
 * body in the lower-right quadrant that reads as the line leaving toward
 * the N/NW, drifting gently upward, then curving hard into the gateway.
 */
export function galaxyArmPath(
  from: { x: number; y: number },
  hub: { x: number; y: number },
): string {
  const dx = from.x - hub.x;
  const dy = from.y - hub.y;
  const radius = Math.hypot(dx, dy);
  if (radius < 1) return `M ${from.x} ${from.y} L ${hub.x} ${hub.y}`;
  const startAngle = Math.atan2(dy, dx);

  const points: string[] = [];
  for (let step = 0; step <= ARM_SAMPLES; step += 1) {
    const t = step / ARM_SAMPLES;
    const sweep =
      ARM_SWEEP
      * (ARM_LINEAR_SHARE * t
        + (1 - ARM_LINEAR_SHARE) * Math.pow(t, ARM_EASE_POWER));
    const r = radius * (1 - t);
    const angle = startAngle + sweep;
    const x = hub.x + Math.cos(angle) * r;
    const y = hub.y + Math.sin(angle) * r;
    points.push(`${step === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return points.join(" ");
}

export type CardRing = { rx: number; ry: number; capacity: number };

function ringAt(index: number, cardWidth: number): CardRing {
  const base = ringBase(cardWidth);
  const rx = base.rx + index * RING_STEP_RX;
  const ry = base.ry + index * RING_STEP_RY;
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
/** Radius an instance claims when it has no cards at all — its own body. */
const EMPTY_INSTANCE_EXTENT = 70;

export function cardRingExtent(
  count: number,
  cardWidth: number,
): { rx: number; ry: number } {
  // An instance with nothing to show claims only its body. `cardRings`
  // always returns at least one ring so a lone card has somewhere to sit;
  // charging an empty instance for that phantom ring pushed every other
  // body a full ring-width further out and left a void around the hub.
  if (count <= 0) {
    return { rx: EMPTY_INSTANCE_EXTENT, ry: EMPTY_INSTANCE_EXTENT };
  }
  // Half-extent of the DRAWN cloud, cards included — measured from the
  // placed slots rather than the bare rings. Keep-out relief pushes some
  // slots outside their ring, and slots hold card centres, so a caller
  // spacing bodies on ring radii alone would let real cards collide.
  let rx = 0;
  let ry = 0;
  for (const slot of cardRingSlots(count, cardWidth)) {
    rx = Math.max(rx, Math.abs(slot.dx) + cardWidth / 2);
    ry = Math.max(ry, Math.abs(slot.dy) + CARD_HALF_HEIGHT);
  }
  return { rx, ry };
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
      slots.push(
        pushOutOfKeepout(
          {
            dx: Math.cos(angle) * ring.rx,
            dy: Math.sin(angle) * ring.ry,
          },
          cardWidth,
        ),
      );
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
  /**
   * Measured half-extent of an instance's drawn cloud, when the caller
   * lays cards out itself (the project-cluster clouds). Instances without
   * an entry fall back to the ring extent their card count implies.
   */
  extents?: ReadonlyMap<string, { rx: number; ry: number }>;
}): OrbitPlacement {
  const root = params.nodes.find((node) => node.depth === 0);
  if (!root) {
    return { instances: [], links: [], canvasWidth: 0, canvasHeight: 0 };
  }
  const extentFor = (instanceId: string) =>
    params.extents?.get(instanceId)
    ?? cardRingExtent(params.cardCounts.get(instanceId) ?? 0, params.cardWidth);
  const radiusFor = (instanceId: string) => extentFor(instanceId).rx;

  const raw = new Map<string, { x: number; y: number }>();
  raw.set(root.instanceId, { x: 0, y: 0 });

  const children = params.nodes
    .filter((node) => node.parentId === root.instanceId)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));

  // Space children so the widest pair of adjacent card rings still clears.
  const widestChildRing = children.reduce(
    (widest, node) => Math.max(widest, radiusFor(node.instanceId)),
    ringBase(params.cardWidth).rx,
  );
  const ringRadius = Math.max(
    INSTANCE_RING_MIN_RADIUS,
    radiusFor(root.instanceId) + widestChildRing + 80,
    children.length > 1
      ? (children.length * (widestChildRing * 2 + 60)) / (2 * Math.PI)
      : 0,
  );

  children.forEach((node, index) => {
    const even = -Math.PI / 2 + (index * 2 * Math.PI) / children.length;
    const angle =
      even
      + GALAXY_BASE_ROTATION
      + (instanceNoise(node.instanceId, 1) * 2 - 1) * GALAXY_ANGLE_JITTER;
    // Outward-only so the clearance computed above still holds.
    const radius =
      ringRadius
      * (1 + instanceNoise(node.instanceId, 2) * GALAXY_RADIUS_JITTER);
    raw.set(node.instanceId, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
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
 *
 * `.star-map-card-shell` is listed explicitly because a thread card is no
 * longer one big `<button>`: its open-thread button, kebab, and chips are
 * siblings inside a plain container (see StarMapThreadCard), so the card's
 * padding and the gaps between chips match none of the element selectors.
 * The shell is the whole card's drag target, so pressing anywhere on it
 * must never fall through to a canvas pan.
 *
 * Naming the shell also captures `.star-map-card__watermark`, which used
 * to match nothing here and so started a pan. It is the card's own mark
 * and overhangs the card's top-right corner, so dragging the card from it
 * is the right behaviour — but it is a change, not just a port.
 */
export function shouldStartCanvasPan(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !target.closest(
    "button, a, input, label, .star-map-card-shell, .star-map__chrome, .star-map__filters",
  );
}
