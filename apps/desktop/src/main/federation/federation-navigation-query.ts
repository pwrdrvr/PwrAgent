import type {
  FederationRemoteTarget,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationIdentity,
  FederationCapability,
  FederationPeerSummary,
} from "@pwragent/shared";
import {
  expandNavigationRemoteOwner,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  NAVIGATION_REMOTE_OWNER_MAX_BYTES,
  navigationQueryPageBudgetBytes,
  navigationRemoteOwnerBytes,
} from "@pwragent/shared";
import { NavigationQueryError } from "@pwragent/owner-core/navigation-query-store";

/**
 * Read an owner's page for this viewer, asking again for fewer rows if it
 * cannot be held.
 *
 * A page costs its viewer what it cost its owner: the viewer's additions ride
 * in `remoteOwner` and do not count (`navigationQueryPageBudgetBytes`). So
 * the first read fits whenever the owner honored the budget. Two cases remain,
 * and both are deterministic, so refusing them would fail on every refresh:
 * an owner that predates the budget or miscounts it, and a block too large
 * for its own cap because a page lists many directories this viewer
 * discloses differently. Fewer rows shrink both.
 */
export async function readRemoteNavigationPageWithinBudget(params: {
  request: NavigationQueryRequest;
  read: (request: NavigationQueryRequest) => Promise<NavigationQueryPage>;
  maxBytes?: number;
  maxOwnerBytes?: number;
}): Promise<NavigationQueryPage> {
  const maxBytes = params.maxBytes ?? NAVIGATION_QUERY_MAX_RESULT_BYTES;
  const maxOwnerBytes = params.maxOwnerBytes ?? NAVIGATION_REMOTE_OWNER_MAX_BYTES;
  let request = params.request;
  for (;;) {
    const page = await params.read(request);
    if (navigationQueryPageBudgetBytes(page) <= maxBytes && navigationRemoteOwnerBytes(page) <= maxOwnerBytes) return page;
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

/** An owner's page with every row filled in and no block: the form in-process callers read. */
export function stampRemoteNavigationQueryPage(params: {
  instanceLabel: string;
  page: NavigationQueryPage;
  target: FederationRemoteTarget;
  capabilities?: FederationCapability[];
  peerStatus?: FederationPeerSummary["status"];
  celestialIcon?: FederationPeerSummary["celestialIcon"];
}): NavigationQueryPage {
  const { remoteOwner: _owner, ...stamped } = expandNavigationRemoteOwner({ ...params.page, remoteOwner: {
    instanceId: params.target.instanceId, instanceLabel: params.instanceLabel, capabilities: params.capabilities,
    peerStatus: params.peerStatus, celestialIcon: params.celestialIcon,
  } });
  return stamped;
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
