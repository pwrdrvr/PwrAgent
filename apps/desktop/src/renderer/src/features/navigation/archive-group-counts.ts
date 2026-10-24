import type { NavigationThreadSummary } from "@pwragent/shared";
import { resolveThreadParentKey } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import type { NavigationPresentedThread } from "../../lib/navigation-loaded-rows";

export type ArchiveGroupCounts = {
  /** Direct sub-threads that "Archive Thread Only" ungroups. */
  childCount: number;
  /** The parent plus every sub-thread "Archive + Sub-Threads" removes. */
  threadCount: number;
  /**
   * False when some sub-threads are not loaded, as under a collapsed parent.
   * Those may have sub-threads of their own, so `threadCount` is a floor.
   */
  exact: boolean;
};

/**
 * Counts a parent's archive group from what the sidebar already holds. A
 * collapsed parent's sub-threads are never loaded, so each row's
 * owner-reported `ordinaryChildCount` fills in what the list lacks. Reading
 * the complete group is a paged owner query, too heavy for opening a menu;
 * the archive itself still runs that query.
 */
export function countArchiveGroup(
  parent: NavigationPresentedThread,
  threads: readonly NavigationPresentedThread[],
  threadsByKey: ReadonlyMap<string, NavigationThreadSummary>,
): ArchiveGroupCounts {
  const loadedChildren = new Map<string, NavigationPresentedThread[]>();
  for (const thread of threads) {
    const parentKey = resolveThreadParentKey(thread, threadsByKey);
    if (parentKey === undefined) continue;
    const siblings = loadedChildren.get(parentKey);
    if (siblings) siblings.push(thread);
    else loadedChildren.set(parentKey, [thread]);
  }

  const parentKey = threadSummaryIdentityKey(parent);
  const reportedChildren = (thread: NavigationPresentedThread, loaded: number): number =>
    Math.max(thread.ordinaryChildCount ?? 0, loaded);
  const childCount = reportedChildren(
    parent,
    loadedChildren.get(parentKey)?.length ?? 0,
  );

  let threadCount = 1;
  let exact = true;
  const visited = new Set([parentKey]);
  const pending: NavigationPresentedThread[] = [parent];
  while (pending.length > 0) {
    const thread = pending.pop()!;
    const children = loadedChildren.get(threadSummaryIdentityKey(thread)) ?? [];
    const unloaded = reportedChildren(thread, children.length) - children.length;
    if (unloaded > 0) {
      threadCount += unloaded;
      exact = false;
    }
    for (const child of children) {
      const childKey = threadSummaryIdentityKey(child);
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      threadCount += 1;
      pending.push(child);
    }
  }

  return { childCount, threadCount, exact };
}
