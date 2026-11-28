import { addAbortListener } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { LiveNavigationIndex, type NavigationViewerProjection } from "./live-navigation-index";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AppServerBackendScope, AppServerThreadSummary, LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationDirectorySummary, NavigationIdentity, NavigationQueryRequest, NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import { buildPullRequestStatusKey, buildThreadIdentityKey, NAVIGATION_INDEX_MAX_INPUT_BYTES } from "@pwragent/shared/contracts/navigation";
import { navigationPathIdentity } from "@pwragent/shared/directory-navigation";
import { isWorkspaceHandoffDirectory } from "@pwragent/shared/navigation-state";
import {
  NAVIGATION_DIRECTORY_SET_CHANGED_METHOD,
  NAVIGATION_LIVE_INDEX_RECONCILED_METHOD,
  NAVIGATION_SIDEBAR_ENRICHMENT_UPDATED_METHOD,
  navigationPullRequestKeysMayMatch,
  normalizedNavigationPullRequestKey,
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
import { readMessagingBindingsRevision } from "../messaging/named-messaging-bindings";
import { attachNavigationPrCiWatchMarks } from "./navigation-pr-watch-marks";
import { NAVIGATION_RETAINED_BYTE_BUDGET, NavigationIndexReadPool, type NavigationIndexCheckpoint } from "./navigation-index-read-pool";
import { nextNavigationObservation } from "./navigation-observation-clock";
import { resolveNavigationWorktreeProjects } from "./navigation-worktree-projects";
import {
  DIRECTORY_SET_RECHECK_INTERVAL_MS,
  directorySetMayHaveChanged,
  NavigationDirectorySetAnnouncer,
} from "./navigation-directory-set-announcer";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import { getMainLogger } from "../log";
import { withCodexRequestActivity } from "../codex-app-server/request-activity";
import { PR_METADATA_PRIORITY, SharedPrMetadataRead } from "../pr-status/pr-metadata-process";
import { getDesktopStackReader, StackReadObservation } from "../stacks/stack-reader";
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
const stackReader = getDesktopStackReader();
const navigationQueryLog = getMainLogger("pwragent:navigation-query");

export type StackPrRelevanceScope = {
  prKeys: ReadonlySet<string>;
  repositories: ReadonlySet<string>;
};

export function buildStackPrRelevanceScope(params: {
  prs?: readonly PrSummary[];
  repositories?: readonly string[];
  stackPrKeys?: readonly string[];
}): StackPrRelevanceScope {
  const prKeys = new Set<string>(params.stackPrKeys ?? []);
  const repositories = new Set<string>();
  for (const pr of params.prs ?? []) {
    const key = buildPullRequestStatusKey(pr);
    prKeys.add(key);
    const repo = normalizedPullRequestRepository(key);
    if (repo) repositories.add(repo);
  }
  for (const repository of params.repositories ?? []) {
    const repo = normalizedPullRequestRepository(repository);
    if (repo) repositories.add(repo);
  }
  return { prKeys, repositories };
}

function normalizedPullRequestRepository(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  const fromPrKey = /^([^/#]+)\/([^/#]+(?:\/[^/#]+)+)#\d+$/.exec(trimmed);
  if (fromPrKey) {
    const [, provider, repository] = fromPrKey;
    const host = provider === "github" || provider === "gitlab" ? `${provider}.com` : provider;
    return `${host}/${repository}`;
  }
  const fromCatalog = /^([^/#]+):([^:/#]+(?:\/[^/#]+)+)$/.exec(trimmed);
  if (fromCatalog) {
    const [, provider, repository] = fromCatalog;
    const host = provider === "github" || provider === "gitlab" ? `${provider}.com` : provider;
    return `${host}/${repository}`;
  }
  return undefined;
}

function extractPullRequestEventKey(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as { prKey?: unknown; pr?: PrSummary };
  if (typeof record.prKey === "string" && record.prKey.trim()) return record.prKey.trim();
  const pr = record.pr;
  if (pr && typeof pr === "object"
    && typeof pr.provider === "string"
    && typeof pr.org === "string"
    && typeof pr.repo === "string"
    && typeof pr.number === "number") {
    return buildPullRequestStatusKey(pr);
  }
  return undefined;
}

function pullRequestStatusEventRelevant(params: unknown, scope: StackPrRelevanceScope | undefined): boolean {
  if (!scope) return true;
  const eventPrKey = extractPullRequestEventKey(params);
  if (!eventPrKey) return true;
  for (const key of scope.prKeys) {
    if (navigationPullRequestKeysMayMatch(key, eventPrKey)) return true;
  }
  const eventRepository = normalizedPullRequestRepository(eventPrKey);
  if (!eventRepository) return true;
  return scope.repositories.has(eventRepository);
}

/** Events that affect only viewer-mounted remote pins, never local owner membership or stacks. */
function viewerOnlyNavigationEvent(method: string): boolean {
  return method === "navigation/remoteThreadPins/changed"
    || method === "federation/peerStatus/changed";
}

/** A stacked index read is stale after this event; its stack inputs may have changed. */
export function stackIndexEventInvalidates(
  notification: { method: string; params?: unknown },
  prScope?: StackPrRelevanceScope,
): boolean {
  if (viewerOnlyNavigationEvent(notification.method)
    || notification.method === NAVIGATION_SIDEBAR_ENRICHMENT_UPDATED_METHOD) return false;
  if (notification.method === "pullRequest/status/updated") {
    return pullRequestStatusEventRelevant(notification.params, prScope);
  }
  return navigationQueryEventRequiresRefresh(notification.method, notification.params);
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
    const latest = latestStackProjections.get(registry);
    const overlayStore = getDesktopOverlayStore();
    // Only filter PR events against a projection that is still current; while
    // a newer scan is pending or running, conservatively invalidate.
    const prScope = latest
      && latest.epoch === counter.value
      && latest.overlayStore === overlayStore
      && latest.version === navigationIndexVersion(registry, overlayStore, false)
      ? latest.prScope
      : undefined;
    if (stackIndexEventInvalidates(event.notification, prScope)) counter.value += 1;
  });
  epoch = counter;
  stackInputEpochs.set(registry, epoch);
  return epoch;
}

type StackProjectionRecord = {
  stacks: StackSummary[];
  prScope?: StackPrRelevanceScope;
  overlayStore: object;
  /** The stack input epoch when the projection started reading. */
  epoch: number;
  version: string;
  completedAt: number;
};
const latestStackProjections = new WeakMap<DesktopBackendRegistry, StackProjectionRecord>();
const stackPrScopes = new WeakMap<NavigationQueryIndex, StackPrRelevanceScope>();

function navigationIndexVersion(
  registry: DesktopBackendRegistry,
  overlayStore: ReturnType<typeof getDesktopOverlayStore>,
  includeViewerTables = true,
): string {
  const sourceVersion = includeViewerTables
    ? overlayStore.readNavigationSourceVersion?.() ?? ""
    : overlayStore.readOwnerNavigationSourceVersion?.() ?? overlayStore.readNavigationSourceVersion?.() ?? "";
  return `${sourceVersion}|${registry.getStartupProviderRefreshStatus?.()?.state ?? ""}`;
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
    || record.version !== navigationIndexVersion(registry, overlayStore, false)) return undefined;
  const age = Date.now() - record.completedAt;
  return age >= 0 && age <= STACK_DETAIL_REUSE_MS ? record : undefined;
}

export function navigationPullRequestProjection(options: {
  kind: NavigationQueryRequest["query"]["kind"];
  signal?: AbortSignal;
  registry?: DesktopBackendRegistry;
  backgroundValidation?: boolean;
  backend?: AppServerBackendScope;
}): NavigationPullRequestProjection {
  const priority = options.kind === "star-map" ? PR_METADATA_PRIORITY.background : PR_METADATA_PRIORITY.page;
  const verify = (batches: PrSummary[][]) => {
    const registry = options.registry ?? getDesktopBackendRegistry();
    const demand = { signal: options.signal, priority: () => priority };
    return Promise.all(batches.map((prs) => options.backgroundValidation
      ? readSidebarPullRequests(registry, prs, demand)
      : registry.canonicalizeNavigationPullRequests(prs, demand)));
  };
  return {
    verify,
    read: (threads) => {
      options.signal?.throwIfAborted();
      const overlay = getDesktopOverlayStore();
      if (options.backgroundValidation) {
        const registry = options.registry ?? getDesktopBackendRegistry();
        const owner = liveOwners.get(registry);
        const live = owner?.overlay === overlay ? owner.scopes.get(options.backend ?? "all")?.reference.deref() : undefined;
        if (live) return verify(threads.map((ref) => live.attachments(ref)));
      }
      return verify(overlay.readNavigationPullRequests(threads));
    },
  };
}

const pendingSidebarNotifications = new WeakSet<DesktopBackendRegistry>();

function publishSidebarEnrichment(registry: DesktopBackendRegistry): void {
  if (pendingSidebarNotifications.has(registry)) return;
  pendingSidebarNotifications.add(registry);
  setImmediate(() => {
    pendingSidebarNotifications.delete(registry);
    void registry.publishLocalEvent?.({ backend: "codex", notification: {
      method: NAVIGATION_SIDEBAR_ENRICHMENT_UPDATED_METHOD, params: {},
    } }).catch((error: unknown) => navigationQueryLog.warn("sidebar enrichment notification failed", { error: String(error) }));
  });
}

type SidebarPrValidation = {
  rows: PrSummary[];
  prKeys: Set<string>;
  epoch: number;
  verifiedEpoch: number;
  pending: boolean;
  expiresAt: number;
};
type SidebarPrCache = {
  validations: Map<string, SidebarPrValidation>;
  byPr: Map<string, Set<SidebarPrValidation>>;
  checkouts: Map<string, { admitted: Set<string>; expiresAt: number }>;
};
const sidebarPrValidations = new WeakMap<DesktopBackendRegistry, SidebarPrCache>();
const SIDEBAR_PR_VALIDATION_REUSE_MS = 60_000;
const MAX_SIDEBAR_PR_VALIDATIONS = 256;

function indexValidation(cache: SidebarPrCache, entry: SidebarPrValidation, keys: Set<string>): void {
  for (const key of entry.prKeys) {
    const entries = cache.byPr.get(key);
    entries?.delete(entry);
    if (!entries?.size) cache.byPr.delete(key);
  }
  entry.prKeys = keys;
  for (const key of keys) {
    const entries = cache.byPr.get(key);
    if (entries) entries.add(entry);
    else cache.byPr.set(key, new Set([entry]));
  }
}

function sidebarPrCache(registry: DesktopBackendRegistry): SidebarPrCache {
  const existing = sidebarPrValidations.get(registry);
  if (existing) return existing;
  const cache: SidebarPrCache = { validations: new Map(), byPr: new Map(), checkouts: new Map() };
  registry.onEvent?.(({ notification, navigationPullRequestKeyAliases }) => {
    if (notification.method !== "pullRequest/status/updated") return;
    const key = extractPullRequestEventKey(notification.params);
    const affected = new Set<SidebarPrValidation>();
    for (const value of [key, ...(navigationPullRequestKeyAliases ?? [])]) {
      const normalized = value && normalizedNavigationPullRequestKey(value);
      if (!normalized) {
        for (const entry of cache.validations.values()) affected.add(entry);
        break;
      }
      for (const entry of cache.byPr.get(normalized) ?? []) affected.add(entry);
    }
    for (const entry of affected) entry.epoch++;
  });
  sidebarPrValidations.set(registry, cache);
  return cache;
}

// These fields decide automatic attachment membership in filterStoredDiscoveredPullRequests.
// Status, CI and review updates can reuse the checkout verdict until its original expiry.
function checkoutBinding(pr: PrSummary): string {
  const source = pr.sourceRepository ?? pr;
  return JSON.stringify([buildPullRequestStatusKey(pr), source.provider, source.org, source.repo,
    pr.explicitlyAttached, pr.linkedDirectoryPaths, pr.headRefName]);
}

async function readSidebarPullRequests(registry: DesktopBackendRegistry, prs: PrSummary[],
  demand: { signal?: AbortSignal }): Promise<PrSummary[]> {
  demand.signal?.throwIfAborted();
  if (!prs.length) return [];
  const cache = sidebarPrCache(registry);
  const key = createHash("sha256").update(JSON.stringify(prs)).digest("base64url");
  let validation = cache.validations.get(key);
  if (!validation) {
    if (cache.validations.size >= MAX_SIDEBAR_PR_VALIDATIONS) {
      const oldest = [...cache.validations].find(([, entry]) => !entry.pending);
      if (!oldest) return [];
      indexValidation(cache, oldest[1], new Set());
      cache.validations.delete(oldest[0]);
    }
    validation = { rows: [], prKeys: new Set(), epoch: 0, verifiedEpoch: -1, expiresAt: 0, pending: false };
    cache.validations.set(key, validation);
    indexValidation(cache, validation, new Set(prs.map(buildPullRequestStatusKey)));
  }
  const entry = validation;
  const { epoch } = entry;
  if (!entry.pending && (entry.expiresAt <= Date.now() || entry.verifiedEpoch !== epoch)) {
    entry.pending = true;
    setImmediate(() => {
      const demand = { priority: () => PR_METADATA_PRIORITY.background, signal: AbortSignal.timeout(30_000) };
      void (async () => {
        const canonical = await registry.canonicalizeNavigationPullRequests(prs, demand, false);
        const bindings = JSON.stringify(canonical.map(checkoutBinding));
        indexValidation(cache, entry, new Set([...prs, ...canonical].map(buildPullRequestStatusKey)));
        const proof = cache.checkouts.get(bindings);
        const reusable = proof && proof.expiresAt > Date.now() ? proof : undefined;
        const verified = reusable ? canonical.filter((pr) => reusable.admitted.has(checkoutBinding(pr)))
          : await registry.canonicalizeNavigationPullRequests(canonical, demand);
        if (entry.epoch !== epoch) { publishSidebarEnrichment(registry); return; }
        entry.expiresAt = reusable?.expiresAt ?? Date.now() + SIDEBAR_PR_VALIDATION_REUSE_MS;
        if (!reusable) {
          if (!cache.checkouts.has(bindings) && cache.checkouts.size >= MAX_SIDEBAR_PR_VALIDATIONS) {
            cache.checkouts.delete(cache.checkouts.keys().next().value!);
          }
          cache.checkouts.set(bindings, { admitted: new Set(verified.map(checkoutBinding)), expiresAt: entry.expiresAt });
        }
        if (!isDeepStrictEqual(entry.rows, verified)) publishSidebarEnrichment(registry);
        entry.rows = verified;
        entry.verifiedEpoch = epoch;
      })().catch((error: unknown) => navigationQueryLog.warn("sidebar PR validation failed", { error: String(error) }))
        .finally(() => { entry.pending = false; });
    });
  }
  return entry.rows;
}

export function navigationQueryShowsStacks(
  query: NavigationQueryRequest["query"],
  consumer?: NavigationQueryRequest["consumer"],
): boolean {
  if (consumer === "mentions") return false;
  return query.kind === "lens" || query.kind === "directory" || query.kind === "children"
    || query.kind === "exact" || query.kind === "search" || query.kind === "star-map";
}

export function isSidebarDisplayQuery(request: NavigationQueryRequest): boolean {
  return request.consumer === "main-sidebar" && request.query.kind !== "group-members" && request.query.kind !== "star-map";
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
 * when the check is still running. Pin refreshes and sidebar queries draw
 * `checking` and can refresh on `navigation/providerThreads/refreshed`.
 */
export async function awaitStartupProviderCoverage(params: {
  query: { kind: string };
  readReason?: NavigationQueryRequest["readReason"];
  deadlineAt?: number;
  registry?: Pick<DesktopBackendRegistry, "getStartupProviderRefreshStatus" | "onEvent">;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.query.kind !== "group-members" || params.readReason === "pins" || params.deadlineAt === undefined) return;
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
  /** Display and coverage checks can use saved membership while discovery runs. */
  useSavedStartupInventory?: boolean;
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
  /** Internal scope to keep a viewer's native stack lease independent of the owner's without re-scanning on remote pin churn. */
  stackLeaseScope?: object;
}): Promise<NavigationQueryIndex> {
  params.signal?.throwIfAborted();
  const registry = params.registry ?? getDesktopBackendRegistry();
  const overlayStore = getDesktopOverlayStore();
  const backend = params.backend ?? "all";
  const reads = params.requireVerifiedDirectories ? actionIndexReads : indexReads;
  const publishesSidebar = backend === "all" && !params.requireVerifiedDirectories;
  const useSavedStartupInventory = params.useSavedStartupInventory && registry.getStartupProviderRefreshStatus?.()?.state === "checking";
  // A refresh reads under its own key: it must not be served a retained or
  // in-flight index that predates it, nor overtake other readers' scans.
  const keyFor = (variant: (string | number)[]) => JSON.stringify([sourceId(registry), sourceId(overlayStore), backend,
    ...variant, ...(params.refreshProviders ? ["refresh-providers"] : []),
    ...(useSavedStartupInventory ? ["saved-startup"] : [])]);
  const selectedStackDetail = params.includeStacks && params.callerReason === "selected-stack-detail";
  const key = keyFor([
    ...(params.viewer ? ["viewer", sourceId(params.viewer.source)] : []),
    ...(params.includeStacks
      ? params.stackLeaseScope
        ? ["stacks", sourceId(params.stackLeaseScope)]
        : selectedStackDetail ? ["stacks", "selected-stack-detail"] : ["stacks"]
      : []),
  ]);
  // An index's coverage reads the startup refresh state, so an index built
  // while startup was checking must not serve a reader after it finishes.
  // The refreshed event invalidates the read too, but a listener that runs
  // before the pool's (owner PR metadata) would join the stale index.
  const sourceVersion = navigationIndexVersion(registry, overlayStore, Boolean(params.viewer));
  // Named connections use separate stores, outside the overlay's SQLite version.
  const version = `${sourceVersion}|${readMessagingBindingsRevision()}`;
  return reads.read(key, async (signal, checkpoint, previous, limitReuseTo) => {
    let navigationChanged = false;
    let stackPrScope: StackPrRelevanceScope | undefined;
    // An event during a scan stops later readers from joining it; they share
    // one follow-up scan. Each run owns its listener, because the pool can
    // run this same load again for a follow-up.
    const unsubscribe = registry.onEvent?.((event) => {
      // Connectivity and remote pin publications change viewer-mounted rows
      // without changing local owner membership, SQLite overlays, or stacks.
      // A PR status observation changes page chips, not the compact index's
      // attachments. The page reads those statuses from the live registry.
      const viewerEvent = viewerOnlyNavigationEvent(event.notification.method);
      if (event.notification.method === NAVIGATION_SIDEBAR_ENRICHMENT_UPDATED_METHOD) return;
      if ((params.includeStacks ? stackIndexEventInvalidates(event.notification, stackPrScope)
        : !viewerEvent
          && event.notification.method !== "pullRequest/status/updated"
          && navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params))
        || (params.viewer && viewerEvent)) {
        navigationChanged = true;
        reads.invalidate(key);
      }
    });
    // The pool owns this listener through its bounded completed reuse window.
    // Eviction/expiry/cancellation aborts the lifetime and releases it.
    signal.addEventListener("abort", () => unsubscribe?.(), { once: true });
    if (params.includeStacks) {
      if (params.viewer) {
        // Share the viewer's stack-free pass across stack-free and stack-bearing
        // readers, while keeping the native stack lease independent of remote
        // pin and peer-status churn. Start both concurrently so the native stack
        // lease joins the same owner observation before viewer pin publication
        // can advance any durable navigation version.
        const [viewerLocal, nativeStacks] = await Promise.all([
          loadLocalNavigationQueryIndex({ ...params, includeStacks: false, signal }),
          loadLocalNavigationQueryIndex({
            ...params,
            viewer: undefined,
            includeStacks: true,
            stackLeaseScope: params.viewer.source,
            signal,
          }),
        ]);
        signal.throwIfAborted();
        stackPrScope = stackPrScopes.get(nativeStacks);
        limitReuseTo(keyFor(["stacks", sourceId(params.viewer.source)]), nativeStacks);
        if (!nativeStacks.stacks?.length) return viewerLocal;
        const nativeRows = navigationQuerySnapshotSharedThreads(viewerLocal);
        const pins = nativeRows && viewerLocal.threads !== nativeRows ? viewerLocal.threads.slice(nativeRows.length) : [];
        const share = nativeRows && viewerLocal.observedAt !== undefined
          && nativeStacks.observedAt === viewerLocal.observedAt
          && nativeStacks.threads.length === nativeRows.length
          && pins.every((thread) => thread.federation);
        let threads: NavigationThreadSummary[];
        if (share) {
          threads = pins.length ? [...nativeStacks.threads, ...pins] : nativeStacks.threads;
        } else {
          const stackThreadsByKey = new Map<string, NavigationThreadSummary>();
          for (const thread of nativeStacks.threads) {
            if (!thread.federation && (thread.stackMemberships?.length || thread.stackLeadPrKey)) {
              stackThreadsByKey.set(buildThreadIdentityKey(thread.source, thread.id), thread);
            }
          }
          threads = viewerLocal.threads.map((thread) => {
            if (thread.federation) return thread;
            const stacked = stackThreadsByKey.get(buildThreadIdentityKey(thread.source, thread.id));
            if (!stacked) return thread;
            return {
              ...thread,
              ...(stacked.stackMemberships ? { stackMemberships: stacked.stackMemberships } : {}),
              ...(stacked.stackLeadPrKey ? { stackLeadPrKey: stacked.stackLeadPrKey } : {}),
            };
          });
        }
        const combined = createNavigationQuerySnapshot({
          ...viewerLocal,
          stacks: nativeStacks.stacks,
          threads,
        }, undefined, share ? nativeStacks : viewerLocal, previous());
        if (stackPrScope) stackPrScopes.set(combined, stackPrScope);
        return combined;
      }
      // Taken before reading: a change during the read makes its result stale.
      const epoch = backend === "all" && !params.requireVerifiedDirectories ? stackInputEpoch(registry)?.value : undefined;
      // Share the same membership with stack-free queries.
      const local = await loadLocalNavigationQueryIndex({ ...params, includeStacks: false, stackLeaseScope: undefined, signal });
      const priority = params.callerReason === "selected-stack-detail"
        ? PR_METADATA_PRIORITY.selected
        : PR_METADATA_PRIORITY.background;
      const { index: projected, prScope } = await projectNavigationIndexStacks(local, registry, sourceVersion, priority, signal, previous);
      stackPrScope = prScope;
      if (prScope) stackPrScopes.set(projected, prScope);
      // Owner and viewer leases project the same native stacks, so either can
      // answer a later stack detail read. A slower read that started before
      // a newer one must not replace it.
      if (epoch !== undefined && !((latestStackProjections.get(registry)?.epoch ?? -1) > epoch)) {
        latestStackProjections.set(registry, {
          stacks: projected.stacks ?? [], prScope, overlayStore, epoch, version: sourceVersion, completedAt: Date.now(),
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
    const visibilitySourceVersion = publishesSidebar
      ? overlayStore.readOwnerNavigationSourceVersion?.() ?? overlayStore.readNavigationSourceVersion?.()
      : undefined;
    const directoryScopeCheckpoint = publishesSidebar ? registry.navigationDirectoryScope?.checkpoint() : undefined;
    if (publishesSidebar) latestVisibilityScanByRegistry.set(registry, observedAt);
    const index = { ...await buildLocalNavigationQueryIndex({ ...params, registry, signal, checkpoint, useSavedStartupInventory }), observedAt };
    // Creation uses the same complete membership that the sidebar just read.
    // Waiting for owner PR metadata work can leave visibility uninitialized
    // even after the directory and its pins have appeared in the window.
    // Normal and forced-refresh scans have independent pool keys. Only the
    // latest scan may publish, and an intervening mutation also makes its
    // membership and pin ranks obsolete even when its coverage is complete.
    if (publishesSidebar
      && latestVisibilityScanByRegistry.get(registry) === observedAt
      && !navigationChanged
      && visibilitySourceVersion === (overlayStore.readOwnerNavigationSourceVersion?.() ?? overlayStore.readNavigationSourceVersion?.())) {
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

type SidebarStackFields = Pick<NavigationThreadSummary, "stackMemberships" | "stackLeadPrKey">;
type SidebarStackRow = { binding: string; fields: SidebarStackFields };

function sidebarStackBinding(row: NavigationThreadSummary): string {
  return JSON.stringify([row.projectKey, row.primaryGitRepository, row.observedGitBranch ?? row.gitBranch,
    row.linkedDirectories.map((directory) => [directory.worktreePath ?? directory.path, directory.repositoryKey, directory.gitBranch]),
    row.prs?.map((pr) => [buildPullRequestStatusKey(pr), pr.headRefName, pr.linkedDirectoryPaths])]);
}

type SidebarStackRead = {
  epoch?: number;
  version?: string;
  expiresAt: number;
  rows: Map<string, SidebarStackRow>;
  pending: boolean;
  requestedAgain: boolean;
};
const sidebarStackReads = new WeakMap<DesktopBackendRegistry, {
  overlay: ReturnType<typeof getDesktopOverlayStore>;
  reads: Map<AppServerBackendScope, SidebarStackRead>;
}>();
function applySidebarStackRows(registry: DesktopBackendRegistry, backend: AppServerBackendScope,
  threads: NavigationThreadSummary[]): NavigationThreadSummary[] {
  const state = sidebarStackReads.get(registry);
  const rows = state?.overlay === getDesktopOverlayStore() ? state.reads.get(backend)?.rows : undefined;
  return threads.map((row) => {
    const stack = rows?.get(buildThreadIdentityKey(row.source, row.id));
    if (stack && stack.binding === sidebarStackBinding(row)) return { ...row, ...stack.fields };
    if (!row.stackMemberships) return row;
    const { stackMemberships: _members, stackLeadPrKey: _lead, ...plain } = row;
    return plain;
  });
}

async function waitForSidebarRead<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  const cancelled = Promise.withResolvers<never>();
  using _abort = addAbortListener(signal, () => cancelled.reject(signal.reason));
  return await Promise.race([work, cancelled.promise]);
}

/** Sidebar membership and selection can render while the stack lease verifies Git. */
export async function loadSidebarNavigationQueryIndex(
  params: Parameters<typeof loadLocalNavigationQueryIndex>[0] & { viewerPins?: NavigationViewerProjection },
): Promise<NavigationQueryIndex> {
  params.signal?.throwIfAborted();
  if (params.requireVerifiedDirectories || params.refreshProviders) return loadLocalNavigationQueryIndex(params);
  const registry = params.registry ?? getDesktopBackendRegistry();
  const backend = params.backend ?? "all";
  const overlay = getDesktopOverlayStore();
  const live = liveOwnerIndex(registry, backend, params.callerReason, overlay, !params.registry);
  const { owner, local } = await listingDiagnostics.trace("viewer-index", {}, async () => {
    const owner = await waitForSidebarRead(live.read(), params.signal);
    params.signal?.throwIfAborted();
    const local = params.viewerPins ? await waitForSidebarRead(live.viewer(owner, params.viewerPins, overlay.readViewerNavigationSourceVersion?.() ?? overlay.readNavigationSourceVersion?.() ?? ""), params.signal)
      : params.viewer ? createNavigationQuerySnapshot(await waitForSidebarRead(params.viewer.project(owner), params.signal), undefined, owner) : owner;
    return { owner, local };
  });
  params.signal?.throwIfAborted();
  if (!params.includeStacks || local.coverage?.state === "checking") return local;
  const epoch = stackInputEpoch(registry);
  let state = sidebarStackReads.get(registry);
  if (state?.overlay !== overlay) sidebarStackReads.set(registry, state = { overlay, reads: new Map() });
  const { reads } = state;
  let read = reads.get(backend);
  if (!read) {
    if (reads.size >= 8) {
      const reusable = [...reads].find(([, entry]) => !entry.pending);
      if (!reusable) return local;
      reads.delete(reusable[0]);
    }
    reads.set(backend, read = { rows: new Map(), expiresAt: 0, pending: false, requestedAgain: false });
  }
  const current = read.epoch === epoch?.value && read.version === navigationIndexVersion(registry, overlay, false);
  if (!current || read.expiresAt <= Date.now()) refreshSidebarStacks(read, registry, owner, live, backend, epoch);
  return local;
}

function refreshSidebarStacks(read: SidebarStackRead, registry: DesktopBackendRegistry,
  owner: NavigationQueryIndex, live: LiveNavigationIndex, backend: AppServerBackendScope, epoch?: { value: number }): void {
  if (read.pending) {
    read.requestedAgain = true;
    return;
  }
  read.pending = true;
  const overlay = getDesktopOverlayStore();
  const startedEpoch = epoch?.value;
  const version = navigationIndexVersion(registry, overlay, false);
  const isCurrent = () => getDesktopOverlayStore() === overlay
    && startedEpoch === epoch?.value && version === navigationIndexVersion(registry, overlay, false);
  // Even candidate enumeration and reading attachments belong to the background refresh.
  void new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => projectNavigationStacks(owner.threads.map((row) => {
      if (!row.stackMemberships) return row;
      const { stackMemberships: _members, stackLeadPrKey: _lead, ...unadorned } = row;
      return unadorned;
    }), registry, PR_METADATA_PRIORITY.background, AbortSignal.timeout(30_000)))
    .then(({ projection, prScope }) => {
      if (!isCurrent()) return;
      if (backend === "all" && startedEpoch !== undefined && owner.coverage?.state === "complete" && live.isCurrent(owner)) {
        latestStackProjections.set(registry, {
          stacks: projection?.stacks ?? [], prScope, overlayStore: overlay, epoch: startedEpoch, version, completedAt: Date.now(),
        });
      }
      const rows = new Map<string, SidebarStackRow>();
      for (const row of projection?.threads ?? []) {
        if (row.stackMemberships?.length) rows.set(buildThreadIdentityKey(row.source, row.id), {
          binding: sidebarStackBinding(row),
          fields: { stackMemberships: row.stackMemberships, stackLeadPrKey: row.stackLeadPrKey },
        });
      }
      const changed = [...new Set([...rows.keys(), ...read.rows.keys()])].filter((id) => !isDeepStrictEqual(rows.get(id), read.rows.get(id)));
      read.epoch = startedEpoch;
      read.version = version;
      read.expiresAt = Date.now() + STACK_DETAIL_REUSE_MS;
      if (changed.length) {
        read.rows = rows;
        live.refreshRows(changed, true);
        publishSidebarEnrichment(registry);
      }
    }).finally(() => {
      read.pending = false;
      const requestedAgain = read.requestedAgain;
      read.requestedAgain = false;
      if (requestedAgain && getDesktopOverlayStore() === overlay && !isCurrent()) publishSidebarEnrichment(registry);
    }).catch((error: unknown) => navigationQueryLog.warn("sidebar stack refresh failed", { error: String(error) }));
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

type NavigationStackProjection = {
  projection: Pick<NavigationQueryIndex, "threads" | "stacks"> | undefined;
  prScope: StackPrRelevanceScope | undefined;
};
const activeStackReads = new Map<string, SharedPrMetadataRead<NavigationStackProjection>>();

async function projectNavigationIndexStacks(
  local: NavigationQueryIndex,
  registry: DesktopBackendRegistry,
  version: string,
  priority: number,
  signal: AbortSignal,
  previous: () => NavigationQueryIndex | undefined,
): Promise<{ index: NavigationQueryIndex; prScope: StackPrRelevanceScope | undefined }> {
  const nativeRows = navigationQuerySnapshotSharedThreads(local);
  const pins = nativeRows && local.threads !== nativeRows ? local.threads.slice(nativeRows.length) : [];
  const observedAt = local.observedAt;
  // A viewer observes the same native inventory even if saving its resolved
  // pins advances the source version while projecting this read.
  const share = priority === PR_METADATA_PRIORITY.background
    && Boolean(nativeRows && observedAt !== undefined && pins.every((thread) => thread.federation));
  const { projection, prScope } = share
    ? await readActiveNavigationStacks(nativeRows!, observedAt!, registry, version, priority, signal)
    : await projectNavigationStacks(local.threads, registry, priority, signal);
  if (!projection) return { index: local, prScope };
  return {
    index: createNavigationQuerySnapshot({
      ...local,
      ...projection,
      threads: share && pins.length ? [...projection.threads, ...pins] : projection.threads,
    }, undefined, local, previous()),
    prScope,
  };
}

async function readActiveNavigationStacks(
  nativeRows: readonly NavigationThreadSummary[],
  observedAt: number,
  registry: DesktopBackendRegistry,
  version: string,
  priority: number,
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
      return await projectNavigationStacks(nativeRows, registry, priority, demand.signal!);
    } finally {
      release();
    }
  });
  let unsubscribe: (() => void) | undefined = registry.onEvent?.((event) => {
    if (stackIndexEventInvalidates(event.notification)) release();
  });
  read.signal.addEventListener("abort", release, { once: true });
  activeStackReads.set(key, read);
  return await read.read({ signal });
}

async function projectNavigationStacks(
  threads: readonly NavigationThreadSummary[],
  registry: DesktopBackendRegistry,
  priority: number,
  signal: AbortSignal,
): Promise<NavigationStackProjection> {
  const prKeys = new Set<string>();
  const repositories = new Set<string>();
  const recordPr = (pr: PrSummary) => {
    const key = buildPullRequestStatusKey(pr);
    prKeys.add(key);
    const repo = normalizedPullRequestRepository(key);
    if (repo) repositories.add(repo);
  };
  const candidates = threads.filter((thread) => !thread.federation && (thread.linkedDirectories?.some((directory) =>
    directory.gitBranch || directory.worktreePath || directory.repositoryKey)
    || ((thread.observedGitBranch || thread.gitBranch) && thread.linkedDirectories?.length)));
  if (!candidates.length) {
    return { projection: undefined, prScope: { prKeys, repositories } };
  }
  const attachments = getDesktopOverlayStore().readNavigationPullRequests(
    candidates.map((thread) => ({ backend: thread.source, threadId: thread.id })),
  );
  for (const list of attachments) {
    for (const pr of list ?? []) recordPr(pr);
  }
  // Canonical status supplies the refs used to find potential stacks. Validate
  // automatic attachments only after checkout and stack admission. Neither
  // navigation nor stack detail can initiate forge repository-name lookups.
  const demand = { signal, priority: () => priority, allowForgeLookup: false as const };
  const rows = await Promise.all(candidates.map(async (thread, index) => ({
    ...thread,
    prs: attachments[index]?.length ? await registry.canonicalizeNavigationPullRequests(attachments[index]!, demand, false) : [],
  })));
  signal.throwIfAborted();
  for (const row of rows) {
    for (const pr of row.prs) recordPr(pr);
  }
  const validated = new Map<string, readonly PrSummary[]>(rows.map((row) => [
    buildThreadIdentityKey(row.source, row.id), row.prs,
  ]));
  const { stacks, catalogs } = await stackReader.read(rows, [], undefined,
    (key) => registry.readStackThreadActivity?.(key) ?? Promise.resolve({}),
    new StackReadObservation(demand), async (row, attachmentDemand) => {
      const prs = await registry.canonicalizeNavigationPullRequests(row.prs, attachmentDemand);
      validated.set(buildThreadIdentityKey(row.source, row.id), prs);
      return prs;
    });
  signal.throwIfAborted();
  let incompleteCatalog = false;
  for (const catalog of catalogs) {
    if (catalog.status === "unavailable") {
      incompleteCatalog = true;
      continue;
    }
    if (catalog.status !== "ok") continue;
    const repo = normalizedPullRequestRepository(catalog.catalog.repository);
    if (repo) repositories.add(repo);
  }
  for (const stack of stacks) {
    const repo = normalizedPullRequestRepository(stack.repository);
    if (repo) repositories.add(repo);
    for (const layer of stack.layers) {
      if (repo && layer.pullRequest) prKeys.add(`${repo}#${layer.pullRequest.number}`);
    }
  }
  const prScope = incompleteCatalog ? undefined : { prKeys, repositories };
  return { projection: projectBoundNavigationStacks(threads, stacks, validated), prScope };
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
  useSavedStartupInventory?: boolean;
  requireVerifiedDirectories?: boolean;
  registry: DesktopBackendRegistry;
  signal: AbortSignal;
  checkpoint: NavigationIndexCheckpoint;
}): Promise<NavigationQueryIndex> {
  const registry = params.registry;
  const overlayStore = getDesktopOverlayStore();
  const backend = params.backend ?? "all";
  const provider = backend === "all" ? undefined : backend;
  const saved = params.useSavedStartupInventory && !params.refreshProviders && !params.requireVerifiedDirectories
    ? registry.readStartupNavigationThreads?.(provider) : undefined;
  // Membership refreshes also run on navigation and directory-announcer
  // timers. Opening a thread counts through its own foreground read.
  const listedThreads = await (saved ?? withCodexRequestActivity({ countsAsActivity: false }, () =>
    registry.listThreads({
      backend: provider,
      callerReason: params.callerReason,
      enrichDirectories: params.requireVerifiedDirectories === true,
      skipPendingDirectoryEnrichment: !params.requireVerifiedDirectories,
      ...(params.refreshProviders || params.requireVerifiedDirectories ? { forceRefresh: true } : {}),
    })));
  params.signal?.throwIfAborted();
  // Finish a saved-state paint even if discovery publishes during its
  // projection. New readers can join the live index on the next pass.
  const checkpoint = saved ? () => {} : params.checkpoint;
  // An overtaken scan whose follow-up already has readers hands them over
  // here instead of spending CPU on a projection nobody would keep.
  checkpoint();
  const checkoutProjection = await projectNavigationCheckoutDirectories(
    listedThreads, params.signal, checkpoint, params,
  );
  params.signal.throwIfAborted();
  const index = overlayStore.readNavigationQueryIndex({
    backend,
    ...checkoutProjection,
    workspaceRoots: resolveScratchProjectsRoots(),
  });
  params.signal?.throwIfAborted();
  const threads = await decorateNavigationRows(index.threads, registry, params.signal);
  const projects = await projectDirectories(index, threads, overlayStore, true, params.signal);
  // Startup refresh status says only whether live listings have begun: it
  // records one attempt, and a Claude or ACP discovery failure in it says
  // nothing about rows PwrAgent stores itself. Completeness belongs to the
  // listing this index was built from, so a recovered Codex completes the
  // next index and a later Codex failure cannot pass as complete.
  const coverage: NavigationQueryIndex["coverage"] =
    saved || registry.getStartupProviderRefreshStatus?.()?.state === "checking"
      ? { state: "checking" }
      : registry.isIncompleteThreadList?.(listedThreads)
        ? { state: "degraded", failedProviders: 1 }
        : { state: "complete" };
  return { ...projects, threads: registry.withNavigationSubAgentActivity(threads), inputRequestThreadKeys: registry.getNavigationInputRequestThreadKeys(),
    coverage,
  };
}

async function decorateNavigationRows(rows: NavigationThreadSummary[], registry: DesktopBackendRegistry, signal?: AbortSignal) {
  const overlayStore = getDesktopOverlayStore();
  const bindings = await buildNavigationIndexMessagingBindings(rows);
  signal?.throwIfAborted();
  const boundThreads = bindings.size === 0 ? rows : rows.map((thread) => {
    const messagingBindings = bindings.get(buildThreadIdentityKey(thread.source, thread.id));
    return messagingBindings ? { ...thread, messagingBindings } : thread;
  });
  // One read of every active watch, for the rows' CI watch marks.
  const watchedThreads = await attachNavigationPrCiWatchMarks(
    boundThreads,
    () => rows.length === 1 && overlayStore.listActiveThreadPrStatusWatches
      ? overlayStore.listActiveThreadPrStatusWatches({ backend: rows[0]!.source, threadId: rows[0]!.id })
      : overlayStore.listAllActivePrStatusWatches(),
  );
  signal?.throwIfAborted();
  return registry.hydrateThreadGitWorkingStates(registry.withNavigationPrimaryGitRepositories(watchedThreads), {
    probeMissing: false,
  });
}

async function projectDirectories(index: ReturnType<ReturnType<typeof getDesktopOverlayStore>["readNavigationQueryIndex"]> |
  ReturnType<ReturnType<typeof getDesktopOverlayStore>["readNavigationQueryDirectories"]>, threads: NavigationThreadSummary[],
  overlayStore: ReturnType<typeof getDesktopOverlayStore>, enrich: boolean, signal?: AbortSignal) {
  const directoryStatusCache = await overlayStore.readDirectoryGitStatusCache();
  signal?.throwIfAborted();
  const withGitStatus: NavigationDirectorySummary[] = index.directories.map(
    (directory) => ({
      ...directory,
      gitStatus: directoryStatusCache[directory.key]?.gitStatus,
    }),
  );
  if (!enrich) return { directories: withGitStatus };
  return resolveNavigationWorktreeProjects(withGitStatus, {
    threads, signal, directoryOverlays: index.directoryOverlays, gitStatusByKey: directoryStatusCache,
  });
}

type LiveScope = { live?: LiveNavigationIndex; reference: WeakRef<LiveNavigationIndex>; bytes: number; unsubscribe: () => void };
type LiveOwner = { overlay: ReturnType<typeof getDesktopOverlayStore>; scopes: Map<AppServerBackendScope, LiveScope> };
const liveOwners = new WeakMap<DesktopBackendRegistry, LiveOwner>();

// A single oversized inventory can finish serving its readers and background
// verification. Neither the registry listener nor the reuse slot keeps it alive.
function listenToLiveIndex(registry: DesktopBackendRegistry, reference: WeakRef<LiveNavigationIndex>): () => void {
  const stop = registry.onEvent((event) => {
    const live = reference.deref();
    if (live) live.event(event);
    else stop();
  });
  return stop;
}

function admitLiveIndex(owner: LiveOwner, backend: AppServerBackendScope, live: LiveNavigationIndex, bytes: number): void {
  const scope = owner.scopes.get(backend);
  if (scope?.reference.deref() !== live) return;
  scope.bytes = bytes;
  scope.live = bytes <= NAVIGATION_RETAINED_BYTE_BUDGET ? live : undefined;
  let total = 0;
  for (const candidate of owner.scopes.values()) if (candidate.live) total += candidate.bytes;
  for (const [key, candidate] of owner.scopes) {
    if (total <= NAVIGATION_RETAINED_BYTE_BUDGET) break;
    if (candidate === scope || !candidate.live) continue;
    total -= candidate.bytes;
    owner.scopes.delete(key);
    candidate.unsubscribe();
  }
}

function liveOwnerIndex(registry: DesktopBackendRegistry, backend: AppServerBackendScope, callerReason: string,
  overlay: ReturnType<typeof getDesktopOverlayStore>, announce: boolean): LiveNavigationIndex {
  let owner = liveOwners.get(registry);
  if (owner?.overlay !== overlay) {
    for (const scope of owner?.scopes.values() ?? []) { scope.unsubscribe(); scope.reference.deref()?.close(); }
    liveOwners.set(registry, owner = { overlay, scopes: new Map() });
  }
  const existing = owner.scopes.get(backend);
  const cached = existing?.reference.deref();
  if (existing) {
    owner.scopes.delete(backend);
    if (cached) {
      owner.scopes.set(backend, existing);
      return cached;
    }
    existing.unsubscribe();
  }
  if (owner.scopes.size >= 8) {
    const oldest = owner.scopes.keys().next().value!;
    owner.scopes.get(oldest)!.unsubscribe();
    owner.scopes.delete(oldest);
  }
  type CheckoutFields = Pick<AppServerThreadSummary, "projectKey" | "linkedDirectories" | "observedGitBranch">;
  function checkoutFields({ projectKey, linkedDirectories, observedGitBranch }: CheckoutFields): CheckoutFields {
    return { projectKey, linkedDirectories, observedGitBranch };
  }
  let checkouts = new Map<string, { input: CheckoutFields; output: CheckoutFields }>();
  let managedKeys: ReadonlySet<string> | undefined;
  // Keep SQLite's aggregate admission limit across incremental joins as well.
  const rowBytes = new Map<string, number>();
  let totalBytes = 0;
  let directoryBytes = 0;
  function measureRow(key: string, bytes: number): void {
    totalBytes += bytes - (rowBytes.get(key) ?? 0);
    if (bytes) rowBytes.set(key, bytes);
    else rowBytes.delete(key);
  }
  let aliases: Parameters<typeof overlay.readNavigationQueryThreads>[0]["worktreeRepositoryAliases"];
  let seedJoin: {
    version: string;
    joinedAt: number;
    expiresAt: number;
    workspaceRoots: string[];
    threads: AppServerThreadSummary[];
    aliases: typeof aliases;
    joined: ReturnType<typeof overlay.readNavigationQueryIndex>;
  } | undefined;
  const handoffChildren = new Map<string, Set<string>>();
  function rememberHandoffDependency(child: string, dependency: string): void {
    const children = handoffChildren.get(dependency);
    if (children) children.add(child);
    else handoffChildren.set(dependency, new Set([child]));
  }
  function useCheckout<T extends AppServerThreadSummary>(input: T): T {
    const prior = checkouts.get(buildThreadIdentityKey(input.source, input.id));
    if (!prior || prior.input.projectKey !== input.projectKey || !isDeepStrictEqual(prior.input.linkedDirectories, input.linkedDirectories)) return input;
    return { ...input, linkedDirectories: prior.output.linkedDirectories,
      ...(prior.input.observedGitBranch !== prior.output.observedGitBranch ? { observedGitBranch: prior.output.observedGitBranch } : {}) };
  }
  const live = new LiveNavigationIndex({
    backend, recheckMs: DIRECTORY_SET_RECHECK_INTERVAL_MS,
    visibility: backend === "all" ? (observedAt) => {
      const version = overlay.readOwnerNavigationSourceVersion?.();
      const fence = registry.navigationDirectoryScope?.checkpoint();
      latestVisibilityScanByRegistry.set(registry, observedAt);
      return (index) => {
        if (latestVisibilityScanByRegistry.get(registry) !== observedAt || version !== overlay.readOwnerNavigationSourceVersion?.()
          || registry.navigationDirectoryScope?.checkpoint() !== fence) return;
        if (fence !== undefined) registry.navigationDirectoryScope.remember(index, fence);
        if (index.coverage?.state === "complete") registry.rememberNavigationVisibilityIndex?.(index);
        if (announce) getNavigationDirectorySetAnnouncer().observe(index.directories);
      };
    } : undefined,
    version: () => (overlay.readOwnerNavigationSourceVersion?.() ?? overlay.readNavigationSourceVersion?.() ?? "")
      + "|" + readMessagingBindingsRevision(),
    sqlite: (rows) => registry.reconcileSqliteNavigationThreads(rows, backend),
    changedKeys: (before, after) => {
      const [storage, bindings] = before.split("|");
      const [nextStorage, nextBindings] = after.split("|");
      return bindings === nextBindings ? overlay.readChangedNavigationThreadKeys?.(storage!, nextStorage!) : undefined;
    },
    list: async (scope, seed, forceRefresh) => {
      const provider = scope === "all" ? undefined : scope;
      const checking = registry.getStartupProviderRefreshStatus?.()?.state === "checking";
      const saved = (seed || checking) && (registry.readSavedNavigationThreads?.(provider) ?? registry.readStartupNavigationThreads?.(provider));
      const rows = await (saved || withCodexRequestActivity({ countsAsActivity: false }, () => registry.listThreads({
        backend: provider, callerReason, enrichDirectories: false, skipPendingDirectoryEnrichment: true, ...(forceRefresh ? { forceRefresh } : {}),
      })));
      return { rows, verifyAfterSeed: Boolean(saved) && !checking,
        checkoutsAfterSeed: seed && !saved && !checking && rows.some((row) => row.source === "codex" && (row.projectKey || row.gitOriginUrl)), coverage: checking || saved ? { state: "checking" }
        : registry.isIncompleteThreadList?.(rows) ? { state: "degraded", failedProviders: 1 } : { state: "complete" } };
    },
    cached: (provider, threadId) => registry.getCachedNavigationThread?.({ backend: provider, threadId }) ?? registry.getCachedThreadSummary?.({ backend: provider, threadId }),
    refresh: (backend, threadId, activity, workers) => registry.refreshNavigationThread?.({ backend, threadId }, activity, workers),
    verifySeedDirectories: (index) => index.directories.some((directory) => directory.kind === "directory" && directory.path && path.isAbsolute(directory.path)),
    status: (row) => registry.navigationThreadStatus?.(row),
    join: (rows, coverage, mode, seedCurrent) => listingDiagnostics.trace("index", {}, async () => {
      const seed = seedJoin;
      seedJoin = undefined;
      const enrich = mode !== "saved";
      const projected = mode === "refresh" ? await projectNavigationCheckoutDirectories(rows, AbortSignal.timeout(30_000), () => {}, {})
        : { threads: rows.map(useCheckout), worktreeRepositoryAliases: aliases };
      aliases = projected.worktreeRepositoryAliases;
      checkouts = new Map(rows.map((input, i) => [buildThreadIdentityKey(input.source, input.id),
        { input: checkoutFields(input), output: checkoutFields(projected.threads[i]!) }]));
      const workspaceRoots = resolveScratchProjectsRoots();
      const version = seedCurrent?.() ? overlay.readNavigationSeedJoinVersion?.() : undefined;
      const now = version === undefined ? 0 : Date.now();
      let expiresAt = Infinity;
      let joined: ReturnType<typeof overlay.readNavigationQueryIndex>;
      if (seed && seed.version === version && seed.joinedAt <= now && now < seed.expiresAt
        && isDeepStrictEqual(seed.threads, projected.threads)
        && isDeepStrictEqual(seed.aliases, aliases) && isDeepStrictEqual(seed.workspaceRoots, workspaceRoots)) {
        // The seed also populated the row byte accounting and handoff dependencies.
        joined = seed.joined;
      } else {
        handoffChildren.clear();
        rowBytes.clear();
        totalBytes = 0;
        const inboxClock = mode === "saved" && version !== undefined ? { now,
          observeSnooze: (until: number) => { if (until > now) expiresAt = Math.min(expiresAt, until); },
        } : undefined;
        joined = overlay.readNavigationQueryIndex({ backend, ...projected, workspaceRoots,
          inboxClock,
          measureRow, measureDirectories: (bytes) => { directoryBytes = bytes; },
          managedMembership: (keys) => { managedKeys = keys; }, handoffDependency: rememberHandoffDependency });
      }
      const threads = registry.withNavigationSubAgentActivity(await decorateNavigationRows(joined.threads, registry));
      const directories = await projectDirectories(joined, threads, overlay, enrich);
      if (mode === "saved" && version !== undefined && seedCurrent?.() && overlay.readNavigationSeedJoinVersion?.() === version) {
        seedJoin = { version, joinedAt: now, expiresAt, workspaceRoots, threads: projected.threads, aliases, joined };
      }
      return { ...directories, threads: applySidebarStackRows(registry, backend, threads), coverage,
        inputRequestThreadKeys: registry.getNavigationInputRequestThreadKeys() };
    }),
    decorate: (rows) => applySidebarStackRows(registry, backend, rows),
    forget: (id) => { measureRow(id, 0); checkouts.delete(id); },
    dependents: (id) => handoffChildren.get(id),
    projectRows: async (inputs, hasProvider) => {
      const rows = inputs.map(useCheckout);
      const { threads } = overlay.readNavigationQueryThreads({ backend, threads: rows, workspaceRoots: resolveScratchProjectsRoots(),
        worktreeRepositoryAliases: aliases, hasProvider, measureRow, handoffDependency: rememberHandoffDependency,
        managedMembership: (current) => {
          if (managedKeys && managedKeys !== current) {
            live.refreshRows([...managedKeys].filter((key) => !current.has(key)));
            live.refreshRows([...current].filter((key) => !managedKeys!.has(key)));
          }
          managedKeys = current;
        },
      });
      if (totalBytes + directoryBytes > NAVIGATION_INDEX_MAX_INPUT_BYTES) throw new Error("Owner navigation overlay index exceeds its 32 MiB admission budget.");
      return registry.withNavigationSubAgentActivity(await decorateNavigationRows(threads, registry));
    },
    directories: async (threads) => projectDirectories(overlay.readNavigationQueryDirectories(threads, resolveScratchProjectsRoots(), totalBytes,
      (bytes) => { directoryBytes = bytes; }),
      threads, overlay, true),
    inputKeys: () => registry.getNavigationInputRequestThreadKeys(),
    notify: () => {
      void registry.publishLocalEvent?.({ backend: backend === "all" ? "codex" : backend, notification: {
        method: "navigation/invalidated", params: { sourceMethod: NAVIGATION_LIVE_INDEX_RECONCILED_METHOD },
      } }).catch((error: unknown) => navigationQueryLog.warn("navigation reconciliation notification failed", { error: String(error) }));
    },
    retentionChanged: (bytes) => admitLiveIndex(owner, backend, live, bytes),
    failed: (error) => navigationQueryLog.warn("navigation reconciliation failed", { error: String(error) }),
  });
  const reference = new WeakRef(live);
  owner.scopes.set(backend, { live, reference, bytes: 0, unsubscribe: listenToLiveIndex(registry, reference) });
  return live;
}
