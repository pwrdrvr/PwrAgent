import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  FederationPeerSummary,
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useStarMapThreads } from "../useStarMapThreads";

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
  } as FederationPeerSummary;
}

function buildDesktopApi(): DesktopApi {
  return {
    getNavigationSnapshot: vi.fn(async (request) => ({
      fetchedAt: 123,
      threads: [
        {
          id: `thread-${
            (request as { federationTarget?: { instanceId?: string } })
              ?.federationTarget?.instanceId ?? "local"
          }`,
        } as unknown as NavigationThreadSummary,
      ],
    })) as unknown as DesktopApi["getNavigationSnapshot"],
  };
}

describe("useStarMapThreads", () => {
  it("keeps a disconnected peer's cards, marked stale, instead of blanking", async () => {
    const desktopApi = buildDesktopApi();
    const { result, rerender } = renderHook(
      ({ peers }: { peers: FederationPeerSummary[] }) =>
        useStarMapThreads({ desktopApi, peers, enabled: true }),
      { initialProps: { peers: [peer("pwr_a", "connected")] } },
    );

    await waitFor(() => {
      expect(result.current.threadsByInstance.get("pwr_a")).toHaveLength(1);
    });

    // The federation reconnect backoff tops out at 30s, so a flapping peer
    // hits this path repeatedly; the lane must not blink out.
    rerender({ peers: [peer("pwr_a", "disconnected")] });
    expect(result.current.threadsByInstance.get("pwr_a")).toHaveLength(1);
    expect(result.current.staleInstanceIds.has("pwr_a")).toBe(true);

    rerender({ peers: [peer("pwr_a", "connected")] });
    await waitFor(() => {
      expect(result.current.staleInstanceIds.has("pwr_a")).toBe(false);
    });
    expect(result.current.threadsByInstance.get("pwr_a")).toHaveLength(1);
  });

  it("drops cards only when the peer leaves the directory", async () => {
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
    expect(result.current.snapshotFetchedAtByInstance.get("pwr_a")).toBe(123);
    expect(result.current.snapshotFetchedAtByInstance.has("pwr_b")).toBe(false);
  });

  it("retains cards when a refresh fails and marks the instance unreachable", async () => {
    let failing = false;
    const desktopApi: DesktopApi = {
      getNavigationSnapshot: vi.fn(async () => {
        if (failing) throw new Error("peer unreachable");
        return {
          threads: [{ id: "thread-1" } as unknown as NavigationThreadSummary],
        };
      }) as unknown as DesktopApi["getNavigationSnapshot"],
    };
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

  it("resolves a manual refresh only after the peer snapshot is applied", async () => {
    let resolveRefresh: ((snapshot: NavigationSnapshot) => void) | undefined;
    const pendingRefresh = new Promise<NavigationSnapshot>((resolve) => {
      resolveRefresh = resolve;
    });
    const getNavigationSnapshot = vi
      .fn<NonNullable<DesktopApi["getNavigationSnapshot"]>>()
      .mockResolvedValueOnce({
        threads: [
          { id: "thread-before" } as unknown as NavigationThreadSummary,
        ],
      } as NavigationSnapshot)
      .mockImplementationOnce(async () => await pendingRefresh);
    const desktopApi = { getNavigationSnapshot } as DesktopApi;
    const { result } = renderHook(() =>
      useStarMapThreads({
        desktopApi,
        peers: [peer("pwr_a", "connected")],
        enabled: true,
      }),
    );

    await waitFor(() => {
      expect(
        result.current.threadsByInstance.get("pwr_a")?.[0]?.id,
      ).toBe("thread-before");
    });

    let settled = false;
    const refresh = result.current.refreshInstance("pwr_a").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await act(async () => {
      resolveRefresh?.({
        threads: [
          { id: "thread-after" } as unknown as NavigationThreadSummary,
        ],
      } as NavigationSnapshot);
      await refresh;
    });

    expect(settled).toBe(true);
    expect(result.current.threadsByInstance.get("pwr_a")?.[0]?.id).toBe(
      "thread-after",
    );
  });
});
