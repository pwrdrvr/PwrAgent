import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  type FederationPeerSummary,
  type NavigationCounts,
  type NavigationStarMapFacetCounts,
  type NavigationStarMapFilterSelection,
  type NavigationDirectoryRow,
  type NavigationIdentity,
  type NavigationQueryEntry,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { navigationGeometryBudget, navigationExactRowsBudget } from "../../lib/navigation-metadata-budget";
import { navigationQueryEventRequiresRefresh } from "../../lib/navigation-query-events";
import { readNavigationQueryRange } from "../../lib/read-navigation-query-range";

const STAR_MAP_FIRST_PAGE_ROWS = 10;
const EVENT_REFRESH_DELAY_MS = 250;

type RetainedPeerQuery = {
  attentionThreads: NavigationThreadSummary[];
  completeRevision?: string;
  counts: NavigationCounts;
  facets?: NavigationStarMapFacetCounts;
  directories: NavigationDirectoryRow[];
  exactThreads: NavigationThreadSummary[];
  generation: string;
  nextCursor?: string;
  queryKey: string;
};

export type StarMapRemoteThreads = {
  /** Authoritative owner totals, independent of the visible row page. */
  countsByInstance: Map<string, NavigationCounts>;
  facetsByInstance: Map<string, NavigationStarMapFacetCounts>;
  /** Compact project/group geometry descriptors for each owner. */
  directoriesByInstance: Map<string, NavigationDirectoryRow[]>;
  /** Per-instance bounded row pages, retained across peer reconnect churn. */
  threadsByInstance: Map<string, NavigationThreadSummary[]>;
  /** Instances whose last bounded query failed (rendered as unreachable). */
  unreachableInstanceIds: Set<string>;
  /** Instances whose retained rows are last-known rather than live. */
  staleInstanceIds: Set<string>;
  /** Fetch the next explicit row page for an expanded owner cloud. */
  loadMoreInstance: (instanceId: string) => Promise<void>;
  /** Refresh one owning peer and resolve only after its first page is applied. */
  refreshInstance: (instanceId: string) => Promise<void>;
};

type StarMapRemoteThreadState = {
  queriesByInstance: Map<string, RetainedPeerQuery>;
  unreachableInstanceIds: Set<string>;
  staleInstanceIds: Set<string>;
};

function attentionRequest(params: {
  cursor?: string;
  instanceId: string;
  filters?: NavigationStarMapFilterSelection;
  attentionView?: NavigationQueryRequest["attentionView"];
}): NavigationQueryRequest {
  return {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    consumer: "star-map",
    federationTarget: { scope: "remote", instanceId: params.instanceId },
    query: params.filters ? { kind: "star-map", filters: params.filters } : { kind: "lens", lens: "attention" },
    attentionView: params.attentionView,
    pageSize: STAR_MAP_FIRST_PAGE_ROWS,
    cursor: params.cursor,
  };
}

function geometryRequest(instanceId: string): NavigationQueryRequest {
  return {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    consumer: "star-map",
    federationTarget: { scope: "remote", instanceId },
    query: { kind: "star-map-geometry" },
    pageSize: STAR_MAP_FIRST_PAGE_ROWS,
  };
}

function exactRequest(params: {
  identities: readonly NavigationIdentity[];
  instanceId: string;
}): NavigationQueryRequest {
  return {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    consumer: "star-map",
    federationTarget: { scope: "remote", instanceId: params.instanceId },
    query: {
      kind: "exact",
      identities: params.identities.slice(0, 100),
      includeAncestry: true,
    },
    pageSize: STAR_MAP_FIRST_PAGE_ROWS,
  };
}

function threadKey(thread: NavigationThreadSummary): string {
  return `${thread.source}:${thread.id}`;
}

function mergeThreads(
  current: readonly NavigationThreadSummary[],
  incoming: readonly NavigationThreadSummary[],
): NavigationThreadSummary[] {
  const rows = new Map(current.map((thread) => [threadKey(thread), thread]));
  for (const thread of incoming) {
    rows.set(threadKey(thread), thread);
  }
  return [...rows.values()];
}

function mergeEntries(
  current: readonly NavigationThreadSummary[],
  entries: readonly NavigationQueryEntry[],
): NavigationThreadSummary[] {
  const incoming: NavigationThreadSummary[] = [];
  for (const entry of entries) {
    // NavigationRow is deliberately a strict structural subset of the legacy
    // summary. Exact card detail comes from the chat-card session instead.
    incoming.push(entry.row);
  }
  return mergeThreads(current, incoming);
}


/**
 * Bounded remote Star Map feed. A connected owner contributes one ten-row
 * Attention page plus compact geometry descriptors. More rows are fetched
 * only when the operator expands that owner, while restored/open cards are
 * requested exactly. There is intentionally no periodic collection poll.
 */
export function useStarMapThreads(params: {
  desktopApi?: DesktopApi;
  peers: readonly FederationPeerSummary[];
  enabled: boolean;
  filters?: NavigationStarMapFilterSelection;
  attentionPromoteOnTurnEnd?: boolean;
  demandedIdentitiesByInstance?: ReadonlyMap<
    string,
    readonly NavigationIdentity[]
  >;
  /** Bump to force an immediate refetch (e.g. after intake creates a thread). */
  refreshNonce?: number;
}): StarMapRemoteThreads {
  const desktopApi = params.desktopApi;
  const viewId = useId();
  const attentionOwnersRef = useRef(new Set<string>());
  const metadataKeys = useRef(new Set<string>());
  const attentionView = useMemo(() => ({ id: viewId, promoteOnTurnEnd: params.attentionPromoteOnTurnEnd ?? true }),
    [viewId, params.attentionPromoteOnTurnEnd]);
  const filters = params.filters;
  const [state, setState] = useState<StarMapRemoteThreadState>({
    queriesByInstance: new Map(),
    unreachableInstanceIds: new Set(),
    staleInstanceIds: new Set(),
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const connectedIds = params.peers
    .filter(
      (peer) =>
        peer.status === "connected"
        && peer.capabilities.includes("thread_navigation")
        && peer.navigationQueryProtocol === NAVIGATION_QUERY_PROTOCOL_VERSION,
    )
    .map((peer) => peer.id)
    .sort()
    .join("\n");
  const knownIds = params.peers
    .map((peer) => peer.id)
    .sort()
    .join("\n");
  const generationRef = useRef(0);
  const eventRefreshTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );

  const fetchFirstPageForGeneration = useCallback(
    async (instanceId: string, generation: number): Promise<void> => {
      if (!desktopApi?.getNavigationQueryPage) return;
      let geometryLease: ReturnType<typeof navigationGeometryBudget.begin> | undefined;
      try {
        const key = `${viewId}:${instanceId}:geometry`;
        metadataKeys.current.add(key);
        geometryLease = navigationGeometryBudget.begin(key);
        const previous = stateRef.current.queriesByInstance.get(instanceId);
        attentionOwnersRef.current.add(instanceId);
        const baseRequest = attentionRequest({ instanceId, filters, attentionView });
        const [rowResult, geometryResult] = await Promise.allSettled([
          desktopApi.getNavigationQueryPage({
            ...baseRequest,
            completeBaselineRevision: previous?.completeRevision,
          }),
          readNavigationQueryRange({
            request: { ...geometryRequest(instanceId), pageSize: 100 },
            read: (request) => desktopApi.getNavigationQueryPage!(request),
            isCancelled: () => generationRef.current !== generation,
            maxBytes: 8 * 1024 * 1024,
            reserveBytes: geometryLease.reserve,
            releaseBytes: geometryLease.unreserve,
          }),
        ]);
        if (rowResult.status === "rejected") throw rowResult.reason;
        if (geometryResult.status === "rejected") throw geometryResult.reason;
        const page = rowResult.value;
        const geometry = geometryResult.value;
        if (generationRef.current !== generation) return;
        geometryLease.commit();
        setState((current) => {
          const queriesByInstance = new Map(current.queriesByInstance);
          const retained = queriesByInstance.get(instanceId);
          const attentionThreads = page.unchanged
            ? retained?.attentionThreads ?? []
            : mergeEntries([], page.entries);
          queriesByInstance.set(instanceId, {
            attentionThreads,
            completeRevision: page.complete ? page.countsRevision : undefined,
            counts: page.counts,
            facets: page.facets,
            directories: geometry.directories ?? [],
            exactThreads: retained?.exactThreads ?? [],
            generation: page.generation,
            nextCursor: page.nextCursor,
            queryKey: page.queryKey,
          });
          const unreachableInstanceIds = new Set(current.unreachableInstanceIds);
          unreachableInstanceIds.delete(instanceId);
          const staleInstanceIds = new Set(current.staleInstanceIds);
          staleInstanceIds.delete(instanceId);
          return { queriesByInstance, unreachableInstanceIds, staleInstanceIds };
        });
      } catch (error) {
        if (generationRef.current === generation) {
          setState((current) => {
            const unreachableInstanceIds = new Set(current.unreachableInstanceIds);
            unreachableInstanceIds.add(instanceId);
            const staleInstanceIds = new Set(current.staleInstanceIds);
            if (current.queriesByInstance.has(instanceId)) {
              staleInstanceIds.add(instanceId);
            }
            return { ...current, unreachableInstanceIds, staleInstanceIds };
          });
        }
        throw error;
      } finally { geometryLease?.dispose(); }
    },
    [desktopApi, filters, attentionView, viewId],
  );

  const refreshInstance = useCallback(
    async (instanceId: string): Promise<void> => {
      await fetchFirstPageForGeneration(instanceId, generationRef.current);
    },
    [fetchFirstPageForGeneration],
  );

  const loadMoreInstance = useCallback(
    async (instanceId: string): Promise<void> => {
      const retained = stateRef.current.queriesByInstance.get(instanceId);
      if (!desktopApi?.getNavigationQueryPage || !retained?.nextCursor) return;
      const generation = generationRef.current;
      const page = await desktopApi.getNavigationQueryPage(
        attentionRequest({ cursor: retained.nextCursor, instanceId, filters, attentionView }),
      );
      if (generationRef.current !== generation) return;
      setState((current) => {
        const existing = current.queriesByInstance.get(instanceId);
        if (!existing || existing.generation !== page.generation) return current;
        const queriesByInstance = new Map(current.queriesByInstance);
        queriesByInstance.set(instanceId, {
          ...existing,
          completeRevision: page.complete ? page.countsRevision : undefined,
          counts: page.counts,
          nextCursor: page.nextCursor,
          attentionThreads: mergeEntries(existing.attentionThreads, page.entries),
        });
        return { ...current, queriesByInstance };
      });
    },
    [desktopApi, filters, attentionView],
  );

  useEffect(() => {
    const known = new Set(knownIds.length > 0 ? knownIds.split("\n") : []);
    for (const instanceId of stateRef.current.queriesByInstance.keys()) {
      if (known.has(instanceId)) continue;
      const geometryKey = `${viewId}:${instanceId}:geometry`;
      const exactKey = `${viewId}:${instanceId}:exact`;
      navigationGeometryBudget.release(geometryKey);
      navigationExactRowsBudget.release(exactKey);
      metadataKeys.current.delete(geometryKey);
      metadataKeys.current.delete(exactKey);
    }
    const connected = new Set(
      connectedIds.length > 0 ? connectedIds.split("\n") : [],
    );
    setState((current) => {
      const queriesByInstance = new Map(
        [...current.queriesByInstance].filter(([instanceId]) => known.has(instanceId)),
      );
      const unreachableInstanceIds = new Set(
        [...current.unreachableInstanceIds].filter((instanceId) => known.has(instanceId)),
      );
      const staleInstanceIds = new Set(
        [...queriesByInstance.keys()].filter((instanceId) => !connected.has(instanceId)),
      );
      return { queriesByInstance, unreachableInstanceIds, staleInstanceIds };
    });
  }, [connectedIds, knownIds, viewId]);

  useEffect(() => {
    const getNavigationQueryPage = desktopApi?.getNavigationQueryPage;
    if (!params.enabled || !getNavigationQueryPage) return;
    const instanceIds = connectedIds.length > 0 ? connectedIds.split("\n") : [];
    const generation = (generationRef.current += 1);
    for (const instanceId of instanceIds) {
      void fetchFirstPageForGeneration(instanceId, generation).catch(() => undefined);
    }
    return () => {
      generationRef.current += 1;
    };
  }, [
    connectedIds,
    desktopApi?.getNavigationQueryPage,
    fetchFirstPageForGeneration,
    params.enabled,
    params.refreshNonce,
  ]);

  useEffect(() => {
    const getNavigationQueryPage = desktopApi?.getNavigationQueryPage;
    if (!params.enabled || !getNavigationQueryPage) return;
    const generation = generationRef.current;
    let cancelled = false;
    for (const instanceId of stateRef.current.queriesByInstance.keys()) {
      if (!params.demandedIdentitiesByInstance?.get(instanceId)?.length) navigationExactRowsBudget.release(`${viewId}:${instanceId}:exact`);
    }
    setState((current) => {
      const queriesByInstance = new Map(current.queriesByInstance);
      let changed = false;
      for (const [instanceId, query] of queriesByInstance) {
        if (query.exactThreads.length > 0 && !params.demandedIdentitiesByInstance?.get(instanceId)?.length) {
          queriesByInstance.set(instanceId, { ...query, exactThreads: [] });
          changed = true;
        }
      }
      return changed ? { ...current, queriesByInstance } : current;
    });
    for (const [instanceId, identities] of params.demandedIdentitiesByInstance ?? []) {
      if (identities.length === 0) continue;
      void (async () => {
        if (!stateRef.current.queriesByInstance.has(instanceId)) {
          await refreshInstance(instanceId);
        }
        const key = `${viewId}:${instanceId}:exact`;
        metadataKeys.current.add(key);
        const lease = navigationExactRowsBudget.begin(key);
        try {
          const deadlineAt = Date.now() + 10_000;
          let exactThreads: NavigationThreadSummary[] = [];
          let remainingBytes = 8 * 1024 * 1024;
          const encoder = new TextEncoder();
          for (let offset = 0; offset < identities.length; offset += 100) {
            const page = await readNavigationQueryRange({
              request: { ...exactRequest({ identities: identities.slice(offset, offset + 100), instanceId }), deadlineAt },
              read: getNavigationQueryPage,
              isCancelled: () => cancelled || generationRef.current !== generation,
              maxBytes: remainingBytes,
              reserveBytes: lease.reserve,
              releaseBytes: lease.unreserve,
            });
            remainingBytes -= encoder.encode(JSON.stringify(page)).byteLength;
            exactThreads = mergeEntries(exactThreads, page.entries);
          }
          if (cancelled || generationRef.current !== generation) return;
          lease.commit();
          setState((current) => {
            const existing = current.queriesByInstance.get(instanceId);
            if (!existing) return current;
            const queriesByInstance = new Map(current.queriesByInstance);
            queriesByInstance.set(instanceId, {
              ...existing,
              exactThreads,
            });
            return { ...current, queriesByInstance };
          });
        } finally { lease.dispose(); }
      })().catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [
    desktopApi,
    viewId,
    connectedIds,
    params.demandedIdentitiesByInstance,
    params.enabled,
    refreshInstance,
  ]);

  useEffect(() => {
    if (!params.enabled) return;
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      const target = event.federationTarget;
      if (
        target?.scope !== "remote"
        || !navigationQueryEventRequiresRefresh(event.notification.method)
      ) return;
      const instanceId = target.instanceId;
      const timers = eventRefreshTimersRef.current;
      if (timers.has(instanceId)) return;
      timers.set(instanceId, setTimeout(() => {
        timers.delete(instanceId);
        void refreshInstance(instanceId).catch(() => undefined);
      }, EVENT_REFRESH_DELAY_MS));
    });
    const timers = eventRefreshTimersRef.current;
    return () => {
      unsubscribe?.();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [desktopApi, params.enabled, refreshInstance]);

  useEffect(() => {
    const keys = metadataKeys.current;
    return () => {
      for (const key of keys) {
        navigationGeometryBudget.release(key);
        navigationExactRowsBudget.release(key);
      }
      keys.clear();
    };
  }, []);

  useEffect(() => {
    const owners = attentionOwnersRef.current;
    return () => {
      for (const instanceId of owners) {
        void desktopApi?.releaseNavigationAttentionView?.({ viewId, federationTarget: { scope: "remote", instanceId } }).catch(() => undefined);
      }
      owners.clear();
    };
  }, [desktopApi, viewId]);

  const result = useMemo(() => {
    const countsByInstance = new Map<string, NavigationCounts>();
    const facetsByInstance = new Map<string, NavigationStarMapFacetCounts>();
    const directoriesByInstance = new Map<string, NavigationDirectoryRow[]>();
    const threadsByInstance = new Map<string, NavigationThreadSummary[]>();
    for (const [instanceId, query] of state.queriesByInstance) {
      countsByInstance.set(instanceId, query.counts);
      if (query.facets) facetsByInstance.set(instanceId, query.facets);
      directoriesByInstance.set(instanceId, query.directories);
      threadsByInstance.set(
        instanceId,
        mergeThreads(query.attentionThreads, query.exactThreads),
      );
    }
    return { countsByInstance, facetsByInstance, directoriesByInstance, threadsByInstance };
  }, [state.queriesByInstance]);

  return {
    ...result,
    loadMoreInstance,
    refreshInstance,
    staleInstanceIds: state.staleInstanceIds,
    unreachableInstanceIds: state.unreachableInstanceIds,
  };
}
