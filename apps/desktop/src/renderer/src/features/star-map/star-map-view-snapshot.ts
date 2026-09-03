import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
  type StarMapViewCloud,
  type StarMapViewInstance,
  type StarMapViewLayout,
  type StarMapViewSnapshot,
  type StarMapViewSurface,
  type StarMapViewThread,
} from "@pwragent/shared";
import {
  threadAttentionCategories,
  type StarMapSessionKeys,
} from "./attention";
import {
  STAR_MAP_FILTERS,
  filterState,
  isPinnedThread,
  type StarMapFilterSelection,
} from "./star-map-filters";
import type { StarMapClusterCloud } from "./star-map-clusters";
import type { StarMapLayoutMode } from "./star-map-preferences";
import type { StarMapProject } from "./star-map-projects";
import { STAR_MAP_NO_PROJECT_KEY, threadProjectLabel } from "./star-map-projects";

/**
 * Map-space rect to viewport coordinates.
 *
 * The canvas carries `translate(camera.x, camera.y) scale(camera.scale)`, and
 * a CSS transform list applies right to left, so a card is scaled first and
 * then offset: `screen = map * scale + camera`. Derived here rather than left
 * to the tool's caller because the order is easy to invert, and a spatial
 * reference resolved off a flipped transform names the wrong card without
 * ever looking uncertain.
 */
function toScreenRect(
  rect: { x: number; y: number; width: number; height: number },
  camera: { x: number; y: number; scale: number },
): { x: number; y: number; width: number; height: number } {
  const scale = camera.scale > 0 ? camera.scale : 1;
  return {
    x: rect.x * scale + camera.x,
    y: rect.y * scale + camera.y,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** Whether a viewport-space rect overlaps the viewport at all. */
function overlapsViewport(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): boolean {
  return (
    rect.x + rect.width > 0
    && rect.y + rect.height > 0
    && rect.x < viewport.width
    && rect.y < viewport.height
  );
}

/** `${instanceId}::${threadKey}` — the map's own card identity. */
function cardKeyOf(instanceId: string, threadKey: string): string {
  return `${instanceId}::${threadKey}`;
}

export type StarMapViewSnapshotInput = {
  surface: StarMapViewSurface;
  layout: StarMapLayoutMode;
  camera: { x: number; y: number; scale: number };
  viewport: { width: number; height: number };
  filterSelection: StarMapFilterSelection;
  hideOfflineInstances: boolean;
  hiddenInstanceCount: number;
  matchedThreadCount: number;
  localInstanceId?: string;
  threadsByInstance: ReadonlyMap<string, readonly NavigationThreadSummary[]>;
  instanceLabels: ReadonlyMap<string, string>;
  /**
   * Resolved lazily rather than passed as a built map: this input is
   * assembled on every render of a surface that re-renders per pan frame,
   * while the builder runs at most once per publish window.
   */
  iconFor?: (instanceId: string) => string | undefined;
  /** Cloud layout, in the lenses that draw clouds around each instance. */
  clouds?: ReadonlyMap<string, StarMapClusterCloud>;
  /** Project pools, in the projects lens. */
  projects?: readonly StarMapProject[];
  /**
   * Sub-cloud layout inside each project body, by project key. The projects
   * lens draws labelled clusters inside a project, and those are what a card
   * is "in" — reporting the project instead answers "the others in its
   * cloud" with the whole project.
   */
  projectClouds?: ReadonlyMap<string, StarMapClusterCloud>;
  /**
   * True below the overview zoom threshold, where the map draws cloud labels
   * and no thread cards at all. The rect maps are not gated on it, so without
   * this the snapshot reports every card drawn in the one state where the
   * operator can see none of them.
   */
  overview?: boolean;
  /** Card keys the operator has gathered. */
  selection: ReadonlySet<string>;
  /** Thread keys with a floating chat card open over the map. */
  openChatCardThreadKeys: ReadonlySet<string>;
  /**
   * Map-space geometry by card key, for the cards being drawn. Its key set
   * is also what "drawn" means here: a card the layout is not placing has no
   * rect, so the geometry and the visibility can never disagree.
   *
   * Required, not optional: omitting it publishes a map where every card
   * reports itself invisible, which reads to an Agent as an empty screen.
   */
  cardRects: ReadonlyMap<
    string,
    { x: number; y: number; width: number; height: number }
  >;
  sessionKeys?: StarMapSessionKeys;
  now?: number;
};

/**
 * Describe what the Star Map is currently showing, in the operator's own
 * vocabulary, for the `read_star_map_view` Agent tool.
 *
 * Pure and total: it reads the same structures the render path reads, so a
 * snapshot cannot claim a card is drawn that the operator cannot see. That
 * matters more than completeness here — an Agent that renames "the others
 * in this cloud" is acting on this list, and a card the map folded away is
 * not one the operator was pointing at.
 */
export function buildStarMapViewSnapshot(
  input: StarMapViewSnapshotInput,
): StarMapViewSnapshot {
  const cloudKeyByCard = new Map<string, string>();
  const clouds: StarMapViewCloud[] = [];
  // Overview draws no cards, so no card has geometry the operator can point
  // at. Resolved once here so every drawn-ness question in this function
  // reads the same source.
  const drawnRects = input.overview ? undefined : input.cardRects;

  for (const [instanceId, cloud] of input.clouds ?? []) {
    const instanceLabel = input.instanceLabels.get(instanceId) ?? instanceId;
    for (const cluster of cloud.clusters) {
      const threadKeys = cluster.threads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      );
      // Counted off the same rects the per-thread `visible` flag reads, in
      // one pass. A cloud that counted its own allocation instead could
      // report five drawn members while five of its own threads said
      // otherwise — and at overview zoom, where nothing is painted, every
      // cloud claimed a full house.
      let visibleCount = 0;
      for (const threadKey of threadKeys) {
        const cardKey = cardKeyOf(instanceId, threadKey);
        cloudKeyByCard.set(cardKey, cluster.key);
        if (drawnRects?.has(cardKey)) visibleCount += 1;
      }
      clouds.push({
        key: cluster.key,
        label: cluster.label,
        instanceId,
        instanceLabel,
        isProject: cluster.isProject,
        isParentGroup: cluster.isParentGroup,
        expanded: cluster.expanded,
        threadCount: threadKeys.length,
        visibleCount,
        hiddenCount: threadKeys.length - visibleCount,
        threadKeys,
      });
    }
  }

  // The projects lens pools threads from every instance into one body, so
  // its clouds belong to no single instance.
  // Which instances draw a given thread. Built once: a project pools threads
  // from the whole fleet, and the same thread can sit under two instances
  // (a pinned remote row alongside its owner).
  const instancesByThreadKey = new Map<string, string[]>();
  for (const [instanceId, instanceThreads] of input.threadsByInstance) {
    for (const thread of instanceThreads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const owners = instancesByThreadKey.get(threadKey);
      if (owners) owners.push(instanceId);
      else instancesByThreadKey.set(threadKey, [instanceId]);
    }
  }
  /**
   * Claim a set of threads as one cloud and record it against every card key
   * that can address them. A thread can sit under two instances (a pinned
   * remote row alongside its owner), so membership is recorded per card.
   */
  const pushProjectCloud = (params: {
    key: string;
    label: string;
    isProject: boolean;
    isParentGroup: boolean;
    expanded: boolean;
    threadKeys: readonly string[];
  }): void => {
    let visibleCount = 0;
    for (const threadKey of params.threadKeys) {
      let drawn = false;
      for (const instanceId of instancesByThreadKey.get(threadKey) ?? []) {
        const cardKey = cardKeyOf(instanceId, threadKey);
        cloudKeyByCard.set(cardKey, params.key);
        if (drawnRects?.has(cardKey)) drawn = true;
      }
      if (drawn) visibleCount += 1;
    }
    clouds.push({
      key: params.key,
      label: params.label,
      isProject: params.isProject,
      isParentGroup: params.isParentGroup,
      expanded: params.expanded,
      threadCount: params.threadKeys.length,
      visibleCount,
      hiddenCount: params.threadKeys.length - visibleCount,
      threadKeys: [...params.threadKeys],
    });
  };

  for (const project of input.projects ?? []) {
    // A project body is not itself a cloud: the lens groups its threads into
    // labelled sub-clouds and paints those labels, so those are what a card
    // is in. Reporting the project instead answers "the others in its cloud"
    // with every thread in the project.
    const projectCloud = input.projectClouds?.get(project.key);
    if (projectCloud) {
      for (const cluster of projectCloud.clusters) {
        pushProjectCloud({
          key: cluster.key,
          label: cluster.label,
          isProject: cluster.isProject,
          isParentGroup: cluster.isParentGroup,
          expanded: cluster.expanded,
          threadKeys: cluster.threads.map((thread) =>
            buildThreadIdentityKey(thread.source, thread.id),
          ),
        });
      }
      continue;
    }
    // No layout yet (the lens is opening): the project pool is the best
    // grouping available, and is still better than no cloud at all.
    pushProjectCloud({
      key: project.key,
      label: project.label,
      isProject: project.key !== STAR_MAP_NO_PROJECT_KEY,
      isParentGroup: false,
      expanded: false,
      threadKeys: project.threads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
    });
  }

  const threads: StarMapViewThread[] = [];
  const instances: StarMapViewInstance[] = [];
  for (const [instanceId, instanceThreads] of input.threadsByInstance) {
    const instanceLabel = input.instanceLabels.get(instanceId) ?? instanceId;
    let visibleThreadCount = 0;
    for (const thread of instanceThreads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const cardKey = cardKeyOf(instanceId, threadKey);
      const visible = drawnRects?.has(cardKey) ?? false;
      if (visible) visibleThreadCount += 1;
      const rect = drawnRects?.get(cardKey);
      threads.push({
        backend: thread.source,
        threadId: thread.id,
        threadKey,
        title: thread.title,
        instanceId,
        instanceLabel,
        isLocal: instanceId === input.localInstanceId,
        cloudKey: cloudKeyByCard.get(cardKey),
        visible,
        selected: input.selection.has(cardKey),
        chatCardOpen: input.openChatCardThreadKeys.has(threadKey),
        rect: rect
          ? {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            }
          : undefined,
        ...(rect
          ? (() => {
              const screenRect = toScreenRect(rect, input.camera);
              return {
                screenRect,
                onScreen: overlapsViewport(screenRect, input.viewport),
              };
            })()
          : {}),
        pinned: isPinnedThread(thread) ? true : undefined,
        attention: threadAttentionCategories(thread, input.sessionKeys),
        projectLabel: threadProjectLabel(thread),
      });
    }
    instances.push({
      instanceId,
      label: instanceLabel,
      isLocal: instanceId === input.localInstanceId,
      icon: input.iconFor?.(instanceId),
      threadCount: instanceThreads.length,
      visibleThreadCount,
    });
  }

  return {
    capturedAt: input.now ?? Date.now(),
    surface: input.surface,
    layout: input.layout satisfies StarMapViewLayout,
    camera: input.camera,
    viewport: input.viewport,
    filters: STAR_MAP_FILTERS.flatMap((definition) => {
      const state = filterState(input.filterSelection, definition.key);
      return state === "neutral"
        ? []
        : [{ key: definition.key, label: definition.label, state }];
    }),
    hideOfflineInstances: input.hideOfflineInstances,
    hiddenInstanceCount: input.hiddenInstanceCount,
    instances,
    clouds,
    threads,
    selectedThreadKeys: threads
      .filter((thread) => thread.selected)
      .map((thread) => thread.threadKey),
    openChatCardThreadKeys: [...input.openChatCardThreadKeys],
    matchedThreadCount: input.matchedThreadCount,
  };
}

