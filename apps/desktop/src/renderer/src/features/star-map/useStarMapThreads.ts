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
  type NavigationQueryPage,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { navigationGeometryBudget, navigationExactRowsBudget, navigationAttentionRowsBudget } from "../../lib/navigation-metadata-budget";
import { navigationQueryEventRequiresRefresh } from "../../lib/navigation-query-events";
import { isNavigationCursorExpired } from "../../lib/navigation-query-state";
import { readNavigationQueryRange } from "../../lib/read-navigation-query-range";

const STAR_MAP_FIRST_PAGE_ROWS = 10;
const EVENT_REFRESH_DELAY_MS = 250;

type RetainedPeerQuery = {
  attentionBytes: number;
  rangeStart: number;
  attentionThreads: NavigationThreadSummary[];
  completeRevision?: string;
  counts: NavigationCounts;
  countsReady: boolean;
  facets?: NavigationStarMapFacetCounts;
  generation: string;
  nextCursor?: string;
  queryKey: string;
};

export type StarMapRemoteThreads = {
  /** Authoritative owner totals, independent of the visible row page. */
  countsByInstance: Map<string, NavigationCounts>;
  queriedInstanceIds: Set<string>;
  facetsByInstance: Map<string, NavigationStarMapFacetCounts>;
  /** Compact project/group geometry descriptors for each owner. */
  directoriesByInstance: Map<string, NavigationDirectoryRow[]>;
  geometryReadyInstanceIds: Set<string>;
  geometryErrorsByInstance: Map<string, string>;
  /** Per-instance bounded row pages, retained across peer reconnect churn. */
  threadsByInstance: Map<string, NavigationThreadSummary[]>;
  /** Instances whose last bounded query failed (rendered as unreachable). */
  unreachableInstanceIds: Set<string>;
  /** Instances whose retained rows are last-known rather than live. */
  staleInstanceIds: Set<string>;
  /** Fetch the next explicit row page for an expanded owner cloud. */
  loadMoreInstance: (instanceId: string) => Promise<void>;
  hasMoreInstanceIds: Set<string>;
  /** Refresh one owning peer and resolve only after its first page is applied. */
  refreshInstance: (instanceId: string) => Promise<void>;
};

type StarMapRemoteThreadState = {
  queriesByInstance: Map<string, RetainedPeerQuery>;
  geometryByInstance: Map<string, { directories: NavigationDirectoryRow[]; ready: boolean; error?: string }>;
  exactThreadsByInstance: Map<string, NavigationThreadSummary[]>;
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
  const enabledRef = useRef(params.enabled);
  enabledRef.current = params.enabled;
  const viewId = useId();
  const nextQueryConsumer = useRef(0);
  const queryConsumers = useRef(new Map<string, string>());
  const withQueryConsumer = useCallback(async <T>(instanceId: string, read: (consumerId: string) => Promise<T>): Promise<T> => {
    const consumerId = `${viewId}:remote-query:${++nextQueryConsumer.current}`;
    queryConsumers.current.set(consumerId, instanceId);
    try { return await read(consumerId); }
    finally {
      queryConsumers.current.delete(consumerId);
      void desktopApi?.releaseNavigationQuery?.(consumerId).catch(() => undefined);
    }
  }, [desktopApi, viewId]);
  const attentionOwnersRef = useRef(new Set<string>());
  const metadataKeys = useRef(new Set<string>());
  const retainAttentionRows = useCallback((instanceId: string, bytes: number): void => {
    const key = `${viewId}:${instanceId}:attention`;
    const lease = navigationAttentionRowsBudget.begin(key);
    try {
      lease.reserve(bytes);
      lease.commit();
      metadataKeys.current.add(key);
    } finally { lease.dispose(); }
  }, [viewId]);
  const attentionView = useMemo(() => ({ id: viewId, promoteOnTurnEnd: params.attentionPromoteOnTurnEnd ?? true }),
    [viewId, params.attentionPromoteOnTurnEnd]);
  const filters = params.filters;
  const [state, setState] = useState<StarMapRemoteThreadState>({
    queriesByInstance: new Map(),
    geometryByInstance: new Map(),
    exactThreadsByInstance: new Map(),
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
  const nextOwnerGeneration = useRef(0);
  const ownerGenerations = useRef(new Map<string, number>());
  const loadMoreReads = useRef(new Map<string, Promise<void>>());
  const firstPageReads = useRef(new Map<string, { generation: number; ownerGeneration: number; promise: Promise<void> }>());
  const exactDemands = useRef(new Map<string, { key: string; cancelled: boolean; consumerId?: string }>());
  const connectedIdsRef = useRef(connectedIds);
  connectedIdsRef.current = connectedIds;
  const eventRefreshTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );

  const readFirstPageForGeneration = useCallback(
    async (instanceId: string, generation: number, deadlineAt: number): Promise<void> => {
      if (!desktopApi?.getNavigationQueryPage) return;
      const ownerGeneration = ownerGenerations.current.get(instanceId);
      if (ownerGeneration === undefined) throw new Error("This owner is not connected with navigation query protocol 2.");
      const isCurrent = () => generationRef.current === generation && ownerGenerations.current.get(instanceId) === ownerGeneration;
      attentionOwnersRef.current.add(instanceId);
      const previous = stateRef.current.queriesByInstance.get(instanceId);
      const rows = withQueryConsumer(instanceId, (consumerId) => desktopApi.getNavigationQueryPage!({
        ...attentionRequest({ instanceId, filters, attentionView }),
        deadlineAt,
        completeBaselineRevision: previous?.completeRevision,
      }, consumerId)).then((page) => {
        if (!isCurrent()) return;
        if (Date.now() >= deadlineAt) throw new Error("Navigation refresh exceeded its deadline. Refresh this owner again.");
        if (page.unchanged && (!previous?.completeRevision || previous.completeRevision !== page.countsRevision)) {
          throw new Error("Navigation unchanged response has no matching complete owner baseline.");
        }
        const attentionBytes = page.unchanged ? previous?.attentionBytes ?? 0 : new TextEncoder().encode(JSON.stringify(page)).byteLength;
        retainAttentionRows(instanceId, attentionBytes);
        setState((current) => {
          const queriesByInstance = new Map(current.queriesByInstance);
          const retained = queriesByInstance.get(instanceId);
          queriesByInstance.set(instanceId, {
            attentionBytes,
            rangeStart: page.rangeStart ?? 0,
            attentionThreads: page.unchanged ? retained?.attentionThreads ?? [] : mergeEntries([], page.entries),
            completeRevision: page.complete ? page.countsRevision : undefined,
            counts: page.counts,
            countsReady: page.coverage.state === "complete",
            facets: page.facets,
            generation: page.generation,
            nextCursor: page.nextCursor,
            queryKey: page.queryKey,
          });
          const unreachableInstanceIds = new Set(current.unreachableInstanceIds);
          unreachableInstanceIds.delete(instanceId);
          const staleInstanceIds = new Set(current.staleInstanceIds);
          staleInstanceIds.delete(instanceId);
          return { ...current, queriesByInstance, unreachableInstanceIds, staleInstanceIds };
        });
      }).catch((error: unknown) => {
        if (isCurrent()) setState((current) => {
          const unreachableInstanceIds = new Set(current.unreachableInstanceIds);
          unreachableInstanceIds.add(instanceId);
          const staleInstanceIds = new Set(current.staleInstanceIds);
          if (current.queriesByInstance.has(instanceId) || current.exactThreadsByInstance.has(instanceId)) staleInstanceIds.add(instanceId);
          return { ...current, unreachableInstanceIds, staleInstanceIds };
        });
        throw error;
      });
      const geometry = (async () => {
        let lease: ReturnType<typeof navigationGeometryBudget.begin> | undefined;
        try {
          const key = `${viewId}:${instanceId}:geometry`;
          metadataKeys.current.add(key);
          const reservation = navigationGeometryBudget.begin(key);
          lease = reservation;
          setState((current) => {
            const geometryByInstance = new Map(current.geometryByInstance);
            geometryByInstance.set(instanceId, { directories: geometryByInstance.get(instanceId)?.directories ?? [], ready: false });
            return { ...current, geometryByInstance };
          });
          const page = await withQueryConsumer(instanceId, (consumerId) => readNavigationQueryRange({
            request: { ...geometryRequest(instanceId), pageSize: 100, deadlineAt },
            read: (request) => desktopApi.getNavigationQueryPage!(request, consumerId),
            isCancelled: () => !isCurrent(),
            maxBytes: 8 * 1024 * 1024,
            reserveBytes: reservation.reserve,
            releaseBytes: reservation.unreserve,
          }));
          if (!isCurrent()) return;
          reservation.commit();
          setState((current) => {
            const geometryByInstance = new Map(current.geometryByInstance);
            geometryByInstance.set(instanceId, { directories: page.directories ?? [], ready: true });
            return { ...current, geometryByInstance };
          });
        } catch (error) {
          if (isCurrent()) setState((current) => {
            const geometryByInstance = new Map(current.geometryByInstance);
            geometryByInstance.set(instanceId, { directories: geometryByInstance.get(instanceId)?.directories ?? [], ready: false,
              error: error instanceof Error ? error.message : String(error) });
            return { ...current, geometryByInstance };
          });
          throw error;
        } finally { lease?.dispose(); }
      })();
      const results = await Promise.allSettled([rows, geometry]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    },
    [desktopApi, filters, attentionView, viewId, withQueryConsumer, retainAttentionRows],
  );

  const fetchFirstPageForGeneration = useCallback((instanceId: string, generation: number, deadlineAt = Date.now() + 10_000): Promise<void> => {
    const ownerGeneration = ownerGenerations.current.get(instanceId);
    if (ownerGeneration === undefined) return Promise.reject(new Error("This owner is not connected with navigation query protocol 2."));
    const pending = firstPageReads.current.get(instanceId);
    if (pending?.generation === generation && pending.ownerGeneration === ownerGeneration) return pending.promise;
    const promise = readFirstPageForGeneration(instanceId, generation, deadlineAt).finally(() => {
      if (firstPageReads.current.get(instanceId)?.promise === promise) firstPageReads.current.delete(instanceId);
    });
    firstPageReads.current.set(instanceId, { generation, ownerGeneration, promise });
    return promise;
  }, [readFirstPageForGeneration]);

  const refreshInstance = useCallback(
    async (instanceId: string): Promise<void> => {
      if (!enabledRef.current) return;
      const generation = generationRef.current;
      const ownerGeneration = ownerGenerations.current.get(instanceId);
      const deadlineAt = Date.now() + 10_000;
      const pending = firstPageReads.current.get(instanceId);
      if (pending?.generation === generation && pending.ownerGeneration === ownerGeneration) {
        // A reply or canonical event happened after this read began. Its
        // completion cannot acknowledge that change; coalesce a fresh read
        // after it, keeping the original refresh deadline.
        await pending.promise.catch(() => undefined);
      }
      if (generationRef.current !== generation || ownerGenerations.current.get(instanceId) !== ownerGeneration) {
        throw new Error("Navigation owner changed while refreshing. Refresh the connected owner again.");
      }
      if (Date.now() >= deadlineAt) throw new Error("Navigation refresh exceeded its deadline. Refresh this owner again.");
      await fetchFirstPageForGeneration(instanceId, generation, deadlineAt);
    },
    [fetchFirstPageForGeneration],
  );

  const readMoreInstance = useCallback(
    async (instanceId: string): Promise<void> => {
      const retained = stateRef.current.queriesByInstance.get(instanceId);
      if (!desktopApi?.getNavigationQueryPage || !retained?.nextCursor) return;
      if (!enabledRef.current) return;
      const generation = generationRef.current;
      const ownerGeneration = ownerGenerations.current.get(instanceId);
      if (ownerGeneration === undefined) return;
      const deadlineAt = Date.now() + 10_000;
      let page: NavigationQueryPage;
      let rebaseline = false;
      try {
        page = await withQueryConsumer(instanceId, (consumerId) => desktopApi.getNavigationQueryPage!({
          ...attentionRequest({ cursor: retained.nextCursor, instanceId, filters, attentionView }), deadlineAt,
        }, consumerId));
      } catch (error) {
        if (!isNavigationCursorExpired(error)) throw error;
        if (generationRef.current !== generation || ownerGenerations.current.get(instanceId) !== ownerGeneration) return;
        const anchor = retained.attentionThreads.at(-1);
        rebaseline = true;
        page = await withQueryConsumer(instanceId, (consumerId) => desktopApi.getNavigationQueryPage!({
          ...attentionRequest({ instanceId, filters, attentionView }), deadlineAt,
          ...(anchor ? { anchor: { kind: "thread" as const, ref: {
            backend: anchor.source, threadId: anchor.id, ownerInstanceId: instanceId,
          } } } : {}),
        }, consumerId));
      }
      if (generationRef.current !== generation || ownerGenerations.current.get(instanceId) !== ownerGeneration) return;
      const currentQuery = stateRef.current.queriesByInstance.get(instanceId);
      if (!currentQuery || currentQuery.generation !== retained.generation || currentQuery.nextCursor !== retained.nextCursor) return;
      const attentionBytes = (rebaseline ? 0 : currentQuery.attentionBytes) + new TextEncoder().encode(JSON.stringify(page)).byteLength;
      retainAttentionRows(instanceId, attentionBytes);
      setState((current) => {
        const existing = current.queriesByInstance.get(instanceId);
        if (!existing || existing.generation !== retained.generation
          || (!rebaseline && existing.generation !== page.generation)) return current;
        const queriesByInstance = new Map(current.queriesByInstance);
        queriesByInstance.set(instanceId, {
          ...existing,
          attentionBytes,
          rangeStart: rebaseline ? page.rangeStart ?? 0 : existing.rangeStart,
          completeRevision: page.complete && (rebaseline ? page.rangeStart ?? 0 : existing.rangeStart) === 0 ? page.countsRevision : undefined,
          counts: page.counts,
          countsReady: page.coverage.state === "complete",
          nextCursor: page.nextCursor,
          generation: page.generation,
          queryKey: page.queryKey,
          facets: page.facets,
          attentionThreads: mergeEntries(rebaseline ? [] : existing.attentionThreads, page.entries),
        });
        return { ...current, queriesByInstance };
      });
    },
    [desktopApi, filters, attentionView, withQueryConsumer, retainAttentionRows],
  );

  const loadMoreInstance = useCallback((instanceId: string): Promise<void> => {
    const pending = loadMoreReads.current.get(instanceId);
    if (pending) return pending;
    const read = readMoreInstance(instanceId).finally(() => {
      if (loadMoreReads.current.get(instanceId) === read) loadMoreReads.current.delete(instanceId);
    });
    loadMoreReads.current.set(instanceId, read);
    return read;
  }, [readMoreInstance]);

  useEffect(() => {
    const known = new Set(knownIds.length > 0 ? knownIds.split("\n") : []);
    const retainedOwners = new Set([...stateRef.current.queriesByInstance.keys(), ...stateRef.current.geometryByInstance.keys(), ...stateRef.current.exactThreadsByInstance.keys()]);
    for (const instanceId of retainedOwners) {
      if (known.has(instanceId)) continue;
      const attentionKey = `${viewId}:${instanceId}:attention`;
      navigationAttentionRowsBudget.release(attentionKey);
      metadataKeys.current.delete(attentionKey);
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
      const geometryByInstance = new Map([...current.geometryByInstance].filter(([instanceId]) => known.has(instanceId))
        .map(([instanceId, geometry]) => [instanceId, { ...geometry, ready: connected.has(instanceId) && geometry.ready }]));
      const exactThreadsByInstance = new Map([...current.exactThreadsByInstance].filter(([instanceId]) => known.has(instanceId)));
      const unreachableInstanceIds = new Set(
        [...current.unreachableInstanceIds].filter((instanceId) => known.has(instanceId)),
      );
      const staleInstanceIds = new Set(
        [...new Set([...queriesByInstance.keys(), ...exactThreadsByInstance.keys()])].filter((instanceId) => !connected.has(instanceId)),
      );
      return { queriesByInstance, geometryByInstance, exactThreadsByInstance, unreachableInstanceIds, staleInstanceIds };
    });
  }, [connectedIds, knownIds, viewId]);

  useEffect(() => {
    const getNavigationQueryPage = desktopApi?.getNavigationQueryPage;
    if (!params.enabled || !getNavigationQueryPage) return;
    const instanceIds = connectedIdsRef.current.length > 0 ? connectedIdsRef.current.split("\n") : [];
    const consumers = queryConsumers.current;
    const owners = ownerGenerations.current;
    const generation = (generationRef.current += 1);
    for (const instanceId of instanceIds) {
      owners.set(instanceId, ++nextOwnerGeneration.current);
      void fetchFirstPageForGeneration(instanceId, generation).catch(() => undefined);
    }
    return () => {
      generationRef.current += 1;
      owners.clear();
      for (const consumerId of consumers.keys()) void desktopApi?.releaseNavigationQuery?.(consumerId).catch(() => undefined);
      consumers.clear();
    };
  }, [
    desktopApi,
    fetchFirstPageForGeneration,
    params.enabled,
    params.refreshNonce,
  ]);

  useEffect(() => {
    if (!params.enabled) return;
    const connected = new Set(connectedIds ? connectedIds.split("\n") : []);
    for (const instanceId of ownerGenerations.current.keys()) {
      if (connected.has(instanceId)) continue;
      ownerGenerations.current.delete(instanceId);
      for (const [consumerId, owner] of queryConsumers.current) {
        if (owner !== instanceId) continue;
        queryConsumers.current.delete(consumerId);
        void desktopApi?.releaseNavigationQuery?.(consumerId).catch(() => undefined);
      }
    }
    for (const instanceId of connected) {
      if (ownerGenerations.current.has(instanceId)) continue;
      ownerGenerations.current.set(instanceId, ++nextOwnerGeneration.current);
      void fetchFirstPageForGeneration(instanceId, generationRef.current).catch(() => undefined);
    }
  }, [connectedIds, desktopApi, fetchFirstPageForGeneration, params.enabled]);

  useEffect(() => {
    const getNavigationQueryPage = desktopApi?.getNavigationQueryPage;
    if (!params.enabled || !getNavigationQueryPage) return;
    const generation = generationRef.current;
    const demandKey = (instanceId: string, identities: readonly NavigationIdentity[]) => JSON.stringify([
      generation, ownerGenerations.current.get(instanceId),
      identities.map((ref) => JSON.stringify([ref.backend, ref.threadId, ref.ownerInstanceId ?? null])).sort(),
    ]);
    for (const [instanceId, demand] of exactDemands.current) {
      const identities = params.demandedIdentitiesByInstance?.get(instanceId);
      if (identities?.length && ownerGenerations.current.has(instanceId) && demand.key === demandKey(instanceId, identities)) continue;
      demand.cancelled = true;
      if (demand.consumerId) void desktopApi?.releaseNavigationQuery?.(demand.consumerId).catch(() => undefined);
      exactDemands.current.delete(instanceId);
    }
    for (const instanceId of stateRef.current.exactThreadsByInstance.keys()) {
      if (!params.demandedIdentitiesByInstance?.get(instanceId)?.length) navigationExactRowsBudget.release(`${viewId}:${instanceId}:exact`);
    }
    setState((current) => {
      const exactThreadsByInstance = new Map(current.exactThreadsByInstance);
      let changed = false;
      for (const instanceId of exactThreadsByInstance.keys()) {
        if (!params.demandedIdentitiesByInstance?.get(instanceId)?.length) {
          exactThreadsByInstance.delete(instanceId);
          changed = true;
        }
      }
      return changed ? { ...current, exactThreadsByInstance } : current;
    });
    for (const [instanceId, identities] of params.demandedIdentitiesByInstance ?? []) {
      if (identities.length === 0) continue;
      const ownerGeneration = ownerGenerations.current.get(instanceId);
      if (ownerGeneration === undefined) continue;
      if (exactDemands.current.has(instanceId)) continue;
      const demand: { key: string; cancelled: boolean; consumerId?: string } = { key: demandKey(instanceId, identities), cancelled: false };
      exactDemands.current.set(instanceId, demand);
      const isCancelled = () => demand.cancelled || generationRef.current !== generation || ownerGenerations.current.get(instanceId) !== ownerGeneration;
      void withQueryConsumer(instanceId, async (consumerId) => {
        demand.consumerId = consumerId;
        if (isCancelled()) return;
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
              read: (request) => getNavigationQueryPage(request, consumerId),
              isCancelled,
              maxBytes: remainingBytes,
              reserveBytes: lease.reserve,
              releaseBytes: lease.unreserve,
            });
            remainingBytes -= encoder.encode(JSON.stringify(page)).byteLength;
            exactThreads = mergeEntries(exactThreads, page.entries);
          }
          if (isCancelled()) return;
          lease.commit();
          setState((current) => {
            const exactThreadsByInstance = new Map(current.exactThreadsByInstance);
            exactThreadsByInstance.set(instanceId, exactThreads);
            return { ...current, exactThreadsByInstance };
          });
        } finally { lease.dispose(); }
      }).catch(() => undefined);
    }
  }, [
    desktopApi,
    viewId,
    connectedIds,
    params.demandedIdentitiesByInstance,
    params.enabled,
    params.refreshNonce,
    refreshInstance,
    withQueryConsumer,
  ]);

  useEffect(() => {
    const demands = exactDemands.current;
    return () => {
      for (const demand of demands.values()) {
        demand.cancelled = true;
        if (demand.consumerId) void desktopApi?.releaseNavigationQuery?.(demand.consumerId).catch(() => undefined);
      }
      demands.clear();
    };
  }, [desktopApi, params.enabled, readFirstPageForGeneration]);

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
        navigationAttentionRowsBudget.release(key);
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
  }, [desktopApi, viewId, params.enabled]);

  const result = useMemo(() => {
    const countsByInstance = new Map<string, NavigationCounts>();
    const queriedInstanceIds = new Set(state.queriesByInstance.keys());
    const facetsByInstance = new Map<string, NavigationStarMapFacetCounts>();
    const directoriesByInstance = new Map<string, NavigationDirectoryRow[]>();
    const geometryReadyInstanceIds = new Set<string>();
    const geometryErrorsByInstance = new Map<string, string>();
    const threadsByInstance = new Map<string, NavigationThreadSummary[]>();
    const hasMoreInstanceIds = new Set<string>();
    for (const [instanceId, query] of state.queriesByInstance) {
      if (query.nextCursor) hasMoreInstanceIds.add(instanceId);
      if (query.countsReady) countsByInstance.set(instanceId, query.counts);
      if (query.countsReady && query.facets) facetsByInstance.set(instanceId, query.facets);
      threadsByInstance.set(instanceId, query.attentionThreads);
    }
    for (const [instanceId, geometry] of state.geometryByInstance) {
      directoriesByInstance.set(instanceId, geometry.directories);
      if (geometry.ready) geometryReadyInstanceIds.add(instanceId);
      if (geometry.error) geometryErrorsByInstance.set(instanceId, geometry.error);
    }
    for (const [instanceId, exact] of state.exactThreadsByInstance) threadsByInstance.set(instanceId, mergeThreads(threadsByInstance.get(instanceId) ?? [], exact));
    return { countsByInstance, queriedInstanceIds, facetsByInstance, directoriesByInstance, geometryReadyInstanceIds, geometryErrorsByInstance, threadsByInstance, hasMoreInstanceIds };
  }, [state.queriesByInstance, state.geometryByInstance, state.exactThreadsByInstance]);

  return {
    ...result,
    loadMoreInstance,
    refreshInstance,
    staleInstanceIds: state.staleInstanceIds,
    unreachableInstanceIds: state.unreachableInstanceIds,
  };
}
