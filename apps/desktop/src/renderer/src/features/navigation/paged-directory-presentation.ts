import { readNavigationPresentationOrder, type NavigationPresentationOrder } from "./navigation-presentation-order";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { isPinnedThread } from "@pwragent/shared";
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
  const roots = (presentation.get(`directory:${params.directory.key}`) ?? []).filter((entry) => entry.placement.kind === "root")
    .map((entry) => params.threadsByKey.get(entry.key)).filter((thread): thread is NavigationThreadSummary => Boolean(thread));
  const childThreadsByParentKey = new Map<string, NavigationThreadSummary[]>();
  for (const resource of params.resources.values()) {
    if (resource.state.request.query.kind !== "children") continue;
    for (const entry of presentation.get(resource.id) ?? []) {
      if (entry.placement.kind !== "child") continue;
      const parentKey = navigationThreadSelectionKey(entry.placement.parent);
      const children = childThreadsByParentKey.get(parentKey) ?? [];
      const row = params.threadsByKey.get(entry.key);
      if (!row) continue;
      children.push(row);
      childThreadsByParentKey.set(parentKey, children);
    }
  }
  const directoryPinnedThreads = roots.filter(isPinnedThread);
  const directoryThreadsCollapsed = params.directory.directoryThreadsCollapsed === true;
  const unpinnedThreads = directoryThreadsCollapsed ? [] : roots.filter((thread) => !isPinnedThread(thread));
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
