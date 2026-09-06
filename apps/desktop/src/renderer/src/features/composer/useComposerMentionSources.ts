import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { NavigationDirectoryRow, NavigationRow } from "@pwragent/shared";
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
}): {
  directories: readonly NavigationDirectoryRow[];
  ensureLoaded: (query?: string) => void;
  release: () => void;
  loading: boolean;
  settledQuery?: string;
  threads: readonly NavigationRow[];
} {
  const { desktopApi } = params;
  const consumerId = useId();
  const [demand, setDemand] = useState<string>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<{
    population: NavigationPopulation;
    loading: boolean;
    settledQuery?: string;
  }>({ population: EMPTY_POPULATION, loading: false });
  const loadingRef = useRef(false);

  const ensureLoaded = useCallback((query = ""): void => {
    const normalized = query.trim().toLowerCase();
    setDemand(normalized);
    const cached = desktopApi ? caches.get(desktopApi)?.get(normalized) : undefined;
    if (!loadingRef.current && (!cached
      || cached.revision !== getComposerMentionNavigationRevision()
      || Date.now() - cached.fetchedAt >= NAVIGATION_STALE_MS)) {
      setRefreshVersion((current) => current + 1);
    }
  }, [desktopApi]);
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
    const cached = cache.get(demand);
    if (cached && cached.revision === revision
      && Date.now() - cached.fetchedAt < NAVIGATION_STALE_MS) {
      setState({ population: cached.population, loading: false, settledQuery: demand });
      return;
    }
    let cancelled = false;
    loadingRef.current = true;
    setState((current) => ({ ...current, loading: true }));
    const directoryConsumer = `${consumerId}:directories`;
    const threadConsumer = `${consumerId}:threads`;
    void Promise.all([
      desktopApi.getNavigationQueryPage({
        protocol: 2,
        consumer: "mentions",
        query: { kind: "directory-index", filter: demand },
        pageSize: 10,
      }, directoryConsumer),
      desktopApi.getNavigationQueryPage({
        protocol: 2,
        consumer: "mentions",
        query: demand ? { kind: "search", text: demand } : { kind: "lens", lens: "inbox" },
        pageSize: 10,
      }, threadConsumer),
    ]).then(([directories, threads]) => {
      if (cancelled) return;
      const population: NavigationPopulation = {
        directories: directories.directories ?? [],
        threads: threads.entries.map((entry) => entry.row),
      };
      cache.set(demand, { population, revision, fetchedAt: Date.now() });
      while (cache.size > MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value!);
      setState({ population, loading: false, settledQuery: demand });
    }).catch(() => {
      if (!cancelled) setState((current) => ({ ...current, loading: false, settledQuery: demand }));
    }).finally(() => {
      if (!cancelled) loadingRef.current = false;
    });
    return () => {
      cancelled = true;
      loadingRef.current = false;
      void desktopApi.releaseNavigationQuery?.(directoryConsumer);
      void desktopApi.releaseNavigationQuery?.(threadConsumer);
    };
  }, [consumerId, demand, desktopApi, refreshVersion]);

  return { ...state.population, ensureLoaded, release, loading: state.loading, settledQuery: state.settledQuery };
}
