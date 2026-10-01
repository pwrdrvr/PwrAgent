import type {
  AppServerBackendScope,
  NavigationDirectorySummary,
} from "@pwragent/shared";
import {
  NAVIGATION_DIRECTORY_SET_CHANGED_METHOD,
  navigationQueryEventRequiresRefresh,
} from "@pwragent/shared";
import { getDesktopBackendRegistry, type DesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import type { NavigationQueryIndex } from "./navigation-query-projection";
import { resolveScratchProjectsRoots } from "./scratch-projects";
import { NavigationIndexReadPool } from "./navigation-index-read-pool";
import {
  directorySetMayHaveChanged,
  NavigationDirectorySetAnnouncer,
} from "./navigation-directory-set-announcer";
import { getMainLogger } from "../log";

const indexReads = new NavigationIndexReadPool(1_000);
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 0;
function sourceId(value: object): number {
  let id = sourceIds.get(value);
  if (id === undefined) { id = ++nextSourceId; sourceIds.set(value, id); }
  return id;
}

/**
 * Build the complete compact membership index used by bounded navigation
 * reads. This intentionally does not hydrate queue entries, messaging
 * bindings, launchpad environments, or any other selected-thread collection.
 */
export async function loadLocalNavigationQueryIndex(params: {
  backend?: AppServerBackendScope;
  callerReason: string;
  /** List provider threads afresh rather than from the thread-list cache. */
  refreshProviders?: boolean;
  registry?: DesktopBackendRegistry;
  signal?: AbortSignal;
}): Promise<NavigationQueryIndex> {
  params.signal?.throwIfAborted();
  const registry = params.registry ?? getDesktopBackendRegistry();
  const overlayStore = getDesktopOverlayStore();
  const backend = params.backend ?? "all";
  const key = JSON.stringify([sourceId(registry), sourceId(overlayStore), backend,
    overlayStore.readNavigationSourceVersion?.()]);
  // A retained index predates the refresh this read was asked for.
  if (params.refreshProviders) indexReads.invalidate(key);
  let subscribed = false;
  return indexReads.read(key, async (signal) => {
    // An event during a scan makes its result stale. The read pool shares one
    // replacement with all consumers admitted in the meantime. Own one event
    // listener for the whole read, including any replacement attempt.
    if (!subscribed) {
      subscribed = true;
      const unsubscribe = registry.onEvent?.((event) => {
        if (navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)) indexReads.invalidate(key);
      });
      // The pool owns this listener through its bounded completed reuse window.
      // Eviction/expiry/cancellation aborts the lifetime and releases it.
      signal.addEventListener("abort", () => unsubscribe?.(), { once: true });
    }
    const index = await buildLocalNavigationQueryIndex({ ...params, registry, signal });
    // Only the whole-owner index is what viewers read as its directory set.
    if (backend === "all" && !params.registry) {
      getNavigationDirectorySetAnnouncer().observe(index.directories);
    }
    return index;
  }, params.signal);
}

const directorySetLog = getMainLogger("pwragent:navigation-directory-set");
let directorySetAnnouncer: NavigationDirectorySetAnnouncer | undefined;

/** This owner's announcer; the federation runtime says when viewers watch it. */
export function getNavigationDirectorySetAnnouncer(): NavigationDirectorySetAnnouncer {
  directorySetAnnouncer ??= new NavigationDirectorySetAnnouncer({
    publish: (reason) => {
      void getDesktopBackendRegistry().publishLocalEvent({
        backend: "codex",
        notification: { method: NAVIGATION_DIRECTORY_SET_CHANGED_METHOD, params: { reason } },
      });
    },
    rebuild: ({ refreshProviders }) => loadLocalNavigationQueryIndex({
      callerReason: "directory-set-announcer",
      refreshProviders,
    }),
    subscribeInputs: (changed) => {
      const unsubscribeEvents = getDesktopBackendRegistry().onEvent?.((event) => {
        if (directorySetMayHaveChanged(event)) changed();
      });
      const unsubscribeLaunchpads = getDesktopOverlayStore().onDirectoryLaunchpadsChanged?.(changed);
      return () => {
        unsubscribeEvents?.();
        unsubscribeLaunchpads?.();
      };
    },
    onRebuildError: (error) => directorySetLog.warn("directory set re-check failed", {
      error: error instanceof Error ? error.message : String(error),
    }),
  });
  return directorySetAnnouncer;
}

async function buildLocalNavigationQueryIndex(params: {
  backend?: AppServerBackendScope;
  callerReason: string;
  refreshProviders?: boolean;
  registry: DesktopBackendRegistry;
  signal: AbortSignal;
}): Promise<NavigationQueryIndex> {
  const registry = params.registry;
  const overlayStore = getDesktopOverlayStore();
  const backend = params.backend ?? "all";
  const listedThreads = await registry.listThreads({
    backend: backend === "all" ? undefined : backend,
    callerReason: params.callerReason,
    enrichDirectories: true,
    ...(params.refreshProviders ? { forceRefresh: true } : {}),
  });
  params.signal?.throwIfAborted();
  const index = overlayStore.readNavigationQueryIndex({
    backend,
    threads: listedThreads,
    workspaceRoots: resolveScratchProjectsRoots(),
  });
  params.signal?.throwIfAborted();
  const canonicalThreads = await registry.canonicalizeNavigationThreadPullRequests(
    index.threads,
  );
  params.signal?.throwIfAborted();
  const threads = await registry.hydrateThreadGitWorkingStates(canonicalThreads, {
    probeMissing: false,
  });
  params.signal?.throwIfAborted();
  const directoryStatusCache = await overlayStore.readDirectoryGitStatusCache();
  params.signal?.throwIfAborted();
  const directories: NavigationDirectorySummary[] = index.directories.map(
    (directory) => ({
      ...directory,
      gitStatus: directoryStatusCache[directory.key]?.gitStatus,
    }),
  );
  const providerRefresh = registry.getStartupProviderRefreshStatus?.();
  return { directories, threads: registry.withNavigationSubAgentActivity(threads), inputRequestThreadKeys: registry.getNavigationInputRequestThreadKeys(),
    coverage: providerRefresh ? {
      state: providerRefresh.state === "ready" ? "complete" : providerRefresh.state,
      ...(providerRefresh.failedProviders ? { failedProviders: providerRefresh.failedProviders } : {}),
    } : { state: "complete" },
  };
}
