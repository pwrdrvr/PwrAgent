import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
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
            listThreads: vi.fn(() => new Promise(() => {})),
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
