import type { AppServerBackendScope } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationDirectorySummary, NavigationQueryRequest, PrSummary } from "@pwragent/shared/contracts/navigation";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import {
  NAVIGATION_DIRECTORY_SET_CHANGED_METHOD,
  navigationQueryEventRequiresRefresh,
} from "@pwragent/shared/navigation-query-events";
import { getDesktopBackendRegistry, type DesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import type { NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { createNavigationQuerySnapshot } from "@pwragent/owner-core/navigation-query-projection";
import type { NavigationPullRequestProjection } from "@pwragent/owner-core/navigation-query-store";
import { resolveScratchProjectsRoots } from "./scratch-projects";
import { buildNavigationIndexMessagingBindings } from "../messaging/messaging-bindings-snapshot";
import { attachNavigationPrCiWatchMarks } from "./navigation-pr-watch-marks";
import { NavigationIndexReadPool, type NavigationIndexCheckpoint } from "./navigation-index-read-pool";
import { nextNavigationObservation } from "./navigation-observation-clock";
import {
  directorySetMayHaveChanged,
  NavigationDirectorySetAnnouncer,
} from "./navigation-directory-set-announcer";
import { getMainLogger } from "../log";
import { withCodexRequestActivity } from "../codex-app-server/request-activity";
import { PR_METADATA_PRIORITY } from "../pr-status/pr-metadata-process";

const indexReads = new NavigationIndexReadPool(1_000);

export function navigationPullRequestProjection(options: {
  kind: NavigationQueryRequest["query"]["kind"];
  signal?: AbortSignal;
  registry?: DesktopBackendRegistry;
}): NavigationPullRequestProjection {
  const priority = options.kind === "star-map" ? PR_METADATA_PRIORITY.background : PR_METADATA_PRIORITY.page;
  const verify = (batches: PrSummary[][]) => {
    const registry = options.registry ?? getDesktopBackendRegistry();
    return Promise.all(batches.map((prs) => registry.canonicalizeNavigationPullRequests(prs, { signal: options.signal, priority: () => priority })));
  };
  return {
    verify,
    read: (threads) => {
      options.signal?.throwIfAborted();
      return verify(getDesktopOverlayStore().readNavigationPullRequests(threads));
    },
  };
}
const latestVisibilityScanByRegistry = new WeakMap<DesktopBackendRegistry, number>();
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 0;
function sourceId(value: object): number {
  let id = sourceIds.get(value);
  if (id === undefined) { id = ++nextSourceId; sourceIds.set(value, id); }
  return id;
}

/** Time kept back from a caller's deadline to read and return the page. */
export const STARTUP_COVERAGE_WAIT_MARGIN_MS = 1_000;

/**
 * Group-member reads plan an archive, and their callers accept only complete
 * coverage. While the startup provider check runs, every index reports
 * `checking`, so a read made in the first seconds after launch was refused as
 * incomplete. Such a read waits for the check to end, within the caller's
 * deadline less a margin. After that it answers as before, with `checking`
 * when the check is still running. Sidebar queries never wait: they draw
 * `checking` and refresh on `navigation/providerThreads/refreshed`.
 */
export async function awaitStartupProviderCoverage(params: {
  query: { kind: string };
  deadlineAt?: number;
  registry?: Pick<DesktopBackendRegistry, "getStartupProviderRefreshStatus" | "onEvent">;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.query.kind !== "group-members" || params.deadlineAt === undefined) return;
  const registry = params.registry ?? getDesktopBackendRegistry();
  const checking = () => registry.getStartupProviderRefreshStatus?.()?.state === "checking";
  const waitMs = params.deadlineAt - STARTUP_COVERAGE_WAIT_MARGIN_MS - Date.now();
  if (!checking() || waitMs <= 0) return;
  params.signal?.throwIfAborted();
  await new Promise<void>((resolve) => {
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      clearTimeout(timer);
      unsubscribe?.();
      params.signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    // The registry leaves `checking` before it emits the refreshed event.
    unsubscribe = registry.onEvent?.(() => { if (!checking()) finish(); });
    params.signal?.addEventListener("abort", finish, { once: true });
    if (!checking()) finish();
  });
  params.signal?.throwIfAborted();
}

/**
 * Build the complete compact membership index used by bounded navigation
 * reads. This intentionally does not hydrate queue entries, launchpad
 * environments, or any other selected-thread collection. Messaging bindings
 * are the exception: every row draws its binding chips and Unbind items from
 * them, so they come from one read of the active bindings. CI watch marks
 * come from one read of the active watches the same way.
 */
export async function loadLocalNavigationQueryIndex(params: {
  backend?: AppServerBackendScope;
  callerReason: string;
  /** List provider threads afresh rather than from the thread-list cache. */
  refreshProviders?: boolean;
  registry?: DesktopBackendRegistry;
  signal?: AbortSignal;
  /** Viewer projection shares this pass's fences, lifetime and byte budget.
   * The source identity separates viewer and owner inventories. Changes to
   * that source must publish a navigation invalidation through the registry.
   */
  viewer?: { source: object; project: (index: NavigationQueryIndex) => Promise<NavigationQueryIndex> };
}): Promise<NavigationQueryIndex> {
  params.signal?.throwIfAborted();
  const registry = params.registry ?? getDesktopBackendRegistry();
  const overlayStore = getDesktopOverlayStore();
  const backend = params.backend ?? "all";
  // A refresh reads under its own key: it must not be served a retained or
  // in-flight index that predates it, nor overtake other readers' scans.
  const key = JSON.stringify([sourceId(registry), sourceId(overlayStore), backend,
    ...(params.viewer ? ["viewer", sourceId(params.viewer.source)] : []),
    ...(params.refreshProviders ? ["refresh-providers"] : [])]);
  // An index's coverage reads the startup refresh state, so an index built
  // while startup was checking must not serve a reader after it finishes.
  // The refreshed event invalidates the read too, but a listener that runs
  // before the pool's (owner PR metadata) would join the stale index.
  const version = `${overlayStore.readNavigationSourceVersion?.() ?? ""}|${
    registry.getStartupProviderRefreshStatus?.()?.state ?? ""}`;
  return indexReads.read(key, async (signal, checkpoint) => {
    let navigationChanged = false;
    // An event during a scan stops later readers from joining it; they share
    // one follow-up scan. Each run owns its listener, because the pool can
    // run this same load again for a follow-up.
    const unsubscribe = registry.onEvent?.((event) => {
      // Connectivity changes the liveness of retained peer pins without
      // changing SQLite membership or the local provider inventory.
      if (navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)
        || (params.viewer && event.notification.method === "federation/peerStatus/changed")) {
        navigationChanged = true;
        indexReads.invalidate(key);
      }
    });
    // The pool owns this listener through its bounded completed reuse window.
    // Eviction/expiry/cancellation aborts the lifetime and releases it.
    signal.addEventListener("abort", () => unsubscribe?.(), { once: true });
    if (params.viewer) {
      // Owner consumers and viewers still share the physical local scan.
      // The derived inventory uses this same pool's byte/admission budget;
      // it adds no unbounded or separately timed snapshot cache.
      const local = await loadLocalNavigationQueryIndex({ ...params, viewer: undefined, signal });
      checkpoint();
      const projected = await params.viewer.project(local);
      signal.throwIfAborted();
      return createNavigationQuerySnapshot(projected, undefined, local);
    }
    // Taken before listing. The registry drops its cached and pending
    // listings for a boundary before it tells listeners, so this listing
    // reflects every boundary observed before this value.
    const observedAt = nextNavigationObservation();
    const visibilitySourceVersion = backend === "all" ? overlayStore.readNavigationSourceVersion?.() : undefined;
    const directoryScopeCheckpoint = registry.navigationDirectoryScope?.checkpoint();
    if (backend === "all") latestVisibilityScanByRegistry.set(registry, observedAt);
    const index = { ...await buildLocalNavigationQueryIndex({ ...params, registry, signal, checkpoint }), observedAt };
    // Creation uses the same complete membership that the sidebar just read.
    // Waiting for owner PR metadata work can leave visibility uninitialized
    // even after the directory and its pins have appeared in the window.
    // Normal and forced-refresh scans have independent pool keys. Only the
    // latest scan may publish, and an intervening mutation also makes its
    // membership and pin ranks obsolete even when its coverage is complete.
    if (backend === "all"
      && latestVisibilityScanByRegistry.get(registry) === observedAt
      && !navigationChanged
      && visibilitySourceVersion === overlayStore.readNavigationSourceVersion?.()) {
      if (directoryScopeCheckpoint !== undefined) registry.navigationDirectoryScope.remember(index, directoryScopeCheckpoint);
      if (index.coverage?.state === "complete") registry.rememberNavigationVisibilityIndex?.(index);
    }
    // Only the whole-owner index is what viewers read as its directory set.
    if (backend === "all" && !params.registry) {
      getNavigationDirectorySetAnnouncer().observe(index.directories);
    }
    return createNavigationQuerySnapshot(index);
  }, params.signal, version, params.viewer ? "projection" : "source");
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
  // Membership refreshes also run on navigation and directory-announcer
  // timers. Opening a thread counts through its own foreground read.
  const listedThreads = await withCodexRequestActivity({ countsAsActivity: false }, () =>
    registry.listThreads({
      backend: backend === "all" ? undefined : backend,
      callerReason: params.callerReason,
      enrichDirectories: true,
      ...(params.refreshProviders ? { forceRefresh: true } : {}),
    }));
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
  // One read of every active watch, for the rows' CI watch marks.
  const watchedThreads = await attachNavigationPrCiWatchMarks(
    boundThreads,
    async () => await overlayStore.listAllActivePrStatusWatches(),
  );
  params.signal?.throwIfAborted();
  const canonicalThreads = await registry.canonicalizeNavigationThreadPullRequests(
    watchedThreads, undefined, false,
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
