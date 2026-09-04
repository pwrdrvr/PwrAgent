import type {
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  comparePinnedThreads,
  isPinnedThread,
  resolveThreadParentKey,
  sortSubthreadSummaries,
} from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import {
  isThreadActive,
  isThreadAwaitingReview,
} from "./ThreadRowStatus";

/**
 * Cap on how many unpinned threads an expanded directory renders before the
 * rest sit behind its Show more disclosure.
 */
export const DIRECTORY_UNPINNED_THREAD_CAP = 10;

export type ExpandedDirectoryThreadRenderModel = {
  cappedUnpinnedThreads: NavigationThreadSummary[];
  /**
   * Rendered row key to the whole descendant subtree it displays, depth-first
   * and already ordered. Consumers render this list as-is; re-sorting it by
   * the tray owner's `subthreadOrder` would scatter grandchildren away from
   * their parents, because that order only names direct children.
   */
  childThreadsByParentKey: Map<string, NavigationThreadSummary[]>;
  /**
   * Rendered row key to the ordered keys of its *direct* children — the only
   * rows a tray reorder may move, because `subthreadOrder` is stored per
   * parent. Writing a whole flattened tray back would list grandchildren as
   * children of the row they merely render under.
   */
  directChildKeysByParentKey: Map<string, string[]>;
  directoryPinnedThreads: NavigationThreadSummary[];
  directoryThreadsCollapsed: boolean;
  directoryUnpinnedThreadCount: number;
  hiddenUnpinnedCount: number;
  overflowUnpinnedThreads: NavigationThreadSummary[];
  selectionOrder: string[];
  unpinnedExpanded: boolean;
};

export type DirectoryThreadRenderModel = {
  activeThreadCount: number;
  reviewThreadCount: number;
  visibleThreadCount: number;
  /**
   * Absent for a collapsed project row. Keeping this boundary explicit stops
   * a closed directory from building parent maps, sorting pins, slicing its
   * overflow, and deriving selection order for UI that cannot render.
   */
  expanded?: ExpandedDirectoryThreadRenderModel;
};

export function buildDirectoryThreadRenderModel(params: {
  directory: NavigationDirectorySummary;
  expanded: boolean;
  selectedItemKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threadsByKey: ReadonlyMap<string, NavigationThreadSummary>;
  unpinnedExpanded?: boolean;
}): DirectoryThreadRenderModel {
  let activeThreadCount = 0;
  let reviewThreadCount = 0;
  let visibleThreadCount = 0;
  const directoryThreadKeys = params.expanded
    ? new Set(params.directory.threadKeys)
    : undefined;
  const topLevelVisibleThreads: NavigationThreadSummary[] = [];
  // The parent key is resolved once here and carried, because the later
  // nesting pass would otherwise walk `threadsByKey` for every child again.
  const childThreadCandidates: Array<{
    parentKey: string;
    thread: NavigationThreadSummary;
  }> = [];
  for (const threadKey of params.directory.threadKeys) {
    const thread = params.threadsByKey.get(threadKey);
    if (!thread) continue;
    visibleThreadCount += 1;
    if (isThreadActive(thread, params.thinkingThreadKeys)) {
      activeThreadCount += 1;
    } else if (isThreadAwaitingReview(thread)) {
      // A live turn can also be in the Inbox after emitting new output. Keep
      // it in the activity count only, so a directory never reports the same
      // thread as both active and waiting to be reviewed.
      reviewThreadCount += 1;
    }
    if (!directoryThreadKeys) continue;
    if (!thread.parentThreadId) {
      topLevelVisibleThreads.push(thread);
      continue;
    }
    const parentKey = resolveThreadParentKey(thread, params.threadsByKey);
    if (parentKey && directoryThreadKeys.has(parentKey)) {
      childThreadCandidates.push({ parentKey, thread });
    } else {
      topLevelVisibleThreads.push(thread);
    }
  }

  if (!params.expanded) {
    return {
      activeThreadCount,
      reviewThreadCount,
      visibleThreadCount,
    };
  }

  const topLevelPinnedThreads = topLevelVisibleThreads.filter(isPinnedThread);
  const directoryUnpinnedThreadCount =
    topLevelVisibleThreads.length - topLevelPinnedThreads.length;
  const directoryThreadsCollapsed =
    topLevelPinnedThreads.length > 0
    && params.directory.directoryThreadsCollapsed === true;
  // A sticky Directory threads collapse only renders pins. Keep its large
  // hidden population as a count instead of allocating and slicing three
  // arrays that no JSX will consume.
  const unpinnedThreads = directoryThreadsCollapsed
    ? []
    : topLevelVisibleThreads.filter((thread) => !isPinnedThread(thread));
  const cappedUnpinnedThreads = directoryThreadsCollapsed
    ? []
    : unpinnedThreads.slice(0, DIRECTORY_UNPINNED_THREAD_CAP);
  const overflowUnpinnedThreads = directoryThreadsCollapsed
    ? []
    : unpinnedThreads.slice(DIRECTORY_UNPINNED_THREAD_CAP);
  const hiddenUnpinnedCount = directoryThreadsCollapsed
    ? directoryUnpinnedThreadCount
    : overflowUnpinnedThreads.length;
  const selectedUnpinnedInOverflow = overflowUnpinnedThreads.some(
    (thread) =>
      threadSummaryIdentityKey(thread) ===
      params.selectedItemKey,
  );
  const unpinnedExpanded =
    params.unpinnedExpanded ?? selectedUnpinnedInOverflow;
  const visibleUnpinnedThreads = directoryThreadsCollapsed
    ? []
    : [
        ...cappedUnpinnedThreads,
        ...(unpinnedExpanded ? overflowUnpinnedThreads : []),
      ];
  const childrenByParentKey = new Map<string, NavigationThreadSummary[]>();
  for (const { parentKey, thread } of childThreadCandidates) {
    const siblings = childrenByParentKey.get(parentKey) ?? [];
    siblings.push(thread);
    childrenByParentKey.set(parentKey, siblings);
  }
  // One tray per rendered row, holding that row's whole descendant subtree in
  // depth-first order. Sub-threads nest at their true depth in the data; only
  // the view is one level deep, and depth-first keeps a sub-thread immediately
  // after the thread that created it — the same trade
  // `groupCodexNativeSubAgents` makes for native workers. Collapsing the
  // relationship itself instead would leave a grandchild pointing at a row it
  // does not belong to.
  const childThreadsByParentKey = new Map<string, NavigationThreadSummary[]>();
  const directChildKeysByParentKey = new Map<string, string[]>();
  const placedThreadKeys = new Set<string>();
  const collectSubtree = (
    trayKey: string,
    parent: NavigationThreadSummary,
    parentKey: string,
  ): void => {
    const children = sortSubthreadSummaries(
      parent,
      childrenByParentKey.get(parentKey) ?? [],
    );
    if (parentKey === trayKey) {
      directChildKeysByParentKey.set(
        trayKey,
        children.map((child) => threadSummaryIdentityKey(child)),
      );
    }
    for (const child of children) {
      const childKey = threadSummaryIdentityKey(child);
      // A cycle in the stored parent links, or a thread already placed under
      // an earlier tray, must not render twice or recurse forever.
      if (placedThreadKeys.has(childKey)) continue;
      placedThreadKeys.add(childKey);
      const tray = childThreadsByParentKey.get(trayKey) ?? [];
      tray.push(child);
      childThreadsByParentKey.set(trayKey, tray);
      collectSubtree(trayKey, child, childKey);
    }
  };
  for (const thread of [...topLevelPinnedThreads, ...visibleUnpinnedThreads]) {
    const threadKey = threadSummaryIdentityKey(thread);
    placedThreadKeys.add(threadKey);
    collectSubtree(threadKey, thread, threadKey);
  }
  // A pinned sub-thread must never be swallowed by an ancestor that does not
  // render. The collapse hides every unpinned row, so a pin under one of them
  // would otherwise drop a row the directory still reports as pinned —
  // including the visibility pin the main process appends at creation time.
  // Give it a top-level pinned row, and let its own subtree follow it there.
  const promotedPinnedChildren: NavigationThreadSummary[] = [];
  for (const { thread } of childThreadCandidates) {
    const threadKey = threadSummaryIdentityKey(thread);
    if (placedThreadKeys.has(threadKey) || !isPinnedThread(thread)) continue;
    placedThreadKeys.add(threadKey);
    promotedPinnedChildren.push(thread);
    collectSubtree(threadKey, thread, threadKey);
  }
  const directoryPinnedThreads =
    promotedPinnedChildren.length === 0
      ? topLevelPinnedThreads
      : [...topLevelPinnedThreads, ...promotedPinnedChildren];
  directoryPinnedThreads.sort(comparePinnedThreads);
  const selectionOrder = [
    ...directoryPinnedThreads,
    ...visibleUnpinnedThreads,
  ].flatMap((thread) => {
    const threadKey = threadSummaryIdentityKey(thread);
    return [
      threadKey,
      ...(thread.subthreadsCollapsed
        ? []
        : (childThreadsByParentKey.get(threadKey) ?? []).map((child) =>
            threadSummaryIdentityKey(child),
          )),
    ];
  });

  return {
    activeThreadCount,
    reviewThreadCount,
    visibleThreadCount,
    expanded: {
      cappedUnpinnedThreads,
      childThreadsByParentKey,
      directChildKeysByParentKey,
      directoryPinnedThreads,
      directoryThreadsCollapsed,
      directoryUnpinnedThreadCount,
      hiddenUnpinnedCount,
      overflowUnpinnedThreads,
      selectionOrder,
      unpinnedExpanded,
    },
  };
}
