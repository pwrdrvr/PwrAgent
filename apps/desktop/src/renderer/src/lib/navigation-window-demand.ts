import type {
  FederationTarget, NavigationDirectoryRow, NavigationIdentity, NavigationQueryRequest,
} from "@pwragent/shared";
import { navigationIdentityKey } from "./navigation-query-state";

/** Demand is explicit window state; a missing page never implies a missing item. */
export function buildNavigationWindowDemand(params: {
  browseMode: "attention" | "drafts" | "inbox" | "recents" | "directories";
  target?: FederationTarget;
  attentionView: NonNullable<NavigationQueryRequest["attentionView"]>;
  directories: readonly NavigationDirectoryRow[];
  /** Index membership is distinct from selected descriptors retained outside that page. */
  indexedDirectoryKeys?: ReadonlySet<string>;
  expandedByKey: Readonly<Record<string, boolean>>;
  unpinnedExpandedByKey: Readonly<Record<string, boolean>>;
  selectedDirectoryKeys?: readonly string[];
  /** Confirmed owner removals remain hidden while older descriptor pages are retained. */
  removedDirectoryKeys?: readonly string[];
  selectedRef?: NavigationIdentity;
  selectedRootRef?: NavigationIdentity;
  selectedContextReady?: boolean;
  disclosedParents?: readonly NavigationIdentity[];
  /** Viewer-owned draft identities only. Grouped and bounded per owner below; no draft text. */
  draftRefs?: readonly NavigationIdentity[];
}): Map<string, NavigationQueryRequest> {
  const demand = new Map<string, NavigationQueryRequest>();
  const request = (query: NavigationQueryRequest["query"], pageSize = 10): NavigationQueryRequest => ({
    protocol: 2, inventory: params.target?.scope === "remote" ? "owner" : "viewer",
    consumer: "main-sidebar", federationTarget: params.target,
    attentionView: params.attentionView, pageSize, query,
  });
  // Descriptors provide authoritative counts for collapsed directories and all lenses.
  demand.set("directory-index", request({ kind: "directory-index" }, 100));
  if (params.selectedRef) {
    demand.set("selected-context", { ...request({ kind: "exact", identities: [params.selectedRef], includeAncestry: true }, 100), inventory: "owner",
      federationTarget: params.selectedRef.ownerInstanceId ? { scope: "remote", instanceId: params.selectedRef.ownerInstanceId } : params.target });
  }
  if (params.selectedRef?.ownerInstanceId && params.target?.scope !== "remote") {
    demand.set("selected-viewer-mount", request({ kind: "exact", identities: [params.selectedRef] }, 1));
  }
  const loadedDirectoryKeys = params.indexedDirectoryKeys ?? new Set(params.directories.map((directory) => directory.key));
  const missingSelectedDirectories = (params.selectedDirectoryKeys ?? []).filter((key) => !loadedDirectoryKeys.has(key) && !params.removedDirectoryKeys?.includes(key));
  if (missingSelectedDirectories.length) {
    demand.set("selected-directories", request({ kind: "directory-index", keys: missingSelectedDirectories }, 100));
  }
  if (params.browseMode === "directories") {
    const orderedDirectories = [...params.directories].sort((left, right) => Number(params.selectedDirectoryKeys?.includes(right.key) ?? false) - Number(params.selectedDirectoryKeys?.includes(left.key) ?? false));
    for (const directory of orderedDirectories) {
      if (params.removedDirectoryKeys?.includes(directory.key)) continue;
      const expanded = params.expandedByKey[directory.key] ?? params.selectedDirectoryKeys?.includes(directory.key) ?? false;
      if (!expanded) continue;
      const selectedDirectory = params.selectedDirectoryKeys?.includes(directory.key);
      if (selectedDirectory && params.selectedRef && params.selectedContextReady === false) continue;
      const showUnpinned = params.unpinnedExpandedByKey[directory.key] ?? !directory.directoryThreadsCollapsed;
      demand.set(`directory:${directory.key}`, { ...request({ kind: "directory", directoryKey: directory.key,
        roots: showUnpinned ? "all" : "pinned" }),
        ...(selectedDirectory && params.selectedRootRef ? { anchor: { kind: "thread" as const, ref: params.selectedRootRef } } : {}),
      });
    }

  } else if (params.browseMode === "drafts") {
    const owners = new Map<string, NavigationIdentity[]>();
    for (const ref of params.draftRefs ?? []) {
      const owner = ref.ownerInstanceId ?? "";
      const refs = owners.get(owner) ?? [];
      refs.push(ref);
      owners.set(owner, refs);
    }
    for (const [owner, refs] of owners) {
      for (let offset = 0; offset < refs.length; offset += 100) {
        demand.set(`drafts:${JSON.stringify(owner)}:${offset}`, {
          ...request({ kind: "exact", identities: refs.slice(offset, offset + 100), includeAncestry: true }),
          inventory: "owner", federationTarget: owner ? { scope: "remote", instanceId: owner } : undefined,
        });
      }
    }
  } else {
    demand.set("lens", request({ kind: "lens", lens: params.browseMode }));
  }
  for (const parent of params.disclosedParents ?? []) {
    demand.set(`children:${navigationIdentityKey(parent)}`, { ...request({ kind: "children", parent }),
      inventory: parent.ownerInstanceId || params.target?.scope === "remote" ? "owner" : "viewer",
      federationTarget: parent.ownerInstanceId ? { scope: "remote", instanceId: parent.ownerInstanceId } : params.target,
    });
  }
  return demand;
}

/** Child pages are useful only while their disclosed parent is reachable from a visible collection. */
export function visibleDisclosedNavigationParents(params: {
  collectionIds: Iterable<string>;
  pages: ReadonlyMap<string, import("@pwragent/shared").NavigationQueryPage>;
  disclosedParents: readonly NavigationIdentity[];
}): NavigationIdentity[] {
  const candidates = new Map(params.disclosedParents.map((ref) => [navigationIdentityKey(ref), ref]));
  const visible = new Map<string, NavigationIdentity>();
  const pending = [...params.collectionIds].filter((id) => id === "lens" || id.startsWith("directory:") || id.startsWith("drafts:"));
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const entry of params.pages.get(id)?.entries ?? []) {
      const key = navigationIdentityKey(entry.row.ref);
      const parent = candidates.get(key);
      if (!parent || visible.has(key)) continue;
      visible.set(key, parent);
      pending.push(`children:${key}`);
    }
  }
  return [...visible.values()];
}

/** Visible viewer mounts resolve row metadata from their explicit owners through the shared query pool. */
export function addVisibleMountedOwnerDemand(params: {
  demand: Map<string, NavigationQueryRequest>;
  pages: ReadonlyMap<string, import("@pwragent/shared").NavigationQueryPage>;
  target?: FederationTarget;
  selectedRef?: NavigationIdentity;
}): void {
  if (params.target?.scope === "remote") return;
  const owners = new Map<string, Map<string, NavigationIdentity>>();
  for (const [id, request] of params.demand) {
    if (request.federationTarget?.scope === "remote"
      || !(id === "lens" || id.startsWith("directory:") || id.startsWith("children:"))) continue;
    for (const { row } of params.pages.get(id)?.entries ?? []) {
      const owner = row.ref.ownerInstanceId;
      if (!owner || (params.selectedRef && navigationIdentityKey(params.selectedRef) === navigationIdentityKey(row.ref))) continue;
      const refs = owners.get(owner) ?? new Map<string, NavigationIdentity>();
      refs.set(navigationIdentityKey(row.ref), row.ref);
      owners.set(owner, refs);
    }
  }
  for (const [owner, byKey] of owners) {
    const refs = [...byKey].sort(([left], [right]) => left.localeCompare(right)).map(([, ref]) => ref);
    for (let offset = 0; offset < refs.length; offset += 100) {
      params.demand.set(`visible-owner:${JSON.stringify(owner)}:${offset}`, {
        protocol: 2, inventory: "owner", consumer: "main-sidebar", federationTarget: { scope: "remote", instanceId: owner },
        query: { kind: "exact", identities: refs.slice(offset, offset + 100) }, pageSize: 100,
      });
    }
  }
}
