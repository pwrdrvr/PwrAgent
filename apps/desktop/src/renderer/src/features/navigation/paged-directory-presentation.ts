import { readNavigationPresentationOrder, readOwnerChildOrder, type NavigationPresentationOrder } from "./navigation-presentation-order";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { comparePinnedThreads, isPinnedThread } from "@pwragent/shared";
import type { NavigationDirectoryView } from "../../lib/navigation-loaded-rows";
import type { NavigationWindowQueriesState } from "../../lib/navigation-window-queries";
import { navigationThreadSelectionKey } from "../../lib/navigation-query-state";
export type PagedDirectoryPresentation = {
  directoryPinnedThreads: NavigationThreadSummary[];
  unpinnedThreads: NavigationThreadSummary[];
  selectedUnpinnedThreads: NavigationThreadSummary[];
  childThreadsByParentKey: Map<string, NavigationThreadSummary[]>;
  /** Each parent's child keys in its owner's saved order. */
  ownerChildOrder: Map<string, string[]>;
  /** Directory-scoped counts remain separate from globally refreshed row metadata. */
  ordinaryChildCounts: Map<string, number>;
  directoryThreadsCollapsed: boolean;
  directoryUnpinnedThreadCount: number;
};

type DirectoryChildren = Pick<PagedDirectoryPresentation, "childThreadsByParentKey" | "ownerChildOrder" | "ordinaryChildCounts">;
export type PagedDirectoryChildren = Map<string, DirectoryChildren>;

/** Child pages belong to the window, not to each expanded directory. */
export function buildPagedDirectoryChildren(params: {
  presentationOrder?: NavigationPresentationOrder;
  resources: NavigationWindowQueriesState["resources"];
  threadsByKey: ReadonlyMap<string, NavigationThreadSummary>;
}): PagedDirectoryChildren {
  const presentation = params.presentationOrder ?? readNavigationPresentationOrder(params.resources);
  const directories: PagedDirectoryChildren = new Map();
  const seenByScopeAndParent = new Map<string, Set<string>>();
  const ownerChildOrder = readOwnerChildOrder(params.resources, presentation);
  for (const resource of params.resources.values()) {
    const query = resource.state.request.query;
    if (query.kind !== "children" || query.directoryKey === undefined) continue;
    let directory = directories.get(query.directoryKey);
    if (!directory) {
      directory = { childThreadsByParentKey: new Map(), ownerChildOrder, ordinaryChildCounts: new Map() };
      directories.set(query.directoryKey, directory);
    }
    for (const { row } of resource.state.page?.entries ?? []) {
      directory.ordinaryChildCounts.set(navigationThreadSelectionKey(row.ref), row.ordinaryChildCount);
    }
    for (const entry of presentation.get(resource.id) ?? []) {
      if (entry.placement.kind !== "child") continue;
      const parentKey = navigationThreadSelectionKey(entry.placement.parent);
      const bucketKey = JSON.stringify([query.directoryKey, parentKey]);
      const seen = seenByScopeAndParent.get(bucketKey) ?? new Set<string>();
      const row = params.threadsByKey.get(entry.key);
      const children = directory.childThreadsByParentKey.get(parentKey) ?? [];
      if (!row || seen.has(entry.key)) continue;
      seen.add(entry.key);
      seenByScopeAndParent.set(bucketKey, seen);
      children.push(row);
      directory.childThreadsByParentKey.set(parentKey, children);
    }
  }
  return directories;
}

/** Presentation of admitted entries only. Placement and counts remain owner authority. */
export function buildPagedDirectoryPresentation(params: {
  directory: NavigationDirectoryView;
  presentationOrder?: NavigationPresentationOrder;
  resources: NavigationWindowQueriesState["resources"];
  threadsByKey: ReadonlyMap<string, NavigationThreadSummary>;
  children?: PagedDirectoryChildren;
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
  const children: DirectoryChildren = (params.children ?? buildPagedDirectoryChildren({ ...params, presentationOrder: presentation })).get(params.directory.key)
    ?? { childThreadsByParentKey: new Map(), ownerChildOrder: new Map(), ordinaryChildCounts: new Map() };
  let childThreadsByParentKey = children.childThreadsByParentKey;
  const ordinaryChildCounts = new Map(children.ordinaryChildCounts);
  for (const id of [`directory-pins:${params.directory.key}`, `directory:${params.directory.key}`]) {
    for (const { row } of params.resources.get(id)?.state.page?.entries ?? []) {
      ordinaryChildCounts.set(navigationThreadSelectionKey(row.ref), row.ordinaryChildCount);
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
  // An all-pinned project has no Directory threads disclosure. Keep a new
  // starting row with the pins, matching the owner's automatic pin decision.
  const directoryThreadsCollapsed = params.directory.directoryThreadsCollapsed === true
    || ((params.directory.pinnedRootCount ?? 0) > 0 && params.directory.unpinnedRootCount === 0);
  const unpinnedThreads = directoryThreadsCollapsed ? [] : roots.filter((thread) => !isPinnedThread(thread));
  // Keep the open transcript (or its root ancestor) above the collapsed
  // disclosure without claiming that it has a saved pin.
  const selectedUnpinnedThreads = directoryThreadsCollapsed
    && selected?.selectionDirectory?.key === params.directory.key
    && selectedThread && !isPinnedThread(selectedThread)
    ? [selectedThread] : [];
  // Exact ancestry also admits the selected child while its independently
  // paged siblings are loading (or the child lies beyond their loaded range).
  // Do not change that range's membership or continuation cursor.
  if (selected?.selectionDirectory?.key === params.directory.key) {
    // An off-page selection augments this directory only. Do not mutate the
    // window's shared membership projection or another directory's view.
    childThreadsByParentKey = new Map(childThreadsByParentKey);
    const visibleParents = new Set([...directoryPinnedThreads, ...selectedUnpinnedThreads, ...unpinnedThreads].map(threadSummaryIdentityKey));
    for (const entry of selected.entries) {
      const key = navigationThreadSelectionKey(entry.row.ref);
      if (!ordinaryChildCounts.has(key)) ordinaryChildCounts.set(key, entry.row.ordinaryChildCount);
      if (entry.placement.kind !== "child") continue;
      const parentKey = navigationThreadSelectionKey(entry.placement.parent);
      if (!visibleParents.has(parentKey)) continue;
      const child = params.threadsByKey.get(key);
      const children = childThreadsByParentKey.get(parentKey) ?? [];
      if (child && !children.some((row) => threadSummaryIdentityKey(row) === key)) {
        childThreadsByParentKey.set(parentKey, [...children, child]);
      }
    }
  }
  return {
    directoryPinnedThreads, unpinnedThreads, selectedUnpinnedThreads, childThreadsByParentKey,
    ownerChildOrder: children.ownerChildOrder, ordinaryChildCounts, directoryThreadsCollapsed,
    directoryUnpinnedThreadCount: params.directory.unpinnedThreadCount ?? params.directory.unpinnedRootCount ?? 0,
  };
}
