import type {
  CelestialIconId,
  FederationCapability,
  FederationJumpSearchRequest,
  FederationJumpSearchResponse,
  FederationPeerSummary,
  FederationRemoteTarget,
  NavigationSnapshot,
  NavigationThreadSummary,
  RemoteThreadPin,
} from "@pwragent/shared";
import { threadMatchesQuery } from "@pwragent/shared";

export type RemoteThreadSummaryPeer = {
  target: FederationRemoteTarget;
  label: string;
  capabilities: FederationCapability[];
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

export class RemoteThreadSummaryCache {
  private readonly cache = new Map<
    string,
    { fetchedAt: number; threads: NavigationThreadSummary[] }
  >();
  private readonly inFlight = new Map<string, Promise<NavigationThreadSummary[]>>();
  private readonly archivedCache = new Map<
    string,
    { fetchedAt: number; threadKeys: Set<string> }
  >();
  private readonly archivedInFlight = new Map<string, Promise<Set<string>>>();

  constructor(
    private readonly options: {
      /** Connected peers able to serve navigation snapshots. */
      peers: () => RemoteThreadSummaryPeer[];
      /** Stamped snapshot fetch — `DesktopFederationRuntime.remoteNavigationSnapshot`. */
      fetchSnapshot: (target: FederationRemoteTarget) => Promise<NavigationSnapshot>;
      /** Archived threads for one backend on a connected peer. */
      fetchArchivedThreads: (
        target: FederationRemoteTarget,
        backend: RemoteThreadPin["ref"]["backend"],
      ) => Promise<Array<Pick<NavigationThreadSummary, "source" | "id">>>;
      /** Current visible status + composed label for any peer, connected or not. */
      peerStatus: (instanceId: string) => {
        status?: FederationPeerSummary["status"];
        label?: string;
        celestialIcon?: CelestialIconId;
      };
      ttlMs?: number;
      peerTimeoutMs?: number;
      now?: () => number;
    },
  ) {}

  invalidate(instanceId?: string): void {
    if (instanceId === undefined) {
      this.cache.clear();
      this.archivedCache.clear();
      return;
    }
    this.cache.delete(instanceId);
    for (const key of this.archivedCache.keys()) {
      if (key.startsWith(`${instanceId}:`)) {
        this.archivedCache.delete(key);
      }
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
          return await this.threadsForPeer(peer.target);
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
      .sort(
        (left, right) =>
          (right.updatedAt ?? right.createdAt ?? 0)
          - (left.updatedAt ?? left.createdAt ?? 0),
      )
      .slice(0, limit);
    return { results };
  }

  /**
   * A single thread from a connected peer's cached snapshot, or undefined
   * when the peer is unreachable or the thread is absent (e.g. archived).
   * Used for best-effort lookups like companion parent-pinning.
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
      const threads = await this.threadsForPeer(params.target);
      return threads.find(
        (thread) =>
          thread.source === params.backend && thread.id === params.threadId,
      );
    } catch {
      return undefined;
    }
  }

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

    await Promise.all(
      [...pinsByInstanceId.entries()].map(async ([instanceId, group]) => {
        const peer = connectedByInstanceId.get(instanceId);
        let fresh: NavigationThreadSummary[] | undefined;
        let fetchFailed = false;
        if (peer) {
          try {
            fresh = await this.threadsForPeer(peer.target);
          } catch {
            fetchFailed = true;
          }
        }
        const freshByKey = new Map(
          (fresh ?? []).map((thread) => [`${thread.source}:${thread.id}`, thread]),
        );
        const archivedKeys = new Set<string>();
        if (peer && fresh) {
          const missingBackends = new Set(
            group
              .filter(
                (pin) =>
                  !freshByKey.has(`${pin.ref.backend}:${pin.ref.threadId}`),
              )
              .map((pin) => pin.ref.backend),
          );
          await Promise.all(
            [...missingBackends].map(async (backend) => {
              try {
                const keys = await this.archivedThreadKeysForPeer(
                  peer.target,
                  backend,
                );
                for (const key of keys) {
                  archivedKeys.add(key);
                }
              } catch {
                // Archive detection is proof-based. If the lookup fails, keep
                // the cached row just as we do when the active fetch fails.
              }
            }),
          );
        }
        for (const pin of group) {
          const threadKey = `${pin.ref.backend}:${pin.ref.threadId}`;
          const freshThread = freshByKey.get(threadKey);
          if (freshThread) {
            threads.push(freshThread);
            refreshed.push({
              ref: pin.ref,
              summary: freshThread,
              instanceLabel:
                freshThread.federation?.instanceLabel ?? pin.instanceLabel,
            });
            continue;
          }
          if (archivedKeys.has(threadKey)) {
            archived.push(pin.ref);
            continue;
          }
          threads.push(this.fallbackThread(pin, fetchFailed));
        }
      }),
    );
    return { threads, refreshed, archived };
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
        capabilities: [],
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
  ): Promise<NavigationThreadSummary[]> {
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = this.options.ttlMs ?? REMOTE_SNAPSHOT_TTL_MS;
    const cached = this.cache.get(target.instanceId);
    if (cached && now - cached.fetchedAt < ttlMs) {
      return cached.threads;
    }
    const pending = this.inFlight.get(target.instanceId);
    if (pending) {
      return await pending;
    }
    const fetch = (async () => {
      const timeoutMs =
        this.options.peerTimeoutMs ?? REMOTE_SNAPSHOT_PEER_TIMEOUT_MS;
      const snapshot = await withTimeout(
        this.options.fetchSnapshot(target),
        timeoutMs,
        `Remote thread summaries timed out after ${Math.round(timeoutMs / 1000)}s.`,
      );
      const threads = snapshot.threads;
      this.cache.set(target.instanceId, {
        fetchedAt: this.options.now?.() ?? Date.now(),
        threads,
      });
      return threads;
    })();
    this.inFlight.set(target.instanceId, fetch);
    try {
      return await fetch;
    } finally {
      this.inFlight.delete(target.instanceId);
    }
  }

  private async archivedThreadKeysForPeer(
    target: FederationRemoteTarget,
    backend: RemoteThreadPin["ref"]["backend"],
  ): Promise<Set<string>> {
    const cacheKey = `${target.instanceId}:${backend}`;
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = this.options.ttlMs ?? REMOTE_SNAPSHOT_TTL_MS;
    const cached = this.archivedCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < ttlMs) {
      return cached.threadKeys;
    }
    const pending = this.archivedInFlight.get(cacheKey);
    if (pending) {
      return await pending;
    }
    const fetch = (async () => {
      const timeoutMs =
        this.options.peerTimeoutMs ?? REMOTE_SNAPSHOT_PEER_TIMEOUT_MS;
      const archivedThreads = await withTimeout(
        this.options.fetchArchivedThreads(target, backend),
        timeoutMs,
        `Remote archived threads timed out after ${Math.round(timeoutMs / 1000)}s.`,
      );
      const threadKeys = new Set(
        archivedThreads.map((thread) => `${thread.source}:${thread.id}`),
      );
      this.archivedCache.set(cacheKey, {
        fetchedAt: this.options.now?.() ?? Date.now(),
        threadKeys,
      });
      return threadKeys;
    })();
    this.archivedInFlight.set(cacheKey, fetch);
    try {
      return await fetch;
    } finally {
      this.archivedInFlight.delete(cacheKey);
    }
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
