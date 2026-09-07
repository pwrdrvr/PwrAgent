import type {
  AppServerBackendScope,
  NavigationDirectorySummary,
} from "@pwragent/shared";
import { getDesktopBackendRegistry, type DesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import type { NavigationQueryIndex } from "./navigation-query-projection";
import { resolveScratchProjectsRoots } from "./scratch-projects";

/**
 * Build the complete compact membership index used by bounded navigation
 * reads. This intentionally does not hydrate queue entries, messaging
 * bindings, launchpad environments, or any other selected-thread collection.
 */
export async function loadLocalNavigationQueryIndex(params: {
  backend?: AppServerBackendScope;
  callerReason: string;
  registry?: DesktopBackendRegistry;
}): Promise<NavigationQueryIndex> {
  const registry = params.registry ?? getDesktopBackendRegistry();
  const overlayStore = getDesktopOverlayStore();
  const backend = params.backend ?? "all";
  const listedThreads = await registry.listThreads({
    backend: backend === "all" ? undefined : backend,
    callerReason: params.callerReason,
    enrichDirectories: true,
  });
  const snapshot = await overlayStore.reconcileNavigationSnapshot({
    backend,
    fetchedAt: Date.now(),
    partial: true,
    threads: listedThreads,
    workspaceRoots: resolveScratchProjectsRoots(),
  });
  const canonicalThreads = await registry.canonicalizeNavigationThreadPullRequests(
    snapshot.threads,
  );
  const threads = await registry.hydrateThreadGitWorkingStates(canonicalThreads, {
    probeMissing: false,
  });
  const directoryStatusCache = await overlayStore.readDirectoryGitStatusCache();
  const directories: NavigationDirectorySummary[] = snapshot.directories.map(
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
