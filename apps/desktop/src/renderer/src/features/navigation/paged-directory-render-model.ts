import type { NavigationDirectoryRow, NavigationQueryEntry } from "@pwragent/shared";
import type { NavigationPageState } from "../../lib/navigation-query-state";
import { navigationIdentityKey } from "../../lib/navigation-query-state";

export type PagedDirectoryRenderModel = {
  descriptor: NavigationDirectoryRow;
  roots: NavigationQueryEntry[];
  childrenByParent: ReadonlyMap<string, readonly NavigationQueryEntry[]>;
  /** Missing parent rows never promote owner-designated children to roots. */
  unloadedParentKeys: ReadonlySet<string>;
  counts: NavigationDirectoryRow["counts"];
  pinnedRootCount: number;
  unpinnedRootCount: number;
  rootPage?: NavigationPageState;
  childPages: ReadonlyMap<string, NavigationPageState>;
};

/** Owner placement and page order are authoritative, regardless of arrival order. */
export function buildPagedDirectoryRenderModel(params: {
  descriptor: NavigationDirectoryRow;
  rootPage?: NavigationPageState;
  childPages?: ReadonlyMap<string, NavigationPageState>;
}): PagedDirectoryRenderModel {
  const roots = (params.rootPage?.page?.entries ?? []).filter((entry) => entry.placement.kind === "root");
  const rootKeys = new Set(roots.map((entry) => navigationIdentityKey(entry.row.ref)));
  const children = new Map<string, NavigationQueryEntry[]>();
  const unloadedParentKeys = new Set<string>();
  // Explicit ancestry can arrive before its root, including during selection recovery.
  const addChild = (entry: NavigationQueryEntry): void => {
    if (entry.placement.kind !== "child") return;
    const key = navigationIdentityKey(entry.placement.parent);
    if (!rootKeys.has(key)) unloadedParentKeys.add(key);
    const list = children.get(key) ?? [];
    if (!list.some((child) => navigationIdentityKey(child.row.ref) === navigationIdentityKey(entry.row.ref))) list.push(entry);
    children.set(key, list);
  };
  for (const entry of params.rootPage?.page?.entries ?? []) addChild(entry);
  const childPages = params.childPages ?? new Map();
  for (const [parentKey, state] of childPages) {
    for (const entry of state.page?.entries ?? []) {
      if (entry.placement.kind === "child" && navigationIdentityKey(entry.placement.parent) === parentKey) addChild(entry);
    }
  }
  return {
    descriptor: params.descriptor, roots, childrenByParent: children, unloadedParentKeys,
    counts: params.descriptor.counts, pinnedRootCount: params.descriptor.pinnedRootCount,
    unpinnedRootCount: params.descriptor.unpinnedRootCount, rootPage: params.rootPage, childPages,
  };
}
