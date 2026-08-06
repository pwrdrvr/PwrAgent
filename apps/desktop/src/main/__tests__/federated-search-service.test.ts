import { describe, expect, it, vi } from "vitest";
import type {
  AppServerListThreadsResponse,
  AppServerThreadSummary,
} from "@pwragent/shared";
import { FederatedSearchService } from "../federation/federated-search-service";

function thread(
  id: string,
  title: string,
  updatedAt: number,
): AppServerThreadSummary {
  return {
    id,
    title,
    titleSource: "explicit",
    updatedAt,
    linkedDirectories: [],
    source: "codex",
  };
}

describe("FederatedSearchService", () => {
  it("uses exact resolution for a pasted thread UUID", async () => {
    const threadId = "019fd821-1450-7952-85ca-3bb8e5d150da";
    const localListThreads = vi.fn();
    const remoteListThreads = vi.fn();
    const service = new FederatedSearchService({
      local: {
        listThreads: localListThreads,
        resolveThread: vi.fn(async () => ({})),
      },
      peers: () => [
        {
          instanceId: "pwr_harold",
          label: "Harold-Mac-Mini-M4",
          backend: {
            listThreads: remoteListThreads,
            resolveThread: vi.fn(async () => ({
              thread: thread(
                threadId,
                "Thread list stays disabled after reconnect",
                3_000,
              ),
            })),
          },
        },
      ],
    });

    const response = await service.search({ query: threadId, backend: "codex" });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      ref: {
        backend: "codex",
        target: { scope: "remote", instanceId: "pwr_harold" },
        threadId,
      },
      instanceLabel: "Harold-Mac-Mini-M4",
    });
    expect(localListThreads).not.toHaveBeenCalled();
    expect(remoteListThreads).not.toHaveBeenCalled();
  });

  it("falls back to exact list scanning when a peer lacks resolution RPC", async () => {
    const threadId = "019fd821-1450-7952-85ca-3bb8e5d150da";
    const service = new FederatedSearchService({
      includeLocal: false,
      local: { listThreads: vi.fn() },
      peers: () => [
        {
          instanceId: "pwr_older",
          label: "Older Mac",
          backend: {
            resolveThread: vi.fn(async () => {
              throw new Error("Unsupported federation method");
            }),
            listThreads: vi.fn(async () => ({
              backend: "codex" as const,
              fetchedAt: 1_000,
              threads: [thread(threadId, "Reconnect fix", 3_000)],
            })),
          },
        },
      ],
    });

    await expect(
      service.search({ query: threadId, backend: "codex" }),
    ).resolves.toMatchObject({
      results: [
        {
          ref: {
            target: { scope: "remote", instanceId: "pwr_older" },
            threadId,
          },
        },
      ],
      failures: [],
    });
  });

  it("fans out to local and remote peers and preserves source identity", async () => {
    const service = new FederatedSearchService({
      now: () => 10_000,
      local: {
        listThreads: vi.fn(async () => ({
          backend: "codex" as const,
          fetchedAt: 1_000,
          threads: [thread("local-1", "Build remote control", 1_000)],
        })),
      },
      peers: () => [
        {
          instanceId: "child_one",
          label: "Laptop",
          status: "connected",
          backend: {
            listThreads: vi.fn(async () => ({
              backend: "codex" as const,
              fetchedAt: 1_000,
              threads: [thread("remote-1", "Remote control design", 2_000)],
            })),
          },
        },
      ],
    });

    await expect(
      service.search({ query: "remote", limit: 10 }),
    ).resolves.toMatchObject({
      query: "remote",
      searchedAt: 10_000,
      failures: [],
      results: [
        {
          ref: {
            backend: "codex",
            target: { scope: "remote", instanceId: "child_one" },
            threadId: "remote-1",
          },
          instanceLabel: "Laptop",
          peerStatus: "connected",
        },
        {
          ref: {
            backend: "codex",
            target: { scope: "local" },
            threadId: "local-1",
          },
          instanceLabel: "This Mac",
        },
      ],
    });
  });

  it("returns successful peers when another peer fails", async () => {
    const service = new FederatedSearchService({
      local: {
        listThreads: vi.fn(async () => ({
          backend: "codex" as const,
          fetchedAt: 1_000,
          threads: [],
        })),
      },
      peers: () => [
        {
          instanceId: "child_one",
          label: "Laptop",
          backend: {
            listThreads: vi.fn(async () => {
              throw new Error("offline");
            }),
          },
        },
        {
          instanceId: "child_two",
          label: "Desktop",
          backend: {
            listThreads: vi.fn(async () => ({
              backend: "codex" as const,
              fetchedAt: 1_000,
              threads: [thread("remote-2", "Search survives failure", 3_000)],
            })),
          },
        },
      ],
    });

    await expect(service.search({ query: "search" })).resolves.toMatchObject({
      results: [
        {
          ref: {
            target: { scope: "remote", instanceId: "child_two" },
            threadId: "remote-2",
          },
          instanceLabel: "Desktop",
        },
      ],
      failures: [
        {
          instanceId: "child_one",
          instanceLabel: "Laptop",
          error: "offline",
        },
      ],
      searchedInstances: [
        {
          instanceId: "child_two",
          instanceLabel: "Desktop",
          resultCount: 1,
        },
      ],
    });
  });

  it("times out a hung peer instead of stalling the search", async () => {
    const service = new FederatedSearchService({
      peerTimeoutMs: 25,
      local: {
        listThreads: vi.fn(async () => ({
          backend: "codex" as const,
          fetchedAt: 1_000,
          threads: [thread("local-1", "Timeout resilience", 1_000)],
        })),
      },
      peers: () => [
        {
          instanceId: "child_hung",
          label: "Hung Peer",
          backend: {
            // Never resolves — simulates a peer that accepted the RPC
            // but will not answer within the interactive window.
            listThreads: vi.fn(
              () => new Promise<AppServerListThreadsResponse>(() => {}),
            ),
          },
        },
      ],
    });

    await expect(service.search({ query: "timeout" })).resolves.toMatchObject({
      results: [{ ref: { target: { scope: "local" }, threadId: "local-1" } }],
      failures: [
        {
          instanceId: "child_hung",
          instanceLabel: "Hung Peer",
          error: "Federated search timed out after 0s.",
        },
      ],
      searchedInstances: [],
    });
  });
});
