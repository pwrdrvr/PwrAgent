import type {
  CelestialIconId,
  FederationCapability,
  FederationJumpSearchRequest,
  FederationJumpSearchResponse,
  FederationPeerSummary,
  FederationRemoteTarget,
  FederationThreadSelection,
  NavigationSnapshot,
  NavigationThreadSummary,
  RemoteThreadPin,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  threadHasExactPrNumberMatch,
  threadMatchesQuery,
} from "@pwragent/shared";

export type RemoteThreadSummaryPeer = {
  target: FederationRemoteTarget;
  label: string;
  capabilities: FederationCapability[];
};

/** A peer's display name for one of its threads. */
export type RemoteThreadName = {
  title: string;
  titleSource: NavigationThreadSummary["titleSource"];
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
 * Peer navigation snapshots are the only remote summary shape that carries
 * PR chips (the owner merges its overlay `prs` before serving), so both the
 * ⌘K jump search and the pinned-thread merge read through this cache rather
 * than `listThreads`. The TTL keeps keystroke-debounced jump queries and
 * back-to-back snapshot merges from re-fetching full snapshots per call.
 */
const REMOTE_SNAPSHOT_TTL_MS = 15_000;
/** Mirrors the federated-search per-peer deadline. */
const REMOTE_SNAPSHOT_PEER_TIMEOUT_MS = 10_000;
const DEFAULT_JUMP_SEARCH_LIMIT = 8;
const MAX_JUMP_SEARCH_LIMIT = 50;

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
      selection: FederationThreadSelection;
      threads: NavigationThreadSummary[];
    }
  >();
  private readonly inFlight = new Map<
    string,
    {
      generation: string;
      promise: Promise<NavigationThreadSummary[]>;
      selection: FederationThreadSelection;
    }
  >();
  private readonly archivedCache = new Map<
    string,
    { fetchedAt: number; threadKeys: Set<string> }
  >();
  /**
   * Display names per instance, keyed by thread identity. Deliberately NOT
   * cleared by `invalidate` — see `cachedThreadNameFromPeer`. Dropping a name
   * can only send a row back to its thread id, and a name is stale-tolerant
   * in a way the snapshots above are not.
   */
  private readonly threadNames = new Map<
    string,
    Map<string, RemoteThreadName>
  >();
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
  /**
   * Thread keys a background pass proved archived on their owner, keyed by
   * instance, awaiting report to the caller that removes the pin.
   */
  private readonly provenArchived = new Map<string, Set<string>>();

  constructor(
    private readonly options: {
      /** Connected peers able to serve navigation snapshots. */
      peers: () => RemoteThreadSummaryPeer[];
      /** Stamped snapshot fetch — `DesktopFederationRuntime.remoteNavigationSnapshot`. */
      fetchSnapshot: (
        target: FederationRemoteTarget,
        selection: FederationThreadSelection,
      ) => Promise<NavigationSnapshot>;
      /** Archived threads for one backend on a connected peer. */
      fetchArchivedThreads: (
        target: FederationRemoteTarget,
        backend: RemoteThreadPin["ref"]["backend"],
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
      ttlMs?: number;
      peerTimeoutMs?: number;
      now?: () => number;
    },
  ) {}

  invalidate(instanceId?: string): void {
    if (instanceId === undefined) {
      this.globalGeneration += 1;
      this.cache.clear();
      this.archivedCache.clear();
      this.refreshFailures.clear();
      this.provenArchived.clear();
      return;
    }
    this.peerGenerations.set(
      instanceId,
      (this.peerGenerations.get(instanceId) ?? 0) + 1,
    );
    this.cache.delete(instanceId);
    this.refreshFailures.delete(instanceId);
    this.provenArchived.delete(instanceId);
    for (const key of this.archivedCache.keys()) {
      if (key.startsWith(`${instanceId}:`)) {
        this.archivedCache.delete(key);
      }
    }
  }

  dispose(): void {
    const hadPeerInterest = this.peerInterests.size > 0;
    for (const interests of this.peerInterests.values()) {
      for (const interest of interests.values()) {
        clearTimeout(interest.timer);
      }
    }
    this.peerInterests.clear();
    if (hadPeerInterest) {
      this.options.onPeerInterestChanged?.([]);
    }
  }

  async searchForJump(
    request: FederationJumpSearchRequest,
  ): Promise<FederationJumpSearchResponse> {
    const query = request.query.trim();
    if (!query) {
      return { results: [] };
    }
    const limit = Math.max(
      1,
      Math.min(request.limit ?? DEFAULT_JUMP_SEARCH_LIMIT, MAX_JUMP_SEARCH_LIMIT),
    );
    const groups = await Promise.all(
      this.navigationPeers().map(async (peer) => {
        try {
          return await this.threadsForPeer(
            peer.target,
            { kind: "all" },
            "jump-search",
          );
        } catch {
          // ⌘K is a jump surface, not a diagnostics surface: a slow or
          // failing peer contributes nothing rather than an error row.
          return [];
        }
      }),
    );
    const results = groups
      .flat()
      .filter((thread) => threadMatchesQuery(thread, query))
      .sort((left, right) => {
        const exactPrPriority =
          Number(threadHasExactPrNumberMatch(right, query))
          - Number(threadHasExactPrNumberMatch(left, query));
        if (exactPrPriority !== 0) {
          return exactPrPriority;
        }
        return (
          (right.updatedAt ?? right.createdAt ?? 0)
          - (left.updatedAt ?? left.createdAt ?? 0)
        );
      })
      .slice(0, limit);
    return { results };
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
  ): void {
    let names = this.threadNames.get(instanceId);
    for (const thread of threads) {
      const title = thread.title?.trim();
      if (!title || thread.titleSource === "fallback") {
        continue;
      }
      names ??= new Map();
      names.set(buildThreadIdentityKey(thread.source, thread.id), {
        title,
        titleSource: thread.titleSource,
      });
    }
    if (names) {
      this.threadNames.set(instanceId, names);
    }
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
    return this.threadNames
      .get(params.target.instanceId)
      ?.get(buildThreadIdentityKey(params.backend, params.threadId));
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
   * when the TTL has lapsed, and reports fresh data via
   * `onPinnedSummariesRefreshed` so the owner can re-merge.
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
        const now = this.options.now?.() ?? Date.now();
        const ttlMs = this.options.ttlMs ?? REMOTE_SNAPSHOT_TTL_MS;
        const cached = this.cache.get(instanceId);
        // A pinned parent can mount descendants owned by another instance.
        // Their identities are only discoverable from the owner's full
        // navigation projection, so a direct-pin selection would silently
        // drop them on a cold cache. Keep this collection broad until the
        // Federation protocol can request a server-computed descendant
        // closure.
        const requestedSelection = { kind: "all" } as const;
        const cacheSatisfies = cached
          && selectionIncludes(cached.selection, requestedSelection);
        if (
          !cacheSatisfies
          || (cached && now - cached.fetchedAt >= ttlMs)
        ) {
          this.refreshPeerSummariesInBackground(peer.target, group);
        }
        served = cacheSatisfies ? cached?.threads : undefined;
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
    pins: readonly RemoteThreadPin[],
  ): void {
    const instanceId = target.instanceId;
    // Dedup against the CURRENT generation only: a fetch started before an
    // invalidate is answering a question we no longer trust, so it must not
    // suppress the fresh one.
    if (
      this.inFlight.get(instanceId)?.generation
      === this.generationFor(instanceId)
    ) {
      return;
    }
    const previous = this.cache.get(instanceId)?.threads;
    const failedBefore = this.refreshFailures.has(instanceId);
    this.threadsForPeer(
      target,
      { kind: "all" },
      "pins",
    ).then(
      async (threads) => {
        this.refreshFailures.delete(instanceId);
        const provedArchived = await this.proveArchivedPins(
          target,
          pins,
          threads,
        );
        const changed =
          previous === undefined
          || JSON.stringify(previous) !== JSON.stringify(threads);
        if (failedBefore || changed || provedArchived) {
          this.options.onPinnedSummariesRefreshed?.(instanceId);
        }
      },
      () => {
        this.refreshFailures.add(instanceId);
        if (!failedBefore) {
          this.options.onPinnedSummariesRefreshed?.(instanceId);
        }
      },
    );
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

  private async threadsForPeer(
    target: FederationRemoteTarget,
    selection: FederationThreadSelection,
    interestKey: string,
  ): Promise<NavigationThreadSummary[]> {
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = this.options.ttlMs ?? REMOTE_SNAPSHOT_TTL_MS;
    this.touchPeerInterest(
      target.instanceId,
      interestKey,
      selection,
      ttlMs,
    );
    const cached = this.cache.get(target.instanceId);
    if (
      cached
      && selectionIncludes(cached.selection, selection)
      && now - cached.fetchedAt < ttlMs
    ) {
      return cached.threads;
    }
    const generation = this.generationFor(target.instanceId);
    const pending = this.inFlight.get(target.instanceId);
    if (
      pending?.generation === generation
      && selectionIncludes(pending.selection, selection)
    ) {
      return await pending.promise;
    }
    if (pending?.generation === generation) {
      try {
        await pending.promise;
      } catch {
        // The next read below gets its own attempt for the wider/different
        // collection; an unrelated sparse failure must not answer it.
      }
      return await this.threadsForPeer(target, selection, interestKey);
    }
    const promise = (async () => {
      const timeoutMs =
        this.options.peerTimeoutMs ?? REMOTE_SNAPSHOT_PEER_TIMEOUT_MS;
      const snapshot = await withTimeout(
        this.options.fetchSnapshot(target, selection),
        timeoutMs,
        `Remote thread summaries timed out after ${Math.round(timeoutMs / 1000)}s.`,
      );
      if (this.generationFor(target.instanceId) !== generation) {
        return await this.threadsForPeer(target, selection, interestKey);
      }
      const threads = snapshot.threads;
      this.cache.set(target.instanceId, {
        fetchedAt: this.options.now?.() ?? Date.now(),
        selection,
        threads,
      });
      this.rememberThreadNames(target.instanceId, threads);
      this.touchPeerInterest(
        target.instanceId,
        interestKey,
        selection,
        ttlMs,
      );
      // ANY successful fetch is proof of life, including one the jump
      // search started. Clearing the flag only in the pinned-refresh path
      // would keep freshly-fetched rows dimmed until the next TTL lapse.
      this.refreshFailures.delete(target.instanceId);
      return threads;
    })();
    const entry = { generation, promise, selection };
    this.inFlight.set(target.instanceId, entry);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(target.instanceId) === entry) {
        this.inFlight.delete(target.instanceId);
      }
    }
  }

  private async archivedThreadKeysForPeer(
    target: FederationRemoteTarget,
    backend: RemoteThreadPin["ref"]["backend"],
    candidateKeys: ReadonlySet<string>,
    timeoutMs: number,
  ): Promise<Set<string>> {
    const cacheKey = `${target.instanceId}:${backend}`;
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = this.options.ttlMs ?? REMOTE_SNAPSHOT_TTL_MS;
    const generation = this.generationFor(target.instanceId);
    const cached = this.archivedCache.get(cacheKey);
    if (
      cached
      && now - cached.fetchedAt < ttlMs
      && [...candidateKeys].every((key) => !cached.threadKeys.has(key))
    ) {
      // A cached negative can only delay cleanup. A cached positive could
      // delete a thread restored and re-pinned since the probe, so positive
      // archive evidence is always revalidated with a fresh owner request.
      return cached.threadKeys;
    }
    const archivedThreads = await withTimeout(
      this.options.fetchArchivedThreads(target, backend),
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

  private notifyPeerInterestChanged(): void {
    this.options.onPeerInterestChanged?.(
      [...this.peerInterests]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([instanceId, interests]) => ({
          instanceId,
          threadSelection: mergeSelections(
            [...interests.values()].map((interest) => interest.selection),
          ),
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
