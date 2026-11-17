import type {
  FederationRemoteTarget,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationIdentity,
  FederationCapability,
  FederationPeerSummary,
} from "@pwragent/shared";
import { buildFederatedThreadRef, NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import { NavigationQueryError } from "@pwragent/owner-core/navigation-query-store";

/**
 * Read an owner's page so that it still fits the result budget once this
 * viewer has added its own metadata.
 *
 * An owner fills a page up to its own copy of the budget, and the viewer then
 * stamps federation metadata on every row. The page it holds can therefore
 * exceed a budget its owner honored. The request is deterministic, so
 * refusing that page fails the same way on every refresh. Ask for fewer rows
 * instead; the owner's cursor carries the rest.
 *
 * `read` returns the page as the viewer will serve it, stamped and overlaid.
 */
export async function readRemoteNavigationPageWithinBudget(params: {
  request: NavigationQueryRequest;
  read: (request: NavigationQueryRequest) => Promise<NavigationQueryPage>;
  maxBytes?: number;
}): Promise<NavigationQueryPage> {
  const maxBytes = params.maxBytes ?? NAVIGATION_QUERY_MAX_RESULT_BYTES;
  let request = params.request;
  for (;;) {
    const page = await params.read(request);
    if (Buffer.byteLength(JSON.stringify(page), "utf8") <= maxBytes) return page;
    const served = Math.max(page.entries.length, page.directories?.length ?? 0, page.modelGroups?.length ?? 0);
    // Halve what the owner served, not what was asked: a page cut short by
    // bytes holds fewer rows than its request, and halving the request alone
    // would fetch the same page again.
    const rows = Math.floor(Math.min(request.pageSize ?? served, served) / 2);
    if (rows < 1) {
      throw new NavigationQueryError(
        "navigation_item_too_large",
        "One remote navigation row exceeds the result budget; read its exact detail.",
      );
    }
    request = { ...request, pageSize: rows };
  }
}

/** Stamp owner identity after a bounded owner page reaches its viewer. */
export function stampRemoteNavigationQueryPage(params: {
  instanceLabel: string;
  page: NavigationQueryPage;
  target: FederationRemoteTarget;
  capabilities?: FederationCapability[];
  peerStatus?: FederationPeerSummary["status"];
  celestialIcon?: FederationPeerSummary["celestialIcon"];
}): NavigationQueryPage {
  return {
    ...params.page,
    entries: params.page.entries.map((entry) => {
      const placement = entry.placement.kind === "child"
        && !entry.placement.parent.ownerInstanceId
        ? { ...entry.placement, parent: {
          ...entry.placement.parent, ownerInstanceId: params.target.instanceId,
        } }
        : entry.placement;
      if (entry.row.ref.ownerInstanceId && entry.row.ref.ownerInstanceId !== params.target.instanceId) {
        return placement === entry.placement ? entry : { ...entry, placement };
      }
      const ref = buildFederatedThreadRef({
        backend: entry.row.source,
        instanceId: params.target.instanceId,
        threadId: entry.row.id,
      });
      return {
        ...entry,
        placement,
        row: {
          ...entry.row,
          ref: {
            ...entry.row.ref,
            ownerInstanceId: params.target.instanceId,
          },
          federation: {
            ...entry.row.federation,
            instanceLabel: params.instanceLabel,
            ref,
            ...(params.capabilities ? { capabilities: params.capabilities } : {}),
            ...(params.peerStatus ? { peerStatus: params.peerStatus } : {}),
            celestialIcon: params.celestialIcon,
          },
        },
      };
    }),
  };
}

/** Only the serving owner's explicit identity becomes owner-local on the wire. */
export function navigationRequestForOwner(request: NavigationQueryRequest, target: FederationRemoteTarget): NavigationQueryRequest {
  const localize = (ref: NavigationIdentity): NavigationIdentity => ref.ownerInstanceId === target.instanceId
    ? { backend: ref.backend, threadId: ref.threadId } : ref;
  const { federationTarget: _target, ...ownerRequest } = request;
  const query = request.query.kind === "exact"
    ? { ...request.query, identities: request.query.identities.map(localize) }
    : request.query.kind === "group-members" ? { ...request.query, roots: request.query.roots.map(localize) }
    : request.query.kind === "children" ? { ...request.query, parent: localize(request.query.parent) } : request.query;
  const anchor = request.anchor?.kind === "thread" ? { ...request.anchor, ref: localize(request.anchor.ref) } : request.anchor;
  return { ...ownerRequest, query, ...(anchor ? { anchor } : {}) };
}
