import type {
  FederationRemoteTarget,
  NavigationQueryPage,
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
