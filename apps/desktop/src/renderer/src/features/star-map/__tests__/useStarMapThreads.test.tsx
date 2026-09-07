import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  countNavigationStarMapFacets,
  type FederationPeerSummary,
  type NavigationQueryPage,
  type NavigationQueryRequest,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useStarMapThreads } from "../useStarMapThreads";
import { navigationAttentionRowsBudget, NAVIGATION_METADATA_MAX_RETAINED_BYTES } from "../../../lib/navigation-metadata-budget";

function peer(
  id: string,
  status: FederationPeerSummary["status"],
): FederationPeerSummary {
  return {
    id,
    label: id,
    role: "client",
    status,
    capabilities: ["thread_navigation"],
    navigationQueryProtocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
  } as FederationPeerSummary;
}

function queryPage(params: {
  instanceId: string;
  threadId?: string;
  nextCursor?: string;
}): NavigationQueryPage {
  return {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    queryKey: "attention",
    generation: `generation-${params.instanceId}`,
    ownerEpoch: `epoch-${params.instanceId}`,
    countsRevision: `revision-${params.instanceId}`,
    coverage: { state: "complete" },
    counts: { total: 12, active: 1, unread: 2, review: 1 },
    entries: params.threadId
      ? [{
          row: {
            ref: {
              backend: "codex",
              threadId: params.threadId,
              ownerInstanceId: params.instanceId,
            },
            rowRevision: `row-${params.threadId}`,
            id: params.threadId,
            source: "codex",
            title: params.threadId,
            titleSource: "fallback",
            linkedDirectories: [],
            inbox: { inInbox: true },
            ordinaryChildCount: 0,
            nativeSubAgentGroupPresent: false,
            queueCount: 0,
            queueState: "unknown",
          },
          orderKey: "0000000000",
          placement: { kind: "root" },
        }]
      : [],
    nextCursor: params.nextCursor,
    complete: params.nextCursor === undefined,
  };
}

function buildDesktopApi(): DesktopApi {
  return {
    getNavigationQueryPage: vi.fn(async (request: NavigationQueryRequest) => {
      const instanceId = request.federationTarget?.scope === "remote"
        ? request.federationTarget.instanceId
        : "local";
      return queryPage({
        instanceId,
        threadId: request.query.kind === "lens"
          ? `thread-${instanceId}`
          : undefined,
      });
    }),
  };
}

describe("useStarMapThreads", () => {
  it("coalesces load-more and rebaselines an expired IPC cursor around the visible anchor", async () => {
    const read = vi.fn(async (request: NavigationQueryRequest) => {
      if (request.query.kind !== "lens") return queryPage({ instanceId: "a" });
      if (request.cursor) throw new Error("Error invoking remote method: [navigation_cursor_expired] Navigation cursor expired");
      if (request.anchor) return { ...queryPage({ instanceId: "a", threadId: "anchor" }), generation: "replacement", rangeStart: 10 };
      return queryPage({ instanceId: "a", threadId: "anchor", nextCursor: "expired" });
    });
    const desktopApi: DesktopApi = { getNavigationQueryPage: read };
    const hook = renderHook(() => useStarMapThreads({ enabled: true, peers: [peer("a", "connected")], desktopApi }));
    try {
      await waitFor(() => expect(hook.result.current.threadsByInstance.get("a")?.[0]?.id).toBe("anchor"));
      await act(async () => {
        await Promise.all([hook.result.current.loadMoreInstance("a"), hook.result.current.loadMoreInstance("a")]);
      });
      const continuation = read.mock.calls.map(([request]) => request).filter((request) => request.cursor || request.anchor);
      expect(continuation).toHaveLength(2);
      expect(continuation[1]).toMatchObject({ cursor: undefined, deadlineAt: continuation[0]!.deadlineAt,
        anchor: { kind: "thread", ref: { backend: "codex", threadId: "anchor", ownerInstanceId: "a" } } });
      expect(hook.result.current.threadsByInstance.get("a")?.map((thread) => thread.id)).toEqual(["anchor"]);
      await act(async () => { await hook.result.current.refreshInstance("a"); });
      expect(read.mock.calls.map(([request]) => request).filter((request) => request.query.kind === "lens").at(-1)?.completeBaselineRevision)
        .toBeUndefined();
    } finally { hook.unmount(); }
  });

  it("bounds retained rows across peer clouds and preserves the prior page when admission fails", async () => {
    const desktopApi: DesktopApi = { getNavigationQueryPage: vi.fn(async (request) => request.query.kind !== "lens"
      ? queryPage({ instanceId: "a" })
      : queryPage({ instanceId: "a", threadId: request.cursor ? "next" : "first", nextCursor: request.cursor ? undefined : "next" })) };
    const hook = renderHook(() => useStarMapThreads({ enabled: true, peers: [peer("a", "connected")], desktopApi }));
    try {
      await waitFor(() => expect(hook.result.current.threadsByInstance.get("a")?.[0]?.id).toBe("first"));
      expect(hook.result.current.hasMoreInstanceIds.has("a")).toBe(true);
      const other = navigationAttentionRowsBudget.begin("another-cloud");
      other.reserve(NAVIGATION_METADATA_MAX_RETAINED_BYTES - navigationAttentionRowsBudget.usage().retainedBytes);
      other.commit();
      await act(async () => { await expect(hook.result.current.loadMoreInstance("a")).rejects.toThrow("retained byte budget"); });
      expect(hook.result.current.threadsByInstance.get("a")?.map((thread) => thread.id)).toEqual(["first"]);
      expect(navigationAttentionRowsBudget.usage().transientBytes).toBe(0);
      navigationAttentionRowsBudget.release("another-cloud");
      await act(async () => { await hook.result.current.loadMoreInstance("a"); });
      expect(hook.result.current.threadsByInstance.get("a")?.map((thread) => thread.id)).toEqual(["first", "next"]);
      expect(hook.result.current.hasMoreInstanceIds.has("a")).toBe(false);
    } finally { navigationAttentionRowsBudget.release("another-cloud"); hook.unmount(); }
    expect(navigationAttentionRowsBudget.usage()).toEqual({ retainedBytes: 0, transientBytes: 0 });
  });

  it("does not publish authoritative counts from checking owner coverage", async () => {
    let checking = true;
    const desktopApi: DesktopApi = { getNavigationQueryPage: vi.fn(async (request) => ({
      ...queryPage({ instanceId: "a", threadId: request.query.kind === "lens" ? "visible" : undefined }),
      facets: countNavigationStarMapFacets([], {}),
      coverage: request.query.kind === "lens" && checking ? { state: "checking" as const } : { state: "complete" as const },
    })) };
    const hook = renderHook(() => useStarMapThreads({ desktopApi, peers: [peer("a", "connected")], enabled: true }));
    await waitFor(() => expect(hook.result.current.threadsByInstance.get("a")?.[0]?.id).toBe("visible"));
    expect(hook.result.current.queriedInstanceIds.has("a")).toBe(true);
    expect(hook.result.current.countsByInstance.has("a")).toBe(false);
    expect(hook.result.current.facetsByInstance.has("a")).toBe(false);
    checking = false;
    await act(async () => hook.result.current.refreshInstance("a"));
    expect(hook.result.current.countsByInstance.get("a")?.total).toBe(12);
    expect(hook.result.current.facetsByInstance.get("a")?.active).toBe(0);
    hook.unmount();
  });

  it("publishes Attention rows while complete project geometry is still pending", async () => {
    const desktopApi = buildDesktopApi();
    const normal = desktopApi.getNavigationQueryPage!;
    let finish!: (page: NavigationQueryPage) => void;
    const geometry = new Promise<NavigationQueryPage>((resolve) => { finish = resolve; });
    desktopApi.getNavigationQueryPage = vi.fn((request) => request.query.kind === "star-map-geometry" ? geometry : normal(request));
    const hook = renderHook(() => useStarMapThreads({ desktopApi, peers: [peer("a", "connected")], enabled: true }));
    await waitFor(() => expect(hook.result.current.threadsByInstance.get("a")?.[0]?.id).toBe("thread-a"));
    expect(hook.result.current.countsByInstance.get("a")?.total).toBe(12);
    expect(hook.result.current.geometryReadyInstanceIds.has("a")).toBe(false);
    await act(async () => finish(queryPage({ instanceId: "a" })));
    await waitFor(() => expect(hook.result.current.geometryReadyInstanceIds.has("a")).toBe(true));
    hook.unmount();
  });

  it("resolves a restored card independently of pending rows and geometry without inventing counts", async () => {
    let finishRows!: (page: NavigationQueryPage) => void;
    let finishGeometry!: (page: NavigationQueryPage) => void;
    const rows = new Promise<NavigationQueryPage>((resolve) => { finishRows = resolve; });
    const geometry = new Promise<NavigationQueryPage>((resolve) => { finishGeometry = resolve; });
    const desktopApi: DesktopApi = { getNavigationQueryPage: vi.fn((request) => {
      if (request.query.kind === "star-map-geometry") return geometry;
      if (request.query.kind === "exact") return Promise.resolve(queryPage({ instanceId: "a", threadId: "restored" }));
      return rows;
    }) };
    const demand = new Map([["a", [{ backend: "codex" as const, threadId: "restored", ownerInstanceId: "a" }]]]);
    const hook = renderHook(() => useStarMapThreads({ desktopApi, peers: [peer("a", "connected")], enabled: true, demandedIdentitiesByInstance: demand }));
    await waitFor(() => expect(hook.result.current.threadsByInstance.get("a")?.[0]?.id).toBe("restored"));
    expect(hook.result.current.countsByInstance.has("a")).toBe(false);
    expect(hook.result.current.geometryReadyInstanceIds.has("a")).toBe(false);
    await act(async () => { finishRows(queryPage({ instanceId: "a", threadId: "attention" })); finishGeometry(queryPage({ instanceId: "a" })); });
    await waitFor(() => expect(hook.result.current.threadsByInstance.get("a")).toHaveLength(2));
    expect(hook.result.current.countsByInstance.get("a")?.total).toBe(12);
    hook.unmount();
  });

  it("retains ready rows after a geometry failure and clears the geometry error on retry", async () => {
    const desktopApi = buildDesktopApi();
    const normal = desktopApi.getNavigationQueryPage!;
    let failing = true;
    desktopApi.getNavigationQueryPage = vi.fn((request) => request.query.kind === "star-map-geometry" && failing
      ? Promise.reject(new Error("Project geometry exceeds its budget.")) : normal(request));
    const hook = renderHook(() => useStarMapThreads({ desktopApi, peers: [peer("a", "connected")], enabled: true }));
    await waitFor(() => expect(hook.result.current.geometryErrorsByInstance.get("a")).toContain("budget"));
    expect(hook.result.current.threadsByInstance.get("a")?.[0]?.id).toBe("thread-a");
    expect(hook.result.current.unreachableInstanceIds.has("a")).toBe(false);
    failing = false;
    await act(async () => hook.result.current.refreshInstance("a"));
    expect(hook.result.current.geometryErrorsByInstance.has("a")).toBe(false);
    expect(hook.result.current.geometryReadyInstanceIds.has("a")).toBe(true);
    hook.unmount();
  });

  it("keeps another owner's pending card query through a peer reconnect", async () => {
    const desktopApi = buildDesktopApi();
    const normal = desktopApi.getNavigationQueryPage!;
    let finish!: (page: NavigationQueryPage) => void;
    const pending = new Promise<NavigationQueryPage>((resolve) => { finish = resolve; });
    const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>((request) => {
      const owner = request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : "local";
      if (request.query.kind === "exact") return owner === "b" ? pending : Promise.resolve(queryPage({ instanceId: owner, threadId: `card-${owner}` }));
      return normal(request);
    });
    const release = vi.fn(async () => {});
    desktopApi.getNavigationQueryPage = read;
    desktopApi.releaseNavigationQuery = release;
    const demands = new Map(["a", "b"].map((owner) => [owner, [{ backend: "codex" as const, threadId: `card-${owner}`, ownerInstanceId: owner }]]));
    const hook = renderHook(({ peers }) => useStarMapThreads({ desktopApi, peers, enabled: true, demandedIdentitiesByInstance: demands }), {
      initialProps: { peers: [peer("a", "connected"), peer("b", "connected")] },
    });
    const cardReads = () => read.mock.calls.filter(([request]) => request.query.kind === "exact"
      && request.federationTarget?.scope === "remote" && request.federationTarget.instanceId === "b");
    await waitFor(() => expect(cardReads()).toHaveLength(1));
    const consumer = cardReads()[0]![1];
    hook.rerender({ peers: [peer("a", "disconnected"), peer("b", "connected")] });
    hook.rerender({ peers: [peer("a", "connected"), peer("b", "connected")] });
    await waitFor(() => expect(hook.result.current.staleInstanceIds.has("a")).toBe(false));
    expect(cardReads()).toHaveLength(1);
    expect(release).not.toHaveBeenCalledWith(consumer);
    await act(async () => finish(queryPage({ instanceId: "b", threadId: "card-b" })));
    await waitFor(() => expect(hook.result.current.threadsByInstance.get("b")?.some((thread) => thread.id === "card-b")).toBe(true));
    hook.unmount();
  });

  it("reloads only the peer that reconnects and ignores duplicate peer-directory updates", async () => {
    const desktopApi = buildDesktopApi();
    const read = vi.mocked(desktopApi.getNavigationQueryPage!);
    const hook = renderHook(({ peers }) => useStarMapThreads({ desktopApi, peers, enabled: true }), {
      initialProps: { peers: [peer("a", "connected"), peer("b", "connected")] },
    });
    await waitFor(() => expect(hook.result.current.threadsByInstance.size).toBe(2));
    const readsFor = (id: string) => read.mock.calls.filter(([request]) => request.federationTarget?.scope === "remote"
      && request.federationTarget.instanceId === id).length;
    expect(readsFor("a")).toBe(2);
    expect(readsFor("b")).toBe(2);
    hook.rerender({ peers: [peer("a", "disconnected"), peer("b", "connected")] });
    hook.rerender({ peers: [peer("a", "connected"), peer("b", "connected")] });
    await waitFor(() => expect(hook.result.current.staleInstanceIds.has("a")).toBe(false));
    expect(readsFor("a")).toBe(4);
    expect(readsFor("b")).toBe(2);
    hook.rerender({ peers: [peer("a", "connected"), peer("b", "connected")] });
    expect(readsFor("a")).toBe(4);
    expect(readsFor("b")).toBe(2);
    hook.unmount();
  });

  it("rejects a late page from the previous connection without restarting a healthy peer", async () => {
    const desktopApi = buildDesktopApi();
    const normal = desktopApi.getNavigationQueryPage!;
    let finish!: (page: NavigationQueryPage) => void;
    const pending = new Promise<NavigationQueryPage>((resolve) => { finish = resolve; });
    let first = true;
    const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>((request) => {
      if (first && request.query.kind === "lens" && request.federationTarget?.scope === "remote" && request.federationTarget.instanceId === "a") {
        first = false; return pending;
      }
      return normal(request);
    });
    desktopApi.getNavigationQueryPage = read;
    const hook = renderHook(({ peers }) => useStarMapThreads({ desktopApi, peers, enabled: true }), {
      initialProps: { peers: [peer("a", "connected"), peer("b", "connected")] },
    });
    await waitFor(() => expect(hook.result.current.threadsByInstance.has("b")).toBe(true));
    hook.rerender({ peers: [peer("a", "disconnected"), peer("b", "connected")] });
    hook.rerender({ peers: [peer("a", "connected"), peer("b", "connected")] });
    await waitFor(() => expect(hook.result.current.threadsByInstance.get("a")?.[0]?.id).toBe("thread-a"));
    await act(async () => finish(queryPage({ instanceId: "a", threadId: "late" })));
    expect(hook.result.current.threadsByInstance.get("a")?.[0]?.id).toBe("thread-a");
    expect(read.mock.calls.filter(([request]) => request.federationTarget?.scope === "remote" && request.federationTarget.instanceId === "b")).toHaveLength(2);
    hook.unmount();
  });

  it("releases pending row and geometry reads when the map closes", async () => {
    let finish!: (page: NavigationQueryPage) => void;
    const pending = new Promise<NavigationQueryPage>((resolve) => { finish = resolve; });
    const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>().mockReturnValue(pending);
    const release = vi.fn(async () => {});
    const desktopApi: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: release };
    const hook = renderHook(() => useStarMapThreads({ desktopApi, peers: [peer("a", "connected")], enabled: true }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const consumers = read.mock.calls.map(([, consumerId]) => consumerId);
    expect(new Set(consumers).size).toBe(2);
    hook.unmount();
    for (const consumer of consumers) expect(release).toHaveBeenCalledWith(consumer);
    await act(async () => finish(queryPage({ instanceId: "a" })));
  });

  it("releases an exact-card query when the card demand disappears", async () => {
    const desktopApi = buildDesktopApi();
    const readInitial = desktopApi.getNavigationQueryPage!;
    let finish!: (page: NavigationQueryPage) => void;
    const pending = new Promise<NavigationQueryPage>((resolve) => { finish = resolve; });
    const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>((request) => request.query.kind === "exact" ? pending : readInitial(request));
    const release = vi.fn(async () => {});
    desktopApi.getNavigationQueryPage = read;
    desktopApi.releaseNavigationQuery = release;
    const demand = new Map([["a", [{ backend: "codex" as const, threadId: "card", ownerInstanceId: "a" }]]]);
    const empty = new Map();
    const hook = renderHook(({ open }) => useStarMapThreads({ desktopApi, peers: [peer("a", "connected")], enabled: true,
      demandedIdentitiesByInstance: open ? demand : empty,
    }), { initialProps: { open: false } });
    await waitFor(() => expect(hook.result.current.threadsByInstance.has("a")).toBe(true));
    hook.rerender({ open: true });
    await waitFor(() => expect(read.mock.calls.some(([request]) => request.query.kind === "exact")).toBe(true));
    const consumer = read.mock.calls.find(([request]) => request.query.kind === "exact")![1];
    hook.rerender({ open: false });
    expect(release).toHaveBeenCalledWith(consumer);
    await act(async () => finish(queryPage({ instanceId: "a", threadId: "card" })));
    expect(hook.result.current.threadsByInstance.get("a")?.some((thread) => thread.id === "card")).toBe(false);
    hook.unmount();
  });

  it("keeps a disconnected peer's bounded rows, marked stale", async () => {
    const desktopApi = buildDesktopApi();
    const { result, rerender } = renderHook(
      ({ peers }: { peers: FederationPeerSummary[] }) =>
        useStarMapThreads({ desktopApi, peers, enabled: true }),
      { initialProps: { peers: [peer("pwr_a", "connected")] } },
    );

    await waitFor(() => {
      expect(result.current.threadsByInstance.get("pwr_a")).toHaveLength(1);
    });
    expect(result.current.countsByInstance.get("pwr_a")?.total).toBe(12);

    rerender({ peers: [peer("pwr_a", "disconnected")] });
    expect(result.current.threadsByInstance.get("pwr_a")).toHaveLength(1);
    expect(result.current.staleInstanceIds.has("pwr_a")).toBe(true);

    rerender({ peers: [peer("pwr_a", "connected")] });
    await waitFor(() => {
      expect(result.current.staleInstanceIds.has("pwr_a")).toBe(false);
    });
  });

  it("drops rows only when the peer leaves the directory", async () => {
    const desktopApi = buildDesktopApi();
    const { result, rerender } = renderHook(
      ({ peers }: { peers: FederationPeerSummary[] }) =>
        useStarMapThreads({ desktopApi, peers, enabled: true }),
      {
        initialProps: {
          peers: [peer("pwr_a", "connected"), peer("pwr_b", "connected")],
        },
      },
    );

    await waitFor(() => {
      expect(result.current.threadsByInstance.size).toBe(2);
    });

    rerender({ peers: [peer("pwr_a", "connected")] });
    await waitFor(() => {
      expect(result.current.threadsByInstance.has("pwr_b")).toBe(false);
    });
    expect(result.current.threadsByInstance.has("pwr_a")).toBe(true);
  });

  it("retains rows when a bounded refresh fails", async () => {
    let failing = false;
    const desktopApi = buildDesktopApi();
    vi.mocked(desktopApi.getNavigationQueryPage!).mockImplementation(
      async (request) => {
        if (failing) throw new Error("peer unreachable");
        const instanceId = request.federationTarget?.scope === "remote"
          ? request.federationTarget.instanceId
          : "local";
        return queryPage({
          instanceId,
          threadId: request.query.kind === "lens" ? "thread-1" : undefined,
        });
      },
    );
    const { result, rerender } = renderHook(
      ({ nonce }: { nonce: number }) =>
        useStarMapThreads({
          desktopApi,
          peers: [peer("pwr_a", "connected")],
          enabled: true,
          refreshNonce: nonce,
        }),
      { initialProps: { nonce: 0 } },
    );

    await waitFor(() => {
      expect(result.current.threadsByInstance.get("pwr_a")).toHaveLength(1);
    });

    failing = true;
    rerender({ nonce: 1 });
    await waitFor(() => {
      expect(result.current.unreachableInstanceIds.has("pwr_a")).toBe(true);
    });
    expect(result.current.threadsByInstance.get("pwr_a")).toHaveLength(1);
  });

  it("resolves manual refresh only after the bounded page is applied", async () => {
    let resolveRefresh: ((page: NavigationQueryPage) => void) | undefined;
    const pendingRefresh = new Promise<NavigationQueryPage>((resolve) => {
      resolveRefresh = resolve;
    });
    let attentionReads = 0;
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => {
      const instanceId = request.federationTarget?.scope === "remote"
        ? request.federationTarget.instanceId
        : "local";
      if (request.query.kind !== "lens") return queryPage({ instanceId });
      attentionReads += 1;
      return attentionReads === 1
        ? queryPage({ instanceId, threadId: "thread-before" })
        : await pendingRefresh;
    });
    const desktopApi = { getNavigationQueryPage } as DesktopApi;
    const { result } = renderHook(() =>
      useStarMapThreads({
        desktopApi,
        peers: [peer("pwr_a", "connected")],
        enabled: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.threadsByInstance.get("pwr_a")?.[0]?.id).toBe(
        "thread-before",
      );
    });

    let settled = false;
    const refresh = result.current.refreshInstance("pwr_a").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await act(async () => {
      resolveRefresh?.(queryPage({ instanceId: "pwr_a", threadId: "thread-after" }));
      await refresh;
    });

    expect(settled).toBe(true);
    expect(result.current.threadsByInstance.get("pwr_a")?.[0]?.id).toBe(
      "thread-after",
    );
  });

  it("modern_star_map_never_calls_deprecated_navigation_snapshot", async () => {
    const desktopApi = {
      ...buildDesktopApi(),
      getNavigationSnapshot: vi.fn(),
    } as DesktopApi;
    renderHook(() =>
      useStarMapThreads({
        desktopApi,
        peers: [peer("pwr_a", "connected")],
        enabled: true,
      }),
    );

    await waitFor(() => {
      expect(desktopApi.getNavigationQueryPage).toHaveBeenCalled();
    });
    expect(desktopApi.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(vi.mocked(desktopApi.getNavigationQueryPage!)).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 10, protocol: 2 }),
      expect.stringContaining(":remote-query:"),
    );
  });

  it("hidden_consumers_do_not_poll", async () => {
    const desktopApi = buildDesktopApi();
    renderHook(() =>
      useStarMapThreads({
        desktopApi,
        peers: [peer("pwr_a", "connected")],
        enabled: false,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(desktopApi.getNavigationQueryPage).not.toHaveBeenCalled();
  });

  it("does not extend the refresh deadline while waiting for an older owner read", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let finishInitial!: (page: NavigationQueryPage) => void;
    const pending = new Promise<NavigationQueryPage>((resolve) => { finishInitial = resolve; });
    let rowReads = 0;
    const desktopApi: DesktopApi = { getNavigationQueryPage: vi.fn(async (request) => {
      if (request.query.kind !== "lens") return queryPage({ instanceId: "a" });
      rowReads += 1;
      return await pending;
    }) };
    const hook = renderHook(() => useStarMapThreads({ desktopApi, peers: [peer("a", "connected")], enabled: true }));
    try {
      await waitFor(() => expect(rowReads).toBe(1));
      now.mockReturnValue(2_000);
      const refresh = hook.result.current.refreshInstance("a");
      const failed = expect(refresh).rejects.toThrow("deadline");
      now.mockReturnValue(12_001);
      await act(async () => {
        finishInitial(queryPage({ instanceId: "a", threadId: "too-late" }));
        await failed;
      });
      expect(rowReads).toBe(1);
      expect(hook.result.current.countsByInstance.has("a")).toBe(false);
    } finally { hook.unmount(); now.mockRestore(); }
  });

  it("coalesces post-reply refreshes into a fresh read after the pending initial page", async () => {
    let finishInitial!: (page: NavigationQueryPage) => void;
    const pending = new Promise<NavigationQueryPage>((resolve) => { finishInitial = resolve; });
    const deadlines: number[] = [];
    let rowReads = 0;
    const desktopApi: DesktopApi = { getNavigationQueryPage: vi.fn(async (request) => {
      if (request.query.kind !== "lens") return queryPage({ instanceId: "a" });
      deadlines.push(request.deadlineAt!);
      return ++rowReads === 1 ? await pending : queryPage({ instanceId: "a", threadId: "after-reply" });
    }) };
    const hook = renderHook(() => useStarMapThreads({ desktopApi, peers: [peer("a", "connected")], enabled: true }));
    await waitFor(() => expect(rowReads).toBe(1));
    const refreshes = [hook.result.current.refreshInstance("a"), hook.result.current.refreshInstance("a")];
    expect(rowReads).toBe(1);
    await act(async () => {
      finishInitial(queryPage({ instanceId: "a", threadId: "before-reply" }));
      await Promise.all(refreshes);
    });
    expect(rowReads).toBe(2);
    expect(hook.result.current.threadsByInstance.get("a")?.[0]?.id).toBe("after-reply");
    expect(deadlines.every(Number.isFinite)).toBe(true);
    hook.unmount();
  });
});
