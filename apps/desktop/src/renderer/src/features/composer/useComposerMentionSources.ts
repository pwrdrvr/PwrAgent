import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FederationTarget, NavigationDirectoryRow, NavigationRow } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  getComposerMentionNavigationRevision,
  notifyComposerMentionNavigationChanged,
} from "../../lib/composer-mention-navigation-revision";

const NAVIGATION_STALE_MS = 10_000;
const MAX_CACHED_QUERIES = 8;

type NavigationPopulation = {
  directories: readonly NavigationDirectoryRow[];
  threads: readonly NavigationRow[];
};
type CachedPopulation = {
  population: NavigationPopulation;
  fetchedAt: number;
  revision: number;
};
const EMPTY_POPULATION: NavigationPopulation = { directories: [], threads: [] };
let caches = new WeakMap<DesktopApi, Map<string, CachedPopulation>>();

export function resetComposerMentionSourcesCache(): void {
  caches = new WeakMap();
}

/** Owner-filtered autocomplete pages. A new query can reach any owner member. */
export function useComposerMentionSources(params: {
  desktopApi?: DesktopApi;
  federationTarget?: FederationTarget;
}): {
  directories: readonly NavigationDirectoryRow[];
  ensureLoaded: (query?: string) => void;
  release: () => void;
  loading: boolean;
  settledQuery?: string;
  threads: readonly NavigationRow[];
} {
  const { desktopApi } = params;
  // Navigation updates replace target objects; only an owner change should
  // release an interest or start another autocomplete read.
  const remoteInstanceId = params.federationTarget?.scope === "remote"
    ? params.federationTarget.instanceId : undefined;
  const localTarget = params.federationTarget?.scope === "local";
  const federationTarget = useMemo<FederationTarget | undefined>(() =>
    remoteInstanceId !== undefined ? { scope: "remote", instanceId: remoteInstanceId }
      : localTarget ? { scope: "local" } : undefined,
  [localTarget, remoteInstanceId]);
  const ownerKey = remoteInstanceId === undefined ? "local" : `remote:${remoteInstanceId}`;
  const consumerId = useId();
  const [demand, setDemand] = useState<string>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<{
    ownerKey: string;
    population: NavigationPopulation;
    loading: boolean;
    settledQuery?: string;
  }>({ ownerKey, population: EMPTY_POPULATION, loading: false });
  const loadingRef = useRef(false);

  const ensureLoaded = useCallback((query = ""): void => {
    const normalized = query.trim().toLowerCase();
    setDemand(normalized);
    const cached = desktopApi ? caches.get(desktopApi)?.get(JSON.stringify([ownerKey, normalized])) : undefined;
    if (!loadingRef.current && (!cached
      || cached.revision !== getComposerMentionNavigationRevision()
      || Date.now() - cached.fetchedAt >= NAVIGATION_STALE_MS)) {
      setRefreshVersion((current) => current + 1);
    }
  }, [desktopApi, ownerKey]);
  const release = useCallback(() => setDemand(undefined), []);

  useEffect(() => desktopApi?.onNavigationMentionSourcesChanged?.(() => {
    notifyComposerMentionNavigationChanged();
    setRefreshVersion((current) => current + 1);
  }), [desktopApi]);

  useEffect(() => {
    if (demand === undefined || !desktopApi?.getNavigationQueryPage) return;
    let cache = caches.get(desktopApi);
    if (!cache) {
      cache = new Map();
      caches.set(desktopApi, cache);
    }
    const revision = getComposerMentionNavigationRevision();
    const cacheKey = JSON.stringify([ownerKey, demand]);
    const cached = cache.get(cacheKey);
    if (cached && cached.revision === revision
      && Date.now() - cached.fetchedAt < NAVIGATION_STALE_MS) {
      setState({ ownerKey, population: cached.population, loading: false, settledQuery: demand });
      return;
    }
    let cancelled = false;
    loadingRef.current = true;
    setState((current) => ({
      ownerKey,
      population: current.ownerKey === ownerKey ? current.population : EMPTY_POPULATION,
      loading: true,
    }));
    const directoryConsumer = `${consumerId}:directories`;
    const threadConsumer = `${consumerId}:threads`;
    void Promise.all([
      desktopApi.getNavigationQueryPage({
        protocol: 2,
        consumer: "mentions",
        federationTarget,
        query: { kind: "directory-index", filter: demand },
        pageSize: 10,
      }, directoryConsumer),
      desktopApi.getNavigationQueryPage({
        protocol: 2,
        consumer: "mentions",
        federationTarget,
        query: demand ? { kind: "search", text: demand } : { kind: "lens", lens: "inbox" },
        pageSize: 10,
      }, threadConsumer),
    ]).then(([directories, threads]) => {
      if (cancelled) return;
      const population: NavigationPopulation = {
        directories: directories.directories ?? [],
        threads: threads.entries.map((entry) => entry.row),
      };
      cache.set(cacheKey, { population, revision, fetchedAt: Date.now() });
      while (cache.size > MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value!);
      setState({ ownerKey, population, loading: false, settledQuery: demand });
    }).catch(() => {
      if (!cancelled) setState({ ownerKey, population: EMPTY_POPULATION, loading: false, settledQuery: demand });
    }).finally(() => {
      if (!cancelled) loadingRef.current = false;
    });
    return () => {
      cancelled = true;
      loadingRef.current = false;
      void desktopApi.releaseNavigationQuery?.(directoryConsumer);
      void desktopApi.releaseNavigationQuery?.(threadConsumer);
    };
  }, [consumerId, demand, desktopApi, federationTarget, ownerKey, refreshVersion]);

  // Effects run after render: never expose the old owner's rows in that gap.
  const visibleState = state.ownerKey === ownerKey ? state
    : { population: EMPTY_POPULATION, loading: demand !== undefined, settledQuery: undefined };
  return { ...visibleState.population, ensureLoaded, release, loading: visibleState.loading, settledQuery: visibleState.settledQuery };
}
