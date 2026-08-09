import type {
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  comparePinnedThreads,
  isPinnedThread,
  resolveThreadParentKey,
  sortSubthreadSummaries,
} from "@pwragent/shared";
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
  childThreadsByParentKey: Map<string, NavigationThreadSummary[]>;
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
  const childThreadCandidates: NavigationThreadSummary[] = [];
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
      childThreadCandidates.push(thread);
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

  const directoryPinnedThreads = topLevelVisibleThreads
    .filter(isPinnedThread)
    .sort(comparePinnedThreads);
  const directoryUnpinnedThreadCount =
    topLevelVisibleThreads.length - directoryPinnedThreads.length;
  const directoryThreadsCollapsed =
    directoryPinnedThreads.length > 0
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
      buildThreadIdentityKey(thread.source, thread.id) ===
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
  const renderedParentKeys = new Set(
    [...directoryPinnedThreads, ...visibleUnpinnedThreads].map((thread) =>
      buildThreadIdentityKey(thread.source, thread.id),
    ),
  );
  const childThreadsByParentKey = new Map<
    string,
    NavigationThreadSummary[]
  >();
  for (const thread of childThreadCandidates) {
    const parentKey = resolveThreadParentKey(thread, params.threadsByKey);
    if (!parentKey || !renderedParentKeys.has(parentKey)) continue;
    const children = childThreadsByParentKey.get(parentKey) ?? [];
    children.push(thread);
    childThreadsByParentKey.set(parentKey, children);
  }
  const selectionOrder = [
    ...directoryPinnedThreads,
    ...visibleUnpinnedThreads,
  ].flatMap((thread) => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    const children = sortSubthreadSummaries(
      thread,
      childThreadsByParentKey.get(threadKey) ?? [],
    );
    return [
      threadKey,
      ...(thread.subthreadsCollapsed
        ? []
        : children.map((child) =>
            buildThreadIdentityKey(child.source, child.id),
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
