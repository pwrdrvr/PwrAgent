import { describe, expect, it, vi } from "vitest";
import type {
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  FederationProtocolEnvelope,
  TrustCodexProjectRequest,
} from "@pwragent/shared";
import {
  FEDERATION_BACKEND_METHODS,
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { FEDERATION_MAX_FRAME_BYTES } from "../federation/federation-transport";

describe("federation backend bridge", () => {
  it("routes thread reactions through the thread-navigation capability", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);

    const pending = client.setThreadReaction({
      backend: "codex",
      threadId: "thread-remote",
      emoji: "👀",
      present: true,
    });
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.setThreadReaction,
      params: {
        backend: "codex",
        threadId: "thread-remote",
        emoji: "👀",
        present: true,
      },
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.setThreadReaction
      ],
    ).toBe("thread_navigation");

    rpc.receiveEnvelope({
      id: "response-reaction",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        threadId: "thread-remote",
        reactions: ["✋", "👀"],
      },
    });
    await expect(pending).resolves.toEqual({
      backend: "codex",
      threadId: "thread-remote",
      reactions: ["✋", "👀"],
    });
  });

  it("reads remote PwrSnap status through its dedicated capability", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);

    const pending = client.readPwrSnapConnectionStatus();
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.readPwrSnapConnectionStatus,
      params: {},
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.readPwrSnapConnectionStatus
      ],
    ).toBe("pwrsnap_connection");

    rpc.receiveEnvelope({
      id: "response-pwrsnap",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        connectionId: "pwrsnap",
        displayName: "PwrSnap",
        availability: "running",
        configured: true,
      },
    });
    await expect(pending).resolves.toMatchObject({
      availability: "running",
      configured: true,
    });
  });

  it("maps federation backend methods to local app-server operations", async () => {
    const backend: FederationBackendOperations = {
      listThreads: vi.fn(async () => ({
        backend: "codex",
        fetchedAt: 1_000,
        threads: [],
      })),
      readThread: vi.fn(),
      listSkills: vi.fn(),
      listBackends: vi.fn(),
      archiveThread: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        archivedAt: 2_000,
        cleanup: [],
      })),
      createScheduledThreadAction: vi.fn(async (request) => ({
        action: {
          ...request,
          id: "scheduled-1",
          origin: request.origin ?? "desktop",
          status: "scheduled" as const,
          createdAt: 2_000,
          updatedAt: 2_000,
        },
      })),
      startTurn: vi.fn(),
      cancelQueuedTurn: vi.fn(async ({ queueEntryId }) => ({
        queueEntryId,
        cancelled: true,
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
      now: () => 2_000,
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: [
        "thread_navigation",
        "turn_control",
        "scheduled_actions",
      ],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: {
        id: "request-1",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.listThreads,
        params: { backend: "codex" },
        protocolVersion: 1,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 1_000,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: {
        id: "request-3",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.createScheduledThreadAction,
        params: {
          backend: "codex",
          threadId: "thread-1",
          kind: "turn",
          scheduledFor: 3_000,
          displayText: "Follow up",
          turn: { input: [{ type: "text", text: "Follow up" }] },
        },
        protocolVersion: 1,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 1_200,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: {
        id: "request-2",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.archiveThread,
        params: { backend: "codex", threadId: "thread-1" },
        protocolVersion: 1,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 1_100,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: {
        id: "request-3",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.cancelQueuedTurn,
        params: { queueEntryId: "queue-1" },
        protocolVersion: 1,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 1_200,
      },
    });

    expect(backend.listThreads).toHaveBeenCalledWith({ backend: "codex" });
    expect(backend.archiveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(backend.cancelQueuedTurn).toHaveBeenCalledWith({
      queueEntryId: "queue-1",
    });
    expect(backend.createScheduledThreadAction).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
      }),
    );
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "request-1",
        result: {
          backend: "codex",
          threads: [],
        },
      },
      {
        kind: "response",
        requestId: "request-3",
        result: {
          action: {
            id: "scheduled-1",
            status: "scheduled",
          },
        },
      },
      {
        kind: "response",
        requestId: "request-2",
        result: {
          backend: "codex",
          threadId: "thread-1",
        },
      },
      {
        kind: "response",
        requestId: "request-3",
        result: {
          queueEntryId: "queue-1",
          cancelled: true,
        },
      },
    ]);
  });

  it("reads complete thread history before minting federation cursors", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1_000,
      threadId: "thread-1",
      replay: {
        entries: [
          {
            type: "message",
            id: "entry-1",
            role: "user",
            text: "First",
          },
          {
            type: "activity",
            id: "entry-2",
            summary: "Worked",
            status: "completed",
            details: [],
          },
          {
            type: "message",
            id: "entry-3",
            role: "assistant",
            text: "Third",
          },
          {
            type: "message",
            id: "entry-4",
            role: "user",
            text: "Fourth",
          },
        ],
        messages: [
          { id: "entry-1", role: "user", text: "First" },
          { id: "entry-3", role: "assistant", text: "Third" },
          { id: "entry-4", role: "user", text: "Fourth" },
        ],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const backend = {
      readThread: vi.fn(async () => response),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_detail"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "latest-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.readThread,
        params: { backend: "codex", threadId: "thread-1", limit: 2 },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "older-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.readThread,
        params: {
          backend: "codex",
          threadId: "thread-1",
          before: "entry-3",
          limit: 2,
        },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_100,
      },
    });

    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "latest-request",
        result: {
          replay: {
            entries: [{ id: "entry-3" }, { id: "entry-4" }],
            messages: [{ id: "entry-3" }, { id: "entry-4" }],
            pagination: {
              supportsPagination: true,
              hasPreviousPage: true,
              previousCursor: "entry-3",
            },
          },
        },
      },
      {
        kind: "response",
        requestId: "older-request",
        result: {
          replay: {
            entries: [{ id: "entry-1" }, { id: "entry-2" }],
            messages: [{ id: "entry-1" }],
            pagination: {
              supportsPagination: true,
              hasPreviousPage: false,
            },
          },
        },
      },
    ]);
    expect(backend.readThread).toHaveBeenNthCalledWith(1, {
      backend: "codex",
      threadId: "thread-1",
      limit: 2,
    });
    expect(backend.readThread).toHaveBeenNthCalledWith(2, {
      backend: "codex",
      threadId: "thread-1",
    });
    expect(backend.readThread).toHaveBeenNthCalledWith(3, {
      backend: "codex",
      threadId: "thread-1",
      before: "entry-3",
      limit: 2,
    });
    expect(backend.readThread).toHaveBeenNthCalledWith(4, {
      backend: "codex",
      threadId: "thread-1",
    });
  });

  it("does not lose older history when an unpaginated backend honors limit", async () => {
    const allEntries: AppServerReadThreadResponse["replay"]["entries"] = [
      {
        type: "message",
        id: "older-user",
        role: "user",
        text: "Older question",
      },
      {
        type: "message",
        id: "older-assistant",
        role: "assistant",
        text: "Older answer",
      },
      {
        type: "message",
        id: "latest-user",
        role: "user",
        text: "Latest question",
      },
      {
        type: "message",
        id: "latest-assistant",
        role: "assistant",
        text: "Latest answer",
      },
    ];
    const backend = {
      readThread: vi.fn(async (request: AppServerReadThreadRequest) => {
        const entries = request.limit === undefined
          ? allEntries
          : allEntries.slice(-request.limit);
        return {
          backend: "codex" as const,
          fetchedAt: 1_000,
          threadId: "thread-1",
          replay: {
            entries,
            messages: entries.flatMap((entry) =>
              entry.type === "message"
                ? [{ id: entry.id, role: entry.role, text: entry.text }]
                : []
            ),
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        };
      }),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_detail"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "latest-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.readThread,
        params: { backend: "codex", threadId: "thread-1", limit: 2 },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(backend.readThread).toHaveBeenNthCalledWith(1, {
      backend: "codex",
      threadId: "thread-1",
      limit: 2,
    });
    expect(backend.readThread).toHaveBeenNthCalledWith(2, {
      backend: "codex",
      threadId: "thread-1",
    });
    expect(backend.readThread).toHaveBeenCalledTimes(2);
    expect(replies[0]).toMatchObject({
      kind: "response",
      requestId: "latest-request",
      result: {
        replay: {
          entries: [{ id: "latest-user" }, { id: "latest-assistant" }],
          pagination: {
            supportsPagination: true,
            hasPreviousPage: true,
            previousCursor: "latest-user",
          },
        },
      },
    });
  });

  it("delegates bounded reads to backends with native pagination", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1_000,
      threadId: "thread-1",
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: true,
          hasPreviousPage: false,
        },
      },
    };
    const backend = {
      readThread: vi.fn(async () => response),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_detail"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "native-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.readThread,
        params: {
          backend: "codex",
          threadId: "thread-1",
          before: "cursor-1",
          limit: 2,
        },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(backend.readThread).toHaveBeenNthCalledWith(1, {
      backend: "codex",
      threadId: "thread-1",
      before: "cursor-1",
      limit: 2,
    });
    expect(backend.readThread).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(1);
  });

  it("compacts an oversized retained entry below the frame ceiling", async () => {
    const oversizedOutput = "x".repeat(FEDERATION_MAX_FRAME_BYTES);
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1_000,
      threadId: "thread-1",
      replay: {
        entries: [
          {
            type: "message",
            id: "older-message",
            role: "user",
            text: "Older history remains available through the cursor.",
          },
          {
            type: "activity",
            id: "oversized-activity",
            summary: "Ran a command",
            status: "completed",
            details: [
              {
                id: "oversized-command",
                kind: "command",
                label: "Generated verbose output",
                command: {
                  displayCommand: "verbose-command",
                  output: oversizedOutput,
                },
              },
            ],
          },
        ],
        messages: [
          {
            id: "older-message",
            role: "user",
            text: "Older history remains available through the cursor.",
          },
        ],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const backend = {
      readThread: vi.fn(async () => response),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_detail"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "oversized-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.readThread,
        params: { backend: "codex", threadId: "thread-1", limit: 5 },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: "response",
      requestId: "oversized-request",
      result: {
        replay: {
          entries: [
            {
              id: "oversized-activity",
              summary: expect.stringContaining("exceeded the federation frame limit"),
              details: [],
            },
          ],
          pagination: {
            supportsPagination: true,
            hasPreviousPage: true,
            previousCursor: "oversized-activity",
          },
        },
      },
    });
    const encryptedFrameBytes =
      Buffer.byteLength(
        JSON.stringify({ kind: "envelope", envelope: replies[0] }),
        "utf8",
      ) + 16;
    expect(encryptedFrameBytes).toBeLessThan(FEDERATION_MAX_FRAME_BYTES);
  });

  it("routes branch drift reads and mutations to the owning peer", async () => {
    const backend = {
      checkThreadBranchDrift: vi.fn(async (request) => ({
        ...request,
        checkedAt: 1_100,
        drifted: true,
        observedBranch: "main",
      })),
      updateThreadExpectedBranch: vi.fn(async (request) => ({
        ...request,
        updatedAt: 1_200,
      })),
      retainThreadBranchDrift: vi.fn(async (request) => ({
        ...request,
        retainedAt: 1_300,
      })),
    } as unknown as FederationBackendOperations;
    const ownerRouter = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    ownerRouter.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_navigation", "turn_control"],
      sendEnvelope: (envelope) => {
        rpc.receiveEnvelope(envelope);
      },
    });
    registerFederationBackendHandlers({ router: ownerRouter, backend });
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => {
        void ownerRouter.routeEnvelope({
          envelope,
          sourcePeerId: "viewer_one",
        });
      },
    });
    const client = new FederationRemoteBackendClient(rpc);

    await expect(client.checkThreadBranchDrift({
      backend: "codex",
      expectedBranch: "feature/expected",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      checkedAt: 1_100,
      drifted: true,
      observedBranch: "main",
    });
    await expect(client.updateThreadExpectedBranch({
      backend: "codex",
      branch: "main",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      branch: "main",
      updatedAt: 1_200,
    });
    await expect(client.retainThreadBranchDrift({
      backend: "codex",
      expectedBranch: "feature/expected",
      observedBranch: "main",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      retainedAt: 1_300,
    });

    expect(backend.checkThreadBranchDrift).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      expectedBranch: "feature/expected",
      threadId: "thread-1",
    });
    expect(backend.updateThreadExpectedBranch).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      branch: "main",
      threadId: "thread-1",
    });
    expect(backend.retainThreadBranchDrift).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      expectedBranch: "feature/expected",
      observedBranch: "main",
      threadId: "thread-1",
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.checkThreadBranchDrift
      ],
    ).toBe("thread_navigation");
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.updateThreadExpectedBranch
      ],
    ).toBe("turn_control");
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.retainThreadBranchDrift
      ],
    ).toBe("turn_control");
  });

  it("routes sub-agent stops to the owning peer with turn-control authorization", async () => {
    const backend = {
      stopSubAgent: vi.fn(async (request) => ({
        ...request,
        stoppedAt: 1_100,
      })),
    } as unknown as FederationBackendOperations;
    const ownerRouter = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    ownerRouter.registerConnection({
      peerId: "viewer_one",
      capabilities: ["turn_control"],
      sendEnvelope: (envelope) => {
        rpc.receiveEnvelope(envelope);
      },
    });
    registerFederationBackendHandlers({ router: ownerRouter, backend });
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => {
        void ownerRouter.routeEnvelope({
          envelope,
          sourcePeerId: "viewer_one",
        });
      },
    });
    const client = new FederationRemoteBackendClient(rpc);

    await expect(client.stopSubAgent({
      backend: "codex",
      threadId: "thread-1",
      monitorId: "monitor-1",
    })).resolves.toEqual({
      backend: "codex",
      threadId: "thread-1",
      monitorId: "monitor-1",
      stoppedAt: 1_100,
    });

    expect(backend.stopSubAgent).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      threadId: "thread-1",
      monitorId: "monitor-1",
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.stopSubAgent
      ],
    ).toBe("turn_control");
  });

  it("routes pin reorder over RPC with thread_navigation authorization", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);

    const pending = client.reorderThreadPins({
      threadKeys: ["codex:thread-2", "codex:thread-1"],
    });
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.reorderThreadPins,
      params: { threadKeys: ["codex:thread-2", "codex:thread-1"] },
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.reorderThreadPins
      ],
    ).toBe("thread_navigation");

    rpc.receiveEnvelope({
      id: "response-reorder",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        pinnedRanks: {
          "codex:thread-2": "a0",
          "codex:thread-1": "a1",
        },
      },
    });
    await expect(pending).resolves.toMatchObject({
      pinnedRanks: {
        "codex:thread-2": "a0",
        "codex:thread-1": "a1",
      },
    });
  });

  it("routes thread model migrations over RPC with turn_control authorization", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);

    const pending = client.applyThreadModelMigration({
      backend: "codex",
      threadId: "thread-1",
      threadCreatedAt: 900,
      threadModel: "gpt-5.5",
    });
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.applyThreadModelMigration,
      params: {
        backend: "codex",
        threadId: "thread-1",
        threadCreatedAt: 900,
        threadModel: "gpt-5.5",
      },
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.applyThreadModelMigration
      ],
    ).toBe("turn_control");

    rpc.receiveEnvelope({
      id: "response-migration",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        threadId: "thread-1",
        status: "applied",
      },
    });
    await expect(pending).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      status: "applied",
    });
  });

  it("routes PR detach over RPC with turn_control authorization", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);

    const pending = client.detachThreadPullRequest({
      backend: "codex",
      threadId: "thread-1",
      pr: { provider: "github.com", org: "pwrdrvr", repo: "PwrAgnt", number: 42 },
    });
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.detachThreadPullRequest,
      params: {
        backend: "codex",
        threadId: "thread-1",
        pr: { provider: "github.com", org: "pwrdrvr", repo: "PwrAgnt", number: 42 },
      },
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.detachThreadPullRequest
      ],
    ).toBe("turn_control");

    rpc.receiveEnvelope({
      id: "response-detach",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        threadId: "thread-1",
        detachedPrKeys: ["github.com:pwrdrvr/PwrAgnt#42"],
        prs: [],
      },
    });
    await expect(pending).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      detachedPrKeys: ["github.com:pwrdrvr/PwrAgnt#42"],
      prs: [],
    });
  });

  it("routes PR auto-dispatch over RPC with turn_control authorization", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);

    const pending = client.setThreadPrAutoDispatch({
      backend: "codex",
      threadId: "thread-1",
      enabled: true,
    });
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.setThreadPrAutoDispatch,
      params: {
        backend: "codex",
        threadId: "thread-1",
        enabled: true,
      },
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.setThreadPrAutoDispatch
      ],
    ).toBe("turn_control");

    rpc.receiveEnvelope({
      id: "response-auto-dispatch",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        threadId: "thread-1",
        enabled: true,
      },
    });
    await expect(pending).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      enabled: true,
    });
  });

  it("routes pending PR auto-dispatch cancel over RPC with turn_control authorization", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);

    const pending = client.cancelThreadPrAutoDispatch({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
    });
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.cancelThreadPrAutoDispatch,
      params: {
        backend: "codex",
        threadId: "thread-1",
        fingerprint: "fingerprint-1",
      },
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.cancelThreadPrAutoDispatch
      ],
    ).toBe("turn_control");

    rpc.receiveEnvelope({
      id: "response-auto-dispatch-cancel",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        threadId: "thread-1",
        fingerprint: "fingerprint-1",
        cancelled: true,
      },
    });
    await expect(pending).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
      cancelled: true,
    });
  });

  it("routes pending PR auto-dispatch send-now over RPC with turn_control authorization", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);

    const pending = client.sendThreadPrAutoDispatchNow({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
    });
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.sendThreadPrAutoDispatchNow,
      params: {
        backend: "codex",
        threadId: "thread-1",
        fingerprint: "fingerprint-1",
      },
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.sendThreadPrAutoDispatchNow
      ],
    ).toBe("turn_control");

    rpc.receiveEnvelope({
      id: "response-auto-dispatch-send-now",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        threadId: "thread-1",
        fingerprint: "fingerprint-1",
        accepted: true,
      },
    });
    await expect(pending).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
      accepted: true,
    });
  });

  it("serializes remote backend requests over RPC envelopes", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "gateway_one",
      remoteInstanceId: "client_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);
    const pending = client.listThreads({ backend: "codex" });

    expect(sent).toMatchObject([
      {
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.listThreads,
        params: { backend: "codex" },
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
      },
    ]);

    rpc.receiveEnvelope({
      id: "response-1",
      kind: "response",
      requestId: sent[0]!.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        fetchedAt: 1_100,
        threads: [],
      },
    });

    await expect(pending).resolves.toMatchObject({
      backend: "codex",
      threads: [],
    });

    const archivePending = client.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });
    const archiveRequest = sent.at(-1)!;
    expect(archiveRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.archiveThread,
      params: { backend: "codex", threadId: "thread-1" },
    });
    rpc.receiveEnvelope({
      id: "response-2",
      kind: "response",
      requestId: archiveRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_200,
      result: {
        backend: "codex",
        threadId: "thread-1",
        archivedAt: 1_200,
        cleanup: [],
      },
    });
    await expect(archivePending).resolves.toMatchObject({
      threadId: "thread-1",
      cleanup: [],
    });

    const refreshPending = client.refreshDirectoryGitStatuses({
      directoryKeys: ["directory:/remote/repo"],
      force: true,
    });
    const refreshRequest = sent.at(-1)!;
    expect(refreshRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.refreshDirectoryGitStatuses,
      params: {
        directoryKeys: ["directory:/remote/repo"],
        force: true,
      },
    });
    rpc.receiveEnvelope({
      id: "response-3",
      kind: "response",
      requestId: refreshRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_300,
      result: { scheduledCount: 1 },
    });
    await expect(refreshPending).resolves.toEqual({ scheduledCount: 1 });

    const cancelPending = client.cancelQueuedTurn({ queueEntryId: "queue-1" });
    const cancelRequest = sent.at(-1)!;
    expect(cancelRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.cancelQueuedTurn,
      params: { queueEntryId: "queue-1" },
    });
    rpc.receiveEnvelope({
      id: "response-4",
      kind: "response",
      requestId: cancelRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_400,
      result: {
        queueEntryId: "queue-1",
        cancelled: false,
        disposition: "already_admitted",
        turnId: "turn-1",
      },
    });
    await expect(cancelPending).resolves.toEqual({
      queueEntryId: "queue-1",
      cancelled: false,
      disposition: "already_admitted",
      turnId: "turn-1",
    });
  });

  it("routes transcript images back to their owning instance", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const ownerUrl =
      `pwragent-image://file/${encodeURIComponent("file:///Users/owner/.pwragent/profiles/default/state/image-inputs/image.png")}`;
    const transformedUrl =
      `pwragent-image://federation/owner_one/${encodeURIComponent(ownerUrl)}`;
    const transformReadThreadResponse = vi.fn((
      response: AppServerReadThreadResponse,
    ): AppServerReadThreadResponse => ({
      ...response,
      replay: {
        ...response.replay,
        messages: response.replay.messages.map((message) => ({
          ...message,
          parts: message.parts?.map((part) =>
            part.type === "image" ? { ...part, url: transformedUrl } : part,
          ),
        })),
      },
    }));
    const client = new FederationRemoteBackendClient(
      rpc,
      transformReadThreadResponse,
    );
    const readPending = client.readThread({
      backend: "codex",
      threadId: "thread-1",
    });
    const readRequest = sent.at(-1)!;
    rpc.receiveEnvelope({
      id: "response-read-thread",
      kind: "response",
      requestId: readRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        fetchedAt: 1_100,
        threadId: "thread-1",
        replay: {
          entries: [],
          messages: [{
            id: "message-1",
            role: "user",
            text: "image",
            parts: [{ type: "image", url: ownerUrl }],
          }],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      },
    });

    await expect(readPending).resolves.toMatchObject({
      replay: {
        messages: [{
          parts: [{
            type: "image",
            url: transformedUrl,
          }],
        }],
      },
    });
    expect(transformReadThreadResponse).toHaveBeenCalledTimes(1);

    const imagePending = client.readTranscriptImage({ url: ownerUrl });
    const imageRequest = sent.at(-1)!;
    expect(imageRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.readTranscriptImage,
      params: { url: ownerUrl },
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.readTranscriptImage
      ],
    ).toBe("thread_detail");
    rpc.receiveEnvelope({
      id: "response-image",
      kind: "response",
      requestId: imageRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_200,
      result: {
        dataBase64: "AQID",
        mimeType: "image/png",
      },
    });
    await expect(imagePending).resolves.toEqual({
      dataBase64: "AQID",
      mimeType: "image/png",
    });
  });

  it("executes directory Git status refreshes on the target instance", async () => {
    const backend = {
      refreshDirectoryGitStatuses: vi.fn(async () => ({ scheduledCount: 1 })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "refresh-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.refreshDirectoryGitStatuses,
        params: {
          directoryKeys: ["directory:/remote/repo"],
          force: true,
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_000,
      },
    });

    expect(backend.refreshDirectoryGitStatuses).toHaveBeenCalledExactlyOnceWith({
      directoryKeys: ["directory:/remote/repo"],
      force: true,
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "refresh-request",
        result: { scheduledCount: 1 },
      },
    ]);
  });

  it("routes mark-seen requests through the remote overlay owner", async () => {
    const backend = {
      markThreadSeen: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        seenAt: 2_000,
        seenUpdatedAt: 1_999,
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
      now: () => 2_000,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "mark-seen-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.markThreadSeen,
        params: {
          backend: "codex",
          threadId: "thread-1",
          seenUpdatedAt: 1_999,
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_000,
      },
    });

    expect(backend.markThreadSeen).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      seenUpdatedAt: 1_999,
    });
    expect(replies).toMatchObject([{
      kind: "response",
      requestId: "mark-seen-request",
      result: {
        backend: "codex",
        threadId: "thread-1",
        seenUpdatedAt: 1_999,
      },
    }]);

    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "gateway_one",
      remoteInstanceId: "client_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 3_000,
    });
    const client = new FederationRemoteBackendClient(rpc);
    const pending = client.markThreadSeen({
      backend: "codex",
      threadId: "thread-1",
      seenUpdatedAt: 1_999,
    });
    const request = sent[0]!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.markThreadSeen,
      params: {
        backend: "codex",
        threadId: "thread-1",
        seenUpdatedAt: 1_999,
      },
    });
    rpc.receiveEnvelope({
      id: "mark-seen-response",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 3_100,
      result: {
        backend: "codex",
        threadId: "thread-1",
        seenAt: 3_100,
        seenUpdatedAt: 1_999,
      },
    });
    await expect(pending).resolves.toMatchObject({
      threadId: "thread-1",
      seenUpdatedAt: 1_999,
    });
  });

  it("serializes scheduled action admission over the federation RPC", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "gateway_one",
      remoteInstanceId: "client_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);
    const request = {
      backend: "codex" as const,
      threadId: "thread-1",
      kind: "turn" as const,
      scheduledFor: 2_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text" as const, text: "Follow up" }] },
    };

    const pending = client.createScheduledThreadAction(request);
    const envelope = sent.at(-1)!;
    expect(envelope).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.createScheduledThreadAction,
      params: request,
      sourceInstanceId: "gateway_one",
      targetInstanceId: "client_one",
    });

    rpc.receiveEnvelope({
      id: "response-scheduled-1",
      kind: "response",
      requestId: envelope.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_100,
      result: {
        action: {
          ...request,
          id: "scheduled-1",
          origin: "desktop",
          status: "scheduled",
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });

    await expect(pending).resolves.toMatchObject({
      action: { id: "scheduled-1", status: "scheduled" },
    });
  });

  it("requires scheduled_actions independently from turn_control", async () => {
    const backend = {
      createScheduledThreadAction: vi.fn(),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["turn_control"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: {
        id: "request-scheduled-denied",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.createScheduledThreadAction,
        params: {
          backend: "codex",
          threadId: "thread-1",
          kind: "turn",
          scheduledFor: 3_000,
          displayText: "Follow up",
          turn: { input: [{ type: "text", text: "Follow up" }] },
        },
        protocolVersion: 1,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 1_000,
      },
    });

    expect(backend.createScheduledThreadAction).not.toHaveBeenCalled();
    expect(replies).toMatchObject([
      {
        kind: "error",
        requestId: "request-scheduled-denied",
        error: { code: "capability_denied" },
      },
    ]);
  });

  it("requires thread-detail capability for remote thread reads", async () => {
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({
      router,
      backend: {
        listThreads: vi.fn(),
        readThread: vi.fn(),
        listSkills: vi.fn(),
        listBackends: vi.fn(),
        startTurn: vi.fn(),
      } as unknown as FederationBackendOperations,
    });

    await expect(
      router.routeEnvelope({
        sourcePeerId: "client_one",
        envelope: {
          id: "request-1",
          kind: "request",
          method: FEDERATION_BACKEND_METHODS.readThread,
          params: { backend: "codex", threadId: "thread-1" },
          protocolVersion: 1,
          sourceInstanceId: "client_one",
          targetInstanceId: "gateway_one",
          createdAt: 1_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "capability_denied",
    });
  });

  it("serves transcript image bytes through a thread-detail handler", async () => {
    const backend = {
      readTranscriptImage: vi.fn(async () => ({
        dataBase64: "AQID",
        mimeType: "image/png",
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
      now: () => 2_000,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_detail"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });
    const url =
      "pwragent-image://file/file%3A%2F%2F%2FUsers%2Fowner%2Fimage.png";

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "request-image",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.readTranscriptImage,
        params: { url },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(backend.readTranscriptImage).toHaveBeenCalledWith({ url });
    expect(replies).toMatchObject([{
      kind: "response",
      requestId: "request-image",
      result: {
        dataBase64: "AQID",
        mimeType: "image/png",
      },
    }]);
  });

  it("maps remote turn submission to a turn-control guarded handler", async () => {
    const backend: FederationBackendOperations = {
      listThreads: vi.fn(),
      readThread: vi.fn(),
      listSkills: vi.fn(),
      startTurn: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        queueStatus: "started",
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: ["turn_control"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "request-1",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.startTurn,
        params: {
          backend: "codex",
          threadId: "thread-1",
          input: [{ type: "text", text: "ship it" }],
          messageOrigin: {
            kind: "agent",
            sourceThread: { backend: "codex", threadId: "source-thread" },
          },
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_000,
      },
    });

    expect(backend.startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "ship it" }],
      messageOrigin: {
        kind: "agent",
        sourceThread: { backend: "codex", threadId: "source-thread" },
      },
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "request-1",
        result: {
          backend: "codex",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
    ]);
  });

  it("resolves an exact thread id through thread_navigation", async () => {
    const resolveThread = vi.fn(async () => ({
      thread: {
        source: "codex" as const,
        id: "019fd821-1450-7952-85ca-3bb8e5d150da",
        title: "Thread list stays disabled after reconnect",
        linkedDirectories: [],
      },
    }));
    const backend = {
      resolveThread,
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "request-resolve",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.resolveThread,
        params: {
          backend: "codex",
          threadId: "019fd821-1450-7952-85ca-3bb8e5d150da",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(resolveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "019fd821-1450-7952-85ca-3bb8e5d150da",
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "request-resolve",
        result: {
          thread: {
            id: "019fd821-1450-7952-85ca-3bb8e5d150da",
            title: "Thread list stays disabled after reconnect",
          },
        },
      },
    ]);
  });

  it("maps expanded remote control operations to capability-guarded handlers", async () => {
    const backend: FederationBackendOperations = {
      getNavigationSnapshot: vi.fn(),
      listThreads: vi.fn(),
      resolveThread: vi.fn(),
      readThread: vi.fn(),
      readTranscriptImage: vi.fn(),
      listSkills: vi.fn(),
      listBackends: vi.fn(),
      markThreadSeen: vi.fn(),
      setThreadReaction: vi.fn(),
      setThreadPin: vi.fn(),
      reorderThreadPins: vi.fn(),
      detachThreadPullRequest: vi.fn(),
      setThreadPrAutoDispatch: vi.fn(),
      cancelThreadPrAutoDispatch: vi.fn(),
      sendThreadPrAutoDispatchNow: vi.fn(),
      archiveThread: vi.fn(),
      startThread: vi.fn(),
      forkThread: vi.fn(),
      startTurn: vi.fn(),
      cancelQueuedTurn: vi.fn(),
      startReview: vi.fn(),
      listScheduledThreadActions: vi.fn(),
      createScheduledThreadAction: vi.fn(),
      updateScheduledThreadAction: vi.fn(),
      cancelScheduledThreadAction: vi.fn(),
      sendScheduledThreadActionNow: vi.fn(),
      compactThread: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "compact-1",
      })),
      interruptTurn: vi.fn(),
      stopSubAgent: vi.fn(),
      steerTurn: vi.fn(),
      setThreadExecutionMode: vi.fn(),
      queueThreadExecutionMode: vi.fn(),
      cancelThreadExecutionModeQueue: vi.fn(),
      setAcpSessionRuntimeOption: vi.fn(),
      setThreadModelSettings: vi.fn(),
      applyThreadModelMigration: vi.fn(async (request) => ({
        ...request,
        status: "acknowledged-new-thread" as const,
      })),
      checkThreadBranchDrift: vi.fn(),
      updateThreadExpectedBranch: vi.fn(),
      retainThreadBranchDrift: vi.fn(),
      submitServerRequest: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        requestId: "approval-1",
      })),
      runCodexEnvironmentAction: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        codexEnvironmentRuntime: {
          environmentId: "node",
          environmentName: "Node",
          executionTarget: "local" as const,
        },
      })),
      stopCodexEnvironmentAction: vi.fn(),
      setCodexThreadEnvironment: vi.fn(),
      materializeDirectoryLaunchpad: vi.fn(),
      refreshDirectoryGitStatuses: vi.fn(),
      handoffThreadWorkspace: vi.fn(),
      renameThread: vi.fn(),
      readApplications: vi.fn(),
      openApplication: vi.fn(),
      readMessagingPlatformStatuses: vi.fn(),
      readPwrSnapConnectionStatus: vi.fn(),
      trustCodexProject: vi.fn(),
      setCelestialIcon: vi.fn(),
      starMapIntake: vi.fn(),
    };
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
      now: () => 2_000,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: [
        "turn_control",
        "pending_request_control",
        "environment_actions",
      ],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "compact-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.compactThread,
        params: { backend: "codex", threadId: "thread-1" },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_000,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "approval-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.submitServerRequest,
        params: {
          backend: "codex",
          threadId: "thread-1",
          requestId: "approval-1",
          response: { decision: "approve" },
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_100,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "migration-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.applyThreadModelMigration,
        params: {
          backend: "codex",
          threadId: "thread-1",
          threadCreatedAt: 1_000,
          threadModel: "gpt-5.6-sol",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_150,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "env-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.runCodexEnvironmentAction,
        params: {
          actionId: "start",
          backend: "codex",
          threadId: "thread-1",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_200,
      },
    });

    expect(backend.compactThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(backend.submitServerRequest).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      requestId: "approval-1",
      response: { decision: "approve" },
    });
    expect(backend.applyThreadModelMigration).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      threadCreatedAt: 1_000,
      threadModel: "gpt-5.6-sol",
    });
    expect(backend.runCodexEnvironmentAction).toHaveBeenCalledWith({
      actionId: "start",
      backend: "codex",
      threadId: "thread-1",
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "compact-request",
        result: { turnId: "compact-1" },
      },
      {
        kind: "response",
        requestId: "approval-request",
        result: { requestId: "approval-1" },
      },
      {
        kind: "response",
        requestId: "migration-request",
        result: { status: "acknowledged-new-thread" },
      },
      {
        kind: "response",
        requestId: "env-request",
        result: {
          codexEnvironmentRuntime: {
            environmentId: "node",
          },
        },
      },
    ]);
  });

  it("requires environment_actions for remote environment mutations", async () => {
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: ["turn_control"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({
      router,
      backend: {
        getNavigationSnapshot: vi.fn(),
        listThreads: vi.fn(),
        resolveThread: vi.fn(),
        readThread: vi.fn(),
        readTranscriptImage: vi.fn(),
        listSkills: vi.fn(),
        listBackends: vi.fn(),
        markThreadSeen: vi.fn(),
        setThreadReaction: vi.fn(),
      setThreadPin: vi.fn(),
      reorderThreadPins: vi.fn(),
        detachThreadPullRequest: vi.fn(),
        setThreadPrAutoDispatch: vi.fn(),
        cancelThreadPrAutoDispatch: vi.fn(),
        sendThreadPrAutoDispatchNow: vi.fn(),
        archiveThread: vi.fn(),
        startThread: vi.fn(),
        forkThread: vi.fn(),
        startTurn: vi.fn(),
        cancelQueuedTurn: vi.fn(),
        startReview: vi.fn(),
        listScheduledThreadActions: vi.fn(),
        createScheduledThreadAction: vi.fn(),
        updateScheduledThreadAction: vi.fn(),
        cancelScheduledThreadAction: vi.fn(),
        sendScheduledThreadActionNow: vi.fn(),
        compactThread: vi.fn(),
        interruptTurn: vi.fn(),
        stopSubAgent: vi.fn(),
        steerTurn: vi.fn(),
        setThreadExecutionMode: vi.fn(),
        queueThreadExecutionMode: vi.fn(),
        cancelThreadExecutionModeQueue: vi.fn(),
        setAcpSessionRuntimeOption: vi.fn(),
        setThreadModelSettings: vi.fn(),
        applyThreadModelMigration: vi.fn(),
        checkThreadBranchDrift: vi.fn(),
        updateThreadExpectedBranch: vi.fn(),
        retainThreadBranchDrift: vi.fn(),
        submitServerRequest: vi.fn(),
        runCodexEnvironmentAction: vi.fn(),
        stopCodexEnvironmentAction: vi.fn(),
        setCodexThreadEnvironment: vi.fn(),
        refreshDirectoryGitStatuses: vi.fn(),
        materializeDirectoryLaunchpad: vi.fn(),
        handoffThreadWorkspace: vi.fn(),
        renameThread: vi.fn(),
        readApplications: vi.fn(),
        openApplication: vi.fn(),
        readMessagingPlatformStatuses: vi.fn(),
        readPwrSnapConnectionStatus: vi.fn(),
        trustCodexProject: vi.fn(),
        setCelestialIcon: vi.fn(),
        starMapIntake: vi.fn(),
      } as FederationBackendOperations,
    });

    await expect(
      router.routeEnvelope({
        sourcePeerId: "gateway_one",
        envelope: {
          id: "env-request",
          kind: "request",
          method: FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment,
          params: {
            backend: "codex",
            environmentId: "node",
            threadId: "thread-1",
          },
          protocolVersion: 1,
          sourceInstanceId: "gateway_one",
          targetInstanceId: "client_one",
          createdAt: 1_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "capability_denied",
    });
    expect(replies).toMatchObject([
      {
        kind: "error",
        requestId: "env-request",
        error: { code: "capability_denied" },
      },
    ]);
  });

  it("routes remote thread renames and application operations to the target instance", async () => {
    const backend = {
      renameThread: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        renamedAt: 2_000,
      })),
      readApplications: vi.fn(async () => ({
        editors: [],
        terminals: [{
          id: "terminal",
          kind: "terminal" as const,
          name: "Terminal",
          source: "application" as const,
          canOpenWorkspace: true,
        }],
        preferredEditorId: { value: "", source: "default" as const },
        preferredTerminalId: { value: "", source: "default" as const },
        gh: {
          path: { value: "", source: "default" as const },
          discovery: { candidates: [] },
        },
        git: { discovery: { candidates: [] } },
      })),
      openApplication: vi.fn(async () => ({ opened: true as const })),
      trustCodexProject: vi.fn(async (request: TrustCodexProjectRequest) => ({
        ...request,
        trusted: true,
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: [
        "turn_control",
        "remote_window",
        "environment_actions",
      ],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "rename-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.renameThread,
        params: {
          backend: "codex",
          threadId: "thread-1",
          name: "Remote title",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_000,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "applications-read-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.readApplications,
        params: {},
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_050,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "application-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.openApplication,
        params: {
          applicationId: "terminal",
          kind: "terminal",
          targetPath: "/remote/repo",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_100,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "trust-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.trustCodexProject,
        params: {
          projectPath: "/remote/repo",
          configPath: "/remote/.codex/config.toml",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_200,
      },
    });

    expect(backend.renameThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      name: "Remote title",
    });
    expect(backend.readApplications).toHaveBeenCalledTimes(1);
    expect(backend.openApplication).toHaveBeenCalledWith({
      applicationId: "terminal",
      kind: "terminal",
      targetPath: "/remote/repo",
    });
    expect(backend.trustCodexProject).toHaveBeenCalledWith({
      projectPath: "/remote/repo",
      configPath: "/remote/.codex/config.toml",
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "rename-request",
        result: { renamedAt: 2_000 },
      },
      {
        kind: "response",
        requestId: "applications-read-request",
        result: {
          terminals: [{ id: "terminal" }],
        },
      },
      {
        kind: "response",
        requestId: "application-request",
        result: { opened: true },
      },
      {
        kind: "response",
        requestId: "trust-request",
        result: { trusted: true },
      },
    ]);
  });
});
