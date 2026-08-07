import { describe, expect, it, vi } from "vitest";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { createFederatedThreadMessageHandler } from "../federation/federated-thread-message-service";

const request = {
  backend: "codex" as const,
  threadId: "019fd821-1450-7952-85ca-3bb8e5d150da",
  input: [{ type: "text" as const, text: "Please handle the expanded scope." }],
  messageOrigin: {
    kind: "agent" as const,
    sourceThread: {
      backend: "codex" as const,
      threadId: "source-thread",
    },
  },
  executionMode: "full-access" as const,
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
};

function buildRuntime(params: {
  peers: Array<{
    instanceId: string;
    label: string;
    capabilities?: Array<"thread_navigation" | "turn_control">;
    ownsThread?: boolean;
    resolveUnsupported?: boolean;
  }>;
}) {
  const backends = new Map(
    params.peers.map((peer) => {
      const ownedThread = {
        source: "codex" as const,
        id: request.threadId,
        title: "Thread list stays disabled after reconnect",
        linkedDirectories: [],
      };
      const resolveThread = vi.fn(async () => {
        if (peer.resolveUnsupported) {
          throw new Error("Unsupported federation method: backend.resolveThread");
        }
        return peer.ownsThread ? { thread: ownedThread } : {};
      });
      const listThreads = vi.fn(async () => ({
        backend: "codex" as const,
        fetchedAt: 1_000,
        threads: peer.ownsThread ? [ownedThread] : [],
      }));
      const startTurn = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: request.threadId,
        turnId: "remote-turn-1",
      }));
      return [peer.instanceId, { listThreads, resolveThread, startTurn }] as const;
    }),
  );
  const runtime = {
    connectedPeerTargets: () =>
      params.peers.map((peer) => ({
        target: { scope: "remote" as const, instanceId: peer.instanceId },
        label: peer.label,
        capabilities: peer.capabilities ?? ["thread_navigation", "turn_control"],
      })),
    remoteBackend: (target: { instanceId: string }) =>
      backends.get(target.instanceId),
  } as unknown as DesktopFederationRuntime;
  return { backends, runtime };
}

describe("federated thread message service", () => {
  it("resolves a UUID owner and starts the turn on that peer", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [
        { instanceId: "pwr_other", label: "Other Mac" },
        {
          instanceId: "pwr_harold",
          label: "Harold-Mac-Mini-M4",
          ownsThread: true,
        },
      ],
    });
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
    });

    await expect(handler(request)).resolves.toEqual({
      backend: "codex",
      threadId: request.threadId,
      turnId: "remote-turn-1",
      title: "Thread list stays disabled after reconnect",
      instanceId: "pwr_harold",
      instanceLabel: "Harold-Mac-Mini-M4",
    });
    expect(backends.get("pwr_other")?.resolveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: request.threadId,
    });
    expect(backends.get("pwr_harold")?.startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: request.threadId,
      input: request.input,
      messageOrigin: request.messageOrigin,
      executionMode: "full-access",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: undefined,
      fastMode: undefined,
      approvalPolicy: undefined,
      sandbox: undefined,
    });
  });

  it("returns undefined when no connected peer owns the thread", async () => {
    const { runtime } = buildRuntime({
      peers: [{ instanceId: "pwr_other", label: "Other Mac" }],
    });
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
    });

    await expect(handler(request)).resolves.toBeUndefined();
  });

  it("falls back to exact list scanning for a mixed-version peer", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [
        {
          instanceId: "pwr_older",
          label: "Older Mac",
          ownsThread: true,
          resolveUnsupported: true,
        },
      ],
    });
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
    });

    await expect(handler(request)).resolves.toMatchObject({
      instanceId: "pwr_older",
      turnId: "remote-turn-1",
    });
    expect(backends.get("pwr_older")?.listThreads).toHaveBeenCalledWith({
      backend: "codex",
    });
  });

  it("refuses an ambiguous UUID reported by multiple peers", async () => {
    const { runtime } = buildRuntime({
      peers: [
        { instanceId: "pwr_one", label: "One", ownsThread: true },
        { instanceId: "pwr_two", label: "Two", ownsThread: true },
      ],
    });
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
    });

    await expect(handler(request)).rejects.toThrow(
      "reported by multiple federation instances: One, Two",
    );
  });

  it("requires turn_control on the owning peer", async () => {
    const { runtime } = buildRuntime({
      peers: [
        {
          instanceId: "pwr_read_only",
          label: "Read-only Mac",
          capabilities: ["thread_navigation"],
          ownsThread: true,
        },
      ],
    });
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
    });

    await expect(handler(request)).rejects.toThrow(
      "owns thread 019fd821-1450-7952-85ca-3bb8e5d150da but does not grant turn_control",
    );
  });
});
