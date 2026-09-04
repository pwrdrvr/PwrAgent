import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerListThreadsResponse,
  AppServerThreadSummary,
  FederationProtocolEnvelope,
} from "@pwragent/shared";
import { FederationRemoteBackendClient } from "../federation/federation-backend-bridge";
import { FederatedSearchService } from "../federation/federated-search-service";
import { FederationRpcEndpoint } from "../federation/federation-rpc";

afterEach(() => {
  vi.useRealTimers();
});

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
              throw Object.assign(new Error("Unsupported federation method"), {
                code: "method_not_found",
              });
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

  it("does not amplify a resolve failure into full active and archive scans", async () => {
    const threadId = "019fd821-1450-7952-85ca-3bb8e5d150da";
    const listThreads = vi.fn();
    const service = new FederatedSearchService({
      includeLocal: false,
      local: { listThreads: vi.fn() },
      peers: () => [{
        instanceId: "pwr_broken",
        label: "Broken Mac",
        backend: {
          resolveThread: vi.fn(async () => {
            throw Object.assign(new Error("Remote handler failed"), {
              code: "handler_failed",
            });
          }),
          listThreads,
        },
      }],
    });

    await expect(service.search({
      query: threadId,
      backend: "codex",
      includeArchived: true,
    })).resolves.toMatchObject({
      results: [],
      failures: [{
        instanceId: "pwr_broken",
        error: "Remote handler failed",
      }],
    });
    expect(listThreads).not.toHaveBeenCalled();
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

  it("applies backend, project, archive, and date filters before limiting", async () => {
    const listThreads = vi.fn(async (request?: {
      archived?: boolean;
      backend?: string;
      filter?: string;
    }) => ({
      backend: "all" as const,
      fetchedAt: 1_000,
      threads: request?.archived
        ? [{
            ...thread("archived-match", "Collector result", 5_000),
            archivedAt: 6_000,
            projectKey: "PwrSuiteLab",
          }]
        : Array.from({ length: 10 }, (_, index) => ({
            ...thread(`wrong-project-${index}`, "Collector result", 5_000),
            projectKey: "OtherProject",
          })),
    }));
    const service = new FederatedSearchService({
      includeLocal: false,
      local: { listThreads: vi.fn() },
      peers: () => [{
        instanceId: "pwr_remote",
        label: "Remote Mac",
        backend: { listThreads },
      }],
    });

    await expect(service.search({
      query: "collector",
      backend: "codex",
      includeArchived: true,
      projectKeys: ["PwrSuiteLab"],
      updatedAfter: 4_000,
      updatedBefore: 6_000,
      limit: 1,
    })).resolves.toMatchObject({
      results: [{ thread: { id: "archived-match", archivedAt: 6_000 } }],
      totalCount: 1,
      truncated: false,
    });
    expect(listThreads).toHaveBeenNthCalledWith(1, {
      backend: "codex",
      archived: false,
      filter: "collector",
    }, expect.objectContaining({ deadlineAt: expect.any(Number) }));
    expect(listThreads).toHaveBeenNthCalledWith(2, {
      backend: "codex",
      archived: true,
      filter: "collector",
    }, expect.objectContaining({ deadlineAt: expect.any(Number) }));
  });

  it("reports totalCount and truncation before slicing the result page", async () => {
    const service = new FederatedSearchService({
      includeLocal: false,
      local: { listThreads: vi.fn() },
      peers: () => [{
        instanceId: "pwr_remote",
        label: "Remote Mac",
        backend: {
          listThreads: vi.fn(async () => ({
            backend: "codex" as const,
            fetchedAt: 1_000,
            threads: Array.from({ length: 11 }, (_, index) =>
              thread(`remote-${index}`, "Collector result", index)),
          })),
        },
      }],
    });

    const response = await service.search({
      query: "collector",
      limit: 10,
    });
    expect(response).toMatchObject({
      results: expect.any(Array),
      totalCount: 11,
      truncated: true,
    });
    expect(response.results).toHaveLength(10);
  });

  it("uses recency as a tie-breaker instead of an empty-query score", async () => {
    const service = new FederatedSearchService({
      includeLocal: false,
      local: { listThreads: vi.fn() },
      peers: () => [{
        instanceId: "pwr_remote",
        label: "Remote Mac",
        backend: {
          listThreads: vi.fn(async () => ({
            backend: "codex" as const,
            fetchedAt: 1_000,
            threads: [
              thread("older", "Older", 1_000),
              thread("newer", "Newer", 2_000),
            ],
          })),
        },
      }],
    });

    const response = await service.search({ query: "", limit: 10 });

    expect(response.results.map((entry) => entry.thread.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(response.results.map((entry) => entry.score)).toEqual([0, 0]);
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

  it("terminates the underlying peer RPC at the search deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: FederationProtocolEnvelope[] = [];
    const endpoint = new FederationRpcEndpoint({
      localInstanceId: "client_one",
      remoteInstanceId: "child_hung",
      sendEnvelope: (envelope) => sent.push(envelope),
    });
    const service = new FederatedSearchService({
      includeLocal: false,
      peerTimeoutMs: 25,
      local: { listThreads: vi.fn() },
      peers: () => [{
        instanceId: "child_hung",
        label: "Hung Peer",
        backend: new FederationRemoteBackendClient(endpoint),
      }],
    });

    const search = service.search({ query: "timeout" });
    await vi.advanceTimersByTimeAsync(25);
    await expect(search).resolves.toMatchObject({
      failures: [{ instanceId: "child_hung" }],
    });
    expect(sent[0]).toMatchObject({ deadlineAt: 1_025 });
    expect(
      (endpoint as unknown as { pending: Map<string, unknown> }).pending.size,
    ).toBe(0);
  });
});
