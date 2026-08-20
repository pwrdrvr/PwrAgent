import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import {
  STAR_MAP_ESTIMATED_CARD_HEIGHT,
  type StarMapCardSlot,
} from "./star-map-layout";
import { STAR_MAP_INSTANCE_KEEPOUT } from "./star-map-orbit";
import {
  STAR_MAP_NO_PROJECT_KEY,
  threadProjectKey,
  threadProjectLabel,
} from "./star-map-projects";

/**
 * Project clouds for the orbit lens.
 *
 * A flat ring seats cards purely by sort index, so two projects with
 * interleaved activity times provably alternate around the ring. Instead,
 * an instance's cards group into clouds — a nebula smudge under a loose
 * ring scatter of cards, not an outlined grid:
 *
 * - each parent thread with children present becomes its own cloud, the
 *   parent in the middle and its children orbiting it;
 * - the rest of a project pools into that project's catch-all cloud;
 * - every scratch checkout collapses into ONE "Workspaces" cloud via the
 *   shared directory classifier, instead of a hash-named body per chat.
 *
 * Each cloud caps what it shows by default and carries a working "+N
 * more" chip. There is deliberately NO cross-cloud budget: allocating a
 * fixed instance-wide card budget in mass order starved every later
 * cloud to zero cards and made expansion a no-op — the exact failure an
 * honest overflow chip exists to prevent.
 */

/**
 * Default visible cards per cloud. Small enough that several clouds fit
 * around one body; the per-cloud "+N more" chip expands past it.
 */
export const ORBIT_MAX_CARDS_PER_GROUP = 8;

/** Cards may shingle slightly on a ring; hover raises the one under the
 * pointer, and the overlap is what makes the scatter read as a cloud
 * rather than a grid. */
const RING_PACKING = 0.82;
/**
 * Ring radii are sized from a nominal card height rather than the tallest
 * card currently in the cloud: a card's real height then only ever moves
 * that card, and a tall arrival cannot push the whole cloud outward.
 */
const NOMINAL_CARD_HEIGHT = STAR_MAP_ESTIMATED_CARD_HEIGHT;
/** Extra x-radius on ring 1 so it clears the centre card. */
const RING_BASE_RX_FACTOR = 1.05;
const RING_STEP_RX_FACTOR = 1.0;
const RING_BASE_RY_PAD = 26;
const RING_STEP_RY_PAD = 20;
/** Max angular jitter as a share of a slot's angular pitch. */
const JITTER_ANGLE_SHARE = 0.35;
/** Max outward-only radial jitter. */
const JITTER_RADIUS_SHARE = 0.12;
/** Breathing room the cloud claims past its outermost card. */
const CLOUD_EXTENT_PAD = 26;
/** Vertical room above/below the cards for the label and the chip. */
const CLOUD_LABEL_ROOM = 30;
const CLOUD_CHIP_ROOM = 30;

/** Clearance between two clouds' extents when seating. */
const CLUSTER_GAP = 56;
/** Clearance between a cloud and the instance's own chrome. */
const KEEPOUT_GAP = 18;
/** First radius probed when seating a cloud around the body. */
const SEAT_BASE_RADIUS = 170;
const SEAT_RADIUS_STEP = 26;
const SEAT_MAX_PROBES = 240;
/** Clouds are wide and short-ish, so seating stretches horizontally. */
const SEAT_ASPECT_X = 1.3;
/** Directions tried around a cloud that is re-fitting into a new size. */
const REFIT_BEARINGS = 16;

export type StarMapClusterSpec = {
  /** Stable identity: project key, or `${projectKey}::pc:${parentKey}`. */
  key: string;
  /** Project name for catch-all clouds; the parent's title otherwise. */
  label: string;
  /** False only for the pooled no-project cloud. */
  isProject: boolean;
  /** Set when this cloud is one parent thread and its descendants. */
  isParentGroup: boolean;
  /** Full ordered membership; the first `visibleCount` render. */
  threads: NavigationThreadSummary[];
  visibleCount: number;
  overflow: number;
  expanded: boolean;
  /** Whether the expand chip has anything to do. */
  expandable: boolean;
};

export type StarMapClusterPlacement = StarMapClusterSpec & {
  /** Cloud centre, body-relative. */
  center: { x: number; y: number };
  /** Half-extent of the drawn cards around the centre. */
  extent: { rx: number; ry: number };
  /** Per visible card: dx = centre x, dy = top y, body-relative. */
  slots: StarMapCardSlot[];
  /** Centre of the floating label, body-relative. */
  labelSlot: StarMapCardSlot;
  /** Centre of the overflow chip, when the cloud shows one. */
  overflowSlot?: StarMapCardSlot;
  /**
   * A lone card needs no nebula, no label, no chip — it just floats.
   * Twenty one-thread clouds wearing full chrome is how the map turned
   * into a spreadsheet.
   */
  chromeless: boolean;
};

export type StarMapClusterCloud = {
  clusters: StarMapClusterPlacement[];
  /** Flat visible threads across every cloud, in draw order. */
  threads: NavigationThreadSummary[];
  /** Flat slots aligned with `threads`. */
  slots: StarMapCardSlot[];
  heights: number[];
  /** Cluster index per flat card. */
  clusterIndexByCard: number[];
  /** Half-extent of the whole drawn cloud set, for instance spacing. */
  extent: { rx: number; ry: number };
  /** Feed back into the next layout to keep everything where it is. */
  memory: StarMapCloudMemory;
};

function threadKeyOf(thread: NavigationThreadSummary): string {
  return buildThreadIdentityKey(thread.source, thread.id);
}

function parentKeyOf(thread: NavigationThreadSummary): string | undefined {
  if (!thread.parentThreadId) return undefined;
  return buildThreadIdentityKey(
    thread.parentThreadBackend ?? thread.source,
    thread.parentThreadId,
  );
}

/** Stable [0,1) from a string, for deterministic willy-nilly. */
function noise(value: string, salt: number): number {
  let hash = 0x811c9dc5 ^ salt;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

/**
 * Reorder a cloud so children sit directly after their parent (DFS), for
 * the clouds that still mix relationships (a catch-all holding an orphan
 * chain). Cycle members fall back to their original position.
 */
export function orderParentAdjacent(
  threads: readonly NavigationThreadSummary[],
): NavigationThreadSummary[] {
  const present = new Set(threads.map(threadKeyOf));
  const childrenOf = new Map<string, NavigationThreadSummary[]>();
  const roots: NavigationThreadSummary[] = [];
  for (const thread of threads) {
    const parentKey = parentKeyOf(thread);
    if (
      parentKey !== undefined
      && parentKey !== threadKeyOf(thread)
      && present.has(parentKey)
    ) {
      const siblings = childrenOf.get(parentKey);
      if (siblings) siblings.push(thread);
      else childrenOf.set(parentKey, [thread]);
    } else {
      roots.push(thread);
    }
  }
  const ordered: NavigationThreadSummary[] = [];
  const emitted = new Set<string>();
  const visit = (thread: NavigationThreadSummary) => {
    const key = threadKeyOf(thread);
    if (emitted.has(key)) return;
    emitted.add(key);
    ordered.push(thread);
    for (const child of childrenOf.get(key) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  for (const thread of threads) {
    if (!emitted.has(threadKeyOf(thread))) {
      emitted.add(threadKeyOf(thread));
      ordered.push(thread);
    }
  }
  return ordered;
}

/**
 * Group one instance's filtered threads into capped clouds.
 *
 * Buckets come from the shared directory classifier (via
 * `threadProjectKey`), so every scratch checkout pools into one
 * "Workspaces" cloud. Within a bucket, each root parent that has
 * children present splits out into its own parent/child cloud (parent
 * first, descendants in DFS order); the remainder stays in the bucket's
 * catch-all. Clouds order by their stable key, NOT by activity: seat
 * angles derive from this order, and a mass ordering re-seated every
 * cloud whenever recency shifted — hand-arranged cards teleporting
 * because some other project got busier.
 */
export function buildInstanceClusters(params: {
  threads: readonly NavigationThreadSummary[];
  /** Cluster keys the operator expanded past the per-group cap. */
  expandedKeys?: ReadonlySet<string>;
}): StarMapClusterSpec[] {
  const buckets = new Map<string, NavigationThreadSummary[]>();
  for (const thread of params.threads) {
    const key = threadProjectKey(thread);
    const members = buckets.get(key);
    if (members) members.push(thread);
    else buckets.set(key, [thread]);
  }

  type Draft = {
    key: string;
    label: string;
    isProject: boolean;
    isParentGroup: boolean;
    threads: NavigationThreadSummary[];
  };
  const drafts: Draft[] = [];

  for (const [bucketKey, members] of buckets) {
    const ordered = orderParentAdjacent(members);
    const present = new Set(members.map(threadKeyOf));
    const isProject = bucketKey !== STAR_MAP_NO_PROJECT_KEY;
    const bucketLabel = threadProjectLabel(members[0]);

    // Root parents: threads with children in this bucket whose own
    // parent is absent (or self/cyclic). `ordered` is DFS, so a root's
    // descendants follow it contiguously — collect until the next root.
    const hasChildren = new Set<string>();
    for (const thread of members) {
      const parentKey = parentKeyOf(thread);
      if (
        parentKey !== undefined
        && parentKey !== threadKeyOf(thread)
        && present.has(parentKey)
      ) {
        hasChildren.add(parentKey);
      }
    }
    const isRoot = (thread: NavigationThreadSummary) => {
      const parentKey = parentKeyOf(thread);
      return (
        parentKey === undefined
        || parentKey === threadKeyOf(thread)
        || !present.has(parentKey)
      );
    };

    const rest: NavigationThreadSummary[] = [];
    let index = 0;
    while (index < ordered.length) {
      const thread = ordered[index];
      if (isRoot(thread) && hasChildren.has(threadKeyOf(thread))) {
        const group: NavigationThreadSummary[] = [thread];
        index += 1;
        while (index < ordered.length && !isRoot(ordered[index])) {
          group.push(ordered[index]);
          index += 1;
        }
        drafts.push({
          key: `${bucketKey}::pc:${threadKeyOf(thread)}`,
          label: thread.title,
          isProject,
          isParentGroup: true,
          threads: group,
        });
        continue;
      }
      rest.push(thread);
      index += 1;
    }
    if (rest.length > 0) {
      drafts.push({
        key: bucketKey,
        label: bucketLabel,
        isProject,
        isParentGroup: false,
        threads: rest,
      });
    }
  }

  drafts.sort((left, right) => left.key.localeCompare(right.key));

  return drafts.map((draft) => {
    const expanded = params.expandedKeys?.has(draft.key) ?? false;
    const visibleCount = expanded
      ? draft.threads.length
      : Math.min(draft.threads.length, ORBIT_MAX_CARDS_PER_GROUP);
    return {
      key: draft.key,
      label: draft.label,
      isProject: draft.isProject,
      isParentGroup: draft.isParentGroup,
      threads: draft.threads,
      visibleCount,
      overflow: draft.threads.length - visibleCount,
      expanded,
      expandable: draft.threads.length > ORBIT_MAX_CARDS_PER_GROUP,
    };
  });
}

/**
 * Where a cloud's cards and bodies were put last time.
 *
 * The layout is incremental, not a pure function of the current set, and
 * that is the whole point: archiving one thread must remove one card and
 * change NOTHING else. A set-derived layout cannot do that — every card's
 * seat came from its index in the visible list, every cloud's extent from
 * its occupied seats, and every cloud's centre from packing those extents,
 * so one departure rippled through all three.
 *
 * So seats are remembered per thread, ring allocation only grows, and a
 * cloud keeps the centre it was given. A new thread takes the lowest free
 * seat; a new cloud is seated around what is already placed. Nothing that
 * was already on screen moves unless the operator asks for it — and even
 * then only what they asked for: expand and collapse drop that cloud's
 * ring allocation alone (see `refitCluster`), so it grows and shrinks
 * around the centre and the seats it already has.
 */
export type StarMapCloudMemory = {
  /** Cloud centre per cluster key, body-relative. */
  centers: Map<string, { x: number; y: number }>;
  /** Seat index per thread, per cluster key. */
  seats: Map<string, Map<string, number>>;
  /** Rings allocated per cluster key. Grows; never shrinks on its own. */
  rings: Map<string, number>;
};

export function emptyCloudMemory(): StarMapCloudMemory {
  return { centers: new Map(), seats: new Map(), rings: new Map() };
}

/**
 * Let one cloud re-fit its rings, in place.
 *
 * Only the ring allocation goes. Rings are grow-only (see
 * `computeClusterCloud`), so without this a cloud the operator collapses
 * would keep the radius its expanded cards needed — a ring of empty space
 * where the cards used to be.
 *
 * The centre and the seats stay, on purpose. Dropping them made the cloud
 * an arrival again, and an arrival is seated from the base radius outward
 * along its own bearing — so expanding a cloud teleported it across the
 * map, and collapsing it teleported it somewhere else again, while the
 * cards that were still on screen shuffled into different seats. Keeping
 * both means an expand grows the cloud outward around the centre it
 * already has, a collapse pulls it back in, and every card that stays
 * visible stays exactly where the operator last saw it. If the grown
 * cloud lands on a neighbour, `computeClusterCloud` re-seats it then —
 * the cloud that changed is still the one that moves.
 */
export function refitCluster(
  memory: StarMapCloudMemory,
  clusterKey: string,
): StarMapCloudMemory {
  if (!memory.rings.has(clusterKey)) return memory;
  const rings = new Map(memory.rings);
  rings.delete(clusterKey);
  // Centres and seats carry through by reference: a layout reads its
  // memory and returns fresh maps, it never writes back into this one.
  return { centers: memory.centers, seats: memory.seats, rings };
}

/**
 * Ring geometry for one ring index, in cloud-local pixels.
 *
 * Capacity is fixed per ring — derived from the ring's circumference and
 * the card width alone — so seat N always lands at the same angle no
 * matter how many cards the cloud currently holds. Deriving the angular
 * pitch from the member count instead is what made every card in a cloud
 * shuffle when one of them left.
 */
function ringGeometry(
  ring: number,
  cardWidth: number,
): { rx: number; ry: number; capacity: number } {
  const rx =
    cardWidth * (RING_BASE_RX_FACTOR + (ring - 1) * RING_STEP_RX_FACTOR);
  const ry =
    NOMINAL_CARD_HEIGHT
    + RING_BASE_RY_PAD
    + (ring - 1) * (NOMINAL_CARD_HEIGHT + RING_STEP_RY_PAD);
  return {
    rx,
    ry,
    capacity: Math.max(
      4,
      Math.floor((2 * Math.PI * rx) / (cardWidth * RING_PACKING)),
    ),
  };
}

/** Which ring a seat sits on, and where around it. Seat 0 is the centre. */
function seatAddress(
  seat: number,
  cardWidth: number,
): { ring: number; position: number; capacity: number } {
  if (seat <= 0) return { ring: 0, position: 0, capacity: 1 };
  let remaining = seat - 1;
  let ring = 1;
  // Bounded by the seat index: each ring seats at least four cards.
  for (;;) {
    const { capacity } = ringGeometry(ring, cardWidth);
    if (remaining < capacity) return { ring, position: remaining, capacity };
    remaining -= capacity;
    ring += 1;
  }
}

/**
 * Where a seat's card sits, cloud-local. `dy` is the card's TOP edge, so
 * a card's own height only ever moves that card.
 */
function seatSlot(params: {
  seat: number;
  cardWidth: number;
  clusterKey: string;
  threadKey: string;
  height: number;
}): StarMapCardSlot {
  const address = seatAddress(params.seat, params.cardWidth);
  if (address.ring === 0) return { dx: 0, dy: -params.height / 2 };
  const ring = ringGeometry(address.ring, params.cardWidth);
  // The cloud leans a little as a whole, so no two clouds start their
  // rings on the same bearing.
  const baseAngle =
    Math.PI / 2 + (noise(params.clusterKey, 3) * 2 - 1) * 0.7;
  const pitch = (2 * Math.PI) / address.capacity;
  const angle =
    baseAngle
    + address.position * pitch
    + (address.ring % 2 === 1 ? 0 : pitch / 2)
    + (noise(params.threadKey, 5) * 2 - 1) * pitch * JITTER_ANGLE_SHARE;
  const reach = 1 + noise(params.threadKey, 7) * JITTER_RADIUS_SHARE;
  return {
    dx: Math.cos(angle) * ring.rx * reach,
    dy: Math.sin(angle) * ring.ry * reach - params.height / 2,
  };
}

/**
 * Half-extent a cloud claims for its allocated rings. Derived from the
 * allocation rather than from the seats currently filled, so a card
 * leaving the outermost ring does not shrink the cloud and re-seat its
 * neighbours.
 */
function extentForRings(
  rings: number,
  cardWidth: number,
): { rx: number; ry: number } {
  if (rings <= 0) {
    return {
      rx: cardWidth / 2 + CLOUD_EXTENT_PAD,
      ry: NOMINAL_CARD_HEIGHT / 2 + CLOUD_EXTENT_PAD,
    };
  }
  const ring = ringGeometry(rings, cardWidth);
  const reach = 1 + JITTER_RADIUS_SHARE;
  return {
    rx: ring.rx * reach + cardWidth / 2 + CLOUD_EXTENT_PAD,
    ry: ring.ry * reach + NOMINAL_CARD_HEIGHT / 2 + CLOUD_EXTENT_PAD,
  };
}

/**
 * Seat assignment for one cloud: everyone who was here keeps their seat,
 * and arrivals take the lowest free one.
 */
function assignSeats(params: {
  visible: readonly NavigationThreadSummary[];
  previous?: Map<string, number>;
}): Map<string, number> {
  const seats = new Map<string, number>();
  const taken = new Set<number>();
  for (const thread of params.visible) {
    const key = threadKeyOf(thread);
    const prior = params.previous?.get(key);
    if (prior !== undefined && !taken.has(prior)) {
      seats.set(key, prior);
      taken.add(prior);
    }
  }
  let cursor = 0;
  for (const thread of params.visible) {
    const key = threadKeyOf(thread);
    if (seats.has(key)) continue;
    while (taken.has(cursor)) cursor += 1;
    seats.set(key, cursor);
    taken.add(cursor);
  }
  return seats;
}

type Box = { x: number; y: number; width: number; height: number };

function boxesOverlap(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap
    && b.x < a.x + a.width + gap
    && a.y < b.y + b.height + gap
    && b.y < a.y + a.height + gap
  );
}

const KEEPOUT_BOX: Box = {
  x: -STAR_MAP_INSTANCE_KEEPOUT.halfWidth,
  y: -STAR_MAP_INSTANCE_KEEPOUT.above,
  width: STAR_MAP_INSTANCE_KEEPOUT.halfWidth * 2,
  height: STAR_MAP_INSTANCE_KEEPOUT.above + STAR_MAP_INSTANCE_KEEPOUT.below,
};

function boxFor(
  center: { x: number; y: number },
  extent: { rx: number; ry: number },
): Box {
  return {
    x: center.x - extent.rx,
    y: center.y - extent.ry - CLOUD_LABEL_ROOM,
    width: extent.rx * 2,
    height: extent.ry * 2 + CLOUD_LABEL_ROOM + CLOUD_CHIP_ROOM,
  };
}

function isClear(box: Box, placed: readonly Box[]): boolean {
  return (
    !boxesOverlap(box, KEEPOUT_BOX, KEEPOUT_GAP)
    && placed.every((other) => !boxesOverlap(box, other, CLUSTER_GAP))
  );
}

/**
 * Seat one cloud on its own bearing, walking outward until it clears the
 * instance's chrome and everything already placed. The bearing comes from
 * the cluster key rather than its position in the list, so a cloud that
 * disappears does not rotate its neighbours.
 */
function seatCluster(params: {
  key: string;
  extent: { rx: number; ry: number };
  placed: readonly Box[];
}): { x: number; y: number } {
  const angle = noise(params.key, 11) * 2 * Math.PI;
  let radius = SEAT_BASE_RADIUS;
  let center = { x: 0, y: 0 };
  for (let probe = 0; probe < SEAT_MAX_PROBES; probe += 1) {
    center = {
      x: Math.cos(angle) * radius * SEAT_ASPECT_X,
      y: Math.sin(angle) * radius,
    };
    if (isClear(boxFor(center, params.extent), params.placed)) break;
    radius += SEAT_RADIUS_STEP;
  }
  return center;
}

/**
 * Re-seat a cloud that has outgrown the spot it is in, as near to that
 * spot as it can be put.
 *
 * A cloud the operator has been looking at is not a cloud to re-seat like
 * an arrival: seating one from the base radius outward along its key's
 * bearing sent an expanded cloud a screen and a half away, which is how
 * "+2 more" came to mean "and now find your threads again". Nor is walking
 * outward along that bearing enough on its own — the bearing is often
 * blocked by the very neighbour the growth ran into, and the cloud sails
 * past it just as far.
 *
 * So the search is around where the cloud already is: rings of increasing
 * radius, each swept from the outward bearing inwards to either side, and
 * the first clear spot wins. Sweeping outward-first keeps the natural
 * answer — a cloud grows away from the body — while allowing the sideways
 * step that a blocked bearing needs. The distance it moves is then bounded
 * by the room it actually needed, not by the map.
 */
function reseatCluster(params: {
  key: string;
  from: { x: number; y: number };
  extent: { rx: number; ry: number };
  placed: readonly Box[];
}): { x: number; y: number } {
  if (isClear(boxFor(params.from, params.extent), params.placed)) {
    return params.from;
  }
  const outward = Math.atan2(params.from.y, params.from.x / SEAT_ASPECT_X);
  for (let step = 1; step <= SEAT_MAX_PROBES; step += 1) {
    const radius = step * SEAT_RADIUS_STEP;
    for (let bearing = 0; bearing < REFIT_BEARINGS; bearing += 1) {
      // 0, +1, -1, +2, -2 … around the outward direction.
      const turn = Math.ceil(bearing / 2) * (bearing % 2 === 0 ? -1 : 1);
      const angle = outward + (turn * 2 * Math.PI) / REFIT_BEARINGS;
      const center = {
        x: params.from.x + Math.cos(angle) * radius * SEAT_ASPECT_X,
        y: params.from.y + Math.sin(angle) * radius,
      };
      if (isClear(boxFor(center, params.extent), params.placed)) return center;
    }
  }
  // Nowhere within reach of where it stands: fall back to the arrival
  // walk, which is guaranteed to leave the instance's chrome behind.
  return seatCluster({
    extent: params.extent,
    key: params.key,
    placed: params.placed,
  });
}

/** Extent an instance claims when its clouds are empty — its own body. */
const EMPTY_CLOUD_EXTENT = 70;

/**
 * Lay out one instance's clouds and flatten them for rendering.
 *
 * Pure: the previous layout arrives as `memory` and the next one is
 * returned, so the caller owns the continuity and the function stays
 * testable. See `StarMapCloudMemory` for why the layout is incremental.
 *
 * The flat `threads`/`slots`/`heights` triple is what the screen's lane
 * plumbing already speaks (index-aligned, slot dy = card top), so cloud
 * membership rides alongside instead of reshaping every consumer.
 */
export function computeClusterCloud(params: {
  clusters: readonly StarMapClusterSpec[];
  cardWidth: number;
  heightForThread: (threadKey: string) => number;
  memory?: StarMapCloudMemory;
}): StarMapClusterCloud {
  const previous = params.memory ?? emptyCloudMemory();
  const nextSeats = new Map<string, Map<string, number>>();
  const nextRings = new Map<string, number>();
  const nextCenters = new Map<string, { x: number; y: number }>();

  const sized = params.clusters.map((spec) => {
    const visible = spec.threads.slice(0, spec.visibleCount);
    const seats = assignSeats({
      visible,
      previous: previous.seats.get(spec.key),
    });
    nextSeats.set(spec.key, seats);
    const highestSeat = [...seats.values()].reduce(
      (top, seat) => Math.max(top, seat),
      -1,
    );
    const needed =
      highestSeat < 0 ? 0 : seatAddress(highestSeat, params.cardWidth).ring;
    // Grow-only: an outermost card leaving must not pull the cloud in and
    // shove its neighbours around. Collapsing the cloud is the operator's
    // call and drops this one entry (see `refitCluster`).
    const rings = Math.max(needed, previous.rings.get(spec.key) ?? 0);
    nextRings.set(spec.key, rings);
    return {
      spec,
      seats,
      slots: visible.map((thread) =>
        seatSlot({
          cardWidth: params.cardWidth,
          clusterKey: spec.key,
          height: params.heightForThread(threadKeyOf(thread)),
          seat: seats.get(threadKeyOf(thread)) ?? 0,
          threadKey: threadKeyOf(thread),
        }),
      ),
      extent: extentForRings(rings, params.cardWidth),
      visible,
    };
  });

  // Retained clouds keep their centre; only clouds that are new — or that
  // grew into a neighbour — are seated. Deterministic order so a fresh map
  // lays out the same way twice.
  const placed: Box[] = [];
  const retained = sized.filter((cluster) =>
    previous.centers.has(cluster.spec.key),
  );
  const arrivals = sized.filter(
    (cluster) => !previous.centers.has(cluster.spec.key),
  );
  const reseat: typeof sized = [];
  for (const cluster of retained) {
    const center = previous.centers.get(cluster.spec.key)!;
    const box = boxFor(center, cluster.extent);
    if (isClear(box, placed)) {
      nextCenters.set(cluster.spec.key, center);
      placed.push(box);
    } else {
      // It outgrew its seat. The cloud that changed is the one that moves.
      reseat.push(cluster);
    }
  }
  const lonely =
    sized.length === 1 && previous.centers.size === 0 ? sized[0] : undefined;
  for (const cluster of [...reseat, ...arrivals]) {
    // A cloud that was already somewhere is re-fitted near where it
    // stands; a new one is seated on its own bearing.
    const held = previous.centers.get(cluster.spec.key);
    const center =
      cluster === lonely
        ? {
            // A lone cloud hangs under the body, where a lane would put it.
            x: 0,
            y:
              STAR_MAP_INSTANCE_KEEPOUT.below
              + KEEPOUT_GAP
              + CLOUD_LABEL_ROOM
              + cluster.extent.ry,
          }
        : held
          ? reseatCluster({
              extent: cluster.extent,
              from: held,
              key: cluster.spec.key,
              placed,
            })
          : seatCluster({
              extent: cluster.extent,
              key: cluster.spec.key,
              placed,
            });
    nextCenters.set(cluster.spec.key, center);
    placed.push(boxFor(center, cluster.extent));
  }

  const clusters: StarMapClusterPlacement[] = [];
  const threads: NavigationThreadSummary[] = [];
  const slots: StarMapCardSlot[] = [];
  const heights: number[] = [];
  const clusterIndexByCard: number[] = [];
  let rx = EMPTY_CLOUD_EXTENT;
  let ry = EMPTY_CLOUD_EXTENT;

  sized.forEach((cluster, index) => {
    const center = nextCenters.get(cluster.spec.key)!;
    const bodySlots = cluster.slots.map((slot) => ({
      dx: center.x + slot.dx,
      dy: center.y + slot.dy,
    }));
    cluster.visible.forEach((thread, cardIndex) => {
      threads.push(thread);
      slots.push(bodySlots[cardIndex]);
      heights.push(params.heightForThread(threadKeyOf(thread)));
      clusterIndexByCard.push(index);
    });
    const chromeless =
      cluster.spec.threads.length === 1
      || (sized.length === 1 && !cluster.spec.isProject);
    const showChip =
      cluster.spec.overflow > 0
      || (cluster.spec.expanded && cluster.spec.expandable);
    clusters.push({
      ...cluster.spec,
      center,
      extent: cluster.extent,
      slots: bodySlots,
      labelSlot: {
        dx: center.x,
        dy: center.y - cluster.extent.ry - CLOUD_LABEL_ROOM / 2,
      },
      overflowSlot: showChip
        ? {
            dx: center.x,
            dy: center.y + cluster.extent.ry + CLOUD_CHIP_ROOM / 2,
          }
        : undefined,
      chromeless,
    });
    rx = Math.max(rx, Math.abs(center.x) + cluster.extent.rx);
    ry = Math.max(
      ry,
      Math.abs(center.y)
        + cluster.extent.ry
        + CLOUD_LABEL_ROOM
        + CLOUD_CHIP_ROOM,
    );
  });

  return {
    clusters,
    threads,
    slots,
    heights,
    clusterIndexByCard,
    extent: { rx, ry },
    memory: { centers: nextCenters, rings: nextRings, seats: nextSeats },
  };
}

export type StarMapCloudDrop =
  /** Nothing to do: same cloud, a project cloud, or an illegal parent. */
  | { kind: "none" }
  /** Make the dragged thread a child of this cloud's parent. */
  | { kind: "adopt"; clusterKey: string; parent: NavigationThreadSummary }
  /** Take the dragged thread out of the parent cloud it was in. */
  | { kind: "release"; clusterKey: string };

/** Which cloud, if any, a point falls inside. */
function clusterAt(
  clusters: readonly StarMapClusterPlacement[],
  point: { x: number; y: number },
): StarMapClusterPlacement | undefined {
  return clusters.find(
    (cluster) =>
      Math.abs(point.x - cluster.center.x) <= cluster.extent.rx
      && Math.abs(point.y - cluster.center.y) <= cluster.extent.ry,
  );
}

/**
 * What dropping a card at this point means.
 *
 * Cloud membership is DERIVED, not stored, so a drop can only change it
 * by changing the data the grouping reads — and the two kinds of cloud
 * read very different data:
 *
 * - A parent/child cloud groups on `parentThreadId`, which the contract
 *   calls a UI-only relationship that "only controls sidebar grouping".
 *   Re-parenting on a drop is safe, reversible, and means exactly what
 *   the gesture looks like it means.
 * - A project cloud groups on the thread's linked directory — its actual
 *   workspace, where its commands run and its worktree lives. A drag
 *   must never silently relink that, so dropping on one moves the card
 *   and changes nothing else.
 *
 * Dropping a child back on its own project's catch-all cloud releases
 * it, which is the inverse gesture and the only way out that does not
 * require finding the thread in the sidebar.
 */
export function resolveCloudDrop(params: {
  clusters: readonly StarMapClusterPlacement[];
  /** Centre of the dropped card, body-relative. */
  point: { x: number; y: number };
  thread: NavigationThreadSummary;
}): StarMapCloudDrop {
  const draggedKey = threadKeyOf(params.thread);
  const target = clusterAt(params.clusters, params.point);
  if (!target) return { kind: "none" };

  const home = params.clusters.find((cluster) =>
    cluster.threads.some((thread) => threadKeyOf(thread) === draggedKey),
  );
  if (target.key === home?.key) return { kind: "none" };

  if (!target.isParentGroup) {
    // Only a release, and only out of a parent cloud into the catch-all
    // of the project the thread already belongs to. Any other landing is
    // a project change, which a drag does not get to make.
    const sameProject =
      home?.isParentGroup === true && home.key.startsWith(`${target.key}::pc:`);
    return sameProject && params.thread.parentThreadId !== undefined
      ? { kind: "release", clusterKey: target.key }
      : { kind: "none" };
  }

  const parent = target.threads[0];
  if (!parent || threadKeyOf(parent) === draggedKey) return { kind: "none" };

  // A thread cannot be adopted by its own descendant: walking up from the
  // candidate would come back around to the card being dragged, and the
  // grouping would fold in on itself.
  const byKey = new Map<string, NavigationThreadSummary>();
  for (const cluster of params.clusters) {
    for (const thread of cluster.threads) byKey.set(threadKeyOf(thread), thread);
  }
  const seen = new Set<string>();
  let walk: NavigationThreadSummary | undefined = parent;
  while (walk) {
    const key = threadKeyOf(walk);
    if (key === draggedKey) return { kind: "none" };
    if (seen.has(key)) break;
    seen.add(key);
    const parentKey = parentKeyOf(walk);
    walk = parentKey ? byKey.get(parentKey) : undefined;
  }

  return { kind: "adopt", clusterKey: target.key, parent };
}
