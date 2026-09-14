import type { AppServerBackendKind, NavigationSnapshot } from "@pwragent/shared";
import { buildThreadIdentityKey, federatedThreadIdentityKey, parseThreadIdentityKey } from "@pwragent/shared";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import { FEDERATION_COLLECTION_PAGE_BYTES, FEDERATION_COLLECTION_PAGE_ROWS } from "./federation-collection-reads";
import { hasFederationErrorCode, type FederationRpcRequestOptions } from "./federation-rpc";

export async function readFederationPinnedSnapshot(
  backend: FederationBackendOperations,
  threadKeys: string[],
  rpcOptions: FederationRpcRequestOptions = { deadlineAt: Date.now() + 10_000 },
): Promise<NavigationSnapshot> {
  if (backend.getNavigationQueryPage) {
    try {
      const selected = [...new Set(threadKeys)].map((key) => {
        const identity = parseThreadIdentityKey(key);
        if (!identity || !identity.threadId) throw new Error("Invalid pinned thread identity.");
        return identity;
      });
      if (!selected.length) throw new Error("Pinned navigation requires at least one root.");
      const threads: NavigationSnapshot["threads"] = [];
      let bytes = 0;
      let pages = 0;
      for (let offset = 0; offset < selected.length; offset += FEDERATION_COLLECTION_PAGE_ROWS) {
        let cursor: string | undefined;
        let generation: string | undefined;
        let ownerEpoch: string | undefined;
        let queryKey: string | undefined;
        const cursors = new Set<string>();
        do {
          if (++pages > 256 || (rpcOptions.deadlineAt !== undefined && Date.now() >= rpcOptions.deadlineAt)) {
            throw new Error("Pinned navigation pagination exceeded its page/deadline budget.");
          }
          const page = await backend.getNavigationQueryPage({
            protocol: 2, consumer: "main-sidebar", inventory: "owner",
            query: { kind: "group-members", roots: selected.slice(offset, offset + FEDERATION_COLLECTION_PAGE_ROWS) },
            pageSize: FEDERATION_COLLECTION_PAGE_ROWS, cursor,
          }, rpcOptions);
          const pageBytes = Buffer.byteLength(JSON.stringify(page));
          bytes += pageBytes;
          if (page.coverage.state !== "complete") {
            throw new Error(`Pinned navigation owner coverage is ${page.coverage.state} (pending providers: ${page.coverage.pendingProviders ?? 0}, failed providers: ${page.coverage.failedProviders ?? 0}).`);
          }
          if (page.protocol !== 2 || page.unchanged || page.rangeUnchanged
            || pageBytes > FEDERATION_COLLECTION_PAGE_BYTES || page.entries.length > FEDERATION_COLLECTION_PAGE_ROWS
            || bytes > 16 * 1024 * 1024
            || (generation !== undefined && (generation !== page.generation || ownerEpoch !== page.ownerEpoch || queryKey !== page.queryKey))
            || page.complete === Boolean(page.nextCursor)
            || (page.nextCursor !== undefined && cursors.has(page.nextCursor))) {
            throw new Error("Pinned navigation returned an oversized, incomplete or inconsistent collection.");
          }
          generation = page.generation;
          ownerEpoch = page.ownerEpoch;
          queryKey = page.queryKey;
          threads.push(...page.entries.map((entry) => entry.row));
          cursor = page.nextCursor;
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
      }
      const unique = [...new Map(threads.map((thread) => [
        thread.federation?.ref ? federatedThreadIdentityKey(thread.federation.ref)
          : buildThreadIdentityKey(thread.source, thread.id), thread,
      ])).values()];
      return {
        backend: "all", fetchedAt: Date.now(), unchanged: false,
        threads: unique, directories: [],
        // This adapter feeds the pin-summary cache only; no launchpad is read
        // or authorized by a collection query.
        launchpadDefaults: { backend: "codex", executionMode: "default" },
        inboxThreadKeys: unique.filter((thread) => thread.inbox.inInbox).map((thread) =>
          thread.federation?.ref ? federatedThreadIdentityKey(thread.federation.ref)
            : buildThreadIdentityKey(thread.source, thread.id)),
      };
    } catch (error) {
      if (!hasFederationErrorCode(error, "method_not_found")) throw error;
    }
  }
  throw new Error("Bounded pinned-thread navigation is unavailable. Upgrade the peer PwrAgent instance to navigation query protocol 2.");
}

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
  throw new Error("Bounded project navigation is unavailable. Upgrade the peer PwrAgent instance to navigation query protocol 2.");
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
  throw new Error("Exact archived-thread lookup is unavailable. Upgrade the peer PwrAgent instance before resolving archived threads.");
}
