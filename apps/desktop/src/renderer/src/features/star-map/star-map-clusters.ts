import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { STAR_MAP_CARD_GAP, type StarMapCardSlot } from "./star-map-layout";
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
 * interleaved activity times provably alternate around the ring — the
 * "intermingled mess" this module exists to fix. Instead, an instance's
 * cards group by project into labeled clouds seated around the body, each
 * capped per group with an honest overflow chip rather than one silent
 * instance-wide truncation.
 */

/**
 * Default visible cards per project cloud. Small enough that four projects
 * still fit around one body; the per-cloud "+N more" chip expands past it.
 */
export const ORBIT_MAX_CARDS_PER_GROUP = 8;
/**
 * DOM-size backstop across an instance's clouds, matching the lane cap: a
 * fleet of five instances at this ceiling is already 200 mounted cards.
 * Never silent — a cloud clipped by the backstop reports the clipped cards
 * in its own overflow chip.
 */
export const ORBIT_MAX_CARDS_PER_CLOUD = 40;

/** Clouds of up to this many cards stack one column; larger use two. */
const SINGLE_COLUMN_MAX = 4;
const CLUSTER_COLUMN_GAP = 14;
const CLUSTER_PAD_X = 16;
/** Room inside the outline's top edge for the label pill row. */
const CLUSTER_PAD_TOP = 44;
const CLUSTER_PAD_BOTTOM = 14;
/** Height reserved for the overflow chip row, gap included. */
const CLUSTER_OVERFLOW_HEIGHT = 24;
const CLUSTER_OVERFLOW_GAP = 10;
/** Clearance between two clouds' outlines. */
const CLUSTER_GAP = 44;
/** Clearance between a cloud and the instance's own chrome. */
const KEEPOUT_GAP = 14;
/** First radius probed when seating a cloud around the body. */
const SEAT_BASE_RADIUS = 150;
const SEAT_RADIUS_STEP = 26;
const SEAT_MAX_PROBES = 240;
/**
 * Same base rotation as the galaxy scatter in star-map-orbit: clouds leave
 * the cardinal axes so two of them never sit at exactly N/S.
 */
const SEAT_BASE_ROTATION = 0.22;
/** Clouds are wide and short-ish, so seating stretches horizontally. */
const SEAT_ASPECT_X = 1.3;

export type StarMapClusterSpec = {
  /** Stable identity: the repo root path, or the no-project sentinel. */
  key: string;
  label: string;
  /** False only for the pooled no-project cloud. */
  isProject: boolean;
  /** Full ordered membership; the first `visibleCount` render. */
  threads: NavigationThreadSummary[];
  visibleCount: number;
  /** Hidden members — per-cloud cap plus any backstop clipping. */
  overflow: number;
  expanded: boolean;
  /** Whether the expand chip has anything to do. */
  expandable: boolean;
};

export type StarMapClusterPlacement = StarMapClusterSpec & {
  /** Outline box, body-relative top-left. */
  rect: { x: number; y: number; width: number; height: number };
  /** Per visible card: dx = centre x, dy = top y, body-relative. */
  slots: StarMapCardSlot[];
  /** Centre of the overflow chip row, when the cloud shows one. */
  overflowSlot?: StarMapCardSlot;
  /**
   * A lone no-project cloud renders without outline or pill — there is
   * nothing to distinguish it from, and a "No project" frame around the
   * whole map would be chrome about nothing.
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
  /** Cluster index per flat card, for per-cloud chip hygiene. */
  clusterIndexByCard: number[];
  /** Half-extent of the drawn cloud set, for inter-instance spacing. */
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

/**
 * Reorder a cloud so children sit directly under their parent.
 *
 * Eight stacked-PR children sorted by recency scatter through the stack in
 * whatever order their turns last ran; adjacency is what makes them read
 * as one piece of work. Threads whose parent is not in this cloud keep
 * their place, and a parent's children keep their relative order. Cycle
 * members (a thread that is its own ancestor) fall back to their original
 * position rather than vanishing.
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
  // Anything not reached hangs off a cycle; keep it rather than lose it.
  for (const thread of threads) {
    if (!emitted.has(threadKeyOf(thread))) {
      emitted.add(threadKeyOf(thread));
      ordered.push(thread);
    }
  }
  return ordered;
}

/**
 * Group one instance's filtered threads into capped project clouds.
 *
 * Threads arrive already sorted (pins first, then recency) and keep that
 * order inside their cloud, apart from the parent-adjacency pass. Clouds
 * order by the same mass the projects lens uses, heaviest first, so the
 * busiest project seats nearest the body.
 */
export function buildInstanceClusters(params: {
  threads: readonly NavigationThreadSummary[];
  /** Cluster keys the operator expanded past the per-group cap. */
  expandedKeys?: ReadonlySet<string>;
  now?: number;
}): StarMapClusterSpec[] {
  const groups = new Map<string, NavigationThreadSummary[]>();
  for (const thread of params.threads) {
    const key = threadProjectKey(thread);
    const members = groups.get(key);
    if (members) members.push(thread);
    else groups.set(key, [thread]);
  }
  const now = params.now ?? Date.now();
  const massed = [...groups.entries()].map(([key, members]) => {
    const lastActivityAt = members.reduce(
      (latest, thread) => Math.max(latest, thread.updatedAt ?? 0),
      0,
    );
    return {
      key,
      label: threadProjectLabel(members[0]),
      isProject: key !== STAR_MAP_NO_PROJECT_KEY,
      threads: orderParentAdjacent(members),
      mass: projectMass({ cardCount: members.length, lastActivityAt, now }),
      expanded: params.expandedKeys?.has(key) ?? false,
    };
  });
  massed.sort(
    (left, right) =>
      right.mass - left.mass || left.label.localeCompare(right.label),
  );

  let budget = ORBIT_MAX_CARDS_PER_CLOUD;
  return massed.map((cluster) => {
    const desired = cluster.expanded
      ? cluster.threads.length
      : Math.min(cluster.threads.length, ORBIT_MAX_CARDS_PER_GROUP);
    const visibleCount = Math.max(0, Math.min(desired, budget));
    budget -= visibleCount;
    return {
      key: cluster.key,
      label: cluster.label,
      isProject: cluster.isProject,
      threads: cluster.threads,
      visibleCount,
      overflow: cluster.threads.length - visibleCount,
      expanded: cluster.expanded,
      expandable: cluster.threads.length > ORBIT_MAX_CARDS_PER_GROUP,
    };
  });
}

type SizedCluster = {
  spec: StarMapClusterSpec;
  width: number;
  height: number;
  /** Cluster-local card slots, from the outline's top-left corner. */
  slots: StarMapCardSlot[];
  overflowSlot?: StarMapCardSlot;
};

/**
 * Stack a cloud's visible cards into one or two columns, row-major so the
 * pins-then-recency order reads left-right, top-down. Rows step by the
 * tallest card in the row — heights vary with chip rows, and a fixed pitch
 * either clips or wastes.
 */
function sizeCluster(params: {
  spec: StarMapClusterSpec;
  cardWidth: number;
  heightForThread: (threadKey: string) => number;
}): SizedCluster {
  const visible = params.spec.threads.slice(0, params.spec.visibleCount);
  const columns = visible.length > SINGLE_COLUMN_MAX ? 2 : 1;
  const contentWidth =
    columns * params.cardWidth + (columns - 1) * CLUSTER_COLUMN_GAP;
  const width = contentWidth + CLUSTER_PAD_X * 2;
  const slots: StarMapCardSlot[] = [];
  let y = CLUSTER_PAD_TOP;
  for (let start = 0; start < visible.length; start += columns) {
    const row = visible.slice(start, start + columns);
    for (let column = 0; column < row.length; column += 1) {
      slots.push({
        dx:
          CLUSTER_PAD_X
          + column * (params.cardWidth + CLUSTER_COLUMN_GAP)
          + params.cardWidth / 2,
        dy: y,
      });
    }
    const rowHeight = Math.max(
      ...row.map((thread) => params.heightForThread(threadKeyOf(thread))),
    );
    y += rowHeight + STAR_MAP_CARD_GAP;
  }
  let bottom = visible.length > 0 ? y - STAR_MAP_CARD_GAP : CLUSTER_PAD_TOP;
  // The chip appears for hidden cards, and stays while expanded so the
  // cloud can be re-collapsed.
  const showChip =
    params.spec.overflow > 0
    || (params.spec.expanded && params.spec.expandable);
  let overflowSlot: StarMapCardSlot | undefined;
  if (showChip) {
    overflowSlot = {
      dx: width / 2,
      dy:
        bottom
        + (visible.length > 0 ? CLUSTER_OVERFLOW_GAP : 0)
        + CLUSTER_OVERFLOW_HEIGHT / 2,
    };
    bottom = overflowSlot.dy + CLUSTER_OVERFLOW_HEIGHT / 2;
  }
  return {
    spec: params.spec,
    width,
    height: bottom + CLUSTER_PAD_BOTTOM,
    slots,
    overflowSlot,
  };
}

type Rect = { x: number; y: number; width: number; height: number };

function rectsOverlap(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap
    && b.x < a.x + a.width + gap
    && a.y < b.y + b.height + gap
    && b.y < a.y + a.height + gap
  );
}

const KEEPOUT_RECT: Rect = {
  x: -STAR_MAP_INSTANCE_KEEPOUT.halfWidth,
  y: -STAR_MAP_INSTANCE_KEEPOUT.above,
  width: STAR_MAP_INSTANCE_KEEPOUT.halfWidth * 2,
  height: STAR_MAP_INSTANCE_KEEPOUT.above + STAR_MAP_INSTANCE_KEEPOUT.below,
};

/**
 * Seat sized clouds around the body: a lone cloud hangs centred below it
 * (the lane shape), several distribute by angle — heaviest first, just off
 * vertical — each walking outward along its own bearing until it clears
 * the chrome and every cloud already seated. Deterministic: same clouds,
 * same sky.
 */
function seatClusters(sized: readonly SizedCluster[]): Rect[] {
  if (sized.length === 1) {
    const only = sized[0];
    return [
      {
        x: -only.width / 2,
        y: STAR_MAP_INSTANCE_KEEPOUT.below + KEEPOUT_GAP,
        width: only.width,
        height: only.height,
      },
    ];
  }
  const placed: Rect[] = [];
  sized.forEach((cluster, index) => {
    const angle =
      Math.PI / 2 + SEAT_BASE_ROTATION + (index * 2 * Math.PI) / sized.length;
    let radius = SEAT_BASE_RADIUS;
    let candidate: Rect = { x: 0, y: 0, width: cluster.width, height: cluster.height };
    for (let probe = 0; probe < SEAT_MAX_PROBES; probe += 1) {
      candidate = {
        x: Math.cos(angle) * radius * SEAT_ASPECT_X - cluster.width / 2,
        y: Math.sin(angle) * radius - cluster.height / 2,
        width: cluster.width,
        height: cluster.height,
      };
      const clear =
        !rectsOverlap(candidate, KEEPOUT_RECT, KEEPOUT_GAP)
        && placed.every((other) => !rectsOverlap(candidate, other, CLUSTER_GAP));
      if (clear) break;
      radius += SEAT_RADIUS_STEP;
    }
    placed.push(candidate);
  });
  return placed;
}

/** Extent an instance claims when its clouds are empty — its own body. */
const EMPTY_CLOUD_EXTENT = 70;

/**
 * Lay out one instance's project clouds and flatten them for rendering.
 *
 * The flat `threads`/`slots`/`heights` triple is what the screen's lane
 * plumbing already speaks (index-aligned, slot dy = card top), so cluster
 * membership rides alongside instead of reshaping every consumer.
 */
export function computeClusterCloud(params: {
  clusters: readonly StarMapClusterSpec[];
  cardWidth: number;
  heightForThread: (threadKey: string) => number;
}): StarMapClusterCloud {
  const sized = params.clusters.map((spec) =>
    sizeCluster({
      spec,
      cardWidth: params.cardWidth,
      heightForThread: params.heightForThread,
    }),
  );
  const rects = seatClusters(sized);

  const clusters: StarMapClusterPlacement[] = [];
  const threads: NavigationThreadSummary[] = [];
  const slots: StarMapCardSlot[] = [];
  const heights: number[] = [];
  const clusterIndexByCard: number[] = [];
  let rx = EMPTY_CLOUD_EXTENT;
  let ry = EMPTY_CLOUD_EXTENT;

  sized.forEach((cluster, index) => {
    const rect = rects[index];
    const bodySlots = cluster.slots.map((slot) => ({
      dx: rect.x + slot.dx,
      dy: rect.y + slot.dy,
    }));
    const visible = cluster.spec.threads.slice(0, cluster.spec.visibleCount);
    visible.forEach((thread, cardIndex) => {
      threads.push(thread);
      slots.push(bodySlots[cardIndex]);
      heights.push(params.heightForThread(threadKeyOf(thread)));
      clusterIndexByCard.push(index);
    });
    clusters.push({
      ...cluster.spec,
      rect,
      slots: bodySlots,
      overflowSlot: cluster.overflowSlot
        ? {
            dx: rect.x + cluster.overflowSlot.dx,
            dy: rect.y + cluster.overflowSlot.dy,
          }
        : undefined,
      chromeless: sized.length === 1 && !cluster.spec.isProject,
    });
    rx = Math.max(rx, Math.abs(rect.x), Math.abs(rect.x + rect.width));
    ry = Math.max(ry, Math.abs(rect.y), Math.abs(rect.y + rect.height));
  });

  return { clusters, threads, slots, heights, clusterIndexByCard, extent: { rx, ry } };
}
