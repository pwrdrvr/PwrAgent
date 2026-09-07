import type {
  FederationRemoteTarget,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationIdentity,
} from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";

/** Stamp owner identity after a bounded owner page reaches its viewer. */
export function stampRemoteNavigationQueryPage(params: {
  instanceLabel: string;
  page: NavigationQueryPage;
  target: FederationRemoteTarget;
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
      if (entry.row.ref.ownerInstanceId || entry.row.federation) {
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
            instanceLabel: params.instanceLabel,
            ref,
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
