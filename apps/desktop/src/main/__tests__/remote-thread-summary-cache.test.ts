import { describe, expect, it, vi } from "vitest";
import {
  buildFederatedThreadRef,
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

    const response = await cache.searchForJump({ query: "match" });
    expect(response.results.map((thread) => thread.id)).toEqual(["t1"]);
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
  const nameOf = (cache: RemoteThreadSummaryCache, threadId: string) =>
    cache.cachedThreadNameFromPeer({
      target: remoteTarget("peer-a"),
      backend: "codex",
      threadId,
    })?.title;

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
    ]);

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
    ]);
    cache.rememberThreadNames("peer-a", [
      stampedThread({ instanceId: "peer-a", threadId: "t3", title: "Cousin" }),
      // A fallback title IS the thread id; recording it would overwrite a
      // real name with nothing.
      {
        ...stampedThread({ instanceId: "peer-a", threadId: "t1", title: "t1" }),
        titleSource: "fallback",
      },
    ]);

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

  it("carries a transitive remote child with its mounted parent", async () => {
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
      peers: () => [peer("peer-a")],
      fetchSnapshot: async (_target, selection) => snapshotOf(
        selection.kind === "all" ? [parent, child] : [parent],
      ),
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
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => {
        throw new Error("boom");
      },
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
      onPinnedSummariesRefreshed,
    });

    // First resolve is optimistic — the failure lands in the background
    // and pokes the callback so the next merge can dim the rows.
    await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    await settle();
    expect(onPinnedSummariesRefreshed).toHaveBeenCalledTimes(1);

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(resolved.threads[0].federation?.peerStatus).toBe("degraded");

    // A repeat failure stays silent — re-firing would loop the renderer
    // refresh cycle against a peer that keeps failing.
    await settle();
    expect(onPinnedSummariesRefreshed).toHaveBeenCalledTimes(1);
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
    );

    const resolved = await cache.resolvePinnedThreads([archivedPin]);
    expect(resolved.threads).toEqual([]);
    expect(resolved.refreshed).toEqual([]);
    expect(resolved.archived).toEqual([archivedPin.ref]);
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
