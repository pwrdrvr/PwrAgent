import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
  type NavigationDirectoryRow,
} from "@pwragent/shared";
import {
  STAR_MAP_ESTIMATED_CARD_HEIGHT,
  type StarMapCardSlot,
} from "./star-map-layout";
import { STAR_MAP_INSTANCE_KEEPOUT } from "./star-map-orbit";
import {
  STAR_MAP_NO_PROJECT_KEY,
  projectThreadOwner,
  starMapThreadKey,
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

/**
 * Default visible cards per cloud in the projects lens.
 *
 * Higher than the instances lens because the two lenses ask a different
 * question. An instance body is one machine and its clouds are a sampler
 * of everything on it; a project body IS the thing the operator came to
 * look at, and eight cards across a repository's whole history — pooled
 * from every machine it is checked out on — showed less than one screen
 * of that project's thread list. Twelve is a full page of ten plus room
 * to see there is more, and the "+N more" chip still opens the rest.
 */
export const PROJECT_MAX_CARDS_PER_GROUP = 12;

/**
 * Chrome a project body draws, as half-extents from its centre.
 *
 * A project is a label and a count, not a sun with a name pill and an
 * intake button, so its clouds pack in far tighter than an instance's.
 * Measured from `.star-map-project` in app.css: a 26px core over a 24px
 * label with a 6px gap, centred, so the box runs 28px either side of the
 * centre; the label caps at 190px plus its border, so 96px either side;
 * the action row is absolutely positioned at `bottom: calc(100% - 14px)`,
 * putting its 24px top edge 38px up. A few pixels of air on each figure.
 * Handing this body the instance's box instead is what threw a project's
 * clouds hundreds of pixels off their own name.
 */
export const STAR_MAP_PROJECT_KEEPOUT = {
  above: 42,
  below: 32,
  halfWidth: 100,
};

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

/**
 * Clearance between a card in one cloud and a card in another.
 *
 * Card-to-card, not cloud-to-cloud: clouds clear each other box by box
 * (see `seatRects`), so this is the visible gutter between two clouds'
 * nearest cards rather than a moat around whole rectangles. Cards inside
 * one cloud deliberately shingle (`RING_PACKING`); cards from different
 * clouds must not, or the two read as one.
 */
const CLUSTER_GAP = 24;
/** Clearance between a cloud and the instance's own chrome. */
const KEEPOUT_GAP = 18;
/** Air between a parent-group header card and the ring of its replies. */
const HEADER_GAP = 14;
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
  /** Complete compact membership, independent of hydrated cards. */
  totalCount?: number;
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
  return starMapThreadKey(thread);
}

function parentKeyOf(thread: NavigationThreadSummary): string | undefined {
  if (!thread.parentThreadId) return undefined;
  const key = buildThreadIdentityKey(
    thread.parentThreadBackend ?? thread.source,
    thread.parentThreadId,
  );
  const owner = projectThreadOwner(thread);
  return owner === undefined ? key : `${thread.parentThreadInstanceId ?? owner}::${key}`;
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
  descriptors?: readonly NavigationDirectoryRow[];
  /** Cluster keys the operator expanded past the per-group cap. */
  expandedKeys?: ReadonlySet<string>;
  /**
   * Pool every thread into one bucket under this identity, rather than
   * bucketing by the directory each thread sits in.
   *
   * The projects lens hands this the merged project. Its threads come
   * from every federated instance and from whatever path each machine
   * checked the repository out to, so `threadProjectKey` would split one
   * project into a bucket per machine — the duplicate names on the map.
   * The parent/child split below then runs inside that one bucket, which
   * is what gives a project its sub-clouds.
   */
  project?: { key: string; label: string; totalCount?: number };
  /** Cards one cloud shows before its "+N more" chip. */
  maxCardsPerGroup?: number;
}): StarMapClusterSpec[] {
  const maxCards = params.maxCardsPerGroup ?? ORBIT_MAX_CARDS_PER_GROUP;
  const descriptors = new Map(
    params.project
      ? []
      : params.descriptors?.map((descriptor) => [descriptor.key, descriptor]),
  );
  const buckets = new Map<string, NavigationThreadSummary[]>(
    params.project
      ? [[params.project.key, []]]
      : [...descriptors.keys()].map((key) => [key, []]),
  );
  for (const thread of params.threads) {
    const key = params.project?.key ?? threadProjectKey(thread);
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
    const descriptor = descriptors.get(bucketKey);
    const bucketLabel =
      params.project?.label ?? descriptor?.label ?? threadProjectLabel(members[0]);

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
    // A project always draws its catch-all, even when every thread landed
    // in a parent group: it is the cloud seated ON the body, and without
    // it the body's own seat would be handed to a sub-cloud.
    if (rest.length > 0 || descriptor || params.project) {
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
      : Math.min(draft.threads.length, maxCards);
    return {
      key: draft.key,
      label: draft.label,
      isProject: draft.isProject,
      isParentGroup: draft.isParentGroup,
      threads: draft.threads,
      visibleCount,
      totalCount: draft.isParentGroup ? draft.threads.length : Math.max(draft.threads.length,
        (descriptors.get(draft.key)?.counts.total ?? params.project?.totalCount ?? draft.threads.length)
          - drafts.filter((group) => group.isParentGroup && group.key.startsWith(`${draft.key}::pc:`))
            .reduce((sum, group) => sum + group.threads.length, 0)),
      overflow: draft.threads.length - visibleCount,
      expanded,
      expandable: draft.threads.length > maxCards,
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
 * So seats are remembered per thread, a cloud's extent only grows, and a
 * cloud keeps the centre it was given. A new thread takes the lowest free
 * seat; a new cloud is seated around what is already placed. Nothing that
 * was already on screen moves unless the operator asks for it — and even
 * then only what they asked for: expand and collapse drop that cloud's
 * grown extent alone (see `refitCluster`), so it grows and shrinks around
 * the centre and the seats it already has.
 */
export type StarMapCloudMemory = {
  /** Cloud centre per cluster key, body-relative. */
  centers: Map<string, { x: number; y: number }>;
  /** Seat index per thread, per cluster key. */
  seats: Map<string, Map<string, number>>;
  /**
   * Footprint per cluster key. Grows; never shrinks on its own.
   *
   * Replaced a ring count, which was too coarse a unit to be honest
   * about space: every cloud from two cards to eight claimed a whole
   * ring. See `seatRects`.
   */
  bounds: Map<string, CloudBounds>;
};

export function emptyCloudMemory(): StarMapCloudMemory {
  return { bounds: new Map(), centers: new Map(), seats: new Map() };
}

/**
 * Let one cloud re-fit its extent, in place.
 *
 * Only the grown extent goes. Extents are grow-only (see
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
  if (!memory.bounds.has(clusterKey)) return memory;
  const bounds = new Map(memory.bounds);
  bounds.delete(clusterKey);
  // Centres and seats carry through by reference: a layout reads its
  // memory and returns fresh maps, it never writes back into this one.
  return { bounds, centers: memory.centers, seats: memory.seats };
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
 * A cloud's footprint as signed offsets from its own centre.
 *
 * `left` and `top` are negative for anything above/left of the centre.
 * Asymmetric on purpose — see `boundsForSeats`.
 */
type CloudBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function padBounds(bounds: CloudBounds, pad: number): CloudBounds {
  return {
    left: bounds.left - pad,
    right: bounds.right + pad,
    top: bounds.top - pad,
    bottom: bounds.bottom + pad,
  };
}

/** Grow-only union: neither side of either axis ever comes back in. */
function unionBounds(left: CloudBounds, right: CloudBounds): CloudBounds {
  return {
    left: Math.min(left.left, right.left),
    right: Math.max(left.right, right.right),
    top: Math.min(left.top, right.top),
    bottom: Math.max(left.bottom, right.bottom),
  };
}

/**
 * The symmetric half-extent a cloud reports to its readers.
 *
 * Placement uses the asymmetric bounds; everything outside this module —
 * the nebula smudge, instance spacing, the project layout — still speaks
 * in a half-extent around the body, so the wider side wins.
 */
function extentOf(bounds: CloudBounds): { rx: number; ry: number } {
  return {
    rx: Math.max(-bounds.left, bounds.right),
    ry: Math.max(-bounds.top, bounds.bottom),
  };
}

/**
 * One box per seat: where that seat's card can land, cloud-local.
 *
 * A box per seat rather than one box for the cloud, because the cloud's
 * box is mostly nothing. A cloud is anchored at its centre and its cards
 * sit out on a ring, so a single box charges a three-card group for the
 * 537×470 rectangle that would hold a full ring — and two clouds then
 * cleared each other by the sum of two rectangles that were mostly empty.
 * That is what seated a project's parent/child sub-cloud 650px from the
 * body it belongs to: the "cards near their cloud, not in it" complaint,
 * drawn by the placement rather than by the seats. Clearing card against
 * card instead lets a small cloud nestle into the gaps between a bigger
 * one's ring cards, which is where it visually belongs.
 *
 * Each box is the seat's whole jitter envelope, not the drawn position:
 * the angular and radial jitter are keyed by THREAD, so measuring the
 * drawn slot would move a cloud's neighbours whenever one of its cards
 * was replaced.
 *
 * Heights are nominal for the same reason ring radii are — see
 * `NOMINAL_CARD_HEIGHT`. A card taller than nominal overhangs its own
 * box downward and moves nothing else.
 */
function seatRects(params: {
  seats: readonly number[];
  cardWidth: number;
  clusterKey: string;
}): Box[] {
  const halfWidth = params.cardWidth / 2;
  const halfHeight = NOMINAL_CARD_HEIGHT / 2;
  const baseAngle =
    Math.PI / 2 + (noise(params.clusterKey, 3) * 2 - 1) * 0.7;
  return params.seats.map((seat) => {
    const address = seatAddress(seat, params.cardWidth);
    if (address.ring === 0) {
      return {
        x: -halfWidth,
        y: -halfHeight,
        width: params.cardWidth,
        height: NOMINAL_CARD_HEIGHT,
      };
    }
    const ring = ringGeometry(address.ring, params.cardWidth);
    const pitch = (2 * Math.PI) / address.capacity;
    const center =
      baseAngle
      + address.position * pitch
      + (address.ring % 2 === 1 ? 0 : pitch / 2);
    const spread = pitch * JITTER_ANGLE_SHARE;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    // Five samples across the jitter arc: the extremes plus the middle,
    // which is where a nearly-axis-aligned seat reaches furthest.
    for (let step = 0; step <= 4; step += 1) {
      const angle = center + spread * (step / 2 - 1);
      for (const reach of [1, 1 + JITTER_RADIUS_SHARE]) {
        const x = Math.cos(angle) * ring.rx * reach;
        const y = Math.sin(angle) * ring.ry * reach;
        left = Math.min(left, x - halfWidth);
        right = Math.max(right, x + halfWidth);
        top = Math.min(top, y - halfHeight);
        bottom = Math.max(bottom, y + halfHeight);
      }
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
}

/** The box that holds every one of these, or nothing when there are none. */
function boundsOf(rects: readonly Box[]): CloudBounds | undefined {
  if (rects.length === 0) return undefined;
  let bounds: CloudBounds = {
    left: Infinity,
    right: -Infinity,
    top: Infinity,
    bottom: -Infinity,
  };
  for (const rect of rects) {
    bounds = {
      left: Math.min(bounds.left, rect.x),
      right: Math.max(bounds.right, rect.x + rect.width),
      top: Math.min(bounds.top, rect.y),
      bottom: Math.max(bounds.bottom, rect.y + rect.height),
    };
  }
  return bounds;
}

/**
 * Seat assignment for one cloud: everyone who was here keeps their seat,
 * and arrivals take the lowest free one.
 *
 * `reserveCenter` holds seat 0 empty. A cloud seated ON its body (see the
 * `core` option of `computeClusterCloud`) has the body's own label and
 * buttons sitting at its centre, and seat 0 is the centre — a card there
 * paints over the one piece of chrome that names the thing.
 */
function assignSeats(params: {
  visible: readonly NavigationThreadSummary[];
  previous?: Map<string, number>;
  reserveCenter?: boolean;
}): Map<string, number> {
  const seats = new Map<string, number>();
  const taken = new Set<number>();
  if (params.reserveCenter) taken.add(0);
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

/** The body's own chrome, as a box centred on it. */
function boxForKeepout(keepout: {
  halfWidth: number;
  above: number;
  below: number;
}): Box {
  return {
    x: -keepout.halfWidth,
    y: -keepout.above,
    width: keepout.halfWidth * 2,
    height: keepout.above + keepout.below,
  };
}

/** A cloud's boxes moved to where the cloud is being tried. */
function movedTo(
  rects: readonly Box[],
  center: { x: number; y: number },
): Box[] {
  return rects.map((rect) => ({
    ...rect,
    x: rect.x + center.x,
    y: rect.y + center.y,
  }));
}

function isClear(
  rects: readonly Box[],
  center: { x: number; y: number },
  placed: readonly Box[],
  keepout: Box,
  /**
   * Gutters demanded around this cloud's cards — from another cloud's
   * cards, and from the body's own chrome. Both are the designed air
   * when choosing where to PUT a cloud, and both are zero when asking
   * whether one already placed may STAY: a cloud on screen is asked only
   * not to cover anything.
   */
  gaps: { cluster: number; keepout: number } = {
    cluster: CLUSTER_GAP,
    keepout: KEEPOUT_GAP,
  },
): boolean {
  for (const rect of rects) {
    const moved = { ...rect, x: rect.x + center.x, y: rect.y + center.y };
    if (boxesOverlap(moved, keepout, gaps.keepout)) return false;
    for (const other of placed) {
      if (boxesOverlap(moved, other, gaps.cluster)) return false;
    }
  }
  return true;
}

/** What a cloud already on screen must clear to keep its spot. */
const RETAINED_GAPS = { cluster: 0, keepout: 0 };

/**
 * Seat one cloud, walking outward from the body until it clears the
 * body's chrome and everything already placed.
 *
 * Its preferred bearing comes from the cluster key rather than from its
 * position in the list, so a cloud that disappears does not rotate its
 * neighbours — but each radius is swept around that bearing before the
 * search steps further out. Walking one fixed bearing instead sailed a
 * cloud clear past the neighbour blocking it and out into empty sky,
 * with a whole free quadrant beside it: a project's three-card sub-cloud
 * landed 570px from a body whose own cards stopped at 150px.
 */
function seatCluster(params: {
  key: string;
  rects: readonly Box[];
  keepout: Box;
  placed: readonly Box[];
}): { x: number; y: number } {
  const bearing = noise(params.key, 11) * 2 * Math.PI;
  let center = { x: 0, y: 0 };
  for (let probe = 0; probe < SEAT_MAX_PROBES; probe += 1) {
    const radius = SEAT_BASE_RADIUS + probe * SEAT_RADIUS_STEP;
    for (let turn = 0; turn < REFIT_BEARINGS; turn += 1) {
      // 0, +1, -1, +2, -2 … around the cloud's own bearing.
      const step = Math.ceil(turn / 2) * (turn % 2 === 0 ? -1 : 1);
      const angle = bearing + (step * 2 * Math.PI) / REFIT_BEARINGS;
      center = {
        x: Math.cos(angle) * radius * SEAT_ASPECT_X,
        y: Math.sin(angle) * radius,
      };
      if (isClear(params.rects, center, params.placed, params.keepout)) {
        return center;
      }
    }
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
  rects: readonly Box[];
  keepout: Box;
  placed: readonly Box[];
}): { x: number; y: number } {
  if (isClear(params.rects, params.from, params.placed, params.keepout)) {
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
      if (isClear(params.rects, center, params.placed, params.keepout)) {
        return center;
      }
    }
  }
  // Nowhere within reach of where it stands: fall back to the arrival
  // walk, which is guaranteed to leave the instance's chrome behind.
  return seatCluster({
    keepout: params.keepout,
    key: params.key,
    placed: params.placed,
    rects: params.rects,
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
  /**
   * Measured height of one card. Takes the thread rather than a key
   * because the two lenses key their measurements differently — the
   * projects lens pools threads from every instance and scopes their
   * cloud identity by owner, while the DOM the heights are measured from
   * is keyed by thread identity alone. Passing `threadKeyOf` here meant
   * every projects-lens lookup missed and every card in that lens laid
   * out at the nominal height.
   */
  heightForThread: (thread: NavigationThreadSummary) => number;
  /**
   * Cluster seated ON the body rather than beside it, with its centre
   * seat held free for the body's own chrome.
   *
   * Every other cloud is thrown clear of `STAR_MAP_INSTANCE_KEEPOUT` and
   * seated from `SEAT_BASE_RADIUS` outward, which is right for an
   * instance — a sun with a name pill and an intake button, and only a
   * handful of them on the map. A project body is a label, and there are
   * thirty of them: seated that way a project's nearest card landed 400px
   * from its own name, and the space it reserved was twice the space it
   * drew. The projects lens passes its project key here so the body sits
   * in the middle of its own cards.
   */
  core?: string;
  /**
   * Chrome the clouds must not cover, as half-extents from the body's
   * centre. Defaults to `STAR_MAP_INSTANCE_KEEPOUT` — a sun, its name
   * pill and its intake button. A project body is a label and needs a
   * far smaller box; handing it the instance's is what pushed a
   * project's sub-clouds hundreds of pixels off their own name.
   */
  keepout?: { halfWidth: number; above: number; below: number };
  memory?: StarMapCloudMemory;
}): StarMapClusterCloud {
  const previous = params.memory ?? emptyCloudMemory();
  const nextSeats = new Map<string, Map<string, number>>();
  const nextBounds = new Map<string, CloudBounds>();
  const nextCenters = new Map<string, { x: number; y: number }>();
  const keepout = params.keepout ?? STAR_MAP_INSTANCE_KEEPOUT;
  const keepoutBox = boxForKeepout(keepout);

  const sized = params.clusters.map((spec) => {
    const isCore = spec.key === params.core;
    const visible = spec.threads.slice(0, spec.visibleCount);
    // A parent group reads as its parent and that parent's replies, so
    // the parent is drawn as the cloud's header rather than as one more
    // card on the ring. It is always `threads[0]`: `buildInstanceClusters`
    // collects a group root-first, and `orderParentAdjacent` keeps it so.
    const header = spec.isParentGroup && visible.length > 1 ? visible[0] : undefined;
    const ringed = header ? visible.slice(1) : visible;
    const seats = assignSeats({
      visible: ringed,
      previous: previous.seats.get(spec.key),
      // Both the core and a headed cloud leave their centre empty: one
      // for the project body sitting on it, one because the header hangs
      // above the ring and a centre card would paint over the gap.
      reserveCenter: isCore || header !== undefined,
    });
    nextSeats.set(spec.key, seats);
    const rects = seatRects({
      seats: [...seats.values()],
      cardWidth: params.cardWidth,
      clusterKey: spec.key,
    });
    const ring = boundsOf(rects) ?? {
      left: -params.cardWidth / 2,
      right: params.cardWidth / 2,
      top: -NOMINAL_CARD_HEIGHT / 2,
      bottom: NOMINAL_CARD_HEIGHT / 2,
    };
    // The header hangs above the ring at a fixed gap rather than at the
    // top of the cloud's box, so where it sits does not depend on how
    // wide the box turned out to be — and the box can then be measured
    // from it.
    const headerTop = ring.top - HEADER_GAP - NOMINAL_CARD_HEIGHT;
    if (header) {
      rects.push({
        x: -params.cardWidth / 2,
        y: headerTop,
        width: params.cardWidth,
        height: NOMINAL_CARD_HEIGHT,
      });
    }
    const measured = header ? { ...ring, top: headerTop } : ring;
    // Grow-only: an outermost card leaving must not pull the cloud in and
    // shove its neighbours around. Collapsing the cloud is the operator's
    // call and drops this one entry (see `refitCluster`).
    const held = previous.bounds.get(spec.key);
    const bounds = padBounds(
      held ? unionBounds(measured, held) : measured,
      CLOUD_EXTENT_PAD,
    );
    nextBounds.set(spec.key, held ? unionBounds(measured, held) : measured);
    // The label and the chip are chrome the next cloud must not sit on,
    // so they claim their room the same way a card does. Both are pills
    // centred over the cloud, so they claim a card's width rather than
    // the cloud's — reserving the full span walled off the corners, which
    // is exactly where a small cloud wants to tuck in.
    rects.push({
      x: -params.cardWidth / 2,
      y: bounds.top - CLOUD_LABEL_ROOM,
      width: params.cardWidth,
      height: CLOUD_LABEL_ROOM,
    });
    rects.push({
      x: -params.cardWidth / 2,
      y: bounds.bottom,
      width: params.cardWidth,
      height: CLOUD_CHIP_ROOM,
    });
    const slots = new Map<string, StarMapCardSlot>();
    if (header) slots.set(threadKeyOf(header), { dx: 0, dy: headerTop });
    for (const thread of ringed) {
      slots.set(threadKeyOf(thread), seatSlot({
        cardWidth: params.cardWidth,
        clusterKey: spec.key,
        height: params.heightForThread(thread),
        seat: seats.get(threadKeyOf(thread)) ?? 0,
        threadKey: threadKeyOf(thread),
      }));
    }
    return {
      spec,
      isCore,
      seats,
      slots: visible.map((thread) => slots.get(threadKeyOf(thread))!),
      bounds,
      extent: extentOf(bounds),
      rects,
      visible,
    };
  });

  // Retained clouds keep their centre; only clouds that are new — or that
  // grew into a neighbour — are seated. Deterministic order so a fresh map
  // lays out the same way twice.
  const placed: Box[] = [];
  // The core cloud is seated before anything else and never moves: it IS
  // the body's position, so there is nothing for it to be re-fitted
  // against. Everything else then packs around the box it claims.
  const core = sized.find((cluster) => cluster.isCore);
  if (core) {
    nextCenters.set(core.spec.key, { x: 0, y: 0 });
    placed.push(...core.rects);
  }
  const seatable = sized.filter((cluster) => !cluster.isCore);
  const retained = seatable.filter((cluster) =>
    previous.centers.has(cluster.spec.key),
  );
  const arrivals = seatable.filter(
    (cluster) => !previous.centers.has(cluster.spec.key),
  );
  const reseat: typeof sized = [];
  for (const cluster of retained) {
    const center = previous.centers.get(cluster.spec.key)!;
    // A cloud already on screen keeps its spot unless its cards would
    // actually overlap: it is asked to clear its neighbours, not to keep
    // the gutter a fresh arrival is given. One card joining a ring nudges
    // the cloud's edge by a few pixels, and charging it the full gutter
    // for that re-seated a cloud the operator was reading.
    if (isClear(cluster.rects, center, placed, keepoutBox, RETAINED_GAPS)) {
      nextCenters.set(cluster.spec.key, center);
      placed.push(...movedTo(cluster.rects, center));
    } else {
      // It outgrew its seat. The cloud that changed is the one that moves.
      reseat.push(cluster);
    }
  }
  // A body with a core cloud has no lone cloud to hang: the core already
  // occupies the space below it, and this branch clears nothing.
  const lonely =
    !core && seatable.length === 1 && previous.centers.size === 0
      ? seatable[0]
      : undefined;
  for (const cluster of [...reseat, ...arrivals]) {
    // A cloud that was already somewhere is re-fitted near where it
    // stands; a new one is seated on its own bearing.
    const held = previous.centers.get(cluster.spec.key);
    const center =
      cluster === lonely
        ? {
            // A lone cloud hangs under the body, where a lane would put it.
            x: 0,
            // Hung by the symmetric half-extent rather than by the
            // cloud's own top edge: a card joining the ring above the
            // centre moves that edge, and the cloud would sink by a card
            // height under cards the operator was already reading.
            y:
              keepout.below
              + KEEPOUT_GAP
              + CLOUD_LABEL_ROOM
              + cluster.extent.ry,
          }
        : held
          ? reseatCluster({
              from: held,
              keepout: keepoutBox,
              key: cluster.spec.key,
              placed,
              rects: cluster.rects,
            })
          : seatCluster({
              keepout: keepoutBox,
              key: cluster.spec.key,
              placed,
              rects: cluster.rects,
            });
    nextCenters.set(cluster.spec.key, center);
    placed.push(...movedTo(cluster.rects, center));
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
      heights.push(params.heightForThread(thread));
      clusterIndexByCard.push(index);
    });
    const chromeless =
      (cluster.spec.totalCount ?? cluster.spec.threads.length) === 1
      || (sized.length === 1 && !cluster.spec.isProject);
    const showChip =
      (cluster.spec.totalCount ?? 0) > cluster.spec.threads.length
      || cluster.spec.overflow > 0
      || (cluster.spec.expanded && cluster.spec.expandable);
    clusters.push({
      ...cluster.spec,
      center,
      extent: cluster.extent,
      slots: bodySlots,
      // Label and chip ride the cloud's real top and bottom, not a
      // half-extent: an asymmetric cloud left them floating over nothing.
      labelSlot: {
        dx: center.x,
        dy: center.y + cluster.bounds.top - CLOUD_LABEL_ROOM / 2,
      },
      overflowSlot: showChip
        ? {
            dx: center.x,
            dy: center.y + cluster.bounds.bottom + CLOUD_CHIP_ROOM / 2,
          }
        : undefined,
      chromeless,
    });
    // Aggregated from the symmetric half-extent each cloud reports, so
    // the body's own extent covers every box its readers will draw.
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
    memory: { bounds: nextBounds, centers: nextCenters, seats: nextSeats },
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
