import type { AppServerBackendKind, NavigationSnapshot, NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey, federatedThreadIdentityKey, parseThreadIdentityKey, NAVIGATION_QUERY_MAX_PAGE_ROWS, NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import { FEDERATION_COLLECTION_PAGE_ROWS } from "./federation-collection-reads";
import { hasFederationErrorCode, type FederationRpcRequestOptions } from "./federation-rpc";

/** One retained complete baseline per bounded root query; replaced atomically after a successful read. */
export type PinnedNavigationReadState = Map<string, {
  queryKey: string;
  revision: string;
  threads: NavigationThreadSummary[];
}>;

export async function readFederationPinnedSnapshot(
  backend: FederationBackendOperations,
  threadKeys: string[],
  rpcOptions: FederationRpcRequestOptions = { deadlineAt: Date.now() + 10_000 },
  state?: PinnedNavigationReadState,
): Promise<NavigationSnapshot> {
  if (backend.getNavigationQueryPage) {
    try {
      const roots = [...new Set(threadKeys)].sort().map((key) => {
        const identity = parseThreadIdentityKey(key);
        if (!identity?.threadId) throw new Error("Pinned navigation requires valid thread identities.");
        return identity;
      });
      if (!roots.length) throw new Error("Pinned navigation requires at least one root.");
      const result: NavigationSnapshot = {
        backend: "all", fetchedAt: Date.now(), unchanged: false,
        threads: [], inboxThreadKeys: [], directories: [],
        launchpadDefaults: { backend: "codex", executionMode: "default" },
      };
      const nextState: PinnedNavigationReadState = new Map();
      let bytes = 0;
      let pages = 0;
      // The pin cache must use the same owner projection as visible rows.
      // The retired descendant-snapshot RPC leaves persisted unread flags
      // stuck forever on peers that correctly reject that old protocol.
      for (let offset = 0; offset < roots.length; offset += NAVIGATION_QUERY_MAX_PAGE_ROWS) {
        const batch = roots.slice(offset, offset + NAVIGATION_QUERY_MAX_PAGE_ROWS);
        const batchKey = JSON.stringify(batch);
        const baseline = state?.get(batchKey);
        const batchThreads: NavigationThreadSummary[] = [];
        let batchRevision: string | undefined;
        let batchQueryKey: string | undefined;
        let cursor: string | undefined;
        let revision: string | undefined;
        const cursors = new Set<string>();
        do {
          rpcOptions.signal?.throwIfAborted();
          if (++pages > 256 || (rpcOptions.deadlineAt !== undefined && Date.now() >= rpcOptions.deadlineAt)) {
            throw new Error("Pinned navigation pagination exceeded its page/deadline budget.");
          }
          const page = await backend.getNavigationQueryPage({
            protocol: 2, consumer: "main-sidebar", inventory: "owner", readReason: "pins",
            query: { kind: "group-members", roots: batch },
            pageSize: NAVIGATION_QUERY_MAX_PAGE_ROWS,
            ...(cursor ? { cursor } : baseline ? { completeBaselineRevision: baseline.revision } : {}),
          }, rpcOptions);
          rpcOptions.signal?.throwIfAborted();
          const pageBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
          bytes += pageBytes;
          if (page.coverage.state !== "complete") {
            throw new Error(`Pinned navigation owner coverage is ${page.coverage.state} (pending providers: ${page.coverage.pendingProviders ?? "unknown"}, failed providers: ${page.coverage.failedProviders ?? "unknown"}).`);
          }
          const pageRevision = JSON.stringify([page.ownerEpoch, page.generation, page.queryKey, page.countsRevision]);
          if (page.unchanged) {
            if (!baseline || cursor || page.protocol !== 2 || !page.complete || page.nextCursor !== undefined
              || page.rangeUnchanged || page.entries.length || page.directories?.length || page.modelGroups?.length
              || page.queryKey !== baseline.queryKey || page.countsRevision !== baseline.revision
              || pageBytes > NAVIGATION_QUERY_MAX_RESULT_BYTES || bytes > 16 * 1024 * 1024) {
              throw new Error("Pinned navigation returned an invalid unchanged baseline.");
            }
            batchThreads.push(...baseline.threads);
            batchRevision = baseline.revision;
            batchQueryKey = baseline.queryKey;
            break;
          }
          if (page.protocol !== 2 || page.rangeUnchanged
            || pageBytes > NAVIGATION_QUERY_MAX_RESULT_BYTES || page.entries.length > NAVIGATION_QUERY_MAX_PAGE_ROWS
            || bytes > 16 * 1024 * 1024 || (revision !== undefined && revision !== pageRevision)
            || (!page.complete && (!page.nextCursor || cursors.has(page.nextCursor)))
            || (page.complete && page.nextCursor !== undefined)) {
            throw new Error("Pinned navigation returned an oversized, incomplete or inconsistent collection.");
          }
          revision = pageRevision;
          batchThreads.push(...page.entries.map(({ row }) => row));
          batchRevision = page.countsRevision;
          batchQueryKey = page.queryKey;
          cursor = page.complete ? undefined : page.nextCursor;
          if (cursor) cursors.add(cursor);
        } while (cursor !== undefined);
        result.threads.push(...batchThreads);
        if (batchRevision && batchQueryKey) nextState.set(batchKey, { queryKey: batchQueryKey, revision: batchRevision, threads: batchThreads });
      }
      result.threads = [...new Map(result.threads.map((thread) => [
        thread.federation?.ref ? federatedThreadIdentityKey(thread.federation.ref)
          : buildThreadIdentityKey(thread.source, thread.id), thread,
      ])).values()];
      result.inboxThreadKeys = result.threads.filter((thread) => thread.inbox.inInbox).map((thread) =>
        thread.federation?.ref ? federatedThreadIdentityKey(thread.federation.ref)
          : buildThreadIdentityKey(thread.source, thread.id));
      // Wire bytes can be tiny for unchanged replies; bound retained data too.
      if (Buffer.byteLength(JSON.stringify(result.threads), "utf8") > 16 * 1024 * 1024) {
        throw new Error("Pinned navigation exceeded its retained row budget.");
      }
      if (state) {
        state.clear();
        for (const [key, baseline] of nextState) state.set(key, baseline);
      }
      return result;
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
