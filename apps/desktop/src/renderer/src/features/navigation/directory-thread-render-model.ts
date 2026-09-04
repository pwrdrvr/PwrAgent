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
  const renderedParentKeys = new Set(
    [...topLevelPinnedThreads, ...visibleUnpinnedThreads].map((thread) =>
      threadSummaryIdentityKey(thread),
    ),
  );
  // A pinned sub-thread must never be swallowed by a parent that does not
  // render. The collapse hides every unpinned row, and a group parent that
  // aged out of the navigation window is in no directory at all, so nesting
  // alone would drop a row the directory still reports as pinned — including
  // the visibility pin the main process appends at creation time. Give it a
  // top-level pinned row instead.
  const promotedPinnedChildren = childThreadCandidates.filter(
    (candidate) =>
      isPinnedThread(candidate.thread)
      && !renderedParentKeys.has(candidate.parentKey),
  );
  const directoryPinnedThreads =
    promotedPinnedChildren.length === 0
      ? topLevelPinnedThreads
      : [
          ...topLevelPinnedThreads,
          ...promotedPinnedChildren.map((candidate) => candidate.thread),
        ];
  directoryPinnedThreads.sort(comparePinnedThreads);
  const promotedThreadKeys = new Set(
    promotedPinnedChildren.map((candidate) =>
      threadSummaryIdentityKey(candidate.thread),
    ),
  );
  for (const threadKey of promotedThreadKeys) {
    renderedParentKeys.add(threadKey);
  }
  const childThreadsByParentKey = new Map<
    string,
    NavigationThreadSummary[]
  >();
  for (const { parentKey, thread } of childThreadCandidates) {
    if (!renderedParentKeys.has(parentKey)) continue;
    // A promotion already gave this row its own top-level place. Nesting it
    // under a parent that a later promotion made visible would render it
    // twice.
    if (promotedThreadKeys.has(threadSummaryIdentityKey(thread))) continue;
    const children = childThreadsByParentKey.get(parentKey) ?? [];
    children.push(thread);
    childThreadsByParentKey.set(parentKey, children);
  }
  const selectionOrder = [
    ...directoryPinnedThreads,
    ...visibleUnpinnedThreads,
  ].flatMap((thread) => {
    const threadKey = threadSummaryIdentityKey(thread);
    const children = sortSubthreadSummaries(
      thread,
      childThreadsByParentKey.get(threadKey) ?? [],
    );
    return [
      threadKey,
      ...(thread.subthreadsCollapsed
        ? []
        : children.map((child) =>
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
