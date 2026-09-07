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
    protocol: 2, consumer: "main-sidebar", federationTarget: params.target,
    attentionView: params.attentionView, pageSize, query,
  });
  // Descriptors provide authoritative counts for collapsed directories and all lenses.
  demand.set("directory-index", request({ kind: "directory-index" }, 100));
  if (params.selectedRef) {
    demand.set("selected-context", { ...request({ kind: "exact", identities: [params.selectedRef], includeAncestry: true }, 100),
      federationTarget: params.selectedRef.ownerInstanceId ? { scope: "remote", instanceId: params.selectedRef.ownerInstanceId } : params.target });
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
          federationTarget: owner ? { scope: "remote", instanceId: owner } : undefined,
        });
      }
    }
  } else {
    demand.set("lens", request({ kind: "lens", lens: params.browseMode }));
  }
  for (const parent of params.disclosedParents ?? []) {
    demand.set(`children:${navigationIdentityKey(parent)}`, { ...request({ kind: "children", parent }),
      federationTarget: parent.ownerInstanceId ? { scope: "remote", instanceId: parent.ownerInstanceId } : params.target,
    });
  }
  return demand;
}
