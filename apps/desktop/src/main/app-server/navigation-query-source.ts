import type {
  AppServerBackendScope,
  NavigationDirectorySummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  NAVIGATION_DIRECTORY_SET_CHANGED_METHOD,
  navigationQueryEventRequiresRefresh,
} from "@pwragent/shared";
import { getDesktopBackendRegistry, type DesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import type { NavigationQueryIndex } from "./navigation-query-projection";
import { resolveScratchProjectsRoots } from "./scratch-projects";
import { buildNavigationIndexMessagingBindings } from "../messaging/messaging-bindings-snapshot";
import { NavigationIndexReadPool, type NavigationIndexCheckpoint } from "./navigation-index-read-pool";
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
 * reads. This intentionally does not hydrate queue entries, launchpad
 * environments, or any other selected-thread collection. Messaging bindings
 * are the exception: every row draws its binding chips and Unbind items from
 * them, so they come from one read of the active bindings.
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
  // A refresh reads under its own key: it must not be served a retained or
  // in-flight index that predates it, nor overtake other readers' scans.
  const key = JSON.stringify([sourceId(registry), sourceId(overlayStore), backend,
    ...(params.refreshProviders ? ["refresh-providers"] : [])]);
  const version = overlayStore.readNavigationSourceVersion?.();
  return indexReads.read(key, async (signal, checkpoint) => {
    // An event during a scan stops later readers from joining it; they share
    // one follow-up scan. Each run owns its listener, because the pool can
    // run this same load again for a follow-up.
    const unsubscribe = registry.onEvent?.((event) => {
      if (navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)) indexReads.invalidate(key);
    });
    // The pool owns this listener through its bounded completed reuse window.
    // Eviction/expiry/cancellation aborts the lifetime and releases it.
    signal.addEventListener("abort", () => unsubscribe?.(), { once: true });
    const index = await buildLocalNavigationQueryIndex({ ...params, registry, signal, checkpoint });
    // Only the whole-owner index is what viewers read as its directory set.
    if (backend === "all" && !params.registry) {
      getNavigationDirectorySetAnnouncer().observe(index.directories);
    }
    return index;
  }, params.signal, version);
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
  checkpoint: NavigationIndexCheckpoint;
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
  // An overtaken scan whose follow-up already has readers hands them over
  // here instead of spending CPU on a projection nobody would keep.
  params.checkpoint();
  const index = overlayStore.readNavigationQueryIndex({
    backend,
    threads: listedThreads,
    workspaceRoots: resolveScratchProjectsRoots(),
  });
  params.signal?.throwIfAborted();
  const bindings = await buildNavigationIndexMessagingBindings(index.threads);
  params.signal?.throwIfAborted();
  const boundThreads = bindings.size === 0 ? index.threads : index.threads.map((thread) => {
    const messagingBindings = bindings.get(buildThreadIdentityKey(thread.source, thread.id));
    return messagingBindings ? { ...thread, messagingBindings } : thread;
  });
  const canonicalThreads = await registry.canonicalizeNavigationThreadPullRequests(
    boundThreads,
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
  // Startup refresh status says only whether live listings have begun: it
  // records one attempt, and a Claude or ACP discovery failure in it says
  // nothing about rows PwrAgent stores itself. Completeness belongs to the
  // listing this index was built from, so a recovered Codex completes the
  // next index and a later Codex failure cannot pass as complete.
  const coverage: NavigationQueryIndex["coverage"] =
    registry.getStartupProviderRefreshStatus?.()?.state === "checking"
      ? { state: "checking" }
      : registry.isIncompleteThreadList?.(listedThreads)
        ? { state: "degraded", failedProviders: 1 }
        : { state: "complete" };
  return { directories, threads: registry.withNavigationSubAgentActivity(threads), inputRequestThreadKeys: registry.getNavigationInputRequestThreadKeys(),
    coverage,
  };
}
