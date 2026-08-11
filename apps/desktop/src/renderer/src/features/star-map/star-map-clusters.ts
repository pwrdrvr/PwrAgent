import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { type StarMapCardSlot } from "./star-map-layout";
import { STAR_MAP_INSTANCE_KEEPOUT } from "./star-map-orbit";
import {
  projectMass,
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
/** Same base rotation as the galaxy scatter: clouds leave the cardinal
 * axes so two of them never sit at exactly N/S. */
const SEAT_BASE_ROTATION = 0.22;
/** Clouds are wide and short-ish, so seating stretches horizontally. */
const SEAT_ASPECT_X = 1.3;

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
 * catch-all. Clouds order by the same mass the projects lens uses,
 * heaviest first, so the busiest work seats nearest the body.
 */
export function buildInstanceClusters(params: {
  threads: readonly NavigationThreadSummary[];
  /** Cluster keys the operator expanded past the per-group cap. */
  expandedKeys?: ReadonlySet<string>;
  now?: number;
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
    mass: number;
  };
  const now = params.now ?? Date.now();
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
          mass: massOf(group, now),
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
        mass: massOf(rest, now),
      });
    }
  }

  drafts.sort(
    (left, right) =>
      right.mass - left.mass || left.label.localeCompare(right.label),
  );

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

function massOf(threads: readonly NavigationThreadSummary[], now: number): number {
  const lastActivityAt = threads.reduce(
    (latest, thread) => Math.max(latest, thread.updatedAt ?? 0),
    0,
  );
  return projectMass({ cardCount: threads.length, lastActivityAt, now });
}

type ScatteredCluster = {
  spec: StarMapClusterSpec;
  /** Cloud-local card slots (dx from centre, dy = card TOP from centre). */
  slots: StarMapCardSlot[];
  extent: { rx: number; ry: number };
};

/**
 * Scatter a cloud's visible cards: the first card in the middle (for a
 * parent/child cloud that IS the parent), the rest walking elliptical
 * rings with deterministic per-thread jitter — willy-nilly like the
 * original orbit, never a grid. Cards may shingle slightly on purpose;
 * they are opaque and hover raises the one under the pointer.
 */
function scatterCluster(params: {
  spec: StarMapClusterSpec;
  cardWidth: number;
  heightForThread: (threadKey: string) => number;
}): ScatteredCluster {
  const visible = params.spec.threads.slice(0, params.spec.visibleCount);
  const heights = visible.map((thread) =>
    params.heightForThread(threadKeyOf(thread)),
  );
  const maxHeight = heights.reduce((top, height) => Math.max(top, height), 1);
  const slots: StarMapCardSlot[] = [];
  if (visible.length > 0) {
    slots.push({ dx: 0, dy: -heights[0] / 2 });
  }

  // The whole cloud leans a little, per cloud, so no two clouds start
  // their rings at the same bearing.
  const baseAngle = Math.PI / 2 + (noise(params.spec.key, 3) * 2 - 1) * 0.7;
  let ringIndex = 0;
  let seated = 1;
  while (seated < visible.length) {
    ringIndex += 1;
    const rx =
      params.cardWidth
      * (RING_BASE_RX_FACTOR + (ringIndex - 1) * RING_STEP_RX_FACTOR);
    const ry =
      (maxHeight + RING_BASE_RY_PAD)
      + (ringIndex - 1) * (maxHeight + RING_STEP_RY_PAD);
    const capacity = Math.max(
      4,
      Math.floor((2 * Math.PI * rx) / (params.cardWidth * RING_PACKING)),
    );
    const onThisRing = Math.min(visible.length - seated, capacity);
    const pitch = (2 * Math.PI) / onThisRing;
    for (let position = 0; position < onThisRing; position += 1) {
      const thread = visible[seated + position];
      const key = threadKeyOf(thread);
      const angle =
        baseAngle
        + position * pitch
        + (ringIndex % 2 === 1 ? 0 : pitch / 2)
        + (noise(key, 5) * 2 - 1) * pitch * JITTER_ANGLE_SHARE;
      const reach = 1 + noise(key, 7) * JITTER_RADIUS_SHARE;
      const height = heights[seated + position];
      slots.push({
        dx: Math.cos(angle) * rx * reach,
        dy: Math.sin(angle) * ry * reach - height / 2,
      });
    }
    seated += onThisRing;
  }

  let rx = 0;
  let ry = 0;
  slots.forEach((slot, index) => {
    rx = Math.max(rx, Math.abs(slot.dx) + params.cardWidth / 2);
    ry = Math.max(ry, Math.abs(slot.dy), Math.abs(slot.dy + heights[index]));
  });
  return {
    spec: params.spec,
    slots,
    extent: {
      rx: rx + CLOUD_EXTENT_PAD,
      ry: ry + CLOUD_EXTENT_PAD,
    },
  };
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
  scattered: ScatteredCluster,
): Box {
  return {
    x: center.x - scattered.extent.rx,
    y: center.y - scattered.extent.ry - CLOUD_LABEL_ROOM,
    width: scattered.extent.rx * 2,
    height: scattered.extent.ry * 2 + CLOUD_LABEL_ROOM + CLOUD_CHIP_ROOM,
  };
}

/**
 * Seat scattered clouds around the body: a lone cloud hangs centred
 * below it, several distribute by angle — heaviest first, just off
 * vertical — each walking outward along its own bearing until it clears
 * the chrome and every cloud already seated. Deterministic.
 */
function seatClusters(
  scattered: readonly ScatteredCluster[],
): { x: number; y: number }[] {
  if (scattered.length === 1) {
    const only = scattered[0];
    return [
      {
        x: 0,
        y:
          STAR_MAP_INSTANCE_KEEPOUT.below
          + KEEPOUT_GAP
          + CLOUD_LABEL_ROOM
          + only.extent.ry,
      },
    ];
  }
  const placedBoxes: Box[] = [];
  const centers: { x: number; y: number }[] = [];
  scattered.forEach((cluster, index) => {
    const angle =
      Math.PI / 2
      + SEAT_BASE_ROTATION
      + (index * 2 * Math.PI) / scattered.length;
    let radius = SEAT_BASE_RADIUS;
    let center = { x: 0, y: 0 };
    for (let probe = 0; probe < SEAT_MAX_PROBES; probe += 1) {
      center = {
        x: Math.cos(angle) * radius * SEAT_ASPECT_X,
        y: Math.sin(angle) * radius,
      };
      const box = boxFor(center, cluster);
      const clear =
        !boxesOverlap(box, KEEPOUT_BOX, KEEPOUT_GAP)
        && placedBoxes.every((other) => !boxesOverlap(box, other, CLUSTER_GAP));
      if (clear) break;
      radius += SEAT_RADIUS_STEP;
    }
    placedBoxes.push(boxFor(center, cluster));
    centers.push(center);
  });
  return centers;
}

/** Extent an instance claims when its clouds are empty — its own body. */
const EMPTY_CLOUD_EXTENT = 70;

/**
 * Lay out one instance's clouds and flatten them for rendering.
 *
 * The flat `threads`/`slots`/`heights` triple is what the screen's lane
 * plumbing already speaks (index-aligned, slot dy = card top), so cloud
 * membership rides alongside instead of reshaping every consumer.
 */
export function computeClusterCloud(params: {
  clusters: readonly StarMapClusterSpec[];
  cardWidth: number;
  heightForThread: (threadKey: string) => number;
}): StarMapClusterCloud {
  const scattered = params.clusters.map((spec) =>
    scatterCluster({
      spec,
      cardWidth: params.cardWidth,
      heightForThread: params.heightForThread,
    }),
  );
  const centers = seatClusters(scattered);

  const clusters: StarMapClusterPlacement[] = [];
  const threads: NavigationThreadSummary[] = [];
  const slots: StarMapCardSlot[] = [];
  const heights: number[] = [];
  const clusterIndexByCard: number[] = [];
  let rx = EMPTY_CLOUD_EXTENT;
  let ry = EMPTY_CLOUD_EXTENT;

  scattered.forEach((cluster, index) => {
    const center = centers[index];
    const bodySlots = cluster.slots.map((slot) => ({
      dx: center.x + slot.dx,
      dy: center.y + slot.dy,
    }));
    const visible = cluster.spec.threads.slice(0, cluster.spec.visibleCount);
    visible.forEach((thread, cardIndex) => {
      threads.push(thread);
      slots.push(bodySlots[cardIndex]);
      heights.push(params.heightForThread(threadKeyOf(thread)));
      clusterIndexByCard.push(index);
    });
    const chromeless =
      cluster.spec.threads.length === 1
      || (scattered.length === 1 && !cluster.spec.isProject);
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
      Math.abs(center.y) + cluster.extent.ry + CLOUD_LABEL_ROOM + CLOUD_CHIP_ROOM,
    );
  });

  return { clusters, threads, slots, heights, clusterIndexByCard, extent: { rx, ry } };
}
