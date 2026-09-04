import { describe, expect, it, vi } from "vitest";
import type {
  ControlActiveTurnRequest,
  ControlActiveTurnResponse,
  StartTurnResponse,
  SteerTurnResponse,
} from "@pwragent/shared";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import {
  createFederatedThreadControlHandler,
  createFederatedThreadMessageHandler,
} from "../federation/federated-thread-message-service";
import { FederationPeerUnavailableError } from "../federation/federation-peer-unavailable-error";

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
    activeTurnId?: string | null;
    interruptTurn?: boolean;
    steerTurn?: boolean;
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
          throw Object.assign(
            new Error("Unsupported federation method: backend.resolveThread"),
            { code: "method_not_found" },
          );
        }
        return peer.ownsThread ? { thread: ownedThread } : {};
      });
      const listThreads = vi.fn(async () => ({
        backend: "codex" as const,
        fetchedAt: 1_000,
        threads: peer.ownsThread ? [ownedThread] : [],
      }));
      const startTurn = vi.fn(async (): Promise<StartTurnResponse> => ({
        backend: "codex" as const,
        threadId: request.threadId,
        turnId: "remote-turn-1",
      }));
      const activeTurnId = peer.activeTurnId === undefined
        ? "remote-active-turn"
        : peer.activeTurnId;
      const listBackends = vi.fn(async () => ({
        fetchedAt: 1_000,
        backends: [{
          kind: "codex" as const,
          label: "Codex",
          available: true,
          methods: [],
          capabilities: {
            listThreads: true,
            createThread: true,
            resumeThread: true,
            renameThread: true,
            readThread: true,
            startTurn: true,
            interruptTurn: peer.interruptTurn ?? true,
            steerTurn: peer.steerTurn ?? true,
            transcriptPagination: false,
            toolUse: true,
            approvalRequests: true,
            multiDirectoryThreads: true,
          },
          executionModes: [],
        }],
      }));
      const readThread = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: request.threadId,
        replay: {
          backend: "codex" as const,
          threadId: request.threadId,
          threadStatus: activeTurnId ? "active" as const : "idle" as const,
          entries: activeTurnId
            ? [{
                id: `turn:${activeTurnId}`,
                timestamp: 1_000,
                kind: "turn" as const,
                turn: {
                  id: activeTurnId,
                  status: "in_progress" as const,
                },
              }]
            : [],
        },
      }));
      const controlActiveTurn = vi.fn(
        async (
          controlRequest: ControlActiveTurnRequest,
        ): Promise<ControlActiveTurnResponse> => {
          const base = {
            backend: "codex" as const,
            threadId: request.threadId,
            requestId: controlRequest.requestId,
          };
          if (!activeTurnId) {
            return {
              ok: false,
              ...base,
              error: {
                code: "no_active_turn",
                message: `Thread ${request.threadId} has no active turn.`,
              },
            };
          }
          if (
            controlRequest.expectedTurnId
            && controlRequest.expectedTurnId !== activeTurnId
          ) {
            return {
              ok: false,
              ...base,
              error: {
                code: "stale_target",
                message: "The active turn changed.",
                activeTurnId,
                expectedTurnId: controlRequest.expectedTurnId,
              },
            };
          }
          if (
            (controlRequest.operation === "stop" && peer.interruptTurn === false)
            || (controlRequest.operation === "steer" && peer.steerTurn === false)
          ) {
            return {
              ok: false,
              ...base,
              error: {
                code: "unsupported_capability",
                message: "The backend does not support this control operation.",
              },
            };
          }
          return {
            ok: true,
            ...base,
            turnId: activeTurnId,
            disposition: controlRequest.operation === "stop"
              ? "interrupted"
              : "steered",
          };
        },
      );
      const resolveActiveTurn = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: request.threadId,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
      }));
      const interruptTurn = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: request.threadId,
        turnId: activeTurnId ?? "missing",
      }));
      const steerTurn = vi.fn(async (steerRequest): Promise<SteerTurnResponse> => ({
        backend: "codex" as const,
        threadId: request.threadId,
        turnId: steerRequest.expectedTurnId,
        disposition: "steered" as const,
      }));
      return [peer.instanceId, {
        controlActiveTurn,
        interruptTurn,
        listBackends,
        listThreads,
        readThread,
        resolveActiveTurn,
        resolveThread,
        startTurn,
        steerTurn,
      }] as const;
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

  it("does not dispatch to a thread that exists only in the remote archive", async () => {
    const archivedThread = {
      source: "codex" as const,
      id: request.threadId,
      title: "Archived remote work",
      archivedAt: 2_000,
      linkedDirectories: [],
    };
    const listThreads = vi.fn(async (params?: { archived?: boolean }) => ({
      backend: "codex" as const,
      fetchedAt: 1_000,
      threads: params?.archived ? [archivedThread] : [],
    }));
    const startTurn = vi.fn();
    const runtime = {
      connectedPeerTargets: () => [{
        target: { scope: "remote" as const, instanceId: "pwr_archive" },
        label: "Archive Mac",
        capabilities: ["thread_navigation", "turn_control"],
      }],
      remoteBackend: () => ({
        resolveThread: vi.fn(async () => {
          throw Object.assign(
            new Error("Unsupported federation method: backend.resolveThread"),
            { code: "method_not_found" },
          );
        }),
        listThreads,
        startTurn,
      }),
    } as unknown as DesktopFederationRuntime;
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
    });

    await expect(handler(request)).resolves.toBeUndefined();
    expect(startTurn).not.toHaveBeenCalled();
    expect(listThreads).toHaveBeenCalledWith({ backend: "codex" });
    expect(listThreads).not.toHaveBeenCalledWith({
      backend: "codex",
      archived: true,
    });
  });

  it("preserves queued delivery metadata from the owning peer", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [{
        instanceId: "pwr_harold",
        label: "Harold-Mac-Mini-M4",
        ownsThread: true,
      }],
    });
    backends.get("pwr_harold")!.startTurn.mockResolvedValueOnce({
      backend: "codex",
      threadId: request.threadId,
      turnId: "thread-turn:queued-1",
      queueStatus: "queued",
      queueEntryId: "thread-turn:queued-1",
    });
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
    });

    await expect(handler(request)).resolves.toMatchObject({
      turnId: "thread-turn:queued-1",
      queueStatus: "queued",
      queueEntryId: "thread-turn:queued-1",
    });
  });

  it("routes directly through a remembered owner and refreshes the mapping", async () => {
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
    const rememberRemoteThreadTarget = vi.fn(async (target) => ({
      ...target,
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
    }));
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
      targetStore: {
        listRemoteThreadTargets: vi.fn(async () => [{
          instanceId: "pwr_harold",
          instanceLabel: "Harold-Mac-Mini-M4",
          backend: "codex" as const,
          threadId: request.threadId,
          firstSeenAt: 500,
          lastSeenAt: 500,
        }]),
        rememberRemoteThreadTarget,
      },
    });

    await expect(handler(request)).resolves.toMatchObject({
      instanceId: "pwr_harold",
      turnId: "remote-turn-1",
    });
    expect(backends.get("pwr_other")?.resolveThread).not.toHaveBeenCalled();
    expect(rememberRemoteThreadTarget).toHaveBeenCalledWith({
      instanceId: "pwr_harold",
      instanceLabel: "Harold-Mac-Mini-M4",
      backend: "codex",
      threadId: request.threadId,
    });
  });

  it("does not probe peers when remembered-only routing has no owner", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [{
        instanceId: "pwr_harold",
        label: "Harold-Mac-Mini-M4",
        ownsThread: true,
      }],
    });
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
      targetStore: {
        listRemoteThreadTargets: vi.fn(async () => []),
        rememberRemoteThreadTarget: vi.fn(),
      },
    });

    await expect(handler({
      ...request,
      resolutionMode: "remembered_only",
    })).resolves.toBeUndefined();
    expect(backends.get("pwr_harold")?.resolveThread).not.toHaveBeenCalled();
  });

  it("does not fall through when a remembered owner no longer reports the thread", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [
        { instanceId: "pwr_other", label: "Other Mac", ownsThread: true },
        { instanceId: "pwr_harold", label: "Harold-Mac-Mini-M4" },
      ],
    });
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
      targetStore: {
        listRemoteThreadTargets: vi.fn(async () => [{
          instanceId: "pwr_harold",
          instanceLabel: "Harold-Mac-Mini-M4",
          backend: "codex" as const,
          threadId: request.threadId,
          firstSeenAt: 500,
          lastSeenAt: 500,
        }]),
        rememberRemoteThreadTarget: vi.fn(),
      },
    });

    await expect(handler({
      ...request,
      resolutionMode: "remembered_only",
    })).rejects.toThrow(
      `Thread ${request.threadId} was not found on its remembered federation owner Harold-Mac-Mini-M4.`,
    );
    expect(backends.get("pwr_other")?.resolveThread).not.toHaveBeenCalled();
  });

  it("reports a remembered disconnected owner without probing other peers", async () => {
    const runtime = {
      connectedPeerTargets: () => [],
      health: async () => ({
        enabled: true,
        role: "gateway",
        status: "listening",
        instanceId: "pwr_local",
        peers: [{
          id: "pwr_harold",
          label: "Harold-Mac-Mini-M4",
          role: "client",
          status: "disconnected",
          capabilities: [],
        }],
      }),
    } as unknown as DesktopFederationRuntime;
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
      targetStore: {
        listRemoteThreadTargets: vi.fn(async () => [{
          instanceId: "pwr_harold",
          instanceLabel: "Harold-Mac-Mini-M4",
          backend: "codex" as const,
          threadId: request.threadId,
          firstSeenAt: 500,
          lastSeenAt: 500,
        }]),
        rememberRemoteThreadTarget: vi.fn(),
      },
    });

    await expect(handler(request)).rejects.toMatchObject({
      code: "peer_unavailable",
      message: expect.stringContaining("is disconnected; the message was not sent"),
    });
  });

  it("uses an explicit instanceId without reading remembered targets", async () => {
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
    const listRemoteThreadTargets = vi.fn(async () => []);
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
      targetStore: {
        listRemoteThreadTargets,
        rememberRemoteThreadTarget: vi.fn(),
      },
    });

    await expect(handler({
      ...request,
      instanceId: "pwr_harold",
    })).resolves.toMatchObject({ instanceId: "pwr_harold" });
    expect(listRemoteThreadTargets).not.toHaveBeenCalled();
    expect(backends.get("pwr_other")?.resolveThread).not.toHaveBeenCalled();
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

  it("does not amplify a resolve failure into a full thread-list scan", async () => {
    const listThreads = vi.fn();
    const runtime = {
      connectedPeerTargets: () => [{
        target: { scope: "remote" as const, instanceId: "pwr_broken" },
        label: "Broken Mac",
        capabilities: ["thread_navigation", "turn_control"],
      }],
      remoteBackend: () => ({
        resolveThread: vi.fn(async () => {
          throw Object.assign(new Error("Remote handler failed"), {
            code: "handler_failed",
          });
        }),
        listThreads,
      }),
    } as unknown as DesktopFederationRuntime;
    const handler = createFederatedThreadMessageHandler({
      runtime: () => runtime,
    });

    await expect(handler(request)).rejects.toThrow("Remote handler failed");
    expect(listThreads).not.toHaveBeenCalled();
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

  it("interrupts the active turn on the owning peer without starting a turn", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [{
        instanceId: "pwr_owner",
        label: "Owner Mac",
        ownsThread: true,
        activeTurnId: "turn-live",
      }],
    });
    const handler = createFederatedThreadControlHandler({
      runtime: () => runtime,
    });

    await expect(handler({
      operation: "stop",
      backend: "codex",
      threadId: request.threadId,
      requestId: "stop-1",
    })).resolves.toEqual({
      backend: "codex",
      threadId: request.threadId,
      turnId: "turn-live",
      disposition: "interrupted",
      instanceId: "pwr_owner",
      instanceLabel: "Owner Mac",
    });
    expect(backends.get("pwr_owner")?.controlActiveTurn).toHaveBeenCalledWith({
      operation: "stop",
      backend: "codex",
      threadId: request.threadId,
      requestId: "stop-1",
    });
    expect(backends.get("pwr_owner")?.interruptTurn).not.toHaveBeenCalled();
    expect(backends.get("pwr_owner")?.startTurn).not.toHaveBeenCalled();
  });

  it("delegates steer atomically and preserves a stale owner disposition", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [{
        instanceId: "pwr_owner",
        label: "Owner Mac",
        ownsThread: true,
        activeTurnId: "turn-live",
      }],
    });
    const handler = createFederatedThreadControlHandler({
      runtime: () => runtime,
    });
    const input = [{ type: "text" as const, text: "Use the smaller fixture." }];

    await expect(handler({
      operation: "steer",
      backend: "codex",
      threadId: request.threadId,
      requestId: "steer-1",
      input,
    })).resolves.toMatchObject({
      turnId: "turn-live",
      disposition: "steered",
    });
    expect(backends.get("pwr_owner")?.controlActiveTurn).toHaveBeenCalledWith({
      operation: "steer",
      backend: "codex",
      threadId: request.threadId,
      requestId: "steer-1",
      input,
    });
    expect(backends.get("pwr_owner")?.steerTurn).not.toHaveBeenCalled();
    expect(backends.get("pwr_owner")?.startTurn).not.toHaveBeenCalled();

    backends.get("pwr_owner")?.controlActiveTurn.mockResolvedValueOnce({
      ok: false,
      backend: "codex",
      threadId: request.threadId,
      requestId: "steer-2",
      error: {
        code: "stale_target",
        message: "The active turn changed before steering.",
      },
    });
    await expect(handler({
      operation: "steer",
      backend: "codex",
      threadId: request.threadId,
      requestId: "steer-2",
      input,
    })).rejects.toMatchObject({ code: "stale_target" });
  });

  it("reports no-active, stale-turn, and capability dispositions structurally", async () => {
    const noActive = buildRuntime({
      peers: [{
        instanceId: "pwr_idle",
        label: "Idle Mac",
        ownsThread: true,
        activeTurnId: null,
      }],
    });
    await expect(createFederatedThreadControlHandler({
      runtime: () => noActive.runtime,
    })({
      operation: "stop",
      backend: "codex",
      threadId: request.threadId,
      requestId: "stop-idle",
    })).rejects.toMatchObject({ code: "no_active_turn" });

    const stale = buildRuntime({
      peers: [{
        instanceId: "pwr_live",
        label: "Live Mac",
        ownsThread: true,
        activeTurnId: "turn-new",
      }],
    });
    await expect(createFederatedThreadControlHandler({
      runtime: () => stale.runtime,
    })({
      operation: "steer",
      backend: "codex",
      threadId: request.threadId,
      requestId: "steer-stale",
      expectedTurnId: "turn-old",
      input: [{ type: "text", text: "Stop." }],
    })).rejects.toMatchObject({ code: "stale_target" });

    const unsupported = buildRuntime({
      peers: [{
        instanceId: "pwr_no_steer",
        label: "No Steer Mac",
        ownsThread: true,
        steerTurn: false,
      }],
    });
    await expect(createFederatedThreadControlHandler({
      runtime: () => unsupported.runtime,
    })({
      operation: "steer",
      backend: "codex",
      threadId: request.threadId,
      requestId: "steer-unsupported",
      input: [{ type: "text", text: "Stop." }],
    })).rejects.toMatchObject({ code: "unsupported_capability" });
  });

  it("preserves owner-side idempotent replay disposition", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [{
        instanceId: "pwr_owner",
        label: "Owner Mac",
        ownsThread: true,
        activeTurnId: "turn-live",
      }],
    });
    backends.get("pwr_owner")?.controlActiveTurn.mockResolvedValueOnce({
      ok: true,
      backend: "codex",
      threadId: request.threadId,
      requestId: "stop-retry",
      turnId: "turn-live",
      disposition: "interrupted",
      idempotentReplay: true,
    });

    await expect(createFederatedThreadControlHandler({
      runtime: () => runtime,
    })({
      operation: "stop",
      backend: "codex",
      threadId: request.threadId,
      requestId: "stop-retry",
    })).resolves.toMatchObject({
      disposition: "interrupted",
      idempotentReplay: true,
    });
  });

  it("classifies control disconnects and timeouts as peer unavailable", async () => {
    const { backends, runtime } = buildRuntime({
      peers: [{
        instanceId: "pwr_owner",
        label: "Owner Mac",
        ownsThread: true,
        activeTurnId: "turn-live",
      }],
    });
    const control = backends.get("pwr_owner")?.controlActiveTurn;
    control?.mockRejectedValueOnce(
      new FederationPeerUnavailableError("pwr_owner"),
    );
    const handler = createFederatedThreadControlHandler({
      runtime: () => runtime,
    });

    await expect(handler({
      operation: "stop",
      backend: "codex",
      threadId: request.threadId,
      requestId: "stop-disconnected",
    })).rejects.toMatchObject({ code: "peer_unavailable" });

    control?.mockRejectedValueOnce(
      new Error("Federation request timed out: backend.controlActiveTurn"),
    );
    await expect(handler({
      operation: "steer",
      backend: "codex",
      threadId: request.threadId,
      requestId: "steer-timeout",
      input: [{ type: "text", text: "Stop." }],
    })).rejects.toMatchObject({ code: "peer_unavailable" });
  });

  it("reports unavailable, ambiguous, and stale federation ownership structurally", async () => {
    const unavailableRuntime = {
      connectedPeerTargets: () => [],
      health: async () => ({
        enabled: true,
        role: "gateway",
        status: "listening",
        instanceId: "pwr_local",
        peers: [{
          id: "pwr_owner",
          label: "Owner Mac",
          role: "client",
          status: "disconnected",
          capabilities: [],
        }],
      }),
    } as unknown as DesktopFederationRuntime;
    await expect(createFederatedThreadControlHandler({
      runtime: () => unavailableRuntime,
      targetStore: {
        listRemoteThreadTargets: vi.fn(async () => [{
          instanceId: "pwr_owner",
          instanceLabel: "Owner Mac",
          backend: "codex" as const,
          threadId: request.threadId,
          firstSeenAt: 500,
          lastSeenAt: 500,
        }]),
        rememberRemoteThreadTarget: vi.fn(),
      },
    })({
      operation: "stop",
      backend: "codex",
      threadId: request.threadId,
      requestId: "stop-unavailable",
    })).rejects.toMatchObject({ code: "peer_unavailable" });

    const ambiguous = buildRuntime({
      peers: [
        { instanceId: "pwr_one", label: "One", ownsThread: true },
        { instanceId: "pwr_two", label: "Two", ownsThread: true },
      ],
    });
    await expect(createFederatedThreadControlHandler({
      runtime: () => ambiguous.runtime,
    })({
      operation: "stop",
      backend: "codex",
      threadId: request.threadId,
      requestId: "stop-ambiguous",
    })).rejects.toMatchObject({ code: "ambiguous_owner" });

    const stale = buildRuntime({
      peers: [{ instanceId: "pwr_owner", label: "Owner Mac" }],
    });
    await expect(createFederatedThreadControlHandler({
      runtime: () => stale.runtime,
    })({
      operation: "stop",
      backend: "codex",
      threadId: request.threadId,
      instanceId: "pwr_owner",
      requestId: "stop-stale-owner",
    })).rejects.toMatchObject({ code: "stale_target" });
  });
});
