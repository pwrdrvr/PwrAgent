import { describe, expect, it, vi } from "vitest";
import {
  buildFederatedThreadRef,
  buildThreadIdentityKey,
  type FederationRemoteTarget,
  type FederationThreadSelection,
  type NavigationSnapshot,
  type NavigationThreadSummary,
  type RemoteThreadPin,
} from "@pwragent/shared";
import {
  RemoteThreadSummaryCache,
  type RemoteThreadSummaryPeer,
} from "../federation/remote-thread-summary-cache";

function remoteTarget(instanceId: string): FederationRemoteTarget {
  return { scope: "remote", instanceId };
}

function peer(
  instanceId: string,
  label = instanceId,
): RemoteThreadSummaryPeer {
  return {
    target: remoteTarget(instanceId),
    label,
    capabilities: ["thread_navigation"],
  };
}

function stampedThread(params: {
  instanceId: string;
  threadId: string;
  title: string;
  updatedAt?: number;
  prNumber?: number;
  prNumbers?: number[];
}): NavigationThreadSummary {
  const prNumbers = params.prNumbers
    ?? (params.prNumber !== undefined ? [params.prNumber] : []);
  return {
    source: "codex",
    id: params.threadId,
    title: params.title,
    titleSource: "derived",
    linkedDirectories: [],
    inbox: { inInbox: false },
    updatedAt: params.updatedAt,
    ...(prNumbers.length > 0
      ? {
          prs: prNumbers.map((number) => ({
            provider: "github.com",
            number,
            org: "pwrdrvr",
            repo: "PwrAgent",
            state: "pending",
            url: `https://github.com/pwrdrvr/PwrAgent/pull/${number}`,
          })),
        }
      : {}),
    federation: {
      ref: buildFederatedThreadRef({
        backend: "codex",
        instanceId: params.instanceId,
        threadId: params.threadId,
      }),
      instanceLabel: params.instanceId,
      peerStatus: "connected",
      capabilities: [],
    },
  } as NavigationThreadSummary;
}

function snapshotOf(threads: NavigationThreadSummary[]): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: 0,
    unchanged: false,
    threads,
    inboxThreadKeys: [],
    directories: [],
  } as unknown as NavigationSnapshot;
}

const noArchivedThreads = async () => [];

it("keeps mounted pin navigation subscriptions until removal and refreshes on lifecycle invalidation without a polling timer", async () => {
  vi.useFakeTimers();
  const summary = stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Mounted" });
  const fetchPinnedSnapshot = vi.fn(async () => snapshotOf([summary]));
  const onPeerInterestChanged = vi.fn();
  const cache = new RemoteThreadSummaryCache({
    peers: () => [peer("peer-a")], fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads: noArchivedThreads, peerStatus: () => ({ status: "connected" }),
    onPeerInterestChanged, hasNavigationSubscription: () => true,
  });
  try {
    await cache.resolvePinnedThreads([pin({ instanceId: "peer-a", threadId: "t1", summary })]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(1);
    expect(onPeerInterestChanged).toHaveBeenLastCalledWith([
      { instanceId: "peer-a", threadSelection: { kind: "all" } },
    ]);
    // A local sidebar rebuild after the old TTL must reuse subscribed owner rows.
    await cache.resolvePinnedThreads([pin({ instanceId: "peer-a", threadId: "t1", summary })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(1);
    cache.invalidate("peer-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(2);
    await cache.resolvePinnedThreads([]);
    expect(onPeerInterestChanged).toHaveBeenLastCalledWith([]);
    cache.invalidate("peer-a");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(2);
    // Remounting starts a new subscription lifetime and must revalidate its rows.
    await cache.resolvePinnedThreads([pin({ instanceId: "peer-a", threadId: "t1", summary })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(3);
  } finally {
    cache.dispose();
    vi.useRealTimers();
  }
});

function pin(params: {
  instanceId: string;
  threadId: string;
  summary?: NavigationThreadSummary;
  instanceLabel?: string;
}): RemoteThreadPin {
  return {
    ref: buildFederatedThreadRef({
      backend: "codex",
      instanceId: params.instanceId,
      threadId: params.threadId,
    }),
    addedAt: 1_000,
    instanceLabel: params.instanceLabel ?? params.instanceId,
    ...(params.summary ? { summary: params.summary } : {}),
  };
}

describe("RemoteThreadSummaryCache — searchForJump", () => {
  it("keeps owner-matched rows whose large matching fields were omitted and compacts older responses", async () => {
    const thread = stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Agent" });
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      searchPeer: async () => [{ ...thread, optimisticUserMessage: { text: "private".repeat(100000) } }],
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });
    const response = await cache.searchForJump({ query: "matches omitted agent instructions", limit: 8 });
    expect(response.results.map((result) => result.id)).toEqual(["t1"]);
    expect(response.results[0].federation?.ref).toEqual(thread.federation?.ref);
    expect(response.results[0]).not.toHaveProperty("optimisticUserMessage");
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(8 * 1024);
  });

  it("asks each peer for bounded matches instead of fetching its full snapshot", async () => {
    const fetchSnapshot = vi.fn(async () => snapshotOf([]));
    const searchPeer = vi.fn(async () => [
      stampedThread({
        instanceId: "peer-a",
        threadId: "t1",
        title: "Matching thread",
      }),
    ]);
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      searchPeer,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const response = await cache.searchForJump({ query: "match", limit: 3 });

    expect(response.results.map((thread) => thread.id)).toEqual(["t1"]);
    expect(searchPeer).toHaveBeenCalledWith(
      remoteTarget("peer-a"),
      { query: "match", limit: 3 },
      { deadlineAt: expect.any(Number) },
    );
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("falls back to a full snapshot when an older peer lacks bounded search", async () => {
    const unavailable = Object.assign(new Error("method not found"), {
      code: "method_not_found",
    });
    const searchPeer = vi.fn(async () => {
      throw unavailable;
    });
    const fetchSnapshot = vi.fn(async () =>
      snapshotOf([
        stampedThread({
          instanceId: "peer-a",
          threadId: "legacy-match",
          title: "Legacy match",
        }),
      ]),
    );
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      searchPeer,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const response = await cache.searchForJump({ query: "match" });

    expect(response.results.map((thread) => thread.id)).toEqual([
      "legacy-match",
    ]);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps an older peer's fallback inside the original peer deadline", async () => {
    vi.useFakeTimers();
    const unavailable = Object.assign(new Error("method not found"), {
      code: "method_not_found",
    });
    const searchPeer = vi.fn(() =>
      new Promise<NavigationThreadSummary[]>((_, reject) => {
        setTimeout(() => reject(unavailable), 80);
      }),
    );
    const fetchSnapshot = vi.fn(() => new Promise<NavigationSnapshot>(() => {}));
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      searchPeer,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
      peerTimeoutMs: 100,
    });

    try {
      const pending = cache.searchForJump({ query: "match" });
      const searchCall = searchPeer.mock.calls[0] as unknown as [
        unknown,
        unknown,
        { deadlineAt: number },
      ];
      const deadlineAt = searchCall[2].deadlineAt;
      await vi.advanceTimersByTimeAsync(80);
      expect(fetchSnapshot).toHaveBeenCalledWith(
        remoteTarget("peer-a"),
        { kind: "all" },
        { deadlineAt },
      );

      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toEqual({ results: [] });
    } finally {
      cache.dispose();
      vi.useRealTimers();
    }
  });

  it("matches remote threads by PR number, title, and branch with local parity", async () => {
    const threads = [
      stampedThread({
        instanceId: "peer-a",
        threadId: "t1",
        title: "Fix messaging retries",
        updatedAt: 10,
        prNumber: 981,
      }),
      stampedThread({
        instanceId: "peer-a",
        threadId: "t2",
        title: "Unrelated",
        updatedAt: 20,
      }),
    ];
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf(threads),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const byPr = await cache.searchForJump({ query: "#981" });
    expect(byPr.results.map((thread) => thread.id)).toEqual(["t1"]);

    const byTitle = await cache.searchForJump({ query: "messaging" });
    expect(byTitle.results.map((thread) => thread.id)).toEqual(["t1"]);

    expect((await cache.searchForJump({ query: "zzz" })).results).toEqual([]);
    expect((await cache.searchForJump({ query: "  " })).results).toEqual([]);
  });

  it("orders results by recency and respects the limit", async () => {
    const threads = [
      stampedThread({ instanceId: "peer-a", threadId: "old", title: "match", updatedAt: 1 }),
      stampedThread({ instanceId: "peer-a", threadId: "new", title: "match", updatedAt: 9 }),
    ];
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf(threads),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const response = await cache.searchForJump({ query: "match", limit: 1 });
    expect(response.results.map((thread) => thread.id)).toEqual(["new"]);
  });

  it("publishes a fast peer before a slow peer settles", async () => {
    let resolveSlow:
      | ((threads: NavigationThreadSummary[]) => void)
      | undefined;
    const searchPeer = vi.fn(async (target: FederationRemoteTarget) => {
      if (target.instanceId === "peer-slow") {
        return await new Promise<NavigationThreadSummary[]>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return [
        stampedThread({
          instanceId: "peer-fast",
          threadId: "fast",
          title: "match fast",
          updatedAt: 1,
        }),
      ];
    });
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-slow"), peer("peer-fast")],
      fetchSnapshot: async () => snapshotOf([]),
      searchPeer,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });
    const onProgress = vi.fn();

    const pending = cache.searchForJump(
      { query: "match" },
      onProgress,
    );

    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(1));
    expect(onProgress).toHaveBeenLastCalledWith({
      results: [expect.objectContaining({ id: "fast" })],
      completedPeerCount: 1,
      totalPeerCount: 2,
      complete: false,
    });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSlow?.([
      stampedThread({
        instanceId: "peer-slow",
        threadId: "slow",
        title: "match slow",
        updatedAt: 2,
      }),
    ]);
    await expect(pending).resolves.toMatchObject({
      results: [{ id: "slow" }, { id: "fast" }],
    });
    expect(onProgress).toHaveBeenLastCalledWith({
      results: [
        expect.objectContaining({ id: "slow" }),
        expect.objectContaining({ id: "fast" }),
      ],
      completedPeerCount: 2,
      totalPeerCount: 2,
      complete: true,
    });
  });

  it("keeps successful peer results when another peer fails", async () => {
    let rejectFailed: ((error: Error) => void) | undefined;
    const searchPeer = vi.fn(async (target: FederationRemoteTarget) => {
      if (target.instanceId === "peer-error") {
        return await new Promise<NavigationThreadSummary[]>((_, reject) => {
          rejectFailed = reject;
        });
      }
      return [
        stampedThread({
          instanceId: "peer-fast",
          threadId: "fast",
          title: "match fast",
        }),
      ];
    });
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-error"), peer("peer-fast")],
      fetchSnapshot: async () => snapshotOf([]),
      searchPeer,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });
    const onProgress = vi.fn();
    const pending = cache.searchForJump({ query: "match" }, onProgress);

    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(1));
    rejectFailed?.(new Error("peer unavailable"));

    await expect(pending).resolves.toMatchObject({
      results: [{ id: "fast" }],
    });
    expect(onProgress).toHaveBeenLastCalledWith({
      results: [expect.objectContaining({ id: "fast" })],
      completedPeerCount: 2,
      totalPeerCount: 2,
      complete: true,
    });
  });

  it("deduplicates globally before applying the result limit", async () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      searchPeer: async () => [
        stampedThread({
          instanceId: "peer-a",
          threadId: "duplicate",
          title: "match old",
          updatedAt: 1,
        }),
        stampedThread({
          instanceId: "peer-a",
          threadId: "duplicate",
          title: "match new",
          updatedAt: 2,
        }),
        stampedThread({
          instanceId: "peer-a",
          threadId: "unique",
          title: "match unique",
          updatedAt: 0,
        }),
      ],
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const response = await cache.searchForJump({ query: "match", limit: 2 });

    expect(response.results.map((thread) => thread.id)).toEqual([
      "duplicate",
      "unique",
    ]);
    expect(response.results[0].title).toBe("match new");
  });

  it("ranks an exact attached PR ahead of newer substring matches", async () => {
    const threads = [
      stampedThread({
        instanceId: "peer-a",
        threadId: "stacked",
        title: "Stacked PRs",
        updatedAt: 1,
        prNumbers: [44, 45, 46, 48, 49],
      }),
      ...Array.from({ length: 8 }, (_, index) =>
        stampedThread({
          instanceId: "peer-a",
          threadId: `substring-${index}`,
          title: `Substring ${index}`,
          updatedAt: 100 + index,
          prNumber: 149 + index * 100,
        }),
      ),
    ];
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf(threads),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const response = await cache.searchForJump({ query: "49", limit: 8 });
    expect(response.results[0].id).toBe("stacked");
  });

  it("caches snapshots within the TTL and refetches after it", async () => {
    let now = 0;
    const fetchSnapshot = vi.fn(async () =>
      snapshotOf([
        stampedThread({ instanceId: "peer-a", threadId: "t1", title: "match" }),
      ]),
    );
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
      ttlMs: 100,
      now: () => now,
    });

    await cache.searchForJump({ query: "match" });
    await cache.searchForJump({ query: "match" });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    now = 200;
    await cache.searchForJump({ query: "match" });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refetches immediately after the peer cache is invalidated", async () => {
    const fetchSnapshot = vi.fn(async () => snapshotOf([]));
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    await cache.searchForJump({ query: "49" });
    cache.invalidate("peer-a");
    await cache.searchForJump({ query: "49" });

    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not restore a stale snapshot invalidated during its fetch", async () => {
    let resolveFirst!: (snapshot: NavigationSnapshot) => void;
    let resolveSecond!: (snapshot: NavigationSnapshot) => void;
    const fetchSnapshot = vi.fn(() =>
      new Promise<NavigationSnapshot>((resolve) => {
        if (fetchSnapshot.mock.calls.length === 1) {
          resolveFirst = resolve;
        } else {
          resolveSecond = resolve;
        }
      }),
    );
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const staleSearch = cache.searchForJump({ query: "49" });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    cache.invalidate("peer-a");
    const freshSearch = cache.searchForJump({ query: "49" });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    const freshThread = stampedThread({
      instanceId: "peer-a",
      threadId: "stacked",
      title: "Stacked PRs",
      prNumbers: [44, 49],
    });
    resolveSecond(snapshotOf([freshThread]));
    await expect(freshSearch).resolves.toMatchObject({
      results: [{ id: "stacked" }],
    });
    resolveFirst(snapshotOf([]));
    await expect(staleSearch).resolves.toMatchObject({
      results: [{ id: "stacked" }],
    });

    await expect(cache.searchForJump({ query: "49" })).resolves.toMatchObject({
      results: [{ id: "stacked" }],
    });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps navigation event interest alive for the cache TTL", async () => {
    vi.useFakeTimers();
    const onPeerInterestChanged = vi.fn();
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
      onPeerInterestChanged,
      ttlMs: 100,
    });

    try {
      await cache.searchForJump({ query: "49" });
      expect(onPeerInterestChanged).toHaveBeenCalledTimes(1);
      expect(onPeerInterestChanged).toHaveBeenLastCalledWith([{
        instanceId: "peer-a",
        threadSelection: { kind: "all" },
      }]);

      await vi.advanceTimersByTimeAsync(50);
      await cache.searchForJump({ query: "49" });
      await vi.advanceTimersByTimeAsync(99);
      expect(onPeerInterestChanged).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(onPeerInterestChanged).toHaveBeenLastCalledWith([]);
    } finally {
      cache.dispose();
      vi.useRealTimers();
    }
  });

  it("skips peers that time out instead of failing the search", async () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-slow"), peer("peer-fast")],
      fetchSnapshot: async (target) => {
        if (target.instanceId === "peer-slow") {
          return await new Promise<never>(() => {});
        }
        return snapshotOf([
          stampedThread({ instanceId: "peer-fast", threadId: "t1", title: "match" }),
        ]);
      },
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
      peerTimeoutMs: 20,
    });
    const onProgress = vi.fn();

    const response = await cache.searchForJump({ query: "match" }, onProgress);
    expect(response.results.map((thread) => thread.id)).toEqual(["t1"]);
    expect(onProgress).toHaveBeenLastCalledWith({
      results: [expect.objectContaining({ id: "t1" })],
      completedPeerCount: 2,
      totalPeerCount: 2,
      complete: true,
    });
  });

  it("ignores peers without the thread_navigation capability", async () => {
    const fetchSnapshot = vi.fn(async () => snapshotOf([]));
    const cache = new RemoteThreadSummaryCache({
      peers: () => [
        {
          target: remoteTarget("peer-a"),
          label: "peer-a",
          capabilities: ["federated_search"],
        },
      ],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    await cache.searchForJump({ query: "match" });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
});

describe("RemoteThreadSummaryCache — threadFromPeer", () => {
  it("returns the matching thread from a connected peer's snapshot", async () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () =>
        snapshotOf([
          stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Parent" }),
        ]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const found = await cache.threadFromPeer({
      target: remoteTarget("peer-a"),
      backend: "codex",
      threadId: "t1",
    });
    expect(found?.title).toBe("Parent");

    const missing = await cache.threadFromPeer({
      target: remoteTarget("peer-a"),
      backend: "codex",
      threadId: "archived",
    });
    expect(missing).toBeUndefined();
  });

  it("returns undefined for a peer that is not connected", async () => {
    const fetchSnapshot = vi.fn(async () => snapshotOf([]));
    const cache = new RemoteThreadSummaryCache({
      peers: () => [],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const found = await cache.threadFromPeer({
      target: remoteTarget("peer-a"),
      backend: "codex",
      threadId: "t1",
    });
    expect(found).toBeUndefined();
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
});

describe("RemoteThreadSummaryCache — remembered thread names", () => {
  const nameOnPeer = (
    cache: RemoteThreadSummaryCache,
    instanceId: string,
    threadId: string,
  ) =>
    cache.cachedThreadNameFromPeer({
      target: remoteTarget(instanceId),
      backend: "codex",
      threadId,
    })?.title;
  const nameOf = (cache: RemoteThreadSummaryCache, threadId: string) =>
    nameOnPeer(cache, "peer-a", threadId);

  it("answers from remembered names without ever contacting the peer", async () => {
    const fetchSnapshot = vi.fn(async () =>
      snapshotOf([
        stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Parent" }),
      ]),
    );
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    // Cold: nothing seen yet, and asking must not go fetch it.
    expect(nameOf(cache, "t1")).toBeUndefined();
    expect(fetchSnapshot).not.toHaveBeenCalled();

    await cache.searchForJump({ query: "Parent" });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    expect(nameOf(cache, "t1")).toBe("Parent");
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  // A federation window reads its navigation straight from the runtime and
  // never populates the snapshot cache above. Without this, a peer's thread
  // open in that window has no name here at all.
  it("remembers names handed in from outside this cache", () => {
    const fetchSnapshot = vi.fn(async () => snapshotOf([]));
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    cache.rememberThreadNames("peer-a", [
      stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Parent" }),
    ], cache.reserveThreadNameObservation());

    expect(nameOf(cache, "t1")).toBe("Parent");
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  // Snapshots are backend- and filter-scoped, so a narrower one must not
  // erase what a wider one already taught us.
  it("merges rather than replacing, and ignores fallback titles", () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    cache.rememberThreadNames("peer-a", [
      stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Parent" }),
      stampedThread({ instanceId: "peer-a", threadId: "t2", title: "Sibling" }),
    ], cache.reserveThreadNameObservation());
    cache.rememberThreadNames("peer-a", [
      stampedThread({ instanceId: "peer-a", threadId: "t3", title: "Cousin" }),
      // A fallback title IS the thread id; recording it would overwrite a
      // real name with nothing.
      {
        ...stampedThread({ instanceId: "peer-a", threadId: "t1", title: "t1" }),
        titleSource: "fallback",
      },
    ], cache.reserveThreadNameObservation());

    expect(nameOf(cache, "t1")).toBe("Parent");
    expect(nameOf(cache, "t2")).toBe("Sibling");
    expect(nameOf(cache, "t3")).toBe("Cousin");
  });

  // A name one navigation refresh out of date still beats the raw thread id,
  // and every alternative costs the round trip this tier avoids.
  it("survives TTL lapse and invalidate", async () => {
    let now = 1_000;
    const fetchSnapshot = vi.fn(async () =>
      snapshotOf([
        stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Parent" }),
      ]),
    );
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
      ttlMs: 10,
      now: () => now,
    });

    await cache.searchForJump({ query: "Parent" });
    now += 10_000;
    cache.invalidate("peer-a");
    cache.invalidate();

    expect(nameOf(cache, "t1")).toBe("Parent");
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  // Two navigation refreshes for one peer can be in flight at once and can
  // finish out of order. The sequence each one records at is taken before its
  // fetch starts, so the loser is decided by when the read began rather than
  // by which reply happened to arrive last.
  it("does not let a slow earlier snapshot revert a newer name", () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    // Both refreshes start; the first one is the slower of the two.
    const slower = cache.reserveThreadNameObservation();
    const faster = cache.reserveThreadNameObservation();

    cache.rememberThreadNames(
      "peer-a",
      [stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Renamed" })],
      faster,
    );
    cache.rememberThreadNames(
      "peer-a",
      [stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Parent" })],
      slower,
    );

    expect(nameOf(cache, "t1")).toBe("Renamed");
  });

  // A rename recorded after both are in hand still wins: ordering is by
  // observation sequence, not by a rule that the first writer keeps the field.
  it("takes a rename that comes after the reverting snapshot", () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    cache.rememberThreadNames("peer-a", [
      stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Parent" }),
    ], cache.reserveThreadNameObservation());
    cache.rememberThreadNames("peer-a", [
      stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Renamed" }),
    ], cache.reserveThreadNameObservation());

    expect(nameOf(cache, "t1")).toBe("Renamed");
  });

  // Thread ids are only unique within the instance that minted them. Two peers
  // reusing one id must never answer for each other.
  it("keeps identically-numbered threads on different peers apart", () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a"), peer("peer-b")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    cache.rememberThreadNames("peer-a", [
      stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Alpha" }),
    ], cache.reserveThreadNameObservation());
    cache.rememberThreadNames("peer-b", [
      stampedThread({ instanceId: "peer-b", threadId: "t1", title: "Beta" }),
    ], cache.reserveThreadNameObservation());

    expect(nameOnPeer(cache, "peer-a", "t1")).toBe("Alpha");
    expect(nameOnPeer(cache, "peer-b", "t1")).toBe("Beta");

    // And a peer that never saw the thread has no opinion about it.
    expect(nameOnPeer(cache, "peer-b", "t2")).toBeUndefined();
  });

  // titleSource is a compile-time contract over another instance's JSON. An
  // older peer sends a real title without one, and a name still beats a uuid.
  it("keeps a peer title that arrived without a titleSource", () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const row = stampedThread({
      instanceId: "peer-a",
      threadId: "t1",
      title: "Design review",
    });
    delete (row as { titleSource?: unknown }).titleSource;
    cache.rememberThreadNames(
      "peer-a",
      [row],
      cache.reserveThreadNameObservation(),
    );

    expect(nameOf(cache, "t1")).toBe("Design review");
  });

  it("drops only the unmounted peer's names", () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a"), peer("peer-b")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    cache.rememberThreadNames("peer-a", [
      stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Alpha" }),
    ], cache.reserveThreadNameObservation());
    cache.rememberThreadNames("peer-b", [
      stampedThread({ instanceId: "peer-b", threadId: "t1", title: "Beta" }),
    ], cache.reserveThreadNameObservation());

    cache.forgetInstanceThreadNames("peer-a");

    expect(nameOnPeer(cache, "peer-a", "t1")).toBeUndefined();
    expect(nameOnPeer(cache, "peer-b", "t1")).toBe("Beta");
  });
});

/** Let a kicked-off background refresh chain settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RemoteThreadSummaryCache — resolvePinnedThreads", () => {
  it("fetches all threads so pinned mounted descendants survive a cold cache", async () => {
    const fetchSnapshot = vi.fn(async (
      _target: FederationRemoteTarget,
      selection: FederationThreadSelection,
    ) => snapshotOf(selection.kind === "all" ? [
      stampedThread({ instanceId: "peer-a", threadId: "t1", title: "t1" }),
      stampedThread({ instanceId: "peer-a", threadId: "t2", title: "t2" }),
    ] : []));
    const onPeerInterestChanged = vi.fn();
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
      onPeerInterestChanged,
    });

    await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t2" }),
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);

    expect(fetchSnapshot).toHaveBeenCalledWith(
      remoteTarget("peer-a"),
      { kind: "all" },
    );
    expect(onPeerInterestChanged).toHaveBeenLastCalledWith([{
      instanceId: "peer-a",
      threadSelection: { kind: "all" },
    }]);
  });

  it("serves cached stamped rows for reachable owners and queues payload refreshes", async () => {
    const fresh = stampedThread({
      instanceId: "peer-a",
      threadId: "t1",
      title: "Fresh title",
      updatedAt: 50,
    });
    const onPinnedSummariesRefreshed = vi.fn();
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a", "Laptop")],
      fetchSnapshot: async () => snapshotOf([fresh]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected", label: "Laptop" }),
      onPinnedSummariesRefreshed,
    });

    // Cold cache: the pin's persisted payload serves immediately while the
    // snapshot fetch runs in the background.
    const cold = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(cold.threads).toHaveLength(1);
    expect(cold.threads[0].title).toBe("t1");
    expect(cold.refreshed).toEqual([]);

    await settle();
    expect(onPinnedSummariesRefreshed).toHaveBeenCalledWith("peer-a");

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(resolved.threads).toHaveLength(1);
    expect(resolved.threads[0].title).toBe("Fresh title");
    expect(resolved.refreshed).toHaveLength(1);
    expect(resolved.refreshed[0].summary.title).toBe("Fresh title");
  });

  it.each([false, true])("carries a transitive remote child with its mounted parent (owner selection: %s)", async (ownerSelection) => {
    const parent = stampedThread({
      instanceId: "peer-a",
      threadId: "parent",
      title: "Parent",
    });
    const child = stampedThread({
      instanceId: "peer-b",
      threadId: "child",
      title: "Child",
    });
    child.parentThreadId = "parent";
    child.parentThreadBackend = "codex";
    child.parentThreadInstanceId = "peer-a";
    const fetchSnapshot = vi.fn(async (_target: FederationRemoteTarget, selection: FederationThreadSelection) => snapshotOf(
      selection.kind === "all" ? [parent, child] : [parent],
    ));
    const fetchPinnedSnapshot = vi.fn(async () => snapshotOf([parent, child]));
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      ...(ownerSelection ? { fetchPinnedSnapshot } : {}),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
    });
    const pins = [pin({ instanceId: "peer-a", threadId: "parent" })];

    await cache.resolvePinnedThreads(pins);
    await settle();
    const resolved = await cache.resolvePinnedThreads(pins);

    expect(resolved.threads.map((thread) => thread.id)).toEqual([
      "parent",
      "child",
    ]);
    expect(resolved.threads[1].federation?.ref.target).toEqual({
      scope: "remote",
      instanceId: "peer-b",
    });
    expect(
      resolved.threads[1].federation?.derivedFromMountedParent,
    ).toBe(true);
    if (ownerSelection) {
      expect(fetchSnapshot).not.toHaveBeenCalled();
      expect(fetchPinnedSnapshot).toHaveBeenCalledWith(
        { scope: "remote", instanceId: "peer-a" },
        [buildThreadIdentityKey("codex", "parent")],
        { deadlineAt: expect.any(Number) },
        expect.any(Map),
      );
    }
  });

  it("does not carry ordinary same-instance siblings with a mounted parent", async () => {
    const parent = stampedThread({
      instanceId: "peer-a",
      threadId: "parent",
      title: "Parent",
    });
    const localChild = stampedThread({
      instanceId: "peer-a",
      threadId: "local-child",
      title: "Local child",
    });
    localChild.parentThreadId = "parent";
    localChild.parentThreadBackend = "codex";
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([parent, localChild]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
    });
    const pins = [pin({ instanceId: "peer-a", threadId: "parent" })];

    await cache.resolvePinnedThreads(pins);
    await settle();
    const resolved = await cache.resolvePinnedThreads(pins);

    expect(resolved.threads.map((thread) => thread.id)).toEqual(["parent"]);
  });

  it("deduplicates a transitive child that is also directly pinned", async () => {
    const parent = stampedThread({
      instanceId: "peer-a",
      threadId: "parent",
      title: "Parent",
    });
    const child = stampedThread({
      instanceId: "peer-b",
      threadId: "child",
      title: "Child",
    });
    child.parentThreadId = "parent";
    child.parentThreadBackend = "codex";
    child.parentThreadInstanceId = "peer-a";
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a"), peer("peer-b")],
      fetchSnapshot: async (target) =>
        target.instanceId === "peer-a"
          ? snapshotOf([parent, child])
          : snapshotOf([child]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
    });
    const pins = [
      pin({ instanceId: "peer-a", threadId: "parent" }),
      pin({ instanceId: "peer-b", threadId: "child" }),
    ];

    await cache.resolvePinnedThreads(pins);
    await settle();
    const resolved = await cache.resolvePinnedThreads(pins);

    expect(resolved.threads.map((thread) => thread.id)).toEqual([
      "parent",
      "child",
    ]);
    expect(
      resolved.threads[1].federation?.derivedFromMountedParent,
    ).toBeUndefined();
  });

  it("returns promptly with cached rows while a peer fetch hangs", async () => {
    let now = 0;
    let hang = false;
    const fetchSnapshot = vi.fn(async () => {
      if (hang) {
        return await new Promise<never>(() => {});
      }
      return snapshotOf([
        stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Cached" }),
      ]);
    });
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot,
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
      ttlMs: 100,
      peerTimeoutMs: 10_000,
      now: () => now,
    });

    await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    await settle();

    // TTL expired and the peer stops answering: the resolve must still
    // return immediately with the stale cached rows — a slow peer can
    // never stall the navigation snapshot.
    now = 500;
    hang = true;
    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(resolved.threads[0].title).toBe("Cached");
    expect(resolved.threads[0].federation?.peerStatus).toBe("connected");
  });

  it("falls back to the cached payload, dimmed, when the owner is unreachable", async () => {
    const cached = stampedThread({
      instanceId: "peer-a",
      threadId: "t1",
      title: "Cached title",
    });
    delete cached.federation;
    const cache = new RemoteThreadSummaryCache({
      peers: () => [],
      fetchSnapshot: async () => {
        throw new Error("unreachable");
      },
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "disconnected", label: "Laptop" }),
    });

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1", summary: cached }),
    ]);
    expect(resolved.threads).toHaveLength(1);
    expect(resolved.threads[0].title).toBe("Cached title");
    expect(resolved.threads[0].federation?.peerStatus).toBe("disconnected");
    expect(resolved.threads[0].federation?.instanceLabel).toBe("Laptop");
    expect(resolved.refreshed).toEqual([]);
  });

  it("dims rows as degraded once a connected owner fails the background fetch", async () => {
    const onPinnedSummariesRefreshed = vi.fn();
    const onPinnedRefreshProblem = vi.fn();
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => {
        throw new Error("boom");
      },
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
      onPinnedSummariesRefreshed,
      onPinnedRefreshProblem,
    });

    // First resolve is optimistic — the failure lands in the background
    // and pokes the callback so the next merge can dim the rows.
    await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    await settle();
    expect(onPinnedSummariesRefreshed).toHaveBeenCalledTimes(1);
    expect(onPinnedRefreshProblem).toHaveBeenCalledExactlyOnceWith({ instanceId: "peer-a", requestedCount: 1,
      threadKeys: ["codex:t1"], error: "boom" });

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(resolved.threads[0].federation?.peerStatus).toBe("degraded");

    // A repeat failure stays silent — re-firing would loop the renderer
    // refresh cycle against a peer that keeps failing.
    await settle();
    expect(onPinnedSummariesRefreshed).toHaveBeenCalledTimes(1);
    expect(onPinnedRefreshProblem).toHaveBeenCalledExactlyOnceWith({ instanceId: "peer-a", requestedCount: 1,
      threadKeys: ["codex:t1"], error: "boom" });
  });

  it("announces recovery so dimmed rows can un-dim", async () => {
    let fail = true;
    const onPinnedSummariesRefreshed = vi.fn();
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => {
        if (fail) {
          throw new Error("boom");
        }
        return snapshotOf([
          stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Live" }),
        ]);
      },
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
      onPinnedSummariesRefreshed,
    });
    const pins = [pin({ instanceId: "peer-a", threadId: "t1" })];

    await cache.resolvePinnedThreads(pins);
    await settle();
    expect(onPinnedSummariesRefreshed).toHaveBeenCalledTimes(1);

    fail = false;
    await cache.resolvePinnedThreads(pins);
    await settle();
    expect(onPinnedSummariesRefreshed).toHaveBeenCalledTimes(2);

    const resolved = await cache.resolvePinnedThreads(pins);
    expect(resolved.threads[0].title).toBe("Live");
    expect(resolved.threads[0].federation?.peerStatus).toBe("connected");
  });

  it("un-dims when a jump-search fetch proves the peer is alive", async () => {
    let now = 0;
    let fail = true;
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => {
        if (fail) {
          throw new Error("boom");
        }
        return snapshotOf([
          stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Live" }),
        ]);
      },
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
      ttlMs: 100,
      now: () => now,
    });
    const pins = [pin({ instanceId: "peer-a", threadId: "t1" })];

    await cache.resolvePinnedThreads(pins);
    await settle();

    // The peer recovers, and it is the JUMP SEARCH that observes it — the
    // pinned-refresh path never runs. The failure flag must still clear,
    // or live rows would render dimmed until the next TTL lapse.
    now = 50;
    fail = false;
    await cache.searchForJump({ query: "Live" });
    await settle();

    const resolved = await cache.resolvePinnedThreads(pins);
    expect(resolved.threads[0].title).toBe("Live");
    expect(resolved.threads[0].federation?.peerStatus).toBe("connected");
    expect(resolved.refreshed).toHaveLength(1);
  });

  it("serves stale cached rows dimmed while a connected owner keeps failing", async () => {
    let now = 0;
    let fail = false;
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => {
        if (fail) {
          throw new Error("boom");
        }
        return snapshotOf([
          stampedThread({ instanceId: "peer-a", threadId: "t1", title: "Cached" }),
        ]);
      },
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
      ttlMs: 100,
      now: () => now,
    });

    await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    await settle();

    now = 500;
    fail = true;
    await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    await settle();

    // Stale snapshot data still beats the pin payload, but must dim: the
    // peer claims connected and is not actually serving.
    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(resolved.threads[0].title).toBe("Cached");
    expect(resolved.threads[0].federation?.peerStatus).toBe("degraded");
    expect(resolved.refreshed).toEqual([]);
  });

  it("stamps the peer's viewer-actionable capabilities onto fallback rows", async () => {
    // Capabilities belong to the PEER, not the cached row, so a row served
    // before any snapshot has landed must still carry them — otherwise the
    // thread view reports "remote terminal not granted" for a peer that
    // grants it, on every cold start. The owner supplies the already
    // relay-stripped set; the cache must not invent one.
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => await new Promise<never>(() => {}),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({
        status: "connected",
        label: "Laptop",
        capabilities: ["thread_navigation", "remote_pty"],
      }),
    });

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(resolved.threads[0].federation?.capabilities).toEqual([
      "thread_navigation",
      "remote_pty",
    ]);
  });

  it("stamps no capabilities when the owner reports none", async () => {
    // An unknown or never-seen peer reports nothing. The cache passes the
    // owner's answer through rather than inventing a set of its own — it
    // has no way to know what the peer granted.
    const cache = new RemoteThreadSummaryCache({
      peers: () => [],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "disconnected", label: "Laptop" }),
    });

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(resolved.threads[0].federation?.capabilities).toEqual([]);
  });

  it("synthesizes a minimal row when the pin has no cached summary", async () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({}),
    });

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1", instanceLabel: "Laptop" }),
    ]);
    expect(resolved.threads[0].id).toBe("t1");
    expect(resolved.threads[0].federation?.peerStatus).toBe("disconnected");
    expect(resolved.threads[0].federation?.instanceLabel).toBe("Laptop");
  });

  it("falls back for a pinned thread missing from a reachable owner's snapshot", async () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
    });

    const cached = stampedThread({
      instanceId: "peer-a",
      threadId: "gone",
      title: "Archived on owner",
    });
    delete cached.federation;
    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "gone", summary: cached }),
    ]);
    expect(resolved.threads[0].title).toBe("Archived on owner");
    expect(resolved.threads[0].federation?.peerStatus).toBe("connected");
    expect(resolved.refreshed).toEqual([]);
    expect(resolved.archived).toEqual([]);
  });

  it("omits pins proven to be archived on a reachable owner", async () => {
    const fetchArchivedThreads = vi.fn(async () => [
      stampedThread({
        instanceId: "peer-a",
        threadId: "archived",
        title: "Archived on owner",
      }),
    ]);
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
    });
    const archivedPin = pin({ instanceId: "peer-a", threadId: "archived" });

    // Proving a pin archived needs a fresh snapshot AND an owner lookup,
    // both of which run in the background so the merge never stalls. The
    // first resolve therefore still serves the cached row; the proof is
    // reported on the next one, which the refresh event triggers.
    const optimistic = await cache.resolvePinnedThreads([archivedPin]);
    expect(optimistic.archived).toEqual([]);
    await settle();

    expect(fetchArchivedThreads).toHaveBeenCalledWith(
      remoteTarget("peer-a"),
      "codex",
      [archivedPin.ref.threadId],
      { deadlineAt: expect.any(Number) },
    );

    const resolved = await cache.resolvePinnedThreads([archivedPin]);
    expect(resolved.threads).toEqual([]);
    expect(resolved.refreshed).toEqual([]);
    expect(resolved.archived).toEqual([archivedPin.ref]);
  });

  it("does not treat an unqueried pin as covered by a cached negative archive lookup", async () => {
    let now = 0;
    const second = stampedThread({
      instanceId: "peer-a", threadId: "second", title: "Archived second pin",
    });
    const fetchArchivedThreads = vi.fn()
      .mockImplementationOnce(async () => {
        now = 50;
        return [];
      })
      .mockResolvedValueOnce([second]);
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
      now: () => now,
      ttlMs: 100,
    });
    await cache.resolvePinnedThreads([pin({ instanceId: "peer-a", threadId: "first" })]);
    await settle();
    // Navigation expired, but the slower first archive probe is still fresh.
    now = 110;
    const secondPin = pin({ instanceId: "peer-a", threadId: "second" });
    await cache.resolvePinnedThreads([secondPin]);
    await settle();
    expect(fetchArchivedThreads).toHaveBeenCalledTimes(2);
    expect((await cache.resolvePinnedThreads([secondPin])).archived).toEqual([secondPin.ref]);
  });

  it("revalidates cached archive evidence before pruning a re-added pin", async () => {
    const archivedThread = stampedThread({
      instanceId: "peer-a",
      threadId: "restored",
      title: "Restored on owner",
    });
    const fetchArchivedThreads = vi
      .fn()
      .mockResolvedValueOnce([archivedThread])
      .mockResolvedValueOnce([]);
    let now = 0;
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
      ttlMs: 100,
      now: () => now,
    });
    const firstPin = pin({ instanceId: "peer-a", threadId: "restored" });

    await cache.resolvePinnedThreads([firstPin]);
    await settle();
    expect((await cache.resolvePinnedThreads([firstPin])).archived).toEqual([
      firstPin.ref,
    ]);

    // The owner restored the thread and the viewer re-pinned it. The spent
    // proof must never prune it a second time — only fresh evidence can,
    // and this pass proves it is no longer archived.
    const cachedSummary = { ...archivedThread };
    delete cachedSummary.federation;
    const readdedPin = {
      ...pin({
        instanceId: "peer-a",
        threadId: "restored",
        summary: cachedSummary,
      }),
      addedAt: 2_000,
    };
    now = 500;
    await cache.resolvePinnedThreads([readdedPin]);
    await settle();
    const resolved = await cache.resolvePinnedThreads([readdedPin]);

    expect(fetchArchivedThreads).toHaveBeenCalledTimes(2);
    expect(resolved.archived).toEqual([]);
    expect(resolved.threads).toHaveLength(1);
    expect(resolved.threads[0].title).toBe("Restored on owner");
  });

  it("never waits on the archived lookup, even when it hangs", async () => {
    // The archived probe used to share the merge's peer deadline, which
    // meant a slow owner delayed navigation. It now runs in the same
    // background pass as the snapshot fetch, so a probe that never answers
    // costs the merge nothing — the pin simply keeps its cached row.
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: async () => await new Promise<never>(() => {}),
      peerStatus: () => ({ status: "connected" }),
      peerTimeoutMs: 100,
    });
    const missingPin = pin({ instanceId: "peer-a", threadId: "missing" });

    const resolved = await cache.resolvePinnedThreads([missingPin]);
    expect(resolved.archived).toEqual([]);
    expect(resolved.threads).toHaveLength(1);

    await settle();
    const again = await cache.resolvePinnedThreads([missingPin]);
    expect(again.archived).toEqual([]);
    expect(again.threads).toHaveLength(1);
  });

  it("keeps the cached row when archive detection fails", async () => {
    const cached = stampedThread({
      instanceId: "peer-a",
      threadId: "missing",
      title: "Cached title",
    });
    delete cached.federation;
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads: async () => {
        throw new Error("archive lookup failed");
      },
      peerStatus: () => ({ status: "connected" }),
    });

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "missing", summary: cached }),
    ]);

    expect(resolved.threads).toHaveLength(1);
    expect(resolved.threads[0].title).toBe("Cached title");
    expect(resolved.archived).toEqual([]);
  });
});

it("reports bounded missing mount identities without repeating an unchanged absence", async () => {
  const onPinnedRefreshProblem = vi.fn();
  const cache = new RemoteThreadSummaryCache({ peers: () => [peer("peer-a")], fetchSnapshot: async () => snapshotOf([]),
    fetchArchivedThreads: noArchivedThreads, peerStatus: () => ({ status: "connected" }), onPinnedRefreshProblem });
  const pins = Array.from({ length: 12 }, (_, i) => pin({ instanceId: "peer-a", threadId: `missing-${i}` }));
  try {
    await cache.resolvePinnedThreads(pins);
    await settle();
    expect(onPinnedRefreshProblem).toHaveBeenCalledExactlyOnceWith({ instanceId: "peer-a", requestedCount: 12,
      missingCount: 12, threadKeys: pins.map((item) => `codex:${item.ref.threadId}`).sort().slice(0, 10) });
    cache.invalidate("peer-a");
    await settle();
    expect(onPinnedRefreshProblem).toHaveBeenCalledTimes(1);
  } finally {
    cache.dispose();
  }
});


it("reuses subscribed pin owners after the TTL and revalidates only the invalidated owner", async () => {
  let now = 1;
  const subscribed = new Set(["peer-a", "peer-b"]);
  const pins = ["peer-a", "peer-b"].map((instanceId) => pin({ instanceId, threadId: "mounted",
    summary: stampedThread({ instanceId, threadId: "mounted", title: instanceId }) }));
  const fetchPinnedSnapshot = vi.fn(async (target: { instanceId: string }) => snapshotOf([
    stampedThread({ instanceId: target.instanceId, threadId: "mounted", title: `${target.instanceId}:${now}` }),
  ]));
  const cache = new RemoteThreadSummaryCache({
    peers: () => [peer("peer-a"), peer("peer-b")], fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads: noArchivedThreads, peerStatus: () => ({ status: "connected" }), now: () => now, ttlMs: 100,
    hasNavigationSubscription: (instanceId) => subscribed.has(instanceId),
  });
  try {
    await cache.resolvePinnedThreads(pins);
    await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(2);
    fetchPinnedSnapshot.mockClear();
    for (let i = 0; i < 5; i++) {
      now += 1000;
      await cache.resolvePinnedThreads(pins);
      await settle();
    }
    expect(fetchPinnedSnapshot).not.toHaveBeenCalled();
    cache.invalidate("peer-a");
    await settle();
    expect(fetchPinnedSnapshot.mock.calls.map(([target]) => target.instanceId)).toEqual(["peer-a"]);
    const resolved = await cache.resolvePinnedThreads(pins);
    expect(resolved.threads.find((thread) => thread.federation?.ref.target.scope === "remote"
      && thread.federation.ref.target.instanceId === "peer-a")?.title).toBe(`peer-a:${now}`);
    // Losing subscription coverage restores TTL for that owner alone.
    subscribed.delete("peer-a");
    now += 1000;
    fetchPinnedSnapshot.mockClear();
    await cache.resolvePinnedThreads(pins);
    await settle();
    expect(fetchPinnedSnapshot.mock.calls.map(([target]) => target.instanceId)).toEqual(["peer-a"]);
    // No owner invalidation arrives during a gap without mounted subscriptions.
    await cache.resolvePinnedThreads([]);
    now += 1000;
    fetchPinnedSnapshot.mockClear();
    await cache.resolvePinnedThreads(pins);
    await settle();
    expect(fetchPinnedSnapshot.mock.calls.map(([target]) => target.instanceId).sort()).toEqual(["peer-a", "peer-b"]);
  } finally {
    cache.dispose();
  }
});

it("revalidates mounted pin summaries after TTL when navigation is not subscribed", async () => {
  let now = 1;
  const mounted = pin({ instanceId: "peer-a", threadId: "mounted" });
  const fetchPinnedSnapshot = vi.fn(async () => snapshotOf([
    stampedThread({ instanceId: "peer-a", threadId: "mounted", title: `Updated:${now}` }),
  ]));
  const cache = new RemoteThreadSummaryCache({
    peers: () => [peer("peer-a")], fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads: noArchivedThreads, peerStatus: () => ({ status: "connected" }),
    now: () => now, ttlMs: 100,
  });
  try {
    await cache.resolvePinnedThreads([mounted]);
    await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(1);
    now += 101;
    await cache.resolvePinnedThreads([mounted]);
    await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(2);
    expect((await cache.resolvePinnedThreads([mounted])).threads[0]?.title).toBe(`Updated:${now}`);
  } finally {
    cache.dispose();
  }
});

it("ignores unrelated same-owner row changes but discovers new group members", async () => {
  const root = stampedThread({ instanceId: "peer-a", threadId: "root", title: "Root" });
  const child = { ...stampedThread({ instanceId: "peer-a", threadId: "child", title: "Child" }), parentThreadId: "root" };
  let rows = [root, child];
  const fetchPinnedSnapshot = vi.fn(async () => snapshotOf(rows));
  const onPeerInterestChanged = vi.fn();
  const cache = new RemoteThreadSummaryCache({ peers: () => [{ ...peer("peer-a"), capabilities: ["thread_navigation", "navigation_group_invalidations"] }], fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads: noArchivedThreads, peerStatus: () => ({ status: "connected" }),
    hasNavigationSubscription: () => true, onPeerInterestChanged });
  const event = (threadId: string, sourceMethod = "thread/status/changed") => ({ backend: "codex" as const,
    notification: { method: "navigation/invalidated" as const, params: { threadId, sourceMethod } } });
  try {
    await cache.resolvePinnedThreads([pin({ instanceId: "peer-a", threadId: "root", summary: root })]);
    await settle();
    fetchPinnedSnapshot.mockClear();
    for (let i = 0; i < 27; i++) { cache.invalidate("peer-a", event("unrelated")); await settle(); }
    expect(fetchPinnedSnapshot).not.toHaveBeenCalled();
    expect(onPeerInterestChanged).toHaveBeenLastCalledWith([{ instanceId: "peer-a", threadSelection: {
      kind: "threads", threads: [{ backend: "codex", threadId: "child" }, { backend: "codex", threadId: "root" }],
    } }]);
    rows = [...rows, { ...stampedThread({ instanceId: "peer-a", threadId: "grandchild", title: "Grandchild" }), parentThreadId: "child" }];
    cache.invalidate("peer-a", event("grandchild", "thread/parent/set"));
    await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(2);
    expect(onPeerInterestChanged).toHaveBeenLastCalledWith([{ instanceId: "peer-a", threadSelection: {
      kind: "threads", threads: expect.arrayContaining([{ backend: "codex", threadId: "grandchild" }]),
    } }]);
    cache.invalidate("peer-a", event("child"));
    await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(3);
  } finally { cache.dispose(); }
});

it("coalesces invalidations during a pinned read into one non-overlapping follow-up", async () => {
  const root = stampedThread({ instanceId: "peer-a", threadId: "root", title: "Root" });
  const reads: Array<(value: NavigationSnapshot) => void> = [];
  const fetchPinnedSnapshot = vi.fn(() => new Promise<NavigationSnapshot>((resolve) => reads.push(resolve)));
  const refreshed = vi.fn();
  const cache = new RemoteThreadSummaryCache({ peers: () => [peer("peer-a")], fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads: noArchivedThreads, peerStatus: () => ({ status: "connected" }), onPinnedSummariesRefreshed: refreshed });
  try {
    await cache.resolvePinnedThreads([pin({ instanceId: "peer-a", threadId: "root", summary: root })]);
    for (let i = 0; i < 27; i++) cache.invalidate("peer-a");
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(1);
    reads[0]!(snapshotOf([{ ...root, title: "Stale" }]));
    await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(2);
    expect(refreshed).not.toHaveBeenCalled();
    reads[1]!(snapshotOf([{ ...root, title: "Fresh" }]));
    await settle();
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect((await cache.resolvePinnedThreads([pin({ instanceId: "peer-a", threadId: "root" })])).threads[0]?.title).toBe("Fresh");
  } finally { cache.dispose(); }
});

it.each(["initial", "updated"])("publishes %s rows after invalidation overlaps archive verification", async (phase) => {
  const root = stampedThread({ instanceId: "peer", threadId: "root", title: "Before" });
  let rows = [root];
  const fetchPinnedSnapshot = vi.fn(async () => snapshotOf(rows));
  const archiveReads: Array<(threads: NavigationThreadSummary[]) => void> = [];
  const fetchArchivedThreads = vi.fn(() => new Promise<NavigationThreadSummary[]>((resolve) => archiveReads.push(resolve)));
  const refreshed = vi.fn();
  const cache = new RemoteThreadSummaryCache({ peers: () => [peer("peer")], fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads, peerStatus: () => ({ status: "connected" }), hasNavigationSubscription: () => true,
    onPinnedSummariesRefreshed: refreshed });
  const pins = [pin({ instanceId: "peer", threadId: "root" }), pin({ instanceId: "peer", threadId: "missing" })];
  try {
    if (phase === "updated") {
      await cache.resolvePinnedThreads(pins);
      await settle();
      archiveReads.shift()!([]);
      for (let i = 0; i < 3; i++) await settle();
      expect(refreshed).toHaveBeenCalledTimes(1);
      refreshed.mockClear();
      fetchPinnedSnapshot.mockClear();
    }
    rows = [{ ...root, title: "After" }];
    if (phase === "initial") await cache.resolvePinnedThreads(pins);
    else cache.invalidate("peer");
    await settle();
    expect(archiveReads).toHaveLength(1);
    // The rows have been committed, but their publication awaits archive
    // verification. Fence that proof and return the same rows on the retry.
    cache.invalidate("peer");
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(1);
    archiveReads.shift()!([]);
    for (let i = 0; i < 3; i++) await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(2);
    expect(archiveReads).toHaveLength(1);
    expect(refreshed).not.toHaveBeenCalled();
    archiveReads.shift()!([]);
    for (let i = 0; i < 3; i++) await settle();
    expect(refreshed).toHaveBeenCalledTimes(1);
    const resolved = await cache.resolvePinnedThreads(pins);
    expect(resolved.threads.find((thread) => thread.id === "root")?.title).toBe("After");
    expect(resolved.archived).toEqual([]);

    // Once published, another unchanged refresh must stay silent.
    cache.invalidate("peer");
    await settle();
    archiveReads.shift()!([]);
    for (let i = 0; i < 3; i++) await settle();
    expect(refreshed).toHaveBeenCalledTimes(1);
  } finally { cache.dispose(); }
});

it("releases removed groups from same-owner navigation demand", async () => {
  const roots = ["a", "b"].map((threadId) => stampedThread({ instanceId: "peer", threadId, title: threadId }));
  const fetchPinnedSnapshot = vi.fn(async (_target: FederationRemoteTarget, keys: string[]) => snapshotOf([
    ...roots.filter((root) => keys.includes(`codex:${root.id}`)),
    ...(keys.includes("codex:b") ? [{ ...stampedThread({ instanceId: "peer", threadId: "b-child", title: "Child" }), parentThreadId: "b" }] : []),
  ]));
  const onPeerInterestChanged = vi.fn();
  const cache = new RemoteThreadSummaryCache({ peers: () => [{ ...peer("peer"), capabilities: ["thread_navigation", "navigation_group_invalidations"] }],
    fetchSnapshot: vi.fn(), fetchPinnedSnapshot, fetchArchivedThreads: noArchivedThreads,
    peerStatus: () => ({ status: "connected" }), hasNavigationSubscription: () => true, onPeerInterestChanged });
  try {
    await cache.resolvePinnedThreads(roots.map((root) => pin({ instanceId: "peer", threadId: root.id })));
    await settle();
    await cache.resolvePinnedThreads([pin({ instanceId: "peer", threadId: "a" })]);
    await settle();
    expect(onPeerInterestChanged).toHaveBeenLastCalledWith([{ instanceId: "peer", threadSelection: {
      kind: "threads", threads: [{ backend: "codex", threadId: "a" }],
    } }]);
    fetchPinnedSnapshot.mockClear();
    cache.invalidate("peer", { backend: "codex", notification: { method: "navigation/invalidated", params: {
      sourceMethod: "thread/status/changed", threadId: "b-child",
    } } });
    await settle();
    expect(fetchPinnedSnapshot).not.toHaveBeenCalled();
  } finally { cache.dispose(); }
});

it("does not follow an invalidated pinned read after its mount is removed", async () => {
  let resolve!: (snapshot: NavigationSnapshot) => void;
  const fetchPinnedSnapshot = vi.fn(() => new Promise<NavigationSnapshot>((done) => { resolve = done; }));
  const refreshed = vi.fn();
  const cache = new RemoteThreadSummaryCache({ peers: () => [peer("peer")], fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads: noArchivedThreads, peerStatus: () => ({ status: "connected" }), onPinnedSummariesRefreshed: refreshed });
  try {
    await cache.resolvePinnedThreads([pin({ instanceId: "peer", threadId: "root" })]);
    cache.invalidate("peer");
    await cache.resolvePinnedThreads([]);
    resolve(snapshotOf([]));
    await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(1);
    expect(refreshed).not.toHaveBeenCalled();
  } finally { cache.dispose(); }
});

it("retains broad discovery until the cold pinned closure is current", async () => {
  const root = stampedThread({ instanceId: "peer", threadId: "root", title: "Root" });
  const child = { ...stampedThread({ instanceId: "peer", threadId: "child", title: "Child" }), parentThreadId: "root" };
  const reads: Array<(snapshot: NavigationSnapshot) => void> = [];
  const fetchPinnedSnapshot = vi.fn(() => new Promise<NavigationSnapshot>((resolve) => reads.push(resolve)));
  const onPeerInterestChanged = vi.fn();
  const cache = new RemoteThreadSummaryCache({ peers: () => [{ ...peer("peer"), capabilities: ["thread_navigation", "navigation_group_invalidations"] }],
    fetchSnapshot: vi.fn(), fetchPinnedSnapshot, fetchArchivedThreads: noArchivedThreads,
    peerStatus: () => ({ status: "connected" }), onPeerInterestChanged });
  try {
    await cache.resolvePinnedThreads([pin({ instanceId: "peer", threadId: "root", summary: root })]);
    expect(onPeerInterestChanged).toHaveBeenLastCalledWith([{ instanceId: "peer", threadSelection: { kind: "all" } }]);
    // This child already exists, but its identity has not arrived in the first
    // page yet. Its row update must fence that page instead of being ignored.
    cache.invalidate("peer", { backend: "codex", notification: { method: "navigation/invalidated", params: {
      sourceMethod: "thread/name/updated", threadId: "child",
    } } });
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(1);
    reads[0]!(snapshotOf([root, child]));
    await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(2);
    expect(onPeerInterestChanged).toHaveBeenLastCalledWith([{ instanceId: "peer", threadSelection: { kind: "all" } }]);
    reads[1]!(snapshotOf([root, { ...child, title: "Updated" }]));
    await settle();
    expect(onPeerInterestChanged).toHaveBeenLastCalledWith([{ instanceId: "peer", threadSelection: {
      kind: "threads", threads: [{ backend: "codex", threadId: "child" }, { backend: "codex", threadId: "root" }],
    } }]);
  } finally { cache.dispose(); }
});

it("revalidates a discovered child after expanding its subscription", async () => {
  const root = stampedThread({ instanceId: "peer", threadId: "root", title: "Root" });
  const child = { ...stampedThread({ instanceId: "peer", threadId: "child", title: "Before subscription" }), parentThreadId: "root" };
  let rows = [root];
  const fetchPinnedSnapshot = vi.fn(async () => snapshotOf(rows));
  const published: Array<string | undefined> = [];
  const cache = new RemoteThreadSummaryCache({ peers: () => [{ ...peer("peer"), capabilities: ["thread_navigation", "navigation_group_invalidations"] }],
    fetchSnapshot: vi.fn(), fetchPinnedSnapshot, fetchArchivedThreads: noArchivedThreads,
    peerStatus: () => ({ status: "connected" }), hasNavigationSubscription: () => true,
    onPeerInterestChanged: (interests) => {
      if (interests.some((interest) => interest.threadSelection.kind === "threads"
        && interest.threadSelection.threads.some((ref) => ref.threadId === "child"))) {
        // The owner changed this newly discovered row before receiving the
        // expanded subscription; no live notification reached this viewer.
        rows = [root, { ...child, title: "After subscription" }];
      }
    },
    onPinnedSummariesRefreshed: () => published.push(cache.cachedThreadNameFromPeer({
      target: { scope: "remote", instanceId: "peer" }, backend: "codex", threadId: "child",
    })?.title),
  });
  try {
    await cache.resolvePinnedThreads([pin({ instanceId: "peer", threadId: "root", summary: root })]);
    await settle();
    published.length = 0;
    rows = [root, child];
    cache.invalidate("peer", { backend: "codex", notification: { method: "navigation/invalidated", params: {
      sourceMethod: "thread/parent/set", threadId: "child",
    } } });
    for (let i = 0; i < 3; i++) await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(3);
    expect(published).toEqual(["After subscription"]);
  } finally { cache.dispose(); }
});

it("scopes subagent metadata and worktree invalidations to mounted rows", async () => {
  const root = { ...stampedThread({ instanceId: "peer", threadId: "root", title: "Root" }), projectKey: "/mounted" };
  const fetchPinnedSnapshot = vi.fn(async () => snapshotOf([root]));
  const cache = new RemoteThreadSummaryCache({ peers: () => [peer("peer")], fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads: noArchivedThreads, peerStatus: () => ({ status: "connected" }), hasNavigationSubscription: () => true });
  try {
    await cache.resolvePinnedThreads([pin({ instanceId: "peer", threadId: "root" })]);
    await settle();
    fetchPinnedSnapshot.mockClear();
    for (let i = 0; i < 27; i++) {
      cache.invalidate("peer", { backend: "codex", notification: { method: "navigation/invalidated", params: {
        sourceMethod: "thread/subAgents/updated", threadId: "unrelated",
      } } });
      cache.invalidate("peer", { backend: "codex", notification: { method: "navigation/invalidated", params: {
        sourceMethod: "navigation/threadGitWorkingState/updated", worktreePath: "/other",
      } } });
    }
    await settle();
    cache.invalidate("peer", { backend: "codex", notification: { method: "navigation/invalidated", params: {
      sourceMethod: "navigation/directoryGitStatus/updated", directoryKey: "directory:/mounted",
    } } });
    await settle();
    expect(fetchPinnedSnapshot).not.toHaveBeenCalled();
    cache.invalidate("peer", { backend: "codex", notification: { method: "navigation/invalidated", params: {
      sourceMethod: "navigation/threadGitWorkingState/updated", worktreePath: "/mounted",
    } } });
    await settle();
    expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(1);
  } finally { cache.dispose(); }
});

it("retains pins through repeated incomplete coverage and publishes recovery once", async () => {
  const root = stampedThread({ instanceId: "peer", threadId: "root", title: "Last known" });
  let incomplete = false;
  const fetchPinnedSnapshot = vi.fn(async () => {
    if (incomplete) throw new Error("Pinned navigation owner coverage is checking (pending providers: unknown, failed providers: unknown).");
    return snapshotOf([root]);
  });
  const problem = vi.fn();
  const refreshed = vi.fn();
  const cache = new RemoteThreadSummaryCache({ peers: () => [peer("peer")], fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads: noArchivedThreads, peerStatus: () => ({ status: "connected" }), hasNavigationSubscription: () => true,
    onPinnedRefreshProblem: problem, onPinnedSummariesRefreshed: refreshed });
  const pins = [pin({ instanceId: "peer", threadId: "root", summary: root })];
  try {
    await cache.resolvePinnedThreads(pins);
    await settle();
    incomplete = true;
    for (let i = 0; i < 3; i++) { cache.invalidate("peer"); for (let j = 0; j < 3; j++) await settle(); }
    expect(problem).toHaveBeenCalledTimes(1);
    const retained = await cache.resolvePinnedThreads(pins);
    expect(retained.threads[0]?.title).toBe("Last known");
    expect(retained.archived).toEqual([]);
    for (let i = 0; i < 3; i++) await settle();
    refreshed.mockClear();
    incomplete = false;
    cache.invalidate("peer");
    for (let i = 0; i < 3; i++) await settle();
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(problem).toHaveBeenCalledTimes(1);
  } finally { cache.dispose(); }
});
