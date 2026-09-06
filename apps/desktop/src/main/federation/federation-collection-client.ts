import type { AppServerBackendKind, NavigationSnapshot } from "@pwragent/shared";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import { FEDERATION_COLLECTION_PAGE_ROWS } from "./federation-collection-reads";
import { hasFederationErrorCode, type FederationRpcRequestOptions } from "./federation-rpc";

export async function readFederationProjectSnapshot(
  backend: FederationBackendOperations,
  projectKey?: string,
): Promise<NavigationSnapshot> {
  const rpcOptions = { deadlineAt: Date.now() + 10_000 };
  if (backend.getProjectPage) {
    try {
      let page = await backend.getProjectPage({ projectKey }, rpcOptions);
      const snapshot: NavigationSnapshot = {
        backend: page.backend,
        fetchedAt: page.fetchedAt,
        launchpadDefaults: page.launchpadDefaults,
        directories: [...page.directories],
        threads: [],
        inboxThreadKeys: [],
        unchanged: false,
      };
      const seen = new Set<string>();
      while (page.nextAfterKey !== undefined) {
        if (seen.has(page.nextAfterKey) || Date.now() >= rpcOptions.deadlineAt) {
          throw new Error("Federation project pagination did not complete within its deadline.");
        }
        seen.add(page.nextAfterKey);
        page = await backend.getProjectPage({ projectKey, afterKey: page.nextAfterKey }, rpcOptions);
        snapshot.directories.push(...page.directories);
      }
      return snapshot;
    } catch (error) {
      if (!hasFederationErrorCode(error, "method_not_found")) throw error;
    }
  }
  // Legacy owners (and local adapters) have no project-only RPC. Never widen
  // an ordinary failed bounded read into a full navigation download.
  return await backend.getNavigationSnapshot({}, rpcOptions);
}

export async function lookupFederationArchivedThreads(
  backend: FederationBackendOperations,
  scope: AppServerBackendKind,
  threadIds: readonly string[],
  rpcOptions: FederationRpcRequestOptions = { deadlineAt: Date.now() + 10_000 },
) {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return [];
  if (backend.lookupArchivedThreads) {
    try {
      const threads = [];
      for (let offset = 0; offset < ids.length; offset += FEDERATION_COLLECTION_PAGE_ROWS) {
        const response = await backend.lookupArchivedThreads({
          backend: scope,
          threadIds: ids.slice(offset, offset + FEDERATION_COLLECTION_PAGE_ROWS),
        }, rpcOptions);
        threads.push(...response.threads);
      }
      return threads;
    } catch (error) {
      if (!hasFederationErrorCode(error, "method_not_found")) throw error;
    }
  }
  const response = await backend.listThreads({ backend: scope, archived: true }, rpcOptions);
  const selected = new Set(ids);
  return response.threads.filter((thread) => thread.source === scope && selected.has(thread.id));
}
