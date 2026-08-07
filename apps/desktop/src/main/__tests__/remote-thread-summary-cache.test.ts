import { describe, expect, it, vi } from "vitest";
import {
  buildFederatedThreadRef,
  type FederationRemoteTarget,
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
}): NavigationThreadSummary {
  return {
    source: "codex",
    id: params.threadId,
    title: params.title,
    titleSource: "derived",
    linkedDirectories: [],
    inbox: { inInbox: false },
    updatedAt: params.updatedAt,
    ...(params.prNumber !== undefined
      ? {
          prs: [
            {
              provider: "github.com",
              number: params.prNumber,
              org: "pwrdrvr",
              repo: "PwrAgent",
              state: "pending",
              url: `https://github.com/pwrdrvr/PwrAgent/pull/${params.prNumber}`,
            },
          ],
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

describe("RemoteThreadSummaryCache — resolvePinnedThreads", () => {
  it("serves fresh stamped rows for reachable owners and queues payload refreshes", async () => {
    const fresh = stampedThread({
      instanceId: "peer-a",
      threadId: "t1",
      title: "Fresh title",
      updatedAt: 50,
    });
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a", "Laptop")],
      fetchSnapshot: async () => snapshotOf([fresh]),
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected", label: "Laptop" }),
    });

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(resolved.threads).toHaveLength(1);
    expect(resolved.threads[0].title).toBe("Fresh title");
    expect(resolved.refreshed).toHaveLength(1);
    expect(resolved.refreshed[0].summary.title).toBe("Fresh title");
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

  it("dims rows as degraded when a connected owner fails the fetch", async () => {
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => {
        throw new Error("boom");
      },
      fetchArchivedThreads: noArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
    });

    const resolved = await cache.resolvePinnedThreads([
      pin({ instanceId: "peer-a", threadId: "t1" }),
    ]);
    expect(resolved.threads[0].federation?.peerStatus).toBe("degraded");
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

    const resolved = await cache.resolvePinnedThreads([archivedPin]);

    expect(fetchArchivedThreads).toHaveBeenCalledWith(
      remoteTarget("peer-a"),
      "codex",
    );
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
    const cache = new RemoteThreadSummaryCache({
      peers: () => [peer("peer-a")],
      fetchSnapshot: async () => snapshotOf([]),
      fetchArchivedThreads,
      peerStatus: () => ({ status: "connected" }),
    });
    const firstPin = pin({ instanceId: "peer-a", threadId: "restored" });
    expect((await cache.resolvePinnedThreads([firstPin])).archived).toEqual([
      firstPin.ref,
    ]);

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
    const resolved = await cache.resolvePinnedThreads([readdedPin]);

    expect(fetchArchivedThreads).toHaveBeenCalledTimes(2);
    expect(resolved.archived).toEqual([]);
    expect(resolved.threads).toHaveLength(1);
    expect(resolved.threads[0].title).toBe("Restored on owner");
  });

  it("shares one peer deadline between the active and archived lookups", async () => {
    vi.useFakeTimers();
    try {
      const cache = new RemoteThreadSummaryCache({
        peers: () => [peer("peer-a")],
        fetchSnapshot: async () => {
          await new Promise((resolve) => setTimeout(resolve, 75));
          return snapshotOf([]);
        },
        fetchArchivedThreads: async () => await new Promise<never>(() => {}),
        peerStatus: () => ({ status: "connected" }),
        peerTimeoutMs: 100,
      });
      const resolution = cache.resolvePinnedThreads([
        pin({ instanceId: "peer-a", threadId: "missing" }),
      ]);
      let settled = false;
      void resolution.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const resolved = await resolution;
      expect(resolved.archived).toEqual([]);
      expect(resolved.threads).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
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
