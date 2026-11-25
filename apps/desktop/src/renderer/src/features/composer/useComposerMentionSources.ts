import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { NavigationDirectoryRow, NavigationRow } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../lib/desktop-api";
import { listInstanceReferences, type InstanceReference } from "../../lib/instance-references";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { useFederationHealth } from "../../lib/useFederationHealth";
import {
  getComposerMentionNavigationRevision,
  notifyComposerMentionNavigationChanged,
} from "../../lib/composer-mention-navigation-revision";

const NAVIGATION_STALE_MS = 10_000;
const MAX_CACHED_QUERIES = 8;
const SLOW_MENTION_QUERY_MS = 1_500;

type NavigationPopulation = {
  directories: readonly NavigationDirectoryRow[];
  ownerRankedDirectories?: boolean;
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

/** Owner-scoped directories and local threads for the shared mention pickers. */
export function useComposerMentionSources(params: {
  desktopApi?: DesktopApi;
  federationTarget?: FederationTarget;
}): {
  directories: readonly NavigationDirectoryRow[];
  ensureLoaded: (query?: string) => void;
  instances: readonly InstanceReference[];
  release: () => void;
  loading: boolean;
  ownerRankedDirectoryQuery?: string;
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
  const viewerInstanceId = readRendererFederationTarget()?.instanceId;
  const viewerTarget = useMemo<FederationTarget | undefined>(() =>
    viewerInstanceId !== undefined ? { scope: "remote", instanceId: viewerInstanceId } : undefined,
  [viewerInstanceId]);
  // The cached population depends on both owners: directories come from the
  // thread's owner, threads from the window's (a remote viewer's peer).
  const ownerKey = JSON.stringify([
    remoteInstanceId === undefined ? "local" : `remote:${remoteInstanceId}`,
    viewerInstanceId ?? "local",
  ]);
  const consumerId = useId();
  const [demand, setDemand] = useState<string>();
  const { health } = useFederationHealth({
    desktopApi,
    enabled: demand !== undefined,
    suspended: demand === undefined,
  });
  const instances = useMemo(() => listInstanceReferences(health), [health]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<{
    ownerKey: string;
    population: NavigationPopulation;
    loading: boolean;
    settledDirectoryQuery?: string;
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
      setState({
        ownerKey,
        population: cached.population,
        loading: false,
        settledDirectoryQuery: demand,
        settledQuery: demand,
      });
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
    const startedAt = performance.now();
    const isRemoteDirectoryOwner = federationTarget?.scope === "remote";
    let directoriesDone = false;
    let threadsDone = false;
    let directoriesSucceeded = false;
    let threadsSucceeded = false;
    let resolvedDirectories: readonly NavigationDirectoryRow[] = [];
    let resolvedOwnerRanked = false;
    let resolvedThreads: readonly NavigationRow[] = [];

    const logMentionQuery = (
      kind: "directories" | "threads",
      outcome: "slow" | "failed",
      error?: unknown,
    ): void => {
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (outcome === "slow" && elapsedMs < SLOW_MENTION_QUERY_MS) return;
      void desktopApi.logRendererDiagnostic?.({
        level: "warn",
        message: outcome === "failed"
          ? "composer mention navigation query failed"
          : "composer mention navigation query slow",
        details: {
          kind,
          elapsedMs,
          remote: kind === "directories" ? isRemoteDirectoryOwner : Boolean(viewerTarget),
          ...(outcome === "failed"
            ? { errorName: error instanceof Error ? error.name : "Error" }
            : {}),
        },
      });
    };

    const finishIfDone = (): void => {
      if (!directoriesDone || !threadsDone) return;
      loadingRef.current = false;
      if (directoriesSucceeded && threadsSucceeded) {
        const population: NavigationPopulation = {
          directories: resolvedDirectories,
          ownerRankedDirectories: resolvedOwnerRanked,
          threads: resolvedThreads,
        };
        cache.set(cacheKey, { population, revision, fetchedAt: Date.now() });
        while (cache.size > MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value!);
      }
    };

    void desktopApi.getNavigationQueryPage({
      protocol: 2,
      consumer: "mentions",
      federationTarget,
      query: { kind: "directory-index", match: "mention", filter: demand },
      pageSize: 10,
    }, directoryConsumer).then((directories) => {
      if (cancelled) return;
      logMentionQuery("directories", "slow");
      directoriesDone = true;
      directoriesSucceeded = true;
      resolvedDirectories = directories.directories ?? [];
      resolvedOwnerRanked = directories.directoryMatch === "mention";
      const allDone = threadsDone;
      setState((current) => ({
        ownerKey,
        population: {
          directories: resolvedDirectories,
          ownerRankedDirectories: resolvedOwnerRanked,
          threads: current.ownerKey === ownerKey ? current.population.threads : [],
        },
        loading: !allDone,
        settledDirectoryQuery: demand,
        ...(allDone ? { settledQuery: demand } : {}),
      }));
      finishIfDone();
    }).catch((error: unknown) => {
      if (cancelled) return;
      logMentionQuery("directories", "failed", error);
      directoriesDone = true;
      const allDone = threadsDone;
      setState((current) => ({
        ownerKey,
        population: isRemoteDirectoryOwner
          ? EMPTY_POPULATION
          : {
              directories: [],
              ownerRankedDirectories: false,
              threads: current.ownerKey === ownerKey ? current.population.threads : [],
            },
        loading: !allDone,
        settledDirectoryQuery: demand,
        ...(allDone ? { settledQuery: demand } : {}),
      }));
      finishIfDone();
    });

    // In the main window the # picker combines local threads with a
    // separate peer search, so scoping this page to the directory owner
    // would remove local references. A remote viewer runs no peer search
    // (`useFederatedThreadSearch`); its threads are the peer's it fronts.
    void desktopApi.getNavigationQueryPage({
      protocol: 2,
      consumer: "mentions",
      ...(viewerTarget ? { federationTarget: viewerTarget } : {}),
      query: demand ? { kind: "search", text: demand } : { kind: "lens", lens: "inbox" },
      pageSize: 10,
    }, threadConsumer).then((threads) => {
      if (cancelled) return;
      logMentionQuery("threads", "slow");
      threadsDone = true;
      threadsSucceeded = true;
      resolvedThreads = threads.entries.map((entry) => entry.row);
      const allDone = directoriesDone;
      const clearForOfflineRemote = isRemoteDirectoryOwner && directoriesDone && !directoriesSucceeded;
      setState((current) => ({
        ownerKey,
        population: clearForOfflineRemote
          ? EMPTY_POPULATION
          : {
              directories: current.ownerKey === ownerKey ? current.population.directories : [],
              ownerRankedDirectories: current.ownerKey === ownerKey ? current.population.ownerRankedDirectories : false,
              threads: resolvedThreads,
            },
        loading: !allDone,
        ...(current.ownerKey === ownerKey && current.settledDirectoryQuery !== undefined
          ? { settledDirectoryQuery: current.settledDirectoryQuery }
          : {}),
        ...(allDone ? { settledQuery: demand } : {}),
      }));
      finishIfDone();
    }).catch((error: unknown) => {
      if (cancelled) return;
      logMentionQuery("threads", "failed", error);
      threadsDone = true;
      const allDone = directoriesDone;
      setState((current) => ({
        ownerKey,
        population: {
          directories: current.ownerKey === ownerKey ? current.population.directories : [],
          ownerRankedDirectories: current.ownerKey === ownerKey ? current.population.ownerRankedDirectories : false,
          threads: [],
        },
        loading: !allDone,
        ...(current.ownerKey === ownerKey && current.settledDirectoryQuery !== undefined
          ? { settledDirectoryQuery: current.settledDirectoryQuery }
          : {}),
        ...(allDone ? { settledQuery: demand } : {}),
      }));
      finishIfDone();
    });
    return () => {
      cancelled = true;
      loadingRef.current = false;
      void desktopApi.releaseNavigationQuery?.(directoryConsumer);
      void desktopApi.releaseNavigationQuery?.(threadConsumer);
    };
  }, [consumerId, demand, desktopApi, federationTarget, ownerKey, refreshVersion, viewerTarget]);

  // Effects run after render: never expose the old owner's rows in that gap.
  const visibleState = state.ownerKey === ownerKey ? state
    : {
        population: EMPTY_POPULATION,
        loading: demand !== undefined,
        settledDirectoryQuery: undefined,
        settledQuery: undefined,
      };
  const { directories, ownerRankedDirectories, threads } = visibleState.population;
  return {
    directories,
    threads,
    instances,
    ensureLoaded,
    release,
    loading: visibleState.loading,
    settledQuery: visibleState.settledQuery,
    ownerRankedDirectoryQuery: ownerRankedDirectories ? visibleState.settledDirectoryQuery : undefined,
  };
}
