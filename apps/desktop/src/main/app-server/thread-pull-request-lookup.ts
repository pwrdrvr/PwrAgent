import type { OverlayStoreLike, PrLookupCacheEntry } from "../storage/desktop-overlay-store";
import { canonicalizeDetachedPrKeys } from "../pr-status/detached-pr-keys";
import {
  type AppServerBackendKind,
  type RefreshThreadPullRequestsRequest,
  type RefreshThreadPullRequestsResponse,
  type PrSummary,
  type ProjectForgeAutomation,
  projectAllowsForgePolling,
  type ThreadOverlayState,
} from "@pwragent/shared";
import { DEFAULT_PULL_REQUEST_PROVIDER, buildThreadIdentityKey, isRemoteFederationTarget } from "@pwragent/shared";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { isFederationPeerUnavailableError } from "../federation/federation-peer-unavailable-error";
import { getMainLogger } from "../log";
import type { ForgePrFetcher } from "../pr-status/forge-pr-fetcher";
import { detectPullRequestsForThread } from "../pr-status/pr-detection";
import type { PrActivityJournal } from "../pr-status/pr-activity";
import { PrLookupsInFlight } from "../pr-status/pr-lookups-in-flight";
import type { PullRequestRepositoryAliases } from "../pr-status/pr-repository-aliases";
import {
  associatePrsWithLinkedDirectories,
  dedupePrsByStatusKey,
  getPrStatusKey,
  normalizePrLookupDirectoryPaths,
  normalizePrSummary,
  normalizePullRequestProvider,
  prLogIds,
  prLogStatuses,
  prSummariesEqual,
} from "./thread-pull-request-summaries";

const appServerLog = getMainLogger("pwragent:app-server");

const THREAD_PR_REFRESH_MIN_INTERVAL_MS = 60_000;

const USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS = 10_000;

/**
 * The renderer's selected-thread tick is also 60s, but it runs on its own
 * timer and its age is measured here from a later stamp (the IPC hop, and the
 * lookup's observation token). With no slack, jitter of a few milliseconds
 * postponed every other tick and halved the cadence. The cooldown exists to
 * stop floods, which this slack still does.
 */
const SCHEDULED_THREAD_PR_REFRESH_SLACK_MS = 5_000;

const TERMINAL_USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS = 60_000;

function getThreadPullRequestsRequestKey(
  backend: AppServerBackendKind,
  request: RefreshThreadPullRequestsRequest,
): string {
  return JSON.stringify({
    lookupVersion: 3,
    backend,
    threadId: request.threadId,
    provider: normalizePullRequestProvider(request.provider),
    branch: request.branch.trim(),
    directoryPaths: request.directoryPaths,
  });
}

function getPullRequestLookupKey(
  request: Pick<
    RefreshThreadPullRequestsRequest,
    "provider" | "branch" | "directoryPaths"
  >,
): string {
  return JSON.stringify({
    lookupVersion: 2,
    provider: normalizePullRequestProvider(request.provider),
    branch: request.branch.trim(),
    directoryPaths: normalizePrLookupDirectoryPaths(request.directoryPaths),
  });
}

function filterDetachedPullRequests(
  prs: PrSummary[],
  detachedPrKeys: string[] | undefined,
): PrSummary[] {
  if (!detachedPrKeys?.length) {
    return prs;
  }
  const detached = new Set(
    detachedPrKeys.map((key) => key.trim().toLowerCase()).filter(Boolean),
  );
  return prs.filter((pr) => !detached.has(getPrStatusKey(pr)));
}

type PullRequestLookupParams = {
  backend: AppServerBackendKind;
  request: RefreshThreadPullRequestsRequest;
  lookupKey: string;
  lookupDirectoryPaths: string[];
  previousPrs: PrSummary[];
};

type PullRequestLookupResult = {
  prs: PrSummary[];
  statusPrs: PrSummary[];
  fetchedAt: number;
  incomplete: boolean;
};

type PrLookupRegistryEntry = {
  prs: PrSummary[];
  fetchedAt: number;
  provider: string;
  branch: string;
  directoryPaths: string[];
  lastScheduledRefreshRequestedAt?: number;
  lastUserRefreshRequestedAt?: number;
};

type PrLookupSubscriber = {
  backend: AppServerBackendKind;
  threadId: string;
  requestKey: string;
  linkedDirectoryPaths: string[];
  previousPrs: PrSummary[];
};

type PrLookupRefreshParams = {
  backend: AppServerBackendKind;
  request: RefreshThreadPullRequestsRequest;
  requestKey: string;
  lookupKey: string;
  lookupDirectoryPaths: string[];
  previousPrs: PrSummary[];
  // When this thread's own overlay last answered this lookup. It counts
  // toward this thread's refresh cooldown only and never enters the shared
  // lookup registry.
  threadLookupObservedAt?: number;
};

type PendingPrLookupRefresh = {
  authoritative: boolean;
  promise: Promise<void>;
};

type PrLookupRefreshClaim =
  | {
      refreshKey: string;
      skippedReason?: undefined;
    }
  | {
      refreshKey?: undefined;
      skippedReason: "cooldown" | "scheduled-token-bucket";
      ageMs?: number;
      minIntervalMs?: number;
      nextAllowedInMs?: number;
    };

function userPrRefreshLogPayload(params: {
  backend: AppServerBackendKind;
  branch: string;
  directoryPathCount: number;
  existingLookupMatches?: boolean;
  ghAvailable?: boolean;
  lookupCacheHit?: boolean;
  lookupKey?: string;
  previousPrs?: PrSummary[];
  provider: string;
  reason?: string;
  requestKey?: string;
  threadId: string;
  trigger: NonNullable<RefreshThreadPullRequestsRequest["trigger"]>;
}): Record<string, unknown> {
  return {
    backend: params.backend,
    branch: params.branch,
    directoryPathCount: params.directoryPathCount,
    existingLookupMatches: params.existingLookupMatches,
    ghAvailable: params.ghAvailable,
    lookupCacheHit: params.lookupCacheHit,
    lookupKey: params.lookupKey,
    previousPrIds: prLogIds(params.previousPrs ?? []),
    previousPrStatuses: prLogStatuses(params.previousPrs ?? []),
    provider: params.provider,
    reason: params.reason,
    requestKey: params.requestKey,
    threadId: params.threadId,
    trigger: params.trigger,
  };
}

function pullRequestStatusFreshness(
  fetchedAt: number | undefined,
  now: number,
): Pick<
  RefreshThreadPullRequestsResponse,
  "lastStatusCheckAt" | "lastStatusCheckAgeMs"
> {
  if (!fetchedAt || fetchedAt <= 0) {
    return {};
  }
  return {
    lastStatusCheckAt: fetchedAt,
    lastStatusCheckAgeMs: Math.max(0, now - fetchedAt),
  };
}

type PrLookupStore = Pick<OverlayStoreLike,
  "getThreadOverlayState" | "setThreadPullRequests" | "readPrLookupCache" | "writePrLookupCacheEntry"
>;

type ThreadPullRequestLookupPorts = {
  getOverlayStore(): PrLookupStore;
  loadPrStatusRegistry(): Promise<void>;
  filterStoredDiscoveredPrs(prs: PrSummary[]): Promise<PrSummary[]>;
  mergePrHistory(
    existingPrs: PrSummary[],
    discoveredPrs: PrSummary[],
  ): PrSummary[];
  rememberPrStatuses(
    prs: PrSummary[],
    fetchedAt: number,
    source: string,
  ): PrSummary[];
  canonicalizePrs(prs: PrSummary[]): PrSummary[];
  detachedPrKeyCanonicalizer(): { canonicalizePrKey?: (key: string) => string };
  publishThreadPullRequestsUpdated(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prs: PrSummary[];
    detachedPrs?: PrSummary[];
  }): Promise<void>;
  getPrFetcher(): ForgePrFetcher;
  storedPrsNeedRename(state: ThreadOverlayState | undefined): boolean;
  threadForgeAutomation(ref: {
    backend: AppServerBackendKind;
    threadId: string;
  }): ProjectForgeAutomation | undefined;
  nextPrObservationTimestamp(): number;
  writePrStatusesToCache(
    prs: PrSummary[],
    fetchedAt: number,
  ): Promise<void>;
  publishPullRequestStatusUpdates(params: {
    backend: AppServerBackendKind;
    prs: PrSummary[];
  }): Promise<void>;
  learnPullRequestRepository(requestedUrl: string, returned: PrSummary | undefined): void;
  recordPrCheck(
    prs: PrSummary[],
    source: string,
    incomplete?: boolean,
    requestingThreadKeys?: string[],
  ): void;
  handlePrAutoDispatchSnapshots(
    prs: PrSummary[],
    observedAt: number,
    operatorInitiated?: boolean,
  ): Promise<void>;
  takePrPollingToken(source: string, prKeys?: string[], threadKeys?: string[]): boolean;
  readonly prRepositoryAliases: Pick<PullRequestRepositoryAliases, "canonicalizeKey" | "renameCandidates" | "confirm" | "canonicalizeUrl">;
  readonly prActivity: Pick<PrActivityJournal, "record">;
  logDebug(event: string, payload: Record<string, unknown>): void;
  isFederationMethodNotFoundError(error: unknown): boolean;
};

/** Owns shared branch lookups and writes each subscriber's thread attachments. */
export class ThreadPullRequestLookup {
  constructor(private readonly ports: ThreadPullRequestLookupPorts) {}

  private readonly pendingThreadPullRequestRefreshes = new Map<
    string,
    Promise<RefreshThreadPullRequestsResponse>
  >();

  private readonly prLookupRegistry = new Map<string, PrLookupRegistryEntry>();

  private readonly pendingPrLookupRefreshes = new Map<
    string,
    PendingPrLookupRefresh
  >();

  private readonly queuedAuthoritativePrLookupRefreshes = new Map<
    string,
    Map<string, PrLookupRefreshParams>
  >();

  private readonly prLookupSubscribers = new Map<
    string,
    Map<string, PrLookupSubscriber>
  >();

  private readonly pendingPrOverlayWrites = new Map<string, Promise<void>>();

  private readonly prLookupsInFlight = new PrLookupsInFlight();

  private prLookupRegistryLoaded = false;

  private prLookupRegistryLoadPromise: Promise<void> | undefined;

  async refreshThreadPullRequests(
    request: RefreshThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const federationTarget = request.federationTarget;
      const federationRuntime = getDesktopFederationRuntime();
      const connectedPeer = federationRuntime.connectedPeerTargets().find(
        (peer) => peer.target.instanceId === federationTarget.instanceId,
      );
      const unavailableResponse = (): RefreshThreadPullRequestsResponse => ({
        backend: request.backend ?? "codex",
        threadId: request.threadId,
        provider: request.provider ?? DEFAULT_PULL_REQUEST_PROVIDER,
        ghAvailable: false,
        prs: [],
        refreshStarted: false,
        skippedReason: "remote_peer_unavailable",
      });
      // Capabilities can survive a disconnect in remembered peer metadata.
      // Background refreshes should stay silent until the owner reconnects.
      if (!connectedPeer) {
        return unavailableResponse();
      }
      const instanceLabel = connectedPeer.label;
      const skippedResponse = (
        reason:
          | "missing-thread-navigation-capability"
          | "remote-method-not-found",
      ): RefreshThreadPullRequestsResponse => {
        const backend = request.backend ?? "codex";
        appServerLog.info(
          `thread PR refresh skipped: attached instance "${instanceLabel}" does not support remote PR refresh`,
          {
            backend,
            instanceId: federationTarget.instanceId,
            reason,
            threadId: request.threadId,
          },
        );
        return {
          backend,
          threadId: request.threadId,
          provider: request.provider ?? DEFAULT_PULL_REQUEST_PROVIDER,
          ghAvailable: false,
          prs: [],
          refreshStarted: false,
          skippedReason: "remote_refresh_unsupported",
        };
      };
      if (!federationRuntime.remoteTargetSupportsCapability(
        federationTarget,
        "thread_navigation",
      )) {
        return skippedResponse("missing-thread-navigation-capability");
      }
      try {
        return await federationRuntime
          .remoteBackend(federationTarget)
          .refreshThreadPullRequests({
            backend: request.backend,
            threadId: request.threadId,
            ...(request.provider ? { provider: request.provider } : {}),
            ...(request.trigger ? { trigger: request.trigger } : {}),
          });
      } catch (error) {
        // The route can disappear after the connected-peer check above.
        if (isFederationPeerUnavailableError(error)) {
          return unavailableResponse();
        }
        if (this.ports.isFederationMethodNotFoundError(error)) {
          return skippedResponse("remote-method-not-found");
        }
        throw error;
      }
    }
    const backend = request.backend ?? "codex";
    const requestKey = getThreadPullRequestsRequestKey(backend, request);
    const pending = this.pendingThreadPullRequestRefreshes.get(requestKey);
    if (pending) {
      if (request.trigger === "user") {
        this.ports.logDebug("threadPullRequestsRefresh:coalesced-request", {
          backend,
          branch: request.branch.trim(),
          directoryPathCount: request.directoryPaths.length,
          requestKey,
          threadId: request.threadId,
          trigger: request.trigger,
        });
      }
      return await pending;
    }

    const refreshPromise = this.refreshThreadPullRequestsUncached(
      backend,
      request,
      requestKey,
    );
    this.pendingThreadPullRequestRefreshes.set(requestKey, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.pendingThreadPullRequestRefreshes.delete(requestKey);
    }
  }

  private async refreshThreadPullRequestsUncached(
    backend: AppServerBackendKind,
    request: RefreshThreadPullRequestsRequest,
    requestKey: string,
  ): Promise<RefreshThreadPullRequestsResponse> {
    const now = Date.now();
    const provider = normalizePullRequestProvider(request.provider);
    const trigger = request.trigger ?? "scheduled";
    const overlay = this.ports.getOverlayStore();
    const existing = await overlay.getThreadOverlayState({
      backend,
      threadId: request.threadId,
    });
    await this.ports.loadPrStatusRegistry();
    await this.loadPrLookupRegistry();
    const storedPrs = existing?.prs ?? [];
    const retainedStoredPrs = await this.ports.filterStoredDiscoveredPrs(storedPrs);
    const persistedPrs = this.ports.mergePrHistory(
      retainedStoredPrs,
      await this.ports.filterStoredDiscoveredPrs(existing?.detachedPrs ?? []),
    );
    this.ports.rememberPrStatuses(
      persistedPrs,
      existing?.prsFetchedAt ?? 0,
      "thread-overlay",
    );
    const existingPrs = this.ports.canonicalizePrs(persistedPrs);
    const branch = request.branch.trim();
    const lookupKey = getPullRequestLookupKey(request);
    const lookupDirectoryPaths = normalizePrLookupDirectoryPaths(
      request.directoryPaths,
    );
    const existingLookupMatches = existing?.prsRefreshKey === requestKey;
    // The lookup registry is shared by every thread on this branch and
    // checkout, so it holds only what a branch lookup returned. Never seed it
    // from this thread's overlay: that list carries the thread's own history
    // (PRs from earlier branches, detached PRs), and a seeded entry attached
    // that history to every other thread in the same checkout.
    // A claim leaves a placeholder entry (fetchedAt 0) until its lookup
    // answers. Only an answered entry is a result; until then this thread's
    // own matching overlay stands in for it.
    const registryEntry = this.prLookupRegistry.get(lookupKey);
    const lookupEntry = registryEntry && registryEntry.fetchedAt > 0
      ? registryEntry
      : undefined;
    const lookupPrs = lookupEntry
      ? this.ports.canonicalizePrs(lookupEntry.prs)
      : existingLookupMatches
        ? existingPrs
        : [];
    const currentLookupPrs = await this.ports.filterStoredDiscoveredPrs(
      associatePrsWithLinkedDirectories(lookupPrs, lookupDirectoryPaths),
    );
    // Legacy automatic matches may already be in an overlay even though the
    // current default-branch lookup correctly answers []. Repair before a
    // cache hit or terminal short-circuit can keep serving those attachments.
    if (!prSummariesEqual(storedPrs, retainedStoredPrs)) {
      await this.enqueuePullRequestOverlayWrite({
        backend,
        threadId: request.threadId,
        write: async () => {
          const latest = await overlay.getThreadOverlayState({ backend, threadId: request.threadId });
          if (!latest) return;
          const prs = await this.ports.filterStoredDiscoveredPrs(latest.prs ?? []);
          if (prSummariesEqual(latest.prs ?? [], prs)) return;
          const updated = await overlay.setThreadPullRequests({
            backend,
            threadId: request.threadId,
            prs,
            fetchedAt: latest.prsFetchedAt ?? 0,
            refreshKey: latest.prsRefreshKey,
            ...this.ports.detachedPrKeyCanonicalizer(),
          });
          await this.ports.publishThreadPullRequestsUpdated({
            backend,
            threadId: request.threadId,
            prs: this.ports.canonicalizePrs(updated.prs ?? []),
            detachedPrs: this.ports.canonicalizePrs(updated.detachedPrs ?? []),
          });
        },
      });
    }
    let knownPrs = this.ports.mergePrHistory(existingPrs, currentLookupPrs);
    // The same rule as the store's write, so a response never hides a chip
    // the store keeps.
    const visibleKnownPrs = (): PrSummary[] =>
      filterDetachedPullRequests(
        knownPrs,
        canonicalizeDetachedPrKeys({
          detachedPrKeys: existing?.detachedPrKeys,
          attachedPrKeys: storedPrs.map(getPrStatusKey),
          canonicalizePrKey: (key) => this.ports.prRepositoryAliases.canonicalizeKey(key),
        }).detachedPrKeys,
      );
    const statusFetchedAt = lookupEntry?.fetchedAt
      ?? (existingPrs.length > 0 || existingLookupMatches
        ? existing?.prsFetchedAt
        : undefined);
    const freshness = pullRequestStatusFreshness(statusFetchedAt, now);
    const fetcher = this.ports.getPrFetcher();
    const providerAvailability = await fetcher.getProviderAvailability(
      request.directoryPaths, visibleKnownPrs().map((pr) => pr.url),
    );
    const providerAvailable = providerAvailability.some((status) => status.available);
    const ghAvailable = providerAvailability.some((status) => status.cli === "gh" && status.available);
    const responseFreshness = request.includeStatusFreshness === true
      ? (refreshStarted: boolean) => ({
          ...freshness,
          providerAvailable,
          providerAvailability,
          refreshStarted,
        })
      : () => ({});
    if (trigger === "user") {
      this.ports.logDebug("threadPullRequestsRefresh:requested", userPrRefreshLogPayload({
        backend,
        branch,
        directoryPathCount: request.directoryPaths.length,
        existingLookupMatches,
        ghAvailable,
        lookupCacheHit: Boolean(lookupEntry),
        lookupKey,
        previousPrs: visibleKnownPrs(),
        provider,
        requestKey,
        threadId: request.threadId,
        trigger,
      }));
    }
    if (!providerAvailable) {
      if (trigger === "user") {
        this.ports.logDebug("threadPullRequestsRefresh:skipped", userPrRefreshLogPayload({
          backend,
          branch,
          directoryPathCount: request.directoryPaths.length,
          ghAvailable,
          previousPrs: visibleKnownPrs(),
          provider,
          reason: "provider-unavailable",
          requestKey,
          threadId: request.threadId,
          trigger,
        }));
      }
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: visibleKnownPrs(),
        ...responseFreshness(false),
        ghAvailable: false,
      };
    }
    if (lookupEntry) {
      knownPrs = await this.persistPullRequestLookupHit({
        backend,
        request,
        requestKey,
        persistedPrs,
        persistedRefreshKey: existing?.prsRefreshKey,
        prs: currentLookupPrs,
        fetchedAt: lookupEntry.fetchedAt,
        renamePending: this.ports.storedPrsNeedRename(existing),
      });
    }
    // Terminal-state short-circuit: once every cached PR for a lookup is
    // merged or closed, we do not need to re-query GitHub for the same
    // branch/directory lookup.
    // A different lookup can mean the thread moved to a new branch after
    // merging an older PR, so stale terminal chips must not block it.
    //
    // No log here on purpose — this path runs on every navigation
    // refresh tick (once a minute per renderer) for every thread with
    // a terminal PR, so logging would produce one line per thread per
    // minute of pure noise. The interesting path is the cache-miss
    // fetch below, and callers that need to observe the no-op
    // programmatically can read `shortCircuited: true` off the
    // response.
    const allExistingPrsTerminal =
      currentLookupPrs.length > 0
      && currentLookupPrs.every(
        (pr) => pr.lifecycleState === "merged" || pr.lifecycleState === "closed",
      );
    if (
      allExistingPrsTerminal
      && branch !== "HEAD"
      && request.trigger !== "user"
      && request.trigger !== "post-turn"
      // A PR shown under two repository names is one the lookup's by-URL
      // fetch can merge, and aliases are relearned after each launch.
      && this.ports.prRepositoryAliases.renameCandidates(visibleKnownPrs()).length === 0
    ) {
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: visibleKnownPrs(),
        ghAvailable,
        ...responseFreshness(false),
        shortCircuited: true,
      };
    }

    if (!branch || request.directoryPaths.length === 0) {
      if (trigger === "user") {
        this.ports.logDebug("threadPullRequestsRefresh:skipped", userPrRefreshLogPayload({
          backend,
          branch,
          directoryPathCount: request.directoryPaths.length,
          ghAvailable,
          previousPrs: visibleKnownPrs(),
          provider,
          reason: !branch ? "missing-branch" : "missing-directory-paths",
          requestKey,
          threadId: request.threadId,
          trigger,
        }));
      }
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: visibleKnownPrs(),
        ...responseFreshness(false),
        ghAvailable,
      };
    }

    // A paused project runs no background lookups. The operator's own
    // refresh and the post-turn lookup still run; the Auto-fix, watch and
    // dependency gates keep them from starting automatic turns.
    if (
      trigger === "scheduled"
      && !projectAllowsForgePolling(this.ports.threadForgeAutomation({ backend, threadId: request.threadId }))
    ) {
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: visibleKnownPrs(),
        ...responseFreshness(false),
        ghAvailable,
      };
    }

    const refreshStarted = this.startPullRequestLookupRefresh({
      backend,
      request,
      requestKey,
      lookupKey,
      lookupDirectoryPaths,
      previousPrs: knownPrs,
      ...(existingLookupMatches && existing?.prsFetchedAt
        ? { threadLookupObservedAt: existing.prsFetchedAt }
        : {}),
    });

    return {
      backend,
      threadId: request.threadId,
      provider,
      prs: visibleKnownPrs(),
      ...responseFreshness(refreshStarted),
      ghAvailable,
    };
  }

  private async fetchPullRequestLookup(
    params: PullRequestLookupParams,
  ): Promise<PullRequestLookupResult> {
    // This timestamp is an observation-order token. Capture it before the
    // network request so an older slow response cannot outrank a newer one.
    const fetchedAt = this.ports.nextPrObservationTimestamp();
    // The lookup re-reads every PR it already knows, so the poller must not
    // fetch them again while it runs. See `PrLookupsInFlight`.
    const release = this.prLookupsInFlight.begin(
      params.previousPrs.map(getPrStatusKey),
      fetchedAt,
    );
    try {
      return await this.runPullRequestLookup(params, fetchedAt);
    } finally {
      release();
    }
  }

  private async runPullRequestLookup(
    params: PullRequestLookupParams,
    fetchedAt: number,
  ): Promise<PullRequestLookupResult> {
    let incomplete = false;
    const onProviderFailure = () => { incomplete = true; };
    const trigger = params.request.trigger ?? "scheduled";
    const prs = (await detectPullRequestsForThread({
      fetcher: this.ports.getPrFetcher(),
      onProviderFailure,
      branch: params.request.branch.trim(),
      directoryPaths: params.request.directoryPaths,
      ...(trigger === "user" || trigger === "post-turn"
        ? { allowPrimedBranchLookup: false }
        : {}),
    })).map(normalizePrSummary);
    this.ports.prRepositoryAliases.confirm(prs);
    const retainedPrs = await this.fetchRetainedNonTerminalPullRequests({
      prs: this.getPullRequestLookupSubscriberPreviousPrs({
        lookupKey: params.lookupKey,
        fallbackPrs: params.previousPrs,
      }),
      discoveredPrs: prs,
      onProviderFailure,
      cwd: params.lookupDirectoryPaths[0] ?? params.request.directoryPaths[0],
    });
    const statusPrs = dedupePrsByStatusKey([...prs, ...retainedPrs]);
    const changedStatusPrs = this.ports.rememberPrStatuses(
      statusPrs,
      fetchedAt,
      `thread-lookup:${trigger}`,
    );
    await this.ports.writePrStatusesToCache(statusPrs, fetchedAt);
    await this.ports.publishPullRequestStatusUpdates({
      backend: params.backend,
      prs: changedStatusPrs,
    });
    // A partial lookup is not an authoritative (possibly empty) branch result.
    if (!incomplete) {
      this.rememberPrLookup({
        lookupKey: params.lookupKey,
        provider: normalizePullRequestProvider(params.request.provider),
        branch: params.request.branch.trim(),
        directoryPaths: params.lookupDirectoryPaths,
        prs,
        fetchedAt,
      });
      await this.writePrLookupToCache({
        lookupKey: params.lookupKey,
        provider: normalizePullRequestProvider(params.request.provider),
        branch: params.request.branch.trim(),
        directoryPaths: params.lookupDirectoryPaths,
        prs,
        fetchedAt,
      });
    }

    return { prs, statusPrs, fetchedAt, incomplete };
  }

  private getPullRequestLookupSubscriberPreviousPrs(params: {
    lookupKey: string;
    fallbackPrs: PrSummary[];
  }): PrSummary[] {
    const subscribers = this.prLookupSubscribers.get(params.lookupKey);
    if (!subscribers?.size) {
      return params.fallbackPrs;
    }
    return [...subscribers.values()].flatMap((subscriber) => subscriber.previousPrs);
  }

  private async fetchRetainedNonTerminalPullRequests(params: {
    prs: PrSummary[];
    discoveredPrs: PrSummary[];
    cwd?: string;
    onProviderFailure?: () => void;
  }): Promise<PrSummary[]> {
    const cwd = params.cwd;
    if (!cwd) {
      return [];
    }

    const discoveredKeys = new Set(
      params.discoveredPrs.map((pr) => getPrStatusKey(pr)),
    );
    const seenRetainedKeys = new Set<string>();
    const normalizedPrs = params.prs.map(normalizePrSummary);
    // A finished PR is fetched again only to learn whether its repository is
    // another's old name.
    const renameCandidateKeys = new Set(
      this.ports.prRepositoryAliases
        .renameCandidates([...params.discoveredPrs, ...normalizedPrs])
        .map(getPrStatusKey),
    );
    const retainedPrs = normalizedPrs
      .filter((pr) => {
        const key = getPrStatusKey(pr);
        if (discoveredKeys.has(key)) return false;
        if (seenRetainedKeys.has(key)) return false;
        if (
          (pr.lifecycleState === "merged" || pr.lifecycleState === "closed")
          && !renameCandidateKeys.has(key)
        ) {
          return false;
        }
        seenRetainedKeys.add(key);
        return true;
      });

    if (retainedPrs.length === 0) {
      return [];
    }

    const fetcher = this.ports.getPrFetcher();
    const refreshed = await Promise.all(
      retainedPrs.map((pr) =>
        fetcher
          .fetchPullRequestByUrl({
            cwd,
            url: pr.url,
            ...(params.onProviderFailure
              ? { onProviderFailure: params.onProviderFailure }
              : {}),
          })
          .catch(() => {
            params.onProviderFailure?.();
            return undefined;
          }),
      ),
    );
    // The pairing with the URL asked for is how a renamed repository is
    // learned: the forge answers its old URL under the new name.
    refreshed.forEach((pr, index) => {
      this.ports.learnPullRequestRepository(retainedPrs[index]!.url, pr);
    });
    return refreshed.filter((pr): pr is PrSummary => Boolean(pr))
      .map(normalizePrSummary);
  }

  private startPullRequestLookupRefresh(
    params: PrLookupRefreshParams,
    options: {
      additionalSubscribers?: PrLookupRefreshParams[];
      skipClaim?: boolean;
    } = {},
  ): boolean {
    const trigger = params.request.trigger ?? "scheduled";
    const authoritative = trigger === "user" || trigger === "post-turn";
    const provider = normalizePullRequestProvider(params.request.provider);
    const pending = this.pendingPrLookupRefreshes.get(params.lookupKey);
    if (pending) {
      if (authoritative && !pending.authoritative) {
        return this.queueAuthoritativePullRequestLookupRefresh(params);
      }
      this.addPullRequestLookupSubscriber(params.lookupKey, params);
      if (trigger === "user") {
        this.ports.logDebug("threadPullRequestsRefresh:coalesced-background", userPrRefreshLogPayload({
          backend: params.backend,
          branch: params.request.branch.trim(),
          directoryPathCount: params.request.directoryPaths.length,
          lookupKey: params.lookupKey,
          previousPrs: params.previousPrs,
          provider,
          requestKey: params.requestKey,
          threadId: params.request.threadId,
          trigger,
        }));
      }
      return true;
    }

    let refreshKey = params.lookupKey;
    if (!options.skipClaim) {
      const claim = this.claimPullRequestLookupRefreshKey(
        params.lookupKey,
        trigger,
        provider,
        params.previousPrs.length > 0
          && params.previousPrs.every(
            (pr) => pr.lifecycleState === "merged" || pr.lifecycleState === "closed",
          ),
        {
          prKeys: params.previousPrs.map(getPrStatusKey),
          threadKeys: [buildThreadIdentityKey(params.backend, params.request.threadId)],
        },
        params.threadLookupObservedAt,
      );
      if (claim.skippedReason) {
        // Not recorded as activity. A cooldown skip means the data is seconds
        // old, and an empty request budget was already recorded by
        // `takePrPollingToken`, so a row here was noise or a duplicate.
        if (trigger === "user") {
          this.ports.logDebug("threadPullRequestsRefresh:skipped", {
            ...userPrRefreshLogPayload({
              backend: params.backend,
              branch: params.request.branch.trim(),
              directoryPathCount: params.request.directoryPaths.length,
              lookupKey: params.lookupKey,
              previousPrs: params.previousPrs,
              provider,
              reason: claim.skippedReason,
              requestKey: params.requestKey,
              threadId: params.request.threadId,
              trigger,
            }),
            ageMs: claim.ageMs,
            minIntervalMs: claim.minIntervalMs,
            nextAllowedInMs: claim.nextAllowedInMs,
          });
        }
        return false;
      }
      refreshKey = claim.refreshKey;
    }

    this.addPullRequestLookupSubscriber(params.lookupKey, params);
    for (const subscriber of options.additionalSubscribers ?? []) {
      this.addPullRequestLookupSubscriber(params.lookupKey, subscriber);
    }
    if (trigger === "user") {
      this.ports.logDebug("threadPullRequestsRefresh:background-start", userPrRefreshLogPayload({
        backend: params.backend,
        branch: params.request.branch.trim(),
        directoryPathCount: params.request.directoryPaths.length,
        lookupKey: params.lookupKey,
        previousPrs: params.previousPrs,
        provider,
        requestKey: params.requestKey,
        threadId: params.request.threadId,
        trigger,
      }));
    }
    const promise = this.fetchPullRequestLookup(params)
      .then(async ({ prs, statusPrs, fetchedAt, incomplete }) => {
        const publishResult = await this.persistPullRequestLookupSubscribers({
          lookupKey: params.lookupKey,
          prs,
          fetchedAt,
          incomplete,
        });
        const canonical = this.ports.canonicalizePrs(statusPrs);
        if (canonical.length === 0) this.ports.prActivity.record({
          category: "check", source: `thread lookup (${trigger})`,
          threadKeys: [buildThreadIdentityKey(params.backend, params.request.threadId)], prKeys: [],
          message: incomplete ? "Partial check: no PR status returned" : "No PR for this branch",
        });
        this.ports.recordPrCheck(canonical, `thread lookup (${trigger})`, incomplete, [
          buildThreadIdentityKey(params.backend, params.request.threadId),
        ]);
        await this.ports.handlePrAutoDispatchSnapshots(canonical, fetchedAt);
        if (trigger === "user") {
          const completedAt = Date.now();
          this.ports.logDebug("threadPullRequestsRefresh:background-complete", {
            ...userPrRefreshLogPayload({
              backend: params.backend,
              branch: params.request.branch.trim(),
              directoryPathCount: params.request.directoryPaths.length,
              lookupKey: params.lookupKey,
              previousPrs: params.previousPrs,
              provider,
              requestKey: params.requestKey,
              threadId: params.request.threadId,
              trigger,
            }),
            changedThreadCount: publishResult.changedThreadCount,
            fetchedAt,
            fetchedPrIds: prLogIds(prs),
            fetchedPrStatuses: prLogStatuses(prs),
            completedAt,
            durationMs: Math.max(0, completedAt - fetchedAt),
            subscriberCount: publishResult.subscriberCount,
          });
        }
      })
      .catch((error) => {
        this.ports.prActivity.record({
          category: "check",
          source: `thread lookup (${trigger})`,
          threadKeys: [buildThreadIdentityKey(params.backend, params.request.threadId)],
          prKeys: params.previousPrs.map(getPrStatusKey),
          tone: "error",
          message: "PR lookup failed; see the application log for details",
        });
        appServerLog.warn("background PR lookup refresh failed", {
          threadId: params.request.threadId,
          branch: params.request.branch.trim(),
          previousPrIds: prLogIds(params.previousPrs),
          provider,
          refreshKey,
          requestKey: params.requestKey,
          trigger,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (
          this.pendingPrLookupRefreshes.get(params.lookupKey)?.promise
          === promise
        ) {
          this.pendingPrLookupRefreshes.delete(params.lookupKey);
          this.prLookupSubscribers.delete(params.lookupKey);
          this.startQueuedAuthoritativePullRequestLookupRefresh(params.lookupKey);
        }
      });
    this.pendingPrLookupRefreshes.set(params.lookupKey, {
      authoritative,
      promise,
    });
    return true;
  }

  private queueAuthoritativePullRequestLookupRefresh(
    params: PrLookupRefreshParams,
  ): boolean {
    const queued = this.queuedAuthoritativePrLookupRefreshes.get(params.lookupKey)
      ?? new Map<string, PrLookupRefreshParams>();
    const threadKey = buildThreadIdentityKey(
      params.backend,
      params.request.threadId,
    );
    queued.set(threadKey, params);
    this.queuedAuthoritativePrLookupRefreshes.set(params.lookupKey, queued);
    if (params.request.trigger === "user") {
      this.ports.logDebug("threadPullRequestsRefresh:queued-authoritative", userPrRefreshLogPayload({
        backend: params.backend,
        branch: params.request.branch.trim(),
        directoryPathCount: params.request.directoryPaths.length,
        lookupKey: params.lookupKey,
        previousPrs: params.previousPrs,
        provider: normalizePullRequestProvider(params.request.provider),
        requestKey: params.requestKey,
        threadId: params.request.threadId,
        trigger: "user",
      }));
    }
    return true;
  }

  private startQueuedAuthoritativePullRequestLookupRefresh(
    lookupKey: string,
  ): void {
    const queued = this.queuedAuthoritativePrLookupRefreshes.get(lookupKey);
    if (!queued?.size) {
      return;
    }
    this.queuedAuthoritativePrLookupRefreshes.delete(lookupKey);
    const [first, ...additionalSubscribers] = [...queued.values()];
    if (!first) {
      return;
    }
    this.startPullRequestLookupRefresh(first, {
      additionalSubscribers,
      skipClaim: true,
    });
  }

  private addPullRequestLookupSubscriber(
    lookupKey: string,
    params: {
      backend: AppServerBackendKind;
      request: RefreshThreadPullRequestsRequest;
      requestKey: string;
      previousPrs: PrSummary[];
    },
  ): void {
    const subscribers =
      this.prLookupSubscribers.get(lookupKey) ?? new Map<string, PrLookupSubscriber>();
    const threadKey = buildThreadIdentityKey(
      params.backend,
      params.request.threadId,
    );
    subscribers.set(threadKey, {
      backend: params.backend,
      threadId: params.request.threadId,
      requestKey: params.requestKey,
      linkedDirectoryPaths: normalizePrLookupDirectoryPaths(
        params.request.directoryPaths,
      ),
      previousPrs: params.previousPrs,
    });
    this.prLookupSubscribers.set(lookupKey, subscribers);
  }

  private async persistPullRequestLookupSubscribers(params: {
    lookupKey: string;
    prs: PrSummary[];
    fetchedAt: number;
    incomplete?: boolean;
  }): Promise<{ changedThreadCount: number; subscriberCount: number }> {
    const subscribers = this.prLookupSubscribers.get(params.lookupKey);
    if (!subscribers?.size) {
      return { changedThreadCount: 0, subscriberCount: 0 };
    }

    let changedThreadCount = 0;
    await Promise.all(
      [...subscribers.values()].map(async (subscriber) => {
        await this.enqueuePullRequestOverlayWrite({
          backend: subscriber.backend,
          threadId: subscriber.threadId,
          write: async () => {
            const overlay = this.ports.getOverlayStore();
            // Branch changes use a different lookup key, so their refresh can
            // overlap the preceding branch's lookup. Re-read inside the
            // per-thread write queue to retain history from either lookup.
            const latest = await overlay.getThreadOverlayState({
              backend: subscriber.backend,
              threadId: subscriber.threadId,
            });
            const previousPersistedPrs = latest?.prs ?? subscriber.previousPrs;
            const latestPrs = this.ports.mergePrHistory(
              latest?.prs ?? [],
              latest?.detachedPrs ?? [],
            );
            const previousPrs = await this.ports.filterStoredDiscoveredPrs(this.ports.mergePrHistory(
              subscriber.previousPrs,
              latestPrs,
            ));
            const associatedPrs = associatePrsWithLinkedDirectories(
              params.prs,
              subscriber.linkedDirectoryPaths,
            );
            const nextPrs = this.ports.mergePrHistory(previousPrs, associatedPrs);
            const updated = await overlay.setThreadPullRequests({
              backend: subscriber.backend,
              threadId: subscriber.threadId,
              prs: nextPrs,
              // Successful status rows were published separately. Retained
              // failed-provider observations must keep their old freshness.
              fetchedAt: params.incomplete ? latest?.prsFetchedAt ?? 0 : params.fetchedAt,
              refreshKey: subscriber.requestKey,
              ...this.ports.detachedPrKeyCanonicalizer(),
            });
            const persistedPrs = updated.prs ?? [];
            if ((updated.prsFetchedAt ?? 0) > params.fetchedAt) {
              appServerLog.info("thread PR overlay observation ignored", {
                backend: subscriber.backend,
                threadId: subscriber.threadId,
                requestKey: subscriber.requestKey,
                observedAt: params.fetchedAt,
                currentObservedAt: updated.prsFetchedAt,
                currentRequestKey: updated.prsRefreshKey,
              });
              return;
            }

            if (!prSummariesEqual(previousPersistedPrs, persistedPrs)) {
              changedThreadCount += 1;
              await this.ports.publishThreadPullRequestsUpdated({
                backend: subscriber.backend,
                threadId: subscriber.threadId,
                prs: persistedPrs,
                detachedPrs: updated.detachedPrs ?? [],
              });
            }
          },
        });
      }),
    );
    return { changedThreadCount, subscriberCount: subscribers.size };
  }

  private enqueuePullRequestOverlayWrite<T>(params: {
    backend: AppServerBackendKind;
    threadId: string;
    write: () => Promise<T>;
  }): Promise<T> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const previous = this.pendingPrOverlayWrites.get(threadKey) ?? Promise.resolve();
    const result = previous.then(params.write);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pendingPrOverlayWrites.set(threadKey, settled);
    void settled.then(() => {
      if (this.pendingPrOverlayWrites.get(threadKey) === settled) {
        this.pendingPrOverlayWrites.delete(threadKey);
      }
    });
    return result;
  }

  private async persistPullRequestLookupHit(params: {
    backend: AppServerBackendKind;
    request: RefreshThreadPullRequestsRequest;
    requestKey: string;
    persistedPrs: PrSummary[];
    persistedRefreshKey?: string;
    prs: PrSummary[];
    fetchedAt: number;
    /** Stored rows or detached keys still use a renamed repository's old name. */
    renamePending?: boolean;
  }): Promise<PrSummary[]> {
    const associatedPrs = associatePrsWithLinkedDirectories(
      params.prs,
      params.request.directoryPaths,
    );
    const nextPrs = this.ports.mergePrHistory(params.persistedPrs, associatedPrs);
    // `persistedPrs` is already projected under the forge's names, so it can
    // equal the result while storage still holds the old ones.
    if (
      params.persistedRefreshKey === params.requestKey
      && !params.renamePending
      && prSummariesEqual(params.persistedPrs, nextPrs)
    ) {
      return params.persistedPrs;
    }

    const updated = await this.ports.getOverlayStore().setThreadPullRequests({
      backend: params.backend,
      threadId: params.request.threadId,
      prs: nextPrs,
      fetchedAt: params.fetchedAt,
      refreshKey: params.requestKey,
      ...this.ports.detachedPrKeyCanonicalizer(),
    });
    const persistedPrs = updated.prs ?? [];
    if ((updated.prsFetchedAt ?? 0) > params.fetchedAt) {
      return persistedPrs;
    }

    if (!prSummariesEqual(params.persistedPrs, persistedPrs)) {
      await this.ports.publishThreadPullRequestsUpdated({
        backend: params.backend,
        threadId: params.request.threadId,
        prs: persistedPrs,
        detachedPrs: updated.detachedPrs ?? [],
      });
    }
    return persistedPrs;
  }

  private claimPullRequestLookupRefreshKey(
    lookupKey: string,
    trigger: NonNullable<RefreshThreadPullRequestsRequest["trigger"]>,
    provider: string,
    terminalOnly: boolean,
    activityContext?: { prKeys: string[]; threadKeys: string[] },
    threadLookupObservedAt = 0,
  ): PrLookupRefreshClaim {
    const now = Date.now();
    const minInterval =
      trigger === "post-turn"
        ? 0
        : trigger === "user"
        ? terminalOnly
          ? TERMINAL_USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS
          : USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS
        : THREAD_PR_REFRESH_MIN_INTERVAL_MS;
    const timestampField =
      trigger === "user"
        ? "lastUserRefreshRequestedAt"
        : "lastScheduledRefreshRequestedAt";
    const entry = this.prLookupRegistry.get(lookupKey);
    const lastRequestedAt = Math.max(
      entry?.[timestampField] ?? 0,
      entry?.fetchedAt ?? 0,
      threadLookupObservedAt,
    );
    const ageMs = now - lastRequestedAt;
    const slack = trigger === "scheduled" ? SCHEDULED_THREAD_PR_REFRESH_SLACK_MS : 0;
    const due = ageMs >= minInterval - slack;
    if (!due) {
      return {
        skippedReason: "cooldown",
        ageMs,
        minIntervalMs: minInterval,
        nextAllowedInMs: minInterval - ageMs,
      };
    }
    if (trigger === "scheduled" && !this.ports.takePrPollingToken("scheduled thread lookup", activityContext?.prKeys, activityContext?.threadKeys)) {
      return { skippedReason: "scheduled-token-bucket" };
    }

    if (entry) {
      entry[timestampField] = now;
    } else {
      this.prLookupRegistry.set(lookupKey, {
        prs: [],
        fetchedAt: 0,
        provider: normalizePullRequestProvider(provider),
        branch: "",
        directoryPaths: [],
        [timestampField]: now,
      });
    }

    return { refreshKey: lookupKey };
  }

  private rememberPrLookup(entry: {
    lookupKey: string;
    provider: string;
    branch: string;
    directoryPaths: string[];
    prs: PrSummary[];
    fetchedAt: number;
  }): void {
    const current = this.prLookupRegistry.get(entry.lookupKey);
    if (current && current.fetchedAt > entry.fetchedAt) {
      return;
    }
    this.prLookupRegistry.set(entry.lookupKey, {
      ...current,
      provider: normalizePullRequestProvider(entry.provider),
      branch: entry.branch,
      directoryPaths: entry.directoryPaths,
      prs: entry.prs.map(normalizePrSummary),
      fetchedAt: entry.fetchedAt,
    });
  }

  async loadPrLookupRegistry(): Promise<void> {
    if (this.prLookupRegistryLoaded) {
      return;
    }
    if (!this.prLookupRegistryLoadPromise) {
      this.prLookupRegistryLoadPromise = (async () => {
        const entries = await this.ports.getOverlayStore().readPrLookupCache();
        for (const entry of Object.values(entries)) {
          this.rememberPrLookup(entry);
          this.ports.rememberPrStatuses(entry.prs, entry.fetchedAt, "pr-lookup-cache");
        }
        this.prLookupRegistryLoaded = true;
      })();
    }
    const loadPromise = this.prLookupRegistryLoadPromise;
    try {
      await loadPromise;
    } finally {
      if (this.prLookupRegistryLoadPromise === loadPromise) {
        this.prLookupRegistryLoadPromise = undefined;
      }
    }
  }

  private async writePrLookupToCache(entry: PrLookupCacheEntry): Promise<void> {
    await this.ports.getOverlayStore().writePrLookupCacheEntry(entry);
  }

  get loaded(): boolean {
    return this.prLookupRegistryLoaded;
  }

  startedAt(prKey: string): number | undefined {
    return this.prLookupsInFlight.startedAt(prKey);
  }

  pendingRefresh(request: Pick<RefreshThreadPullRequestsRequest, "provider" | "branch" | "directoryPaths">): Promise<void> | undefined {
    return this.pendingPrLookupRefreshes.get(getPullRequestLookupKey(request))?.promise;
  }

  clear(): void {
    this.pendingThreadPullRequestRefreshes.clear();
    this.prLookupRegistry.clear();
    this.pendingPrLookupRefreshes.clear();
    this.queuedAuthoritativePrLookupRefreshes.clear();
    this.prLookupSubscribers.clear();
    this.pendingPrOverlayWrites.clear();
    this.prLookupRegistryLoaded = false;
    this.prLookupRegistryLoadPromise = undefined;
  }
}
