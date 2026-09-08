import type {
  AppServerBackendScope,
  NavigationDirectorySummary,
} from "@pwragent/shared";
import { navigationQueryEventRequiresRefresh } from "@pwragent/shared";
import { getDesktopBackendRegistry, type DesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import type { NavigationQueryIndex } from "./navigation-query-projection";
import { resolveScratchProjectsRoots } from "./scratch-projects";
import { NavigationIndexReadPool } from "./navigation-index-read-pool";

const indexReads = new NavigationIndexReadPool();
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
  registry?: DesktopBackendRegistry;
  signal?: AbortSignal;
}): Promise<NavigationQueryIndex> {
  params.signal?.throwIfAborted();
  const registry = params.registry ?? getDesktopBackendRegistry();
  const overlayStore = getDesktopOverlayStore();
  const backend = params.backend ?? "all";
  const key = JSON.stringify([sourceId(registry), sourceId(overlayStore), backend,
    overlayStore.readNavigationSourceVersion?.()]);
  return indexReads.read(key, async (signal) => {
    // Canonical events invalidate joinability, not another consumer's read.
    // A later query must not inherit work begun before a canonical event.
    // Transcript deltas must not multiply the same pending owner scan.
    const unsubscribe = registry.onEvent?.((event) => {
      if (navigationQueryEventRequiresRefresh(event.notification.method)) indexReads.invalidate(key);
    });
    try { return await buildLocalNavigationQueryIndex({ ...params, registry, signal }); }
    finally { unsubscribe?.(); }
  }, params.signal);
}

async function buildLocalNavigationQueryIndex(params: {
  backend?: AppServerBackendScope;
  callerReason: string;
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
  return { directories, threads, inputRequestThreadKeys: registry.getNavigationInputRequestThreadKeys(),
    coverage: providerRefresh ? {
      state: providerRefresh.state === "ready" ? "complete" : providerRefresh.state,
      ...(providerRefresh.failedProviders ? { failedProviders: providerRefresh.failedProviders } : {}),
    } : { state: "complete" },
  };
}
