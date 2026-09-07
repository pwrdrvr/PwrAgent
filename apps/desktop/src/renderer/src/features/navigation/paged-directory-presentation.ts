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
  resources: NavigationWindowQueriesState["resources"];
  threadsByKey: ReadonlyMap<string, NavigationThreadSummary>;
}): PagedDirectoryPresentation {
  const rootPage = params.resources.get(`directory:${params.directory.key}`)?.state.page;
  const roots = (rootPage?.entries ?? []).filter((entry) => entry.placement.kind === "root")
    .map((entry) => params.threadsByKey.get(navigationThreadSelectionKey(entry.row.ref))).filter((thread): thread is NavigationThreadSummary => Boolean(thread));
  const childThreadsByParentKey = new Map<string, NavigationThreadSummary[]>();
  for (const resource of params.resources.values()) {
    if (resource.state.request.query.kind !== "children") continue;
    for (const entry of resource.state.page?.entries ?? []) {
      if (entry.placement.kind !== "child") continue;
      const parentKey = navigationThreadSelectionKey(entry.placement.parent);
      const children = childThreadsByParentKey.get(parentKey) ?? [];
      const row = params.threadsByKey.get(navigationThreadSelectionKey(entry.row.ref));
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
