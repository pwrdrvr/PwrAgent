import type {
  AgentEvent,
  CelestialIconId,
  FederationCapability,
  FederationJumpSearchProgress,
  FederationJumpSearchRequest,
  FederationJumpSearchResponse,
  FederationPeerSummary,
  FederationRemoteTarget,
  FederationThreadSelection,
  FederatedThreadRef,
  NavigationSnapshot,
  NavigationThreadSummary,
  RemoteThreadPin,
} from "@pwragent/shared";
import {
  navigationInvalidationMayChangeMembership,
  navigationWorkingStatePath,
  parseThreadIdentityKey,
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  rankThreadJumpMatches,
  sortThreadJumpMatches,
} from "@pwragent/shared";
import type { PinnedNavigationReadState } from "./federation-collection-client";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import { compactNavigationSearchResult } from "./navigation-search-result";
import { ThreadInfoStore } from "../app-server/thread-info-store";
import {
  hasFederationErrorCode,
  type FederationRpcRequestOptions,
} from "./federation-rpc";

export type RemoteThreadSummaryPeer = {
  target: FederationRemoteTarget;
  label: string;
  capabilities: FederationCapability[];
};

/**
 * A peer's display name for one of its threads.
 *
 * `titleSource` is optional because it is a compile-time contract over another
 * instance's JSON: an older peer sends a real title without one, and a name is
 * still better than the raw thread id.
 */
export type RemoteThreadName = {
  title: string;
  titleSource?: NavigationThreadSummary["titleSource"];
};

export type ResolvedRemotePins = {
  /** One stamped row per pin: fresh from the peer when reachable, else the
   *  cached payload stamped with the peer's current (non-connected) status. */
  threads: NavigationThreadSummary[];
  /** Pins whose cached payload should be refreshed after a successful fetch. */
  refreshed: Array<{
    ref: RemoteThreadPin["ref"];
    summary: NavigationThreadSummary;
    instanceLabel: string;
  }>;
  /** Pins proven to be archived on a reachable owner. The viewer can safely
   *  remove these instead of preserving a permanently stale fallback row. */
  archived: RemoteThreadPin["ref"][];
};

/**
 * Peer navigation summaries are the only remote row shape that carries PR
 * chips (the owner merges its overlay `prs` before serving). Pinned-thread
 * merges and the older-peer Cmd+K fallback read full snapshots through this
 * cache; current peers filter and bound Cmd+K rows on the owner. The TTL keeps
 * compatibility searches and back-to-back pin merges from re-fetching full
 * snapshots per call.
 */
const REMOTE_SNAPSHOT_TTL_MS = 15_000;
/** Mirrors the federated-search per-peer deadline. */
const REMOTE_SNAPSHOT_PEER_TIMEOUT_MS = 10_000;
/**
 * How long a peer thread stays in its owner's demand after the last viewer
 * read that named it. Drafts reads name their threads on every refresh, so a
 * watch lapses only once nothing has listed it for this long.
 */
const WATCHED_THREAD_TTL_MS = 30 * 60_000;
const DEFAULT_JUMP_SEARCH_LIMIT = 8;
const MAX_JUMP_SEARCH_LIMIT = 50;
const JUMP_SEARCH_PEER_CONCURRENCY = 8;

function threadSelection(
  refs: ReadonlyArray<Pick<RemoteThreadPin["ref"], "backend" | "threadId">>,
): FederationThreadSelection {
  const threads = new Map<
    string,
    Extract<FederationThreadSelection, { kind: "threads" }>["threads"][number]
  >();
  for (const ref of refs) {
    threads.set(buildThreadIdentityKey(ref.backend, ref.threadId), {
      backend: ref.backend,
      threadId: ref.threadId,
    });
  }
  return {
    kind: "threads",
    threads: [...threads.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, ref]) => ref),
  };
}

function selectionKey(selection: FederationThreadSelection): string {
  return selection.kind === "all"
    ? "all"
    : JSON.stringify(selection.threads.map((thread) =>
        buildThreadIdentityKey(thread.backend, thread.threadId)
      ));
}

function selectionIncludes(
  available: FederationThreadSelection,
  requested: FederationThreadSelection,
): boolean {
  if (available.kind === "all") return true;
  if (requested.kind === "all") return false;
  const availableKeys = new Set(available.threads.map((thread) =>
    buildThreadIdentityKey(thread.backend, thread.threadId)
  ));
  return requested.threads.every((thread) => availableKeys.has(
    buildThreadIdentityKey(thread.backend, thread.threadId)
  ));
}

function mergeSelections(
  selections: Iterable<FederationThreadSelection>,
): FederationThreadSelection {
  const refs: Array<Pick<RemoteThreadPin["ref"], "backend" | "threadId">> = [];
  for (const selection of selections) {
    if (selection.kind === "all") return { kind: "all" };
    refs.push(...selection.threads);
  }
  return threadSelection(refs);
}

export class RemoteThreadSummaryCache {
  private readonly cache = new Map<
    string,
    {
      fetchedAt: number;
      descendants?: boolean;
      selection: FederationThreadSelection;
      threads: NavigationThreadSummary[];
    }
  >();
  private readonly inFlight = new Map<
    string,
    {
      generation: string;
      descendants?: boolean;
      promise: Promise<NavigationThreadSummary[]>;
      selection: FederationThreadSelection;
    }
  >();
  private readonly pinnedRefreshes = new Set<string>();
  private readonly uncertainPinnedMembership = new Set<string>();
  private readonly unpublishedPinnedRows = new Set<string>();
  private readonly pinnedReadStates = new Map<string, PinnedNavigationReadState>();
  private readonly archivedCache = new Map<
    string,
    { fetchedAt: number; threadKeys: Set<string>; queriedKeys: ReadonlySet<string> }
  >();
  /**
   * Display names for threads owned by peers, held in the same information
   * store the local side uses and keyed by instance so two peers reusing a
   * thread id cannot answer for each other.
   *
   * Deliberately NOT cleared by `invalidate` — see `cachedThreadNameFromPeer`.
   * Dropping a name can only send a row back to its thread id, and a name is
   * stale-tolerant in a way the snapshots above are not.
   */
  private readonly threadNames = new ThreadInfoStore();
  private readonly peerInterests = new Map<
    string,
    Map<
      string,
      {
        selection: FederationThreadSelection;
        timer: ReturnType<typeof setTimeout>;
      }
    >
  >();
  private globalGeneration = 0;
  private readonly peerGenerations = new Map<string, number>();
  /** Peers whose most recent background refresh failed while connected. */
  private readonly refreshFailures = new Set<string>();
  private readonly missingPinSignatures = new Map<string, string>();
  /**
   * Thread keys a background pass proved archived on their owner, keyed by
   * instance, awaiting report to the caller that removes the pin.
   */
  private readonly provenArchived = new Map<string, Set<string>>();
  /** Mounted pins own navigation demand until removed, independent of visible lens pages. */
  private pinnedByInstanceId = new Map<string, RemoteThreadPin[]>();
  /**
   * Peer threads a viewer lists without pinning them (the Drafts lens), keyed
   * by owner and thread key. They join the owner's pin demand, so one owner
   * read and one subscription keep pins and watched threads current together.
   */
  private readonly watchedByInstanceId = new Map<
    string,
    Map<string, { ref: RemoteThreadPin["ref"]; expiresAt: number }>
  >();
  private watchedExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: {
      /** Connected peers able to serve navigation snapshots. */
      peers: () => RemoteThreadSummaryPeer[];
      /** Stamped snapshot fetch — `DesktopFederationRuntime.remoteNavigationSnapshot`. */
      fetchSnapshot: (
        target: FederationRemoteTarget,
        selection: FederationThreadSelection,
        rpcOptions?: FederationRpcRequestOptions,
      ) => Promise<NavigationSnapshot>;
      fetchPinnedSnapshot?: (
        target: FederationRemoteTarget,
        threadKeys: string[],
        rpcOptions?: FederationRpcRequestOptions,
        state?: PinnedNavigationReadState,
      ) => Promise<NavigationSnapshot>;
      /**
       * Bounded owner-side Cmd+K search. Older peers reject the new method;
       * those alone fall back to the full-snapshot compatibility path.
       */
      searchPeer?: (
        target: FederationRemoteTarget,
        request: FederationJumpSearchRequest,
        rpcOptions?: FederationRpcRequestOptions,
      ) => Promise<NavigationThreadSummary[]>;
      /** Archived threads for one backend on a connected peer. */
      fetchArchivedThreads: (
        target: FederationRemoteTarget,
        backend: RemoteThreadPin["ref"]["backend"],
        threadIds: string[],
        rpcOptions: FederationRpcRequestOptions,
      ) => Promise<Array<Pick<NavigationThreadSummary, "source" | "id">>>;
      /**
       * Current visible status, composed label, and the VIEWER-actionable
       * capability set for any peer, connected or not. Capabilities must
       * come from the owner's single stamping rule, never from the raw
       * granted set.
       */
      peerStatus: (instanceId: string) => {
        status?: FederationPeerSummary["status"];
        label?: string;
        celestialIcon?: CelestialIconId;
        capabilities?: FederationCapability[];
      };
      /** True only while owner navigation invalidations can reach this cache. */
      hasNavigationSubscription?: (instanceId: string) => boolean;
      /** Exact navigation collections currently retained by cache consumers. */
      onPeerInterestChanged?: (interests: Array<{
        instanceId: string;
        threadSelection: FederationThreadSelection;
      }>) => void;
      /**
       * Fired when a background pinned-summary pass would change what
       * `resolvePinnedThreads` serves: fresh rows landed, pins were proved
       * archived, a failing peer recovered, or a peer failed for the first
       * time (rows must dim).
       */
      onPinnedSummariesRefreshed?: (instanceId: string) => void;
      onPinnedRefreshProblem?: (problem: {
        instanceId: string;
        requestedCount: number;
        missingCount?: number;
        threadKeys: string[];
        error?: string;
      }) => void;
      ttlMs?: number;
      peerTimeoutMs?: number;
      /** How long a watched thread outlives the last read that named it. */
      watchTtlMs?: number;
      now?: () => number;
    },
  ) {}

  invalidate(instanceId?: string, event?: AgentEvent): void {
    if (instanceId && event) {
      const params = event.notification.params as { sourceMethod?: unknown; threadId?: unknown; worktreePath?: unknown };
      const sourceMethod = event.notification.method === "navigation/invalidated"
        ? params?.sourceMethod : event.notification.method;
      // Directory Git chips are not part of pinned thread rows or membership.
      if (sourceMethod === "navigation/directoryGitStatus/updated") return;
      if (sourceMethod === "navigation/threadGitWorkingState/updated" && typeof params?.worktreePath === "string"
        && this.hasCompletePinnedMembership(instanceId)
        && !this.cache.get(instanceId)?.threads.some((thread) => navigationWorkingStatePath(thread) === params.worktreePath)) return;
      // A broader consumer (for example a remote window) can cause delivery of
      // events outside the mounted groups. Do not turn those into pin reads.
      if (!navigationInvalidationMayChangeMembership(sourceMethod) && typeof params?.threadId === "string"
        && this.hasCompletePinnedMembership(instanceId)) {
        const key = buildThreadIdentityKey(event.backend, params.threadId);
        const keys = this.pinnedThreadKeys(instanceId);
        if (keys.size && !keys.has(key)) return;
      }
    }
    if (!event || navigationInvalidationMayChangeMembership(event.notification.method === "navigation/invalidated"
      ? (event.notification.params as { sourceMethod?: unknown })?.sourceMethod : event.notification.method)) {
      for (const owner of instanceId ? [instanceId] : this.mountedOwners()) this.uncertainPinnedMembership.add(owner);
    }
    if (instanceId === undefined) {
      this.globalGeneration += 1;
      for (const id of this.cache.keys()) this.expirePeerSnapshot(id);
      this.archivedCache.clear();
      this.provenArchived.clear();
      this.refreshMountedPins();
      return;
    }
    this.peerGenerations.set(
      instanceId,
      (this.peerGenerations.get(instanceId) ?? 0) + 1,
    );
    this.expirePeerSnapshot(instanceId);
    this.provenArchived.delete(instanceId);
    for (const key of this.archivedCache.keys()) {
      if (key.startsWith(`${instanceId}:`)) {
        this.archivedCache.delete(key);
      }
    }
    this.refreshMountedPins(instanceId);
  }

  private refreshMountedPins(instanceId?: string): void {
    // Reapply demand on connection transitions too: pins may have been mounted while offline.
    this.notifyPeerInterestChanged();
    for (const peer of this.navigationPeers()) {
      if (instanceId && peer.target.instanceId !== instanceId) continue;
      if (this.hasMountedDemand(peer.target.instanceId)) this.refreshPeerSummariesInBackground(peer.target);
    }
  }

  private expirePeerSnapshot(instanceId: string): void {
    const snapshot = this.cache.get(instanceId);
    if (snapshot && this.hasMountedDemand(instanceId)) {
      // Retain the last owner observation while revalidating. Falling back to the
      // saved pin here would briefly disagree with the already-rendered owner row.
      snapshot.fetchedAt = Number.NEGATIVE_INFINITY;
    } else {
      this.cache.delete(instanceId);
    }
  }

  dispose(): void {
    const hadPeerInterest = this.peerInterests.size > 0 || this.mountedOwners().length > 0;
    for (const interests of this.peerInterests.values()) {
      for (const interest of interests.values()) {
        clearTimeout(interest.timer);
      }
    }
    this.peerInterests.clear();
    this.pinnedByInstanceId.clear();
    this.watchedByInstanceId.clear();
    clearTimeout(this.watchedExpiryTimer);
    this.watchedExpiryTimer = undefined;
    this.pinnedReadStates.clear();
    this.uncertainPinnedMembership.clear();
    this.unpublishedPinnedRows.clear();
    this.missingPinSignatures.clear();
    if (hadPeerInterest) {
      this.options.onPeerInterestChanged?.([]);
    }
  }

  async searchForJump(
    request: FederationJumpSearchRequest,
    onProgress?: (progress: FederationJumpSearchProgress) => void,
  ): Promise<FederationJumpSearchResponse> {
    const query = request.query.trim();
    if (!query) {
      return { results: [] };
    }
    const limit = Math.max(
      1,
      Math.min(request.limit ?? DEFAULT_JUMP_SEARCH_LIMIT, MAX_JUMP_SEARCH_LIMIT),
    );
    const peers = this.navigationPeers();
    const groups = new Map<string, NavigationThreadSummary[]>();
    let completedPeerCount = 0;

    const publishProgress = (): FederationJumpSearchResponse => {
      const response = {
        results: rankUniqueThreadJumpMatches(
          [...groups.values()].flat(),
          query,
          limit,
        ),
      };
      onProgress?.({
        ...response,
        completedPeerCount,
        totalPeerCount: peers.length,
        complete: completedPeerCount === peers.length,
      });
      return response;
    };

    if (peers.length === 0) {
      return publishProgress();
    }

    const concurrency = Math.min(JUMP_SEARCH_PEER_CONCURRENCY, peers.length);
    const searches = new IterableMapper(
      peers,
      async (peer) => {
        try {
          return {
            instanceId: peer.target.instanceId,
            results: await this.searchPeerForJump(peer.target, { query, limit }),
          };
        } catch {
          // ⌘K is a jump surface, not a diagnostics surface: a slow or
          // failing peer contributes nothing rather than an error row.
          return {
            instanceId: peer.target.instanceId,
            results: [],
          };
        }
      },
      {
        concurrency,
        maxUnread: concurrency,
      },
    );

    let response: FederationJumpSearchResponse = { results: [] };
    for await (const group of searches) {
      groups.set(group.instanceId, group.results);
      completedPeerCount += 1;
      response = publishProgress();
    }
    return response;
  }

  /**
   * Record what a peer calls its threads, from any snapshot that reached this
   * instance. Called from every path that fetches a peer snapshot — this
   * cache's own fetch, and the federation-window navigation read, which does
   * NOT go through this cache and is where a viewer sees most remote threads.
   *
   * Merged, never replaced: a backend- or filter-scoped snapshot carries only
   * part of a peer's threads, and forgetting a name because the latest
   * snapshot was narrower would send a row back to its raw thread id.
   *
   * Only names are kept, not summaries — this exists so a display string is
   * always in hand, and holding whole rows for every thread ever seen on
   * every peer would be a real memory cost for no extra answer. Rows whose
   * title IS the thread id are skipped: recording one would overwrite a real
   * name with nothing.
   */
  rememberThreadNames(
    instanceId: string,
    threads: readonly NavigationThreadSummary[],
    observationSequence: number,
  ): void {
    for (const thread of threads) {
      // A fallback or blank title is not news, and observing one anyway leaves
      // an entry behind: the store rejects the value but still creates the
      // record. A peer exposing thousands of unnamed threads would cost
      // per-thread bookkeeping, retained for the life of the process, holding
      // nothing any read can answer from.
      const title = thread.title?.trim();
      if (!title || thread.titleSource === "fallback" || title === thread.id) {
        continue;
      }
      this.threadNames.observe({
        identity: {
          backend: thread.source,
          instanceId,
          threadId: thread.id,
        },
        observationSequence,
        source: "remote-navigation",
        ...(thread.title !== undefined ? { title: thread.title } : {}),
        ...(thread.titleSource ? { titleSource: thread.titleSource } : {}),
      });
    }
  }

  /**
   * Take the sequence a peer snapshot's names will be recorded at, BEFORE the
   * fetch starts.
   *
   * Two refreshes for one peer can be in flight at once and can complete out of
   * order. Without this, the older snapshot's rows would land last and revert a
   * rename the operator has already seen — the remote half of the regression
   * the information store exists to prevent.
   */
  reserveThreadNameObservation(): number {
    return this.threadNames.reserveObservationSequence();
  }

  /** Drop a peer's names when it unmounts and can no longer be asked. */
  forgetInstanceThreadNames(instanceId: string): void {
    this.threadNames.forgetInstance(instanceId);
  }

  /**
   * What a peer calls one of its threads, out of names ALREADY seen. Never
   * contacts the peer, never refetches on a lapsed TTL, never registers peer
   * interest — it is a map read, and it is safe on any path that must not
   * wait.
   *
   * This is the middle tier of thread-name resolution:
   *
   * 1. Local only — this instance's thread list. Correct only when the caller
   *    knows every thread it can see is its own.
   * 2. Local + cached remote (this method) — the right default. A remote
   *    thread the operator can see was named by some snapshot on the way to
   *    the screen; asking the peer again buys nothing.
   * 3. Local + live remote (`threadFromPeer`) — for callers that genuinely
   *    need current data and can afford to wait on a peer.
   *
   * Deliberately survives TTL lapse, peer disconnect, and `invalidate`: a
   * name one navigation refresh out of date beats the raw thread id, and
   * every alternative costs the round trip tier 2 exists to avoid.
   */
  cachedThreadNameFromPeer(params: {
    target: FederationRemoteTarget;
    backend: NavigationThreadSummary["source"];
    threadId: string;
  }): RemoteThreadName | undefined {
    const info = this.threadNames.get({
      backend: params.backend,
      instanceId: params.target.instanceId,
      threadId: params.threadId,
    });
    if (!info?.title) {
      return undefined;
    }
    // titleSource is absent whenever the peer row omitted it — the field is a
    // compile-time contract and the payload is another instance's JSON, so an
    // older peer legitimately sends a real title without one. Requiring it
    // here would answer `undefined` for a name this store holds, and the quit
    // dialog would show the raw thread id instead.
    return { title: info.title, titleSource: info.titleSource };
  }

  /**
   * A single thread from a connected peer's snapshot, fetching when the cache
   * has lapsed; undefined when the peer is unreachable or the thread is absent
   * (e.g. archived). Tier 3 — it can wait on the peer. Callers that only need
   * a name should use `cachedThreadFromPeer`.
   */
  async threadFromPeer(params: {
    target: FederationRemoteTarget;
    backend: NavigationThreadSummary["source"];
    threadId: string;
  }): Promise<NavigationThreadSummary | undefined> {
    const connected = this.navigationPeers().some(
      (peer) => peer.target.instanceId === params.target.instanceId,
    );
    if (!connected) {
      return undefined;
    }
    try {
      const selection = threadSelection([params]);
      const threads = await this.threadsForPeer(
        params.target,
        selection,
        `thread:${selectionKey(selection)}`,
      );
      return threads.find(
        (thread) =>
          thread.source === params.backend && thread.id === params.threadId,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Never awaits a peer: navigation-refresh latency must stay independent
   * of peer responsiveness (a connected-but-slow owner used to stall every
   * snapshot merge by up to the per-peer timeout). Serves the cached
   * snapshot — stale or fresh — immediately, kicks a background refetch
   * on owner invalidation or new pin demand, and reports fresh data via
   * `onPinnedSummariesRefreshed`. Protocol-2 mounted pins keep navigation
   * subscriptions for their lifetime; local rebuilds must not poll healthy
   * owners after a TTL. Legacy snapshots still use TTL revalidation.
   *
   * Archive detection rides the same background pass: proving a pin
   * archived needs a fresh snapshot AND an owner lookup, so it cannot
   * happen inline without reintroducing the stall. Proofs land in
   * `provenArchived` and are reported by the next resolve — which the
   * refresh event triggers immediately.
   */
  async resolvePinnedThreads(
    pins: readonly RemoteThreadPin[],
  ): Promise<ResolvedRemotePins> {
    const threads: NavigationThreadSummary[] = [];
    const refreshed: ResolvedRemotePins["refreshed"] = [];
    const archived: ResolvedRemotePins["archived"] = [];
    const connectedByInstanceId = new Map(
      this.navigationPeers().map((peer) => [peer.target.instanceId, peer]),
    );
    const pinsByInstanceId = new Map<string, RemoteThreadPin[]>();
    for (const pin of pins) {
      if (pin.ref.target.scope !== "remote") {
        continue;
      }
      const group = pinsByInstanceId.get(pin.ref.target.instanceId) ?? [];
      group.push(pin);
      pinsByInstanceId.set(pin.ref.target.instanceId, group);
    }
    // Fence membership changes and remounts, including pending reads from the
    // old mount. Install the new demand before starting the replacement read.
    const previousDemand = new Map([...new Set([...this.pinnedByInstanceId.keys(), ...pinsByInstanceId.keys()])]
      .map((owner) => [owner, this.mountedSelectionKey(owner)]));
    // Retain identities only; persisted payloads must not become another long-lived detail cache.
    this.pinnedByInstanceId = new Map([...pinsByInstanceId].map(([owner, group]) => [
      owner,
      group.map(({ summary: _summary, ...pin }) => pin),
    ]));
    const changedOwners = [...previousDemand].filter(([owner, previous]) => this.hasMountedDemand(owner)
      && (previous
        ? previous !== this.mountedSelectionKey(owner)
        : this.cache.get(owner)?.descendants || this.inFlight.get(owner)?.descendants))
      .map(([owner]) => owner);
    for (const owner of this.missingPinSignatures.keys()) {
      if (!pinsByInstanceId.has(owner)) this.missingPinSignatures.delete(owner);
    }
    for (const owner of this.pinnedReadStates.keys()) {
      if (!this.hasMountedDemand(owner)) {
        this.pinnedReadStates.delete(owner);
        this.uncertainPinnedMembership.delete(owner);
      }
    }
    for (const owner of changedOwners) this.invalidate(owner);
    this.notifyPeerInterestChanged();
    const directPinKeys = new Set(
      pins.map((pin) =>
        buildThreadIdentityKey(pin.ref.backend, pin.ref.threadId)
      ),
    );
    const selectedKeys = new Set<string>();

    for (const [instanceId, group] of pinsByInstanceId) {
      const peer = connectedByInstanceId.get(instanceId);
      let served: NavigationThreadSummary[] | undefined;
      let fetchFailed = false;
      if (peer) {
        served = this.revalidateMountedSnapshot(peer.target, group.map((pin) => pin.ref))
          ? this.cache.get(instanceId)?.threads : undefined;
        fetchFailed = this.refreshFailures.has(instanceId);
      }
      const servedByKey = new Map(
        (served ?? []).map((thread) => [
          buildThreadIdentityKey(thread.source, thread.id),
          thread,
        ]),
      );
      for (const pin of group) {
        const threadKey = buildThreadIdentityKey(
          pin.ref.backend,
          pin.ref.threadId,
        );
        const servedThread = servedByKey.get(threadKey);
        if (servedThread) {
          if (!selectedKeys.has(threadKey)) {
            selectedKeys.add(threadKey);
            threads.push(
              fetchFailed ? this.dimDegraded(servedThread) : servedThread,
            );
          }
          if (!fetchFailed) {
            refreshed.push({
              ref: pin.ref,
              summary: servedThread,
              instanceLabel:
                servedThread.federation?.instanceLabel ?? pin.instanceLabel,
            });
          }
          continue;
        }
        if (this.consumeArchivedProof(instanceId, threadKey)) {
          archived.push(pin.ref);
          continue;
        }
        if (!selectedKeys.has(threadKey)) {
          threads.push(this.fallbackThread(pin, fetchFailed));
          selectedKeys.add(threadKey);
        }
      }

      // A mounted remote parent may itself have mounted a child from another
      // instance. Carry direct children with the pinned parent so a third
      // viewer sees the same nested tree instead of an orphaned parent row.
      // The child's existing federation stamp identifies its true owner and
      // is preserved by DesktopFederationRuntime when snapshots relay.
      const pinnedParentKeys = new Set(
        group.map((pin) =>
          buildThreadIdentityKey(pin.ref.backend, pin.ref.threadId)
        ),
      );
      for (const candidate of served ?? []) {
        const candidateFederation = candidate.federation;
        const candidateOwner = candidateFederation?.ref.target;
        if (
          !candidateFederation
          || candidateOwner?.scope !== "remote"
          || candidateOwner.instanceId === instanceId
        ) {
          continue;
        }
        const parentThreadId = candidate.parentThreadId?.trim();
        if (!parentThreadId) {
          continue;
        }
        if (
          candidate.parentThreadInstanceId
          && candidate.parentThreadInstanceId !== instanceId
        ) {
          continue;
        }
        const parentKey = buildThreadIdentityKey(
          candidate.parentThreadBackend ?? candidate.source,
          parentThreadId,
        );
        const candidateKey = buildThreadIdentityKey(candidate.source, candidate.id);
        if (
          !pinnedParentKeys.has(parentKey)
          || directPinKeys.has(candidateKey)
          || selectedKeys.has(candidateKey)
        ) {
          continue;
        }
        selectedKeys.add(candidateKey);
        const derivedCandidate = {
          ...candidate,
          federation: {
            ...candidateFederation,
            derivedFromMountedParent: true,
          },
        };
        threads.push(
          fetchFailed ? this.dimDegraded(derivedCandidate) : derivedCandidate,
        );
      }
    }
    return { threads, refreshed, archived };
  }

  /**
   * Rows for peer threads a viewer lists without pinning them: the other
   * instances' threads in the Drafts lens. Like `resolvePinnedThreads`, this
   * never awaits a peer. Each identity joins its owner's mounted demand, so
   * the pinned background pass reads it, the owner subscription covers it,
   * and `onPinnedSummariesRefreshed` asks the viewer to read again once its
   * row lands.
   *
   * Serves only rows this cache holds: live rows, dimmed rows for a connected
   * owner whose refresh failed, and the last observed rows for an owner that
   * is not connected, stamped with its status. An identity never observed is
   * left out rather than shown as a bare thread id. Same-owner ancestors join
   * the demand as their children's rows reveal them, so an exact query with
   * ancestry can place a draft under its parent.
   *
   * A watch lapses `watchTtlMs` after the last read that named it.
   */
  resolveWatchedThreads(
    refs: readonly FederatedThreadRef[],
  ): NavigationThreadSummary[] {
    const now = this.options.now?.() ?? Date.now();
    const expiresAt = now + (this.options.watchTtlMs ?? WATCHED_THREAD_TTL_MS);
    const keysByInstanceId = new Map<string, Set<string>>();
    for (const ref of refs) {
      if (ref.target.scope !== "remote") continue;
      const keys = keysByInstanceId.get(ref.target.instanceId) ?? new Set<string>();
      keys.add(buildThreadIdentityKey(ref.backend, ref.threadId));
      keysByInstanceId.set(ref.target.instanceId, keys);
    }
    const connectedByInstanceId = new Map(
      this.navigationPeers().map((peer) => [peer.target.instanceId, peer]),
    );
    const threads: NavigationThreadSummary[] = [];
    for (const [instanceId, keys] of keysByInstanceId) {
      const previous = this.mountedSelectionKey(instanceId);
      const watches = this.watchedByInstanceId.get(instanceId) ?? new Map();
      // A relayed row another instance owns can share a thread id. Only this
      // owner's rows answer for its identities.
      const rows = new Map((this.cache.get(instanceId)?.threads ?? []).flatMap((thread) => {
        const owner = thread.federation?.ref.target;
        return owner && (owner.scope !== "remote" || owner.instanceId !== instanceId) ? []
          : [[buildThreadIdentityKey(thread.source, thread.id), thread] as const];
      }));
      // Walk each row's same-owner parent into the demand. A parent that has
      // no row yet arrives with the next owner read and continues the walk.
      const queue = [...keys];
      for (let index = 0; index < queue.length; index += 1) {
        const key = queue[index]!;
        const ref = parseThreadIdentityKey(key);
        if (ref) {
          watches.set(key, {
            ref: { backend: ref.backend, target: { scope: "remote", instanceId }, threadId: ref.threadId },
            expiresAt,
          });
        }
        const row = rows.get(key);
        const parentThreadId = row?.parentThreadId?.trim();
        if (!row || !parentThreadId
          || (row.parentThreadInstanceId && row.parentThreadInstanceId !== instanceId)) continue;
        const parentKey = buildThreadIdentityKey(row.parentThreadBackend ?? row.source, parentThreadId);
        if (keys.has(parentKey)) continue;
        keys.add(parentKey);
        queue.push(parentKey);
      }
      if (watches.size) this.watchedByInstanceId.set(instanceId, watches);
      if (previous !== this.mountedSelectionKey(instanceId)) {
        // Wider demand fences the narrower read and starts one for all of it.
        this.invalidate(instanceId);
      }
      const peer = connectedByInstanceId.get(instanceId);
      if (peer) {
        this.revalidateMountedSnapshot(peer.target, this.mountedRefs(instanceId));
      }
      const failed = this.refreshFailures.has(instanceId);
      for (const key of keys) {
        const row = rows.get(key);
        if (!row) continue;
        threads.push(!peer ? this.heldOfflineThread(row, instanceId)
          : failed ? this.dimDegraded(row) : row);
      }
    }
    this.scheduleWatchedExpiry();
    return threads;
  }

  /**
   * Stop listing an instance's watched threads, as a revocation stops its
   * pins. Its retained snapshot then lapses like any unmounted owner's.
   */
  forgetWatchedThreads(instanceId: string): void {
    if (!this.watchedByInstanceId.delete(instanceId)) return;
    if (!this.hasMountedDemand(instanceId)) {
      this.cache.delete(instanceId);
      this.pinnedReadStates.delete(instanceId);
      this.uncertainPinnedMembership.delete(instanceId);
    }
    this.notifyPeerInterestChanged();
    this.scheduleWatchedExpiry();
  }

  /**
   * Whether the held owner snapshot covers `refs`. Kicks a background refresh
   * when it does not, or when it is fenced or past its TTL without an owner
   * subscription. Never awaits the peer.
   */
  private revalidateMountedSnapshot(
    target: FederationRemoteTarget,
    refs: ReadonlyArray<Pick<RemoteThreadPin["ref"], "backend" | "threadId">>,
  ): boolean {
    const instanceId = target.instanceId;
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = this.options.ttlMs ?? REMOTE_SNAPSHOT_TTL_MS;
    const cached = this.cache.get(instanceId);
    const requestedSelection = this.options.fetchPinnedSnapshot
      ? threadSelection(refs) : { kind: "all" } as const;
    const cacheSatisfies = cached
      && (cached.selection.kind === "all" || cached.descendants)
      && selectionIncludes(cached.selection, requestedSelection);
    if (
      !cacheSatisfies
      || (cached && (cached.fetchedAt === Number.NEGATIVE_INFINITY
        || ((!cached.descendants || !this.options.hasNavigationSubscription?.(instanceId))
          && now - cached.fetchedAt >= ttlMs)))
    ) {
      this.refreshPeerSummariesInBackground(target);
    }
    return Boolean(cacheSatisfies);
  }

  /**
   * The last observed row of an owner that cannot be read now. It stays
   * listed, dimmed by the owner's status, and claims no live turn.
   */
  private heldOfflineThread(
    thread: NavigationThreadSummary,
    instanceId: string,
  ): NavigationThreadSummary {
    if (!thread.federation) {
      return thread;
    }
    const current = this.options.peerStatus(instanceId);
    return {
      ...thread,
      threadStatus: thread.threadStatus === "active" ? undefined : thread.threadStatus,
      federation: {
        ...thread.federation,
        instanceLabel: current.label ?? thread.federation.instanceLabel,
        // Connected without navigation still cannot refresh this row.
        peerStatus: current.status === "connected" ? "degraded" : current.status ?? "disconnected",
        // The peer's live grants and icon, as a pin's fallback row carries.
        capabilities: current.capabilities ?? [],
        celestialIcon: current.celestialIcon,
      },
    };
  }

  private scheduleWatchedExpiry(): void {
    clearTimeout(this.watchedExpiryTimer);
    this.watchedExpiryTimer = undefined;
    let next = Number.POSITIVE_INFINITY;
    for (const watches of this.watchedByInstanceId.values()) {
      for (const watch of watches.values()) next = Math.min(next, watch.expiresAt);
    }
    if (next === Number.POSITIVE_INFINITY) return;
    const now = this.options.now?.() ?? Date.now();
    const timer = setTimeout(() => {
      if (this.watchedExpiryTimer === timer) this.expireWatchedThreads();
    }, Math.max(0, next - now));
    timer.unref?.();
    this.watchedExpiryTimer = timer;
  }

  private expireWatchedThreads(): void {
    const now = this.options.now?.() ?? Date.now();
    for (const [instanceId, watches] of [...this.watchedByInstanceId]) {
      const previous = this.mountedSelectionKey(instanceId);
      for (const [key, watch] of [...watches]) {
        if (watch.expiresAt <= now) watches.delete(key);
      }
      if (!watches.size) this.watchedByInstanceId.delete(instanceId);
      if (previous === this.mountedSelectionKey(instanceId)) continue;
      if (this.hasMountedDemand(instanceId)) {
        // Read the narrower demand so membership filtering stays exact.
        this.invalidate(instanceId);
      } else {
        this.pinnedReadStates.delete(instanceId);
        this.uncertainPinnedMembership.delete(instanceId);
      }
    }
    this.notifyPeerInterestChanged();
    this.scheduleWatchedExpiry();
  }

  /**
   * Read-and-clear: a proof is spent the moment it is reported, so a
   * thread the owner restored (and the viewer re-pinned) after the probe
   * can never be deleted by yesterday's evidence. A still-archived thread
   * simply earns a fresh proof on the next background pass.
   */
  private consumeArchivedProof(instanceId: string, threadKey: string): boolean {
    const proofs = this.provenArchived.get(instanceId);
    if (!proofs?.delete(threadKey)) {
      return false;
    }
    if (proofs.size === 0) {
      this.provenArchived.delete(instanceId);
    }
    return true;
  }

  /**
   * Kick a stale-snapshot refetch without blocking the caller, then prove
   * which of this peer's pins are archived rather than merely missing.
   * Completion fires `onPinnedSummariesRefreshed` only when a re-merge
   * would serve something different — fresh rows differing from the served
   * ones, archive proofs to act on, a failing peer recovering, or a first
   * failure (rows must dim). A repeat failure stays silent: firing on every
   * failed attempt would loop (event → re-merge → another kick → another
   * failure → event).
   */
  private refreshPeerSummariesInBackground(
    target: FederationRemoteTarget,
  ): void {
    const instanceId = target.instanceId;
    // Keep one complete refresh (including archive proof) per owner. A newer
    // invalidation fences its result and is consumed by one follow-up below.
    if (this.pinnedRefreshes.has(instanceId)) return;
    this.pinnedRefreshes.add(instanceId);
    const generation = this.generationFor(instanceId);
    const previous = this.cache.get(instanceId)?.threads;
    const failedBefore = this.refreshFailures.has(instanceId);
    // Watched threads ride the same read. Only pins are proved archived:
    // a watched thread the owner no longer lists simply leaves the lens.
    const pins = this.pinnedByInstanceId.get(instanceId) ?? [];
    const refs = this.mountedRefs(instanceId);
    this.threadsForPeer(
      target,
      this.options.fetchPinnedSnapshot ? threadSelection(refs) : { kind: "all" },
      "pins",
    ).then(
      async (threads) => {
        if (generation !== this.generationFor(instanceId) || !this.hasMountedDemand(instanceId)) return;
        this.refreshFailures.delete(instanceId);
        const provedArchived = await this.proveArchivedPins(
          target,
          pins,
          threads,
        );
        if (generation !== this.generationFor(instanceId) || !this.hasMountedDemand(instanceId)) return;
        const unpublished = this.unpublishedPinnedRows.delete(instanceId);
        const changed = unpublished
          || previous === undefined
          || JSON.stringify(previous) !== JSON.stringify(threads);
        const returned = new Set(threads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)));
        const missing = pins.map((pin) => buildThreadIdentityKey(pin.ref.backend, pin.ref.threadId))
          .filter((key) => !returned.has(key) && !this.provenArchived.get(instanceId)?.has(key)).sort();
        const missingSignature = JSON.stringify(missing);
        if (this.missingPinSignatures.get(instanceId) !== missingSignature) {
          this.missingPinSignatures.set(instanceId, missingSignature);
          if (missing.length) this.options.onPinnedRefreshProblem?.({ instanceId, requestedCount: pins.length,
            missingCount: missing.length, threadKeys: missing.slice(0, 10).map((key) => key.slice(0, 200)) });
        }
        if (failedBefore || changed || provedArchived) {
          this.options.onPinnedSummariesRefreshed?.(instanceId);
        }
      },
      (error: unknown) => {
        if (generation !== this.generationFor(instanceId) || !this.hasMountedDemand(instanceId)) return;
        this.refreshFailures.add(instanceId);
        if (!failedBefore) {
          this.options.onPinnedRefreshProblem?.({ instanceId, requestedCount: refs.length,
            threadKeys: refs.slice(0, 10).map((ref) => buildThreadIdentityKey(ref.backend, ref.threadId).slice(0, 200)),
            error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
          this.options.onPinnedSummariesRefreshed?.(instanceId);
        }
      },
    ).finally(() => {
      this.pinnedRefreshes.delete(instanceId);
      if (this.hasMountedDemand(instanceId) && generation !== this.generationFor(instanceId)
        && this.navigationPeers().some((peer) => peer.target.instanceId === instanceId)) {
        this.refreshPeerSummariesInBackground(target);
      }
    });
  }

  /**
   * Ask the owner which of the pins absent from its fresh snapshot are
   * archived. Absence alone is not proof — an unreachable backend or a
   * filtered snapshot looks identical — so only a positive archive listing
   * authorizes removing the viewer's pin. Returns whether anything new was
   * proved, so the caller knows a re-merge is worth announcing.
   */
  private async proveArchivedPins(
    target: FederationRemoteTarget,
    pins: readonly RemoteThreadPin[],
    fresh: readonly NavigationThreadSummary[],
  ): Promise<boolean> {
    const freshKeys = new Set(
      fresh.map((thread) => buildThreadIdentityKey(thread.source, thread.id)),
    );
    const missing = pins.filter(
      (pin) => !freshKeys.has(
        buildThreadIdentityKey(pin.ref.backend, pin.ref.threadId),
      ),
    );
    if (missing.length === 0) {
      return false;
    }
    const timeoutMs =
      this.options.peerTimeoutMs ?? REMOTE_SNAPSHOT_PEER_TIMEOUT_MS;
    const backends = new Set(missing.map((pin) => pin.ref.backend));
    let proved = false;
    await Promise.all(
      [...backends].map(async (backend) => {
        const candidateKeys = new Set(
          missing
            .filter((pin) => pin.ref.backend === backend)
            .map((pin) =>
              buildThreadIdentityKey(pin.ref.backend, pin.ref.threadId)
            ),
        );
        try {
          const keys = await this.archivedThreadKeysForPeer(
            target,
            backend,
            candidateKeys,
            timeoutMs,
            missing.filter((pin) => pin.ref.backend === backend).map((pin) => pin.ref.threadId),
          );
          for (const key of candidateKeys) {
            if (!keys.has(key)) {
              continue;
            }
            const proofs =
              this.provenArchived.get(target.instanceId) ?? new Set<string>();
            proofs.add(key);
            this.provenArchived.set(target.instanceId, proofs);
            proved = true;
          }
        } catch {
          // Archive detection is proof-based. If the lookup fails, keep the
          // cached row just as we do when the active fetch fails.
        }
      }),
    );
    return proved;
  }

  /**
   * A connected peer whose last background refresh failed still serves its
   * cached rows, but they must dim like fallback rows: the data is not live.
   */
  private dimDegraded(
    thread: NavigationThreadSummary,
  ): NavigationThreadSummary {
    if (!thread.federation) {
      return thread;
    }
    return {
      ...thread,
      federation: { ...thread.federation, peerStatus: "degraded" },
    };
  }

  private fallbackThread(
    pin: RemoteThreadPin,
    fetchFailed: boolean,
  ): NavigationThreadSummary {
    const base: NavigationThreadSummary =
      pin.summary
      ?? {
        source: pin.ref.backend,
        id: pin.ref.threadId,
        title: pin.ref.threadId,
        titleSource: "fallback",
        linkedDirectories: [],
        inbox: { inInbox: false },
      };
    const instanceId =
      pin.ref.target.scope === "remote" ? pin.ref.target.instanceId : "";
    const current = this.options.peerStatus(instanceId);
    // A peer that reports connected but failed the fetch must still dim:
    // the row's data is cached, not live.
    const peerStatus =
      fetchFailed && current.status === "connected"
        ? ("degraded" as const)
        : (current.status ?? ("disconnected" as const));
    return {
      ...base,
      // A saved running flag is not evidence of a live turn in this process.
      // Keep the row, but establish activity from an owner refresh after startup.
      threadStatus: base.threadStatus === "active" ? undefined : base.threadStatus,
      federation: {
        ref: pin.ref,
        instanceLabel: current.label ?? pin.instanceLabel,
        peerStatus,
        // Capabilities are a property of the PEER, not of the cached row,
        // so a fallback row can carry the live set. Stamping [] here would
        // tell the thread view "remote terminal not granted" for a peer
        // that grants it, every time the merge serves a cached row.
        capabilities: current.capabilities ?? [],
        celestialIcon: current.celestialIcon,
      },
    };
  }

  private navigationPeers(): RemoteThreadSummaryPeer[] {
    return this.options
      .peers()
      .filter((peer) => peer.capabilities.includes("thread_navigation"));
  }

  private async searchPeerForJump(
    target: FederationRemoteTarget,
    request: FederationJumpSearchRequest,
  ): Promise<NavigationThreadSummary[]> {
    const timeoutMs =
      this.options.peerTimeoutMs ?? REMOTE_SNAPSHOT_PEER_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    if (this.options.searchPeer) {
      try {
        return await withTimeout(
          this.options.searchPeer(target, request, { deadlineAt }),
          timeoutMs,
          `Remote thread search timed out after ${Math.round(timeoutMs / 1000)}s.`,
        );
      } catch (error) {
        if (!hasFederationErrorCode(error, "method_not_found")) {
          throw error;
        }
      }
    }
    const legacyThreads = await this.threadsForPeer(
      target,
      { kind: "all" },
      "jump-search",
      deadlineAt,
    );
    return rankThreadJumpMatches(legacyThreads, request.query);
  }

  private async threadsForPeer(
    target: FederationRemoteTarget,
    selection: FederationThreadSelection,
    interestKey: string,
    deadlineAt?: number,
  ): Promise<NavigationThreadSummary[]> {
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = this.options.ttlMs ?? REMOTE_SNAPSHOT_TTL_MS;
    const descendants = interestKey === "pins" && Boolean(this.options.fetchPinnedSnapshot);
    // Keep new-child discovery notifications broad. Sparse payload selection
    // must not hide a child whose identity has not arrived yet.
    const interestSelection = descendants ? { kind: "all" } as const : selection;
    if (interestKey !== "pins") {
      this.touchPeerInterest(target.instanceId, interestKey, interestSelection, ttlMs);
    }
    const cached = this.cache.get(target.instanceId);
    if (
      cached
      && (!descendants || cached.selection.kind === "all" || cached.descendants)
      && selectionIncludes(cached.selection, selection)
      && (cached.fetchedAt !== Number.NEGATIVE_INFINITY && descendants && cached.descendants
        && this.options.hasNavigationSubscription?.(target.instanceId)
        || now - cached.fetchedAt < ttlMs)
    ) {
      return cached.threads;
    }
    const generation = this.generationFor(target.instanceId);
    const pending = this.inFlight.get(target.instanceId);
    if (
      pending?.generation === generation
      && (!descendants || pending.selection.kind === "all" || pending.descendants)
      && selectionIncludes(pending.selection, selection)
    ) {
      return await this.awaitPeerSnapshot(
        pending.promise,
        deadlineAt,
      );
    }
    if (pending?.generation === generation) {
      try {
        await this.awaitPeerSnapshot(pending.promise, deadlineAt);
      } catch {
        // The next read below gets its own attempt for the wider/different
        // collection; an unrelated sparse failure must not answer it.
      }
      return await this.threadsForPeer(
        target,
        selection,
        interestKey,
        deadlineAt,
      );
    }
    // Reserved before the fetch, not after it: a snapshot that starts first and
    // finishes last must not overwrite the names a later refresh already
    // recorded.
    const nameObservationSequence = this.reserveThreadNameObservation();
    const promise = (async () => {
      const rpcOptions = deadlineAt !== undefined ? { deadlineAt }
        : descendants ? { deadlineAt: Date.now() + REMOTE_SNAPSHOT_PEER_TIMEOUT_MS } : undefined;
      const pinState = this.pinnedReadStates.get(target.instanceId) ?? new Map();
      if (descendants) this.pinnedReadStates.set(target.instanceId, pinState);
      const snapshot = await this.awaitPeerSnapshot(
        descendants && selection.kind === "threads"
          ? this.options.fetchPinnedSnapshot!(target, selection.threads.map((thread) =>
              buildThreadIdentityKey(thread.backend, thread.threadId)), rpcOptions, pinState)
          : rpcOptions
          ? this.options.fetchSnapshot(target, selection, rpcOptions)
          : this.options.fetchSnapshot(target, selection),
        deadlineAt,
      );
      if (this.generationFor(target.instanceId) !== generation) {
        if (interestKey === "pins") return snapshot.threads;
        return await this.threadsForPeer(
          target,
          selection,
          interestKey,
          deadlineAt,
        );
      }
      const threads = snapshot.threads;
      if (interestKey === "pins") {
        const previous = this.cache.get(target.instanceId)?.threads;
        // Cache commitment precedes archive verification and publication. Keep
        // this obligation across invalidation so an identical follow-up still
        // publishes rows whose earlier archive check was superseded.
        if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(threads)
          || this.refreshFailures.has(target.instanceId)) {
          this.unpublishedPinnedRows.add(target.instanceId);
        }
      }
      const knownMembers = this.hasRetainedPinnedMembership(target.instanceId) ? this.pinnedThreadKeys(target.instanceId) : undefined;
      this.cache.set(target.instanceId, {
        descendants,
        fetchedAt: this.options.now?.() ?? Date.now(),
        selection,
        threads,
      });
      if (interestKey === "pins") {
        this.uncertainPinnedMembership.delete(target.instanceId);
        this.notifyPeerInterestChanged();
        if (knownMembers && threads.some((thread) => !knownMembers.has(buildThreadIdentityKey(thread.source, thread.id)))) {
          // A new child may have changed between the owner snapshot and this
          // expanded subscription. Revalidate after subscribing; do not toggle
          // unchanged closures through broad subscriptions on every event.
          this.unpublishedPinnedRows.add(target.instanceId);
          this.invalidate(target.instanceId);
          return threads;
        }
      }
      this.rememberThreadNames(
        target.instanceId,
        threads,
        nameObservationSequence,
      );
      if (interestKey !== "pins") {
        this.touchPeerInterest(target.instanceId, interestKey, interestSelection, ttlMs);
      }
      // ANY successful fetch is proof of life, including one the jump
      // search started. Clearing the flag only in the pinned-refresh path
      // would keep freshly-fetched rows dimmed until the next TTL lapse.
      this.refreshFailures.delete(target.instanceId);
      return threads;
    })();
    const entry = { generation, promise, selection, descendants };
    this.inFlight.set(target.instanceId, entry);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(target.instanceId) === entry) {
        this.inFlight.delete(target.instanceId);
      }
    }
  }

  private async awaitPeerSnapshot<T>(
    promise: Promise<T>,
    deadlineAt?: number,
  ): Promise<T> {
    const defaultTimeoutMs =
      this.options.peerTimeoutMs ?? REMOTE_SNAPSHOT_PEER_TIMEOUT_MS;
    const timeoutMs = deadlineAt === undefined
      ? defaultTimeoutMs
      : Math.max(0, deadlineAt - Date.now());
    const message =
      `Remote thread summaries timed out after ${Math.round(defaultTimeoutMs / 1000)}s.`;
    if (timeoutMs <= 0) {
      throw new Error(message);
    }
    return await withTimeout(promise, timeoutMs, message);
  }

  private async archivedThreadKeysForPeer(
    target: FederationRemoteTarget,
    backend: RemoteThreadPin["ref"]["backend"],
    candidateKeys: ReadonlySet<string>,
    timeoutMs: number,
    threadIds: string[],
  ): Promise<Set<string>> {
    const cacheKey = `${target.instanceId}:${backend}`;
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = this.options.ttlMs ?? REMOTE_SNAPSHOT_TTL_MS;
    const generation = this.generationFor(target.instanceId);
    const cached = this.archivedCache.get(cacheKey);
    if (
      cached
      && now - cached.fetchedAt < ttlMs
      && [...candidateKeys].every((key) => cached.queriedKeys.has(key) && !cached.threadKeys.has(key))
    ) {
      // A cached negative can only delay cleanup. A cached positive could
      // delete a thread restored and re-pinned since the probe, so positive
      // archive evidence is always revalidated with a fresh owner request.
      return cached.threadKeys;
    }
    const archivedThreads = await withTimeout(
      this.options.fetchArchivedThreads(target, backend, threadIds, {
        deadlineAt: Date.now() + timeoutMs,
      }),
      timeoutMs,
      `Remote archived threads timed out after ${Math.round(timeoutMs / 1000)}s.`,
    );
    const threadKeys = new Set(
      archivedThreads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id)
      ),
    );
    if (this.generationFor(target.instanceId) !== generation) {
      return new Set();
    }
    this.archivedCache.set(cacheKey, {
      fetchedAt: this.options.now?.() ?? Date.now(),
      threadKeys,
      queriedKeys: new Set(candidateKeys),
    });
    return threadKeys;
  }

  private generationFor(instanceId: string): string {
    return `${this.globalGeneration}:${this.peerGenerations.get(instanceId) ?? 0}`;
  }

  private touchPeerInterest(
    instanceId: string,
    interestKey: string,
    selection: FederationThreadSelection,
    ttlMs: number,
  ): void {
    const interests = this.peerInterests.get(instanceId) ?? new Map();
    const existing = interests.get(interestKey);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      const currentInterests = this.peerInterests.get(instanceId);
      if (currentInterests?.get(interestKey)?.timer !== timer) {
        return;
      }
      currentInterests.delete(interestKey);
      if (currentInterests.size === 0) {
        this.peerInterests.delete(instanceId);
      }
      this.notifyPeerInterestChanged();
    }, ttlMs);
    timer.unref?.();
    interests.set(interestKey, { selection, timer });
    this.peerInterests.set(instanceId, interests);
    if (
      !existing
      || selectionKey(existing.selection) !== selectionKey(selection)
    ) {
      this.notifyPeerInterestChanged();
    }
  }

  /** Pins and watched threads together: what an owner's background pass reads. */
  private mountedRefs(instanceId: string): RemoteThreadPin["ref"][] {
    return [
      ...(this.pinnedByInstanceId.get(instanceId) ?? []).map((pin) => pin.ref),
      ...[...(this.watchedByInstanceId.get(instanceId)?.values() ?? [])].map((watch) => watch.ref),
    ];
  }

  private mountedSelectionKey(instanceId: string): string | undefined {
    return this.hasMountedDemand(instanceId)
      ? selectionKey(threadSelection(this.mountedRefs(instanceId))) : undefined;
  }

  private hasMountedDemand(instanceId: string): boolean {
    return this.pinnedByInstanceId.has(instanceId) || this.watchedByInstanceId.has(instanceId);
  }

  private mountedOwners(): string[] {
    return [...new Set([...this.pinnedByInstanceId.keys(), ...this.watchedByInstanceId.keys()])];
  }

  private hasCompletePinnedMembership(instanceId: string): boolean {
    return !this.uncertainPinnedMembership.has(instanceId) && this.hasRetainedPinnedMembership(instanceId);
  }

  private hasRetainedPinnedMembership(instanceId: string): boolean {
    const cached = this.cache.get(instanceId);
    return Boolean(cached?.descendants
      && selectionKey(cached.selection) === this.mountedSelectionKey(instanceId));
  }

  private pinnedThreadKeys(instanceId: string): Set<string> {
    // The group-members projection is authoritative for ancestry, including
    // legacy cross-backend parents. Do not reconstruct its graph from rows.
    return new Set([
      ...this.mountedRefs(instanceId).map((ref) => buildThreadIdentityKey(ref.backend, ref.threadId)),
      ...(this.hasRetainedPinnedMembership(instanceId) ? this.cache.get(instanceId)?.threads ?? [] : [])
        .map((thread) => buildThreadIdentityKey(thread.source, thread.id)),
    ]);
  }

  private notifyPeerInterestChanged(): void {
    const owners = new Set([...this.peerInterests.keys(), ...this.mountedOwners()]);
    this.options.onPeerInterestChanged?.(
      [...owners].sort().map((instanceId) => ({
        instanceId,
        // Ordinary row changes need only the mounted closure. Membership
        // invalidations bypass sparse filtering to discover unknown children.
        // Older owners filter unknown children by exact ID. Keep their broad
        // notifications and filter row relevance locally until they upgrade.
        threadSelection: this.hasMountedDemand(instanceId)
          && (!this.hasRetainedPinnedMembership(instanceId)
            || !this.navigationPeers().find((peer) => peer.target.instanceId === instanceId)
              ?.capabilities.includes("navigation_group_invalidations")) ? { kind: "all" } : mergeSelections([
          ...[...(this.peerInterests.get(instanceId)?.values() ?? [])].map((interest) => interest.selection),
          ...(this.hasMountedDemand(instanceId) ? [threadSelection(
            [...this.pinnedThreadKeys(instanceId)].map((key) => parseThreadIdentityKey(key)!),
          )] : []),
        ]),
      })),
    );
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (timer.unref) timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}


function rankUniqueThreadJumpMatches(
  threads: readonly NavigationThreadSummary[],
  query: string,
  limit: number,
): NavigationThreadSummary[] {
  const seen = new Set<string>();
  return sortThreadJumpMatches(threads, query)
    .filter((thread) => {
      const key = thread.federation?.ref
        ? federatedThreadIdentityKey(thread.federation.ref)
        : buildThreadIdentityKey(thread.source, thread.id);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((thread) => compactNavigationSearchResult(thread, query));
}
