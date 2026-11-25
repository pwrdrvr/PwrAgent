import path from "node:path";
import { createHash } from "node:crypto";
import type { AppServerBackendScope, AppServerThreadSummary, LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationDirectorySummary, NavigationIdentity, NavigationQueryRequest, NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import { buildPullRequestStatusKey, buildThreadIdentityKey, parseThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { navigationPathIdentity } from "@pwragent/shared/directory-navigation";
import { isWorkspaceHandoffDirectory } from "@pwragent/shared/navigation-state";
import {
  NAVIGATION_DIRECTORY_SET_CHANGED_METHOD,
  navigationQueryEventRequiresRefresh,
} from "@pwragent/shared/navigation-query-events";
import { getDesktopBackendRegistry, type DesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import type { NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { hydrateMissingLinkedDirectoriesFromSiblingRepos } from "@pwragent/owner-core/codex-app-server/thread-directory-fallback";
import { createNavigationQuerySnapshot, navigationQuerySnapshotSharedThreads } from "@pwragent/owner-core/navigation-query-projection";
import type { NavigationPullRequestProjection } from "@pwragent/owner-core/navigation-query-store";
import { resolveScratchProjectsRoots } from "./scratch-projects";
import { buildNavigationIndexMessagingBindings } from "../messaging/messaging-bindings-snapshot";
import { attachNavigationPrCiWatchMarks } from "./navigation-pr-watch-marks";
import { NavigationIndexReadPool, type NavigationIndexCheckpoint } from "./navigation-index-read-pool";
import { nextNavigationObservation } from "./navigation-observation-clock";
import { resolveNavigationWorktreeProjects } from "./navigation-worktree-projects";
import {
  directorySetMayHaveChanged,
  NavigationDirectorySetAnnouncer,
} from "./navigation-directory-set-announcer";
import { getMainLogger } from "../log";
import { withCodexRequestActivity } from "../codex-app-server/request-activity";
import { PR_METADATA_PRIORITY, SharedPrMetadataRead } from "../pr-status/pr-metadata-process";
import { StackReader, StackReadObservation } from "../stacks/stack-reader";
import {
  compactStackMembership, MAX_COMPACT_STACK_MEMBERSHIPS, STACK_DETAIL_REUSE_MS,
  type CompactStackMembership, type SelectedStackLayer, type StackSummary,
} from "@pwragent/shared/stacks/stack-status";
import { comparePullRequestStack } from "@pwragent/shared/pull-request-rollup";
import { readNavigationCheckouts } from "../git-info/directory-store";

// Keep a bounded comparison candidate across nearby refreshes. The serving
// window and the provider/filesystem validation on its expiry still apply.
const indexReads = new NavigationIndexReadPool(1_000, 15_000);
const actionIndexReads = new NavigationIndexReadPool();
const stackReader = new StackReader();

/** A stacked index read is stale after this event; its stack inputs may have changed. */
function stackIndexEventInvalidates(notification: { method: string; params?: unknown }): boolean {
  return notification.method === "pullRequest/status/updated"
    || navigationQueryEventRequiresRefresh(notification.method, notification.params);
}

/** Counts the events that invalidate stacked index reads, per registry. */
const stackInputEpochs = new WeakMap<DesktopBackendRegistry, { value: number }>();

function stackInputEpoch(registry: DesktopBackendRegistry): { value: number } | undefined {
  let epoch = stackInputEpochs.get(registry);
  if (epoch || !registry.onEvent) return epoch;
  const counter = { value: 0 };
  // One listener for the registry's lifetime, so no change is missed between
  // projections. Without events, nothing could say a projection went stale.
  registry.onEvent((event) => {
    if (stackIndexEventInvalidates(event.notification)) counter.value += 1;
  });
  epoch = counter;
  stackInputEpochs.set(registry, epoch);
  return epoch;
}

type StackProjectionRecord = {
  stacks: StackSummary[];
  overlayStore: object;
  /** The stack input epoch when the projection started reading. */
  epoch: number;
  version: string;
  completedAt: number;
};
const latestStackProjections = new WeakMap<DesktopBackendRegistry, StackProjectionRecord>();

function navigationIndexVersion(registry: DesktopBackendRegistry, overlayStore: ReturnType<typeof getDesktopOverlayStore>): string {
  return `${overlayStore.readNavigationSourceVersion?.() ?? ""}|${registry.getStartupProviderRefreshStatus?.()?.state ?? ""}`;
}

/**
 * The newest projection, while no stack input has changed since it started
 * and it is younger than STACK_DETAIL_REUSE_MS. The row whose stack is being
 * expanded came from a projection at least that old, so the detail is never
 * staler than the row's own tag.
 */
function currentStackProjection(registry: DesktopBackendRegistry): StackProjectionRecord | undefined {
  const record = latestStackProjections.get(registry);
  const overlayStore = getDesktopOverlayStore();
  if (!record || record.overlayStore !== overlayStore || record.epoch !== stackInputEpochs.get(registry)?.value
    || record.version !== navigationIndexVersion(registry, overlayStore)) return undefined;
  const age = Date.now() - record.completedAt;
  return age >= 0 && age <= STACK_DETAIL_REUSE_MS ? record : undefined;
}

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
export function navigationQueryShowsStacks(query: NavigationQueryRequest["query"]): boolean {
  return query.kind === "lens" || query.kind === "directory" || query.kind === "children"
    || query.kind === "exact" || query.kind === "search" || query.kind === "star-map";
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
  /** Actions that use checkout membership as authority need live Git verification. */
  requireVerifiedDirectories?: boolean;
  /** This caller renders thread stack membership. */
  includeStacks?: boolean;
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
  const reads = params.requireVerifiedDirectories ? actionIndexReads : indexReads;
  const publishesSidebar = backend === "all" && !params.requireVerifiedDirectories;
  // A refresh reads under its own key: it must not be served a retained or
  // in-flight index that predates it, nor overtake other readers' scans.
  const key = JSON.stringify([sourceId(registry), sourceId(overlayStore), backend,
    ...(params.viewer ? ["viewer", sourceId(params.viewer.source)] : []),
    ...(params.includeStacks ? ["stacks"] : []),
    ...(params.refreshProviders ? ["refresh-providers"] : [])]);
  // An index's coverage reads the startup refresh state, so an index built
  // while startup was checking must not serve a reader after it finishes.
  // The refreshed event invalidates the read too, but a listener that runs
  // before the pool's (owner PR metadata) would join the stale index.
  const version = navigationIndexVersion(registry, overlayStore);
  return reads.read(key, async (signal, checkpoint, previous) => {
    let navigationChanged = false;
    // An event during a scan stops later readers from joining it; they share
    // one follow-up scan. Each run owns its listener, because the pool can
    // run this same load again for a follow-up.
    const unsubscribe = registry.onEvent?.((event) => {
      // Connectivity changes the liveness of retained peer pins without
      // changing SQLite membership or the local provider inventory.
      // A PR status observation changes page chips, not the compact index's
      // attachments. The page reads those statuses from the live registry.
      if ((params.includeStacks ? stackIndexEventInvalidates(event.notification)
        : event.notification.method !== "pullRequest/status/updated"
          && navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params))
        || (params.viewer && event.notification.method === "federation/peerStatus/changed")) {
        navigationChanged = true;
        reads.invalidate(key);
      }
    });
    // The pool owns this listener through its bounded completed reuse window.
    // Eviction/expiry/cancellation aborts the lifetime and releases it.
    signal.addEventListener("abort", () => unsubscribe?.(), { once: true });
    if (params.includeStacks) {
      // Taken before reading: a change during the read makes its result stale.
      const epoch = backend === "all" && !params.requireVerifiedDirectories ? stackInputEpoch(registry)?.value : undefined;
      // Share the same membership and viewer projection with stack-free queries.
      const local = await loadLocalNavigationQueryIndex({ ...params, includeStacks: false, signal });
      const projected = await projectNavigationIndexStacks(local, registry, version, signal, previous);
      // Owner and viewer leases project the same native stacks, so either can
      // answer a later stack detail read. A slower read that started before
      // a newer one must not replace it.
      if (epoch !== undefined && !((latestStackProjections.get(registry)?.epoch ?? -1) > epoch)) {
        latestStackProjections.set(registry, {
          stacks: projected.stacks ?? [], overlayStore, epoch, version, completedAt: Date.now(),
        });
      }
      return projected;
    }
    if (params.viewer) {
      const local = await loadLocalNavigationQueryIndex({ ...params, viewer: undefined, signal });
      checkpoint();
      const projected = await params.viewer.project(local);
      signal.throwIfAborted();
      return createNavigationQuerySnapshot(projected, undefined, local, previous());
    }
    // Taken before listing. The registry drops its cached and pending
    // listings for a boundary before it tells listeners, so this listing
    // reflects every boundary observed before this value.
    const observedAt = nextNavigationObservation();
    const visibilitySourceVersion = publishesSidebar ? overlayStore.readNavigationSourceVersion?.() : undefined;
    const directoryScopeCheckpoint = publishesSidebar ? registry.navigationDirectoryScope?.checkpoint() : undefined;
    if (publishesSidebar) latestVisibilityScanByRegistry.set(registry, observedAt);
    const index = { ...await buildLocalNavigationQueryIndex({ ...params, registry, signal, checkpoint }), observedAt };
    // Creation uses the same complete membership that the sidebar just read.
    // Waiting for owner PR metadata work can leave visibility uninitialized
    // even after the directory and its pins have appeared in the window.
    // Normal and forced-refresh scans have independent pool keys. Only the
    // latest scan may publish, and an intervening mutation also makes its
    // membership and pin ranks obsolete even when its coverage is complete.
    if (publishesSidebar
      && latestVisibilityScanByRegistry.get(registry) === observedAt
      && !navigationChanged
      && visibilitySourceVersion === overlayStore.readNavigationSourceVersion?.()) {
      if (directoryScopeCheckpoint !== undefined) registry.navigationDirectoryScope.remember(index, directoryScopeCheckpoint);
      if (index.coverage?.state === "complete") registry.rememberNavigationVisibilityIndex?.(index);
    }
    // Only the whole-owner index is what viewers read as its directory set.
    if (publishesSidebar && !params.registry) {
      getNavigationDirectorySetAnnouncer().observe(index.directories);
    }
    return createNavigationQuerySnapshot(index, undefined, undefined, previous());
  }, params.signal, version, params.viewer || params.includeStacks ? "projection" : "source");
}

async function projectNavigationCheckoutDirectories(
  threads: AppServerThreadSummary[],
  signal: AbortSignal,
  checkpoint: NavigationIndexCheckpoint,
  options: { requireVerifiedDirectories?: boolean; refreshProviders?: boolean },
) {
  const verified = options.requireVerifiedDirectories === true;
  const fresh = verified || options.refreshProviders === true;
  const candidates = new Map<string, AppServerThreadSummary[]>();
  for (const thread of threads) {
    // Recheck provider-derived relationships, including remembered Git roots.
    // The overlay projection below still owns explicit attachments.
    if (thread.source !== "codex" || !thread.projectKey || thread.workspaceHandoff || thread.linkedDirectories.length > 1) continue;
    const [directory] = thread.linkedDirectories;
    if (directory && (isWorkspaceHandoffDirectory(directory) || directory.worktreeOwnership
      || (directory.kind === "worktree" && !directory.worktreePath))) continue;
    const cwd = path.resolve(thread.projectKey);
    const rows = candidates.get(cwd) ?? [];
    rows.push(thread);
    candidates.set(cwd, rows);
  }
  const entries = [...candidates];
  const checkouts = await readNavigationCheckouts(entries.map(([cwd]) => cwd), {
    fresh,
    verified,
    signal,
    checkpoint,
  });
  const observed = entries.map(([cwd, rows], index) => ({ cwd, rows, checkout: checkouts[index] }));
  // Git does not record the primary checkout path in a separate git-dir.
  // Join only to a primary established in this inventory, even when its row
  // follows the linked checkout. Multiple primary paths are ambiguous.
  const primaryByCommon = new Map<string, LinkedDirectorySummary | null>();
  for (const { rows, checkout } of observed) {
    const separate = checkout?.separateGit;
    const primary = separate?.primary;
    if (!primary || !separate) continue;
    if (verified && !rows.some((row) => {
      const [directory] = row.linkedDirectories;
      return directory?.kind === "local" && path.relative(primary.path, directory.path) === "";
    })) continue;
    const previous = primaryByCommon.get(separate.commonDirectory);
    if (previous === undefined) primaryByCommon.set(separate.commonDirectory, primary);
    else if (previous && path.relative(previous.path, primary.path) !== "") primaryByCommon.set(separate.commonDirectory, null);
  }

  const projected = new Map<AppServerThreadSummary, AppServerThreadSummary>();
  const worktreeRepositoryAliases = new Map<string, { adminPath: string; path: string; label: string }>();
  for (const { cwd, rows, checkout } of observed) {
    if (!checkout) continue;
    const separate = checkout.separateGit;
    const primary = separate && !separate.primary && primaryByCommon.get(separate.commonDirectory);
    const linked = primary && separate
      ? { ...primary, worktreePath: separate.checkoutRoot, kind: "worktree" as const }
      : undefined;
    for (const row of rows) {
      const [previous] = row.linkedDirectories;
      if (linked && separate && (!verified || (previous?.worktreePath
        && path.relative(previous.worktreePath, linked.worktreePath) === ""
        && path.relative(previous.path, separate.commonDirectory) === ""))) {
        worktreeRepositoryAliases.set(navigationPathIdentity(linked.worktreePath, process.platform === "win32"),
          { adminPath: separate.commonDirectory, path: linked.path, label: linked.label });
        const sameWorktree = previous?.worktreePath && path.relative(previous.worktreePath, linked.worktreePath) === "";
        projected.set(row, { ...row, linkedDirectories: [linked], observedGitBranch: sameWorktree ? row.observedGitBranch : undefined });
        continue;
      }
      if (verified) continue;
      let directories = checkout.directories;
      if (!directories && previous && checkout.provisional) {
        const relative = path.relative(previous.worktreePath ?? previous.path, checkout.provisional.root);
        if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          directories = [checkout.provisional.directory];
        }
      }
      if (!directories) continue;
      const [current] = directories;
      // A missing cwd can retire a provisional folder. Keep the last known
      // repository and branch of an unavailable checkout for status polling.
      if (!current && (!previous || row.observedGitBranch || path.relative(cwd, previous.id) !== ""
        || path.relative(cwd, previous.path) !== ""
        || path.relative(cwd, previous.worktreePath ?? previous.path) !== "")) continue;
      if (current && previous && current.kind === previous.kind
        && path.relative(current.path, previous.path) === ""
        && path.relative(current.worktreePath ?? current.path, previous.worktreePath ?? previous.path) === "") continue;
      projected.set(row, { ...row, linkedDirectories: directories, observedGitBranch: undefined });
    }
  }
  const rows = threads.map((thread) => projected.get(thread) ?? thread);
  return {
    threads: verified ? rows : hydrateMissingLinkedDirectoriesFromSiblingRepos(rows),
    ...(worktreeRepositoryAliases.size ? { worktreeRepositoryAliases } : {}),
  };
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

type NavigationStackProjection = Pick<NavigationQueryIndex, "threads" | "stacks"> | undefined;
const activeStackReads = new Map<string, SharedPrMetadataRead<NavigationStackProjection>>();

async function projectNavigationIndexStacks(
  local: NavigationQueryIndex,
  registry: DesktopBackendRegistry,
  version: string,
  signal: AbortSignal,
  previous: () => NavigationQueryIndex | undefined,
): Promise<NavigationQueryIndex> {
  const nativeRows = navigationQuerySnapshotSharedThreads(local);
  const pins = nativeRows && local.threads !== nativeRows ? local.threads.slice(nativeRows.length) : [];
  const observedAt = local.observedAt;
  // A viewer observes the same native inventory even if saving its resolved
  // pins advances the source version while projecting this read.
  const share = nativeRows && observedAt !== undefined && pins.every((thread) => thread.federation);
  const projection = share
    ? await readActiveNavigationStacks(nativeRows, observedAt, registry, version, signal)
    : await projectNavigationStacks(local.threads, registry, signal);
  if (!projection) return local;
  return createNavigationQuerySnapshot({
    ...local,
    ...projection,
    threads: share && pins.length ? [...projection.threads, ...pins] : projection.threads,
  }, undefined, local, previous());
}

async function readActiveNavigationStacks(
  nativeRows: readonly NavigationThreadSummary[],
  observedAt: number,
  registry: DesktopBackendRegistry,
  version: string,
  signal: AbortSignal,
): Promise<NavigationStackProjection> {
  signal.throwIfAborted();
  const key = JSON.stringify([sourceId(nativeRows), observedAt, version]);
  const existing = activeStackReads.get(key);
  if (existing && !existing.signal.aborted) return await existing.read({ signal });
  // Only a running verification is shared. A later consumer must verify
  // Git before starting a new lease, even on identical native membership.
  const release = () => {
    if (activeStackReads.get(key) === read) activeStackReads.delete(key);
    unsubscribe?.();
    unsubscribe = undefined;
  };
  const read = new SharedPrMetadataRead(async (demand) => {
    try {
      return await projectNavigationStacks(nativeRows, registry, demand.signal!);
    } finally {
      release();
    }
  });
  let unsubscribe: (() => void) | undefined = registry.onEvent?.((event) => {
    if (navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)) release();
  });
  read.signal.addEventListener("abort", release, { once: true });
  activeStackReads.set(key, read);
  return await read.read({ signal });
}

async function projectNavigationStacks(
  threads: readonly NavigationThreadSummary[],
  registry: DesktopBackendRegistry,
  signal: AbortSignal,
): Promise<NavigationStackProjection> {
  const candidates = threads.filter((thread) => !thread.federation && (thread.linkedDirectories?.some((directory) =>
    directory.gitBranch || directory.worktreePath || directory.repositoryKey)
    || ((thread.observedGitBranch || thread.gitBranch) && thread.linkedDirectories?.length)));
  if (!candidates.length) return undefined;
  const attachments = getDesktopOverlayStore().readNavigationPullRequests(
    candidates.map((thread) => ({ backend: thread.source, threadId: thread.id })),
  );
  // Canonical status supplies the refs used to find potential stacks. Validate
  // automatic attachments only after checkout and stack admission. Neither
  // navigation nor stack detail can initiate forge repository-name lookups.
  const demand = { signal, priority: () => PR_METADATA_PRIORITY.background, allowForgeLookup: false as const };
  const rows = await Promise.all(candidates.map(async (thread, index) => ({
    ...thread,
    prs: attachments[index]?.length ? await registry.canonicalizeNavigationPullRequests(attachments[index]!, demand, false) : [],
  })));
  signal.throwIfAborted();
  const validated = new Map<string, readonly PrSummary[]>(rows.map((row) => [
    buildThreadIdentityKey(row.source, row.id), row.prs,
  ]));
  const { stacks } = await stackReader.read(rows, [], undefined,
    async (key) => {
      const thread = parseThreadIdentityKey(key);
      if (!thread) return {};
      const held = registry.stackThreadHeld?.(thread) ?? false;
      return { held, repair: !held && (Boolean(await getDesktopOverlayStore().getThreadPrAutoDispatchPending(thread))
        || await registry.stackRepairActive?.(thread) === true) };
    }, new StackReadObservation(demand), async (row, attachmentDemand) => {
      const prs = await registry.canonicalizeNavigationPullRequests(row.prs, attachmentDemand);
      validated.set(buildThreadIdentityKey(row.source, row.id), prs);
      return prs;
    });
  signal.throwIfAborted();
  return projectBoundNavigationStacks(threads, stacks, validated);
}

export function projectBoundNavigationStacks(
  threads: readonly NavigationThreadSummary[],
  stacks: readonly StackSummary[],
  prsByThread?: ReadonlyMap<string, readonly PrSummary[]>,
): Pick<NavigationQueryIndex, "threads" | "stacks"> | undefined {
  const localKeys = new Set(threads.filter((thread) => !thread.federation)
    .map((thread) => buildThreadIdentityKey(thread.source, thread.id)));
  const memberships = new Map<string, CompactStackMembership[]>();
  const boundStacks: StackSummary[] = [];
  for (const stack of stacks) {
    if (!stack.layers.some((layer) => layer.thread && localKeys.has(layer.thread.key))) continue;
    boundStacks.push(stack);
    const detailRevision = stackRevision(stack);
    const hasOpenPr = stack.layers.some((layer) => layer.pullRequest?.lifecycleState === "open");
    for (const [offset, layer] of stack.layers.entries()) {
      if (!layer.thread || !localKeys.has(layer.thread.key)) continue;
      const entries = memberships.get(layer.thread.key) ?? [];
      entries.push({ ...compactStackMembership(stack, offset + 1, hasOpenPr)!, detailRevision });
      memberships.set(layer.thread.key, entries);
    }
  }
  return memberships.size ? { stacks: boundStacks, threads: threads.map((thread) => {
    if (thread.federation) return thread;
    const key = buildThreadIdentityKey(thread.source, thread.id);
    const entries = memberships.get(key);
    const preview = entries && previewStackMemberships(entries, prsByThread?.get(key) ?? thread.prs);
    return preview ? { ...thread, ...preview } : thread;
  }) } : undefined;
}

function previewStackMemberships(members: CompactStackMembership[], prs?: readonly PrSummary[]) {
  if (members.length <= MAX_COMPACT_STACK_MEMBERSHIPS) return { stackMemberships: members };
  const byPr = new Map<string, CompactStackMembership>();
  for (const member of members) {
    const identity = `${member.repository}#${member.number}`;
    if (!byPr.has(identity)) byPr.set(identity, member);
  }
  // Retain the membership of the lead PR even when its position is beyond
  // the compact preview. The row prefers an unheld PR, if one is attached.
  const ordered = prs?.toReversed().sort(comparePullRequestStack);
  const membership = (pr: PrSummary) => byPr.get(`${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase() + `#${pr.number}`);
  const lead = ordered?.find((pr) => !membership(pr)?.heldBy) ?? ordered?.[0];
  const keep = lead && membership(lead);
  const preview = members.slice(0, MAX_COMPACT_STACK_MEMBERSHIPS);
  if (keep && !preview.includes(keep)) preview[preview.length - 1] = keep;
  return { stackMemberships: preview, stackLeadPrKey: lead && buildPullRequestStatusKey(lead) };
}

const stackRevisions = new WeakMap<StackSummary, string>();

function stackRevision(stack: StackSummary): string {
  const known = stackRevisions.get(stack);
  if (known) return known;
  const computed = createHash("sha256").update(JSON.stringify(stack)).digest("base64url");
  stackRevisions.set(stack, computed);
  return computed;
}

export async function readNavigationStackLayers(ref: NavigationIdentity, signal?: AbortSignal) {
  // A sidebar read usually projected these stacks moments ago. Only when no
  // current projection exists does a detail read observe Git itself.
  const current = currentStackProjection(getDesktopBackendRegistry());
  if (current) return projectSelectedStackLayers({ threads: [], directories: [], stacks: current.stacks }, ref);
  const index = await loadLocalNavigationQueryIndex({ callerReason: "selected-stack-detail", includeStacks: true, signal });
  return projectSelectedStackLayers(index, ref);
}

export function projectSelectedStackLayers(index: NavigationQueryIndex, ref: NavigationIdentity) {
  const key = buildThreadIdentityKey(ref.backend, ref.threadId);
  const stacks = (index.stacks ?? []).filter((stack) => stack.layers.some((layer) => layer.thread?.key === key));
  const revisions = stacks.map(stackRevision);
  return {
    count: stacks.reduce((total, stack) => total + stack.layers.length, 0),
    revision: createHash("sha256").update(JSON.stringify([ref, revisions])).digest("base64url"),
    page(offset: number, limit: number): SelectedStackLayer[] {
      const rows: SelectedStackLayer[] = [];
      for (const { layers, ...stack } of stacks) {
        if (offset >= layers.length) {
          offset -= layers.length;
          continue;
        }
        for (let index = offset; index < layers.length && rows.length < limit; index++) {
          const layer = layers[index]!;
          rows.push({
            stackKey: stack.key,
            ...(index === 0 ? { stack: { ...stack, name: stack.name.slice(0, 1024), trunk: stack.trunk.slice(0, 1024) } } : {}),
            position: index + 1,
            layer: {
              ...layer,
              branch: layer.branch.slice(0, 4096),
              parent: layer.parent.slice(0, 4096),
              ...(layer.activeBase ? { activeBase: layer.activeBase.slice(0, 4096) } : {}),
              ...(layer.thread ? { thread: { key: layer.thread.key.slice(0, 1024), title: layer.thread.title.slice(0, 1024) } } : {}),
            },
          });
        }
        if (rows.length >= limit) break;
        offset = 0;
      }
      return rows;
    },
  };
}

async function buildLocalNavigationQueryIndex(params: {
  backend?: AppServerBackendScope;
  callerReason: string;
  refreshProviders?: boolean;
  requireVerifiedDirectories?: boolean;
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
      enrichDirectories: params.requireVerifiedDirectories === true,
      skipPendingDirectoryEnrichment: !params.requireVerifiedDirectories,
      ...(params.refreshProviders || params.requireVerifiedDirectories ? { forceRefresh: true } : {}),
    }));
  params.signal?.throwIfAborted();
  // An overtaken scan whose follow-up already has readers hands them over
  // here instead of spending CPU on a projection nobody would keep.
  params.checkpoint();
  const checkoutProjection = await projectNavigationCheckoutDirectories(
    listedThreads, params.signal, params.checkpoint, params,
  );
  params.signal.throwIfAborted();
  const index = overlayStore.readNavigationQueryIndex({
    backend,
    ...checkoutProjection,
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
  const threads = await registry.hydrateThreadGitWorkingStates(registry.withNavigationPrimaryGitRepositories(watchedThreads), {
    probeMissing: false,
  });
  params.signal?.throwIfAborted();
  const directoryStatusCache = await overlayStore.readDirectoryGitStatusCache();
  params.signal?.throwIfAborted();
  const withGitStatus: NavigationDirectorySummary[] = index.directories.map(
    (directory) => ({
      ...directory,
      gitStatus: directoryStatusCache[directory.key]?.gitStatus,
    }),
  );
  const projects = await resolveNavigationWorktreeProjects(withGitStatus, {
    threads, signal: params.signal, directoryOverlays: index.directoryOverlays, gitStatusByKey: directoryStatusCache,
  });
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
  return { ...projects, threads: registry.withNavigationSubAgentActivity(threads), inputRequestThreadKeys: registry.getNavigationInputRequestThreadKeys(),
    coverage,
  };
}
