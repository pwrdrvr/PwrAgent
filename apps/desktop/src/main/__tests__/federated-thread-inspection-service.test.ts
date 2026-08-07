import { describe, expect, it, vi } from "vitest";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { createFederatedThreadInspectionHandler } from "../federation/federated-thread-inspection-service";

const threadId = "019fdc10-799b-7540-8884-87899f896ebc";

function buildRuntime(params: {
  peers: Array<{
    instanceId: string;
    label: string;
    ownsThread?: boolean;
    capabilities?: Array<
      "thread_navigation" | "thread_detail" | "turn_control"
    >;
  }>;
}) {
  const backends = new Map(
    params.peers.map((peer) => {
      const thread = {
        source: "codex" as const,
        id: threadId,
        title: "Remote collector result",
        linkedDirectories: [],
      };
      const resolveThread = vi.fn(async () =>
        peer.ownsThread ? { thread } : {},
      );
      const readThread = vi.fn(async () => ({
        backend: "codex" as const,
        fetchedAt: 2_000,
        threadId,
        replay: {
          entries: [],
          messages: [],
          lastAssistantMessage: "Sanitized result",
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
          threadStatus: "idle" as const,
        },
        threadStatus: "idle" as const,
      }));
      const listThreads = vi.fn(async () => ({
        backend: "codex" as const,
        fetchedAt: 2_000,
        threads: [],
      }));
      return [peer.instanceId, { listThreads, readThread, resolveThread }] as const;
    }),
  );
  const runtime = {
    connectedPeerTargets: () =>
      params.peers.map((peer) => ({
        target: { scope: "remote" as const, instanceId: peer.instanceId },
        label: peer.label,
        capabilities:
          peer.capabilities ?? ["thread_navigation", "thread_detail"],
      })),
    remoteBackend: (target: { instanceId: string }) =>
      backends.get(target.instanceId),
  } as unknown as DesktopFederationRuntime;
  return { backends, runtime };
}

describe("federated thread inspection service", () => {
  it("discovers an owning peer and reads its transcript without instanceId", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [
        { instanceId: "pwr_other", label: "Other Mac" },
        {
          instanceId: "pwr_owner",
          label: "Owner Mac",
          ownsThread: true,
        },
      ],
    });
    const rememberRemoteThreadTarget = vi.fn(async (target) => target);
    const handler = createFederatedThreadInspectionHandler({
      runtime: () => runtime,
      targetStore: {
        listRemoteThreadTargets: vi.fn(async () => []),
        rememberRemoteThreadTarget,
      },
    });

    await expect(handler({
      backend: "codex",
      threadId,
      limit: 10,
      includeTurns: true,
    })).resolves.toMatchObject({
      instanceId: "pwr_owner",
      instanceLabel: "Owner Mac",
      thread: { id: threadId },
      read: {
        threadId,
        threadStatus: "idle",
      },
    });
    expect(backends.get("pwr_owner")?.readThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId,
      includeTurns: true,
      limit: 10,
      viewOnly: true,
    });
    expect(rememberRemoteThreadTarget).toHaveBeenCalledWith({
      backend: "codex",
      instanceId: "pwr_owner",
      instanceLabel: "Owner Mac",
      threadId,
    });
  });

  it("routes directly to an explicit instance", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [
        { instanceId: "pwr_other", label: "Other Mac" },
        {
          instanceId: "pwr_owner",
          label: "Owner Mac",
          ownsThread: true,
        },
      ],
    });
    const handler = createFederatedThreadInspectionHandler({
      runtime: () => runtime,
    });

    await expect(handler({
      backend: "codex",
      threadId,
      instanceId: "pwr_owner",
      limit: 0,
      includeTurns: false,
    })).resolves.toMatchObject({ instanceId: "pwr_owner" });
    expect(backends.get("pwr_other")?.resolveThread).not.toHaveBeenCalled();
    expect(backends.get("pwr_owner")?.readThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId,
      includeTurns: false,
      limit: 0,
      viewOnly: true,
    });
  });

  it("requires thread_detail on the owning peer", async () => {
    const { runtime } = buildRuntime({
      peers: [
        {
          instanceId: "pwr_navigation_only",
          label: "Navigation-only Mac",
          ownsThread: true,
          capabilities: ["thread_navigation"],
        },
      ],
    });
    const handler = createFederatedThreadInspectionHandler({
      runtime: () => runtime,
    });

    await expect(handler({
      backend: "codex",
      threadId,
      limit: 10,
      includeTurns: true,
    })).rejects.toThrow(
      "owns thread 019fdc10-799b-7540-8884-87899f896ebc but does not grant thread_detail",
    );
  });

  it("resolves an archived thread on its explicit remote owner", async () => {
    const archivedThread = {
      source: "codex" as const,
      id: threadId,
      title: "Archived collector result",
      archivedAt: 3_000,
      linkedDirectories: [],
    };
    const listThreads = vi.fn(async (request?: { archived?: boolean }) => ({
      backend: "codex" as const,
      fetchedAt: 2_000,
      threads: request?.archived ? [archivedThread] : [],
    }));
    const readThread = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: 2_000,
      threadId,
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle" as const,
      },
      threadStatus: "idle" as const,
    }));
    const runtime = {
      connectedPeerTargets: () => [{
        target: { scope: "remote" as const, instanceId: "pwr_owner" },
        label: "Owner Mac",
        capabilities: ["thread_navigation", "thread_detail"],
      }],
      remoteBackend: () => ({
        resolveThread: vi.fn(async () => ({})),
        listThreads,
        readThread,
      }),
    } as unknown as DesktopFederationRuntime;
    const handler = createFederatedThreadInspectionHandler({
      runtime: () => runtime,
    });

    await expect(handler({
      backend: "codex",
      threadId,
      instanceId: "pwr_owner",
      limit: 10,
      includeTurns: true,
    })).resolves.toMatchObject({
      instanceId: "pwr_owner",
      thread: { id: threadId, archivedAt: 3_000 },
    });
    expect(listThreads).toHaveBeenCalledWith({
      backend: "codex",
      archived: true,
    });
  });

  it("returns peer_unavailable for a remembered disconnected owner", async () => {
    const runtime = {
      connectedPeerTargets: () => [],
      health: vi.fn(async () => ({ peers: [] })),
    } as unknown as DesktopFederationRuntime;
    const handler = createFederatedThreadInspectionHandler({
      runtime: () => runtime,
      targetStore: {
        listRemoteThreadTargets: vi.fn(async () => [{
          instanceId: "pwr_offline",
          instanceLabel: "Offline Mac",
          backend: "codex" as const,
          threadId,
          firstSeenAt: 1_000,
          lastSeenAt: 2_000,
        }]),
        rememberRemoteThreadTarget: vi.fn(),
      },
    });

    await expect(handler({
      backend: "codex",
      threadId,
      limit: 10,
      includeTurns: true,
    })).rejects.toMatchObject({
      code: "peer_unavailable",
      message: expect.stringContaining("Offline Mac"),
    });
  });
});
