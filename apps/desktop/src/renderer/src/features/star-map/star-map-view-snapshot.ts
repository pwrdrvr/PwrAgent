import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
  type StarMapViewCloud,
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
  instanceIcons?: ReadonlyMap<string, string | undefined>;
  /** Cloud layout, in the lenses that draw clouds around each instance. */
  clouds?: ReadonlyMap<string, StarMapClusterCloud>;
  /** Project pools, in the projects lens. */
  projects?: readonly StarMapProject[];
  /** Card keys the surface is actually drawing right now. */
  visibleCardKeys: ReadonlySet<string>;
  /** Card keys the operator has gathered. */
  selection: ReadonlySet<string>;
  /** Thread keys with a floating chat card open over the map. */
  openChatCardThreadKeys: ReadonlySet<string>;
  /** Map-space geometry by card key, for the cards being drawn. */
  cardRects?: ReadonlyMap<
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

  for (const [instanceId, cloud] of input.clouds ?? []) {
    const instanceLabel = input.instanceLabels.get(instanceId) ?? instanceId;
    const drawn = new Set(
      cloud.threads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
    );
    for (const cluster of cloud.clusters) {
      const threadKeys = cluster.threads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      );
      for (const threadKey of threadKeys) {
        cloudKeyByCard.set(cardKeyOf(instanceId, threadKey), cluster.key);
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
        // `visibleCount` is what the cloud allocated; intersecting with the
        // cards actually drawn keeps the two from disagreeing when a filter
        // removed a member after the layout ran.
        visibleCount: threadKeys.filter((key) => drawn.has(key)).length,
        hiddenCount: threadKeys.filter((key) => !drawn.has(key)).length,
        threadKeys,
      });
    }
  }

  // The projects lens pools threads from every instance into one body, so
  // its clouds belong to no single instance.
  for (const project of input.projects ?? []) {
    const threadKeys = project.threads.map((thread) =>
      buildThreadIdentityKey(thread.source, thread.id),
    );
    clouds.push({
      key: project.key,
      label: project.label,
      isProject: project.key !== STAR_MAP_NO_PROJECT_KEY,
      isParentGroup: false,
      expanded: false,
      threadCount: threadKeys.length,
      visibleCount: threadKeys.filter((threadKey) =>
        isDrawnInAnyInstance(input, threadKey),
      ).length,
      hiddenCount: threadKeys.filter(
        (threadKey) => !isDrawnInAnyInstance(input, threadKey),
      ).length,
      threadKeys,
    });
  }

  const threads: StarMapViewThread[] = [];
  const instances = [];
  for (const [instanceId, instanceThreads] of input.threadsByInstance) {
    const instanceLabel = input.instanceLabels.get(instanceId) ?? instanceId;
    let visibleThreadCount = 0;
    for (const thread of instanceThreads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const cardKey = cardKeyOf(instanceId, threadKey);
      const visible = input.visibleCardKeys.has(cardKey);
      if (visible) visibleThreadCount += 1;
      const rect = input.cardRects?.get(cardKey);
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
        pinned: isPinnedThread(thread) ? true : undefined,
        attention: threadAttentionCategories(thread, input.sessionKeys),
        projectLabel: threadProjectLabel(thread),
      });
    }
    instances.push({
      instanceId,
      label: instanceLabel,
      isLocal: instanceId === input.localInstanceId,
      icon: input.instanceIcons?.get(instanceId),
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

function isDrawnInAnyInstance(
  input: StarMapViewSnapshotInput,
  threadKey: string,
): boolean {
  for (const instanceId of input.threadsByInstance.keys()) {
    if (input.visibleCardKeys.has(cardKeyOf(instanceId, threadKey))) {
      return true;
    }
  }
  return false;
}
