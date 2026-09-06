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
  expandedByKey: Readonly<Record<string, boolean>>;
  unpinnedExpandedByKey: Readonly<Record<string, boolean>>;
  selectedDirectoryKeys?: readonly string[];
  selectedRef?: NavigationIdentity;
  disclosedParents?: readonly NavigationIdentity[];
  /** Explicitly admitted draft identities, already grouped to this owner; no draft text. */
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
    demand.set("selected-context", request({ kind: "exact", identities: [params.selectedRef], includeAncestry: true }, 100));
  }
  if (params.browseMode === "directories") {
    for (const directory of params.directories) {
      const expanded = params.expandedByKey[directory.key] ?? params.selectedDirectoryKeys?.includes(directory.key) ?? false;
      if (!expanded) continue;
      const showUnpinned = params.unpinnedExpandedByKey[directory.key] ?? !directory.directoryThreadsCollapsed;
      demand.set(`directory:${directory.key}`, request({ kind: "directory", directoryKey: directory.key,
        roots: showUnpinned ? "all" : "pinned" }));
    }
    for (const parent of params.disclosedParents ?? []) {
      demand.set(`children:${navigationIdentityKey(parent)}`, request({ kind: "children", parent }));
    }
  } else if (params.browseMode === "drafts") {
    if (params.draftRefs?.length) demand.set("drafts", request({ kind: "exact", identities: [...params.draftRefs], includeAncestry: true }));
  } else {
    demand.set("lens", request({ kind: "lens", lens: params.browseMode }));
  }
  return demand;
}
