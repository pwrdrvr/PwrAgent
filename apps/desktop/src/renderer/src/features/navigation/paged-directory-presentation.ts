import { readNavigationPresentationOrder, type NavigationPresentationOrder } from "./navigation-presentation-order";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { comparePinnedThreads, isPinnedThread } from "@pwragent/shared";
import type { NavigationDirectoryView } from "../../lib/navigation-loaded-rows";
import type { NavigationWindowQueriesState } from "../../lib/navigation-window-queries";
import { navigationThreadSelectionKey } from "../../lib/navigation-query-state";
export type PagedDirectoryPresentation = {
  directoryPinnedThreads: NavigationThreadSummary[];
  unpinnedThreads: NavigationThreadSummary[];
  childThreadsByParentKey: Map<string, NavigationThreadSummary[]>;
  directoryThreadsCollapsed: boolean;
  directoryUnpinnedThreadCount: number;
  selectionOrder: string[];
};

/** Presentation of admitted entries only. Placement and counts remain owner authority. */
export function buildPagedDirectoryPresentation(params: {
  directory: NavigationDirectoryView;
  presentationOrder?: NavigationPresentationOrder;
  resources: NavigationWindowQueriesState["resources"];
  threadsByKey: ReadonlyMap<string, NavigationThreadSummary>;
}): PagedDirectoryPresentation {
  const presentation = params.presentationOrder ?? readNavigationPresentationOrder(params.resources);
  const rootEntries = [...(presentation.get(`directory-pins:${params.directory.key}`) ?? []),
    ...(presentation.get(`directory:${params.directory.key}`) ?? [])];
  const seen = new Set<string>();
  const roots = rootEntries.filter((entry) => {
    if (entry.placement.kind !== "root" || seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  })
    .map((entry) => params.threadsByKey.get(entry.key)).filter((thread): thread is NavigationThreadSummary => Boolean(thread));
  const childThreadsByParentKey = new Map<string, NavigationThreadSummary[]>();
  for (const resource of params.resources.values()) {
    if (resource.state.request.query.kind !== "children") continue;
    for (const entry of presentation.get(resource.id) ?? []) {
      if (entry.placement.kind !== "child") continue;
      const parentKey = navigationThreadSelectionKey(entry.placement.parent);
      const children = childThreadsByParentKey.get(parentKey) ?? [];
      const row = params.threadsByKey.get(entry.key);
      if (!row || children.some((child) => threadSummaryIdentityKey(child) === entry.key)) continue;
      children.push(row);
      childThreadsByParentKey.set(parentKey, children);
    }
  }
  const directoryPinnedThreads = roots.filter(isPinnedThread);
  // Selection is an independent exact read, not a replacement pin range.
  // Admit only its root in this directory; keep page membership and cursors
  // untouched so revealing a newly appended pin cannot discard earlier pins.
  const selected = params.resources.get("selected-viewer-mount")?.state.page
    ?? params.resources.get("selected-context")?.state.page;
  const selectedEntry = selected?.entries.find((entry) => entry.placement.kind === "root");
  const selectedThread = selectedEntry && params.threadsByKey.get(navigationThreadSelectionKey(selectedEntry.row.ref));
  const pinResource = params.resources.get(`directory-pins:${params.directory.key}`);
  if (pinResource && selectedThread && isPinnedThread(selectedThread)
    && selected?.selectionDirectory?.key === params.directory.key
    && !directoryPinnedThreads.some((thread) => threadSummaryIdentityKey(thread) === threadSummaryIdentityKey(selectedThread))) {
    const before = directoryPinnedThreads.findIndex((thread) => comparePinnedThreads(selectedThread, thread) < 0);
    directoryPinnedThreads.splice(before < 0 ? directoryPinnedThreads.length : before, 0, selectedThread);
  }
  const directoryThreadsCollapsed = params.directory.directoryThreadsCollapsed === true;
  const unpinnedThreads = directoryThreadsCollapsed ? [] : roots.filter((thread) => !isPinnedThread(thread));
  // Exact ancestry also admits the selected child while its independently
  // paged siblings are loading (or the child lies beyond their loaded range).
  // Do not change that range's membership or continuation cursor.
  if (selected?.selectionDirectory?.key === params.directory.key) {
    const visibleParents = new Set([...directoryPinnedThreads, ...unpinnedThreads].map(threadSummaryIdentityKey));
    for (const entry of selected.entries) {
      if (entry.placement.kind !== "child") continue;
      const parentKey = navigationThreadSelectionKey(entry.placement.parent);
      if (!visibleParents.has(parentKey)) continue;
      const key = navigationThreadSelectionKey(entry.row.ref);
      const child = params.threadsByKey.get(key);
      const children = childThreadsByParentKey.get(parentKey) ?? [];
      if (child && !children.some((row) => threadSummaryIdentityKey(row) === key)) {
        childThreadsByParentKey.set(parentKey, [...children, child]);
      }
    }
  }
  return {
    directoryPinnedThreads, unpinnedThreads, childThreadsByParentKey, directoryThreadsCollapsed,
    directoryUnpinnedThreadCount: params.directory.unpinnedRootCount ?? 0,
    selectionOrder: [...directoryPinnedThreads, ...unpinnedThreads].flatMap((thread) => {
      const key = threadSummaryIdentityKey(thread);
      return [key, ...(thread.subthreadsCollapsed ? [] : (childThreadsByParentKey.get(key) ?? []).map((child) =>
        threadSummaryIdentityKey(child)))];
    }),
  };
}
