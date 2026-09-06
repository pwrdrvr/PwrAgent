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
      if (entry.row.ref.ownerInstanceId || entry.row.federation) {
        return entry;
      }
      const ref = buildFederatedThreadRef({
        backend: entry.row.source,
        instanceId: params.target.instanceId,
        threadId: entry.row.id,
      });
      return {
        ...entry,
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
