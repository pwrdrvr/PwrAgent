import { describe, expect, it, vi } from "vitest";
import type {
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AppServerTurnInputItem,
  FederationProtocolEnvelope,
  NavigationSnapshotTransportResponse,
  NavigationThreadSummary,
  TrustCodexProjectRequest,
} from "@pwragent/shared";
import {
  buildFederatedThreadRef,
  rankThreadJumpMatches,
} from "@pwragent/shared";
import {
  FEDERATION_BACKEND_METHODS,
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FEDERATION_LOAD_STATUS_TIMEOUT_MS,
  FEDERATION_RESPONSE_BYTE_BUDGET,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { FEDERATION_MAX_FRAME_BYTES } from "../federation/federation-transport";
import { pageNormalizedReplay } from "../app-server/thread-replay-pagination";

describe("federation backend bridge", () => {
  it("prepares start, steer, handoff, and Star Map attachments before remote RPC", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === FEDERATION_BACKEND_METHODS.startTurn) {
        return { backend: "codex", threadId: "thread-1", turnId: "turn-1" };
      }
      if (method === FEDERATION_BACKEND_METHODS.controlActiveTurn) {
        return {
          ok: true,
          backend: "codex",
          threadId: "thread-1",
          turnId: "turn-live",
          requestId: "steer-1",
          disposition: "steered",
        };
      }
      return { accepted: true, threadId: "manager-1" };
    });
    const prepare = vi.fn(async (input: readonly AppServerTurnInputItem[]) =>
      input.map((item, index) => item.type === "text"
        ? item
        : { type: "federationBlob" as const, transferId: `blob-${index}` }),
    );
    const client = new FederationRemoteBackendClient(
      { request } as unknown as FederationRpcEndpoint,
      (response) => response,
      prepare,
    );
    const image = {
      type: "localImage" as const,
      name: "screen.png",
      path: "/sender/staged/screen.png",
    };

    await client.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Inspect" }, image],
    });
    await client.controlActiveTurn({
      operation: "steer",
      backend: "codex",
      threadId: "thread-1",
      requestId: "steer-1",
      input: [{ type: "text", text: "Also inspect" }, image],
    });
    await client.materializeDirectoryLaunchpad({
      directoryKey: "dir:/repo",
      input: [{ type: "text", text: "Delegate" }, image],
    });
    await client.starMapIntake({
      requestId: "intake-1",
      request: "Create a manager",
      attachments: [image],
    });

    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: FEDERATION_BACKEND_METHODS.startTurn,
      params: expect.objectContaining({
        input: [
          { type: "text", text: "Inspect" },
          { type: "federationBlob", transferId: "blob-1" },
        ],
      }),
    }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: FEDERATION_BACKEND_METHODS.controlActiveTurn,
      params: expect.objectContaining({
        input: [
          { type: "text", text: "Also inspect" },
          { type: "federationBlob", transferId: "blob-1" },
        ],
      }),
    }));
    expect(request).toHaveBeenNthCalledWith(3, expect.objectContaining({
      method: FEDERATION_BACKEND_METHODS.materializeDirectoryLaunchpad,
      params: expect.objectContaining({
        directoryKey: "dir:/repo",
        input: [
          { type: "text", text: "Delegate" },
          { type: "federationBlob", transferId: "blob-1" },
        ],
      }),
    }));
    expect(request).toHaveBeenNthCalledWith(4, expect.objectContaining({
      method: FEDERATION_BACKEND_METHODS.starMapIntake,
      params: {
        requestId: "intake-1",
        request: "Create a manager",
        attachments: [{ type: "federationBlob", transferId: "blob-0" }],
      },
    }));
    expect(JSON.stringify(request.mock.calls)).not.toContain(image.path);
  });

  it("resolves verified steer refs and rejects raw peer Star Map paths", async () => {
    const controlActiveTurn = vi.fn(async (request) => ({
      ok: true as const,
      backend: request.backend,
      threadId: request.threadId,
      requestId: request.requestId,
      turnId: "turn-live",
      disposition: "steered" as const,
    }));
    const starMapIntake = vi.fn(async () => ({
      accepted: true,
      threadId: "manager-1",
    }));
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["turn_control", "environment_actions"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({
      router,
      backend: {
        controlActiveTurn,
        starMapIntake,
      } as unknown as FederationBackendOperations,
      resolveTurnInput: async (input) => {
        if (input.some((item) => item.type !== "federationBlob")) {
          throw new Error("Peer paths are forbidden.");
        }
        return [{
          type: "localImage",
          name: "screen.png",
          path: "/receiver/staged/screen.png",
        }];
      },
    });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "steer-with-blob",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.controlActiveTurn,
        params: {
          operation: "steer",
          backend: "codex",
          threadId: "thread-1",
          requestId: "steer-1",
          input: [{ type: "federationBlob", transferId: "blob-1" }],
        },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "star-map-with-path",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.starMapIntake,
        params: {
          requestId: "intake-1",
          request: "Create a manager",
          attachments: [{
            type: "localImage",
            path: "/peer/controlled/screen.png",
          }],
        },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_001,
      },
    });

    expect(controlActiveTurn).toHaveBeenCalledWith(expect.objectContaining({
      input: [{
        type: "localImage",
        name: "screen.png",
        path: "/receiver/staged/screen.png",
      }],
    }));
    expect(starMapIntake).not.toHaveBeenCalled();
    expect(replies).toContainEqual(expect.objectContaining({
      kind: "error",
      requestId: "star-map-with-path",
    }));
  });

  it("negotiates launchpad metadata separately from environment actions", () => {
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.ensureDirectoryLaunchpad
      ],
    ).toBe("launchpad_metadata");
  });

  it("routes targeted admission state through messaging_route", async () => {
    const resolveThreadAdmissionState = vi.fn(async () => ({
      threadStatus: "active" as const,
      activeTurn: {
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    }));
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["messaging_route"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({
      router,
      backend: {
        resolveThreadAdmissionState,
      } as unknown as FederationBackendOperations,
    });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "admission-state",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.resolveThreadAdmissionState,
        params: { backend: "codex", threadId: "thread-1" },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.resolveThreadAdmissionState
      ],
    ).toBe("messaging_route");
    expect(resolveThreadAdmissionState).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(replies).toContainEqual(
      expect.objectContaining({
        kind: "response",
        requestId: "admission-state",
        result: expect.objectContaining({ threadStatus: "active" }),
      }),
    );
  });

  it("does not expose profile-local thread model migrations over federation", () => {
    expect(FEDERATION_BACKEND_METHODS).not.toHaveProperty(
      "applyThreadModelMigration",
    );
    expect(FederationRemoteBackendClient.prototype).not.toHaveProperty(
      "applyThreadModelMigration",
    );
  });

  it("carries and authenticates Agent provenance for remote thread creation", async () => {
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "created-thread",
      executionMode: "default" as const,
      workMode: "local" as const,
      turnId: "created-turn",
    }));
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["environment_actions"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({
      router,
      backend: {
        materializeDirectoryLaunchpad,
      } as unknown as FederationBackendOperations,
      resolveSourceInstance: () => ({
        label: "Viewer Mac",
        celestialIcon: "moon",
      }),
    });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "materialize-thread",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.materializeDirectoryLaunchpad,
        params: {
          directoryKey: "dir:/repo",
          input: [{ type: "text", text: "Deploy the runner" }],
          messageOrigin: {
            kind: "agent",
            sourceThread: {
              backend: "codex",
              instanceId: "spoofed_instance",
              instanceLabel: "Spoofed Mac",
              threadId: "source-thread",
              title: "Runner rollout",
            },
          },
        },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      {
        directoryKey: "dir:/repo",
        input: [{ type: "text", text: "Deploy the runner" }],
      },
      expect.objectContaining({
        sourceInstanceId: "viewer_one",
        messageOrigin: {
          kind: "agent",
          sourceThread: {
            backend: "codex",
            instanceId: "viewer_one",
            instanceLabel: "Viewer Mac",
            celestialIcon: "moon",
            threadId: "source-thread",
            title: "Runner rollout",
          },
        },
      }),
    );
    expect(replies).toMatchObject([
      { kind: "response", requestId: "materialize-thread" },
    ]);
  });

  it("sends thread-creation provenance from the remote backend client", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
    });
    const client = new FederationRemoteBackendClient(rpc);
    const pending = client.materializeDirectoryLaunchpad(
      {
        directoryKey: "dir:/repo",
        input: [{ type: "text", text: "Deploy the runner" }],
      },
      {
        messageOrigin: {
          kind: "agent",
          sourceThread: {
            backend: "codex",
            threadId: "source-thread",
          },
        },
      },
    );
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      method: FEDERATION_BACKEND_METHODS.materializeDirectoryLaunchpad,
      params: {
        directoryKey: "dir:/repo",
        input: [{ type: "text", text: "Deploy the runner" }],
        messageOrigin: {
          kind: "agent",
          sourceThread: {
            backend: "codex",
            threadId: "source-thread",
          },
        },
      },
    });

    rpc.receiveEnvelope({
      id: "materialize-response",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        threadId: "created-thread",
        executionMode: "default",
        workMode: "local",
        turnId: "created-turn",
      },
    });
    await expect(pending).resolves.toMatchObject({
      threadId: "created-thread",
      turnId: "created-turn",
    });
  });

  it("rejects grouping RPCs from a legacy thread-navigation peer", async () => {
    const backend = {
      updateSubthreadOrder: vi.fn(),
      setSubthreadsCollapsed: vi.fn(),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "legacy_viewer",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    for (const [id, method, params] of [
      [
        "order",
        FEDERATION_BACKEND_METHODS.updateSubthreadOrder,
        {
          backend: "codex",
          parentThreadId: "thread-parent",
          threadIds: ["thread-child"],
        },
      ],
      [
        "collapse",
        FEDERATION_BACKEND_METHODS.setSubthreadsCollapsed,
        {
          backend: "codex",
          parentThreadId: "thread-parent",
          collapsed: true,
        },
      ],
    ] as const) {
      await router.routeEnvelope({
        sourcePeerId: "legacy_viewer",
        envelope: {
          id,
          kind: "request",
          method,
          params,
          protocolVersion: 1,
          sourceInstanceId: "legacy_viewer",
          targetInstanceId: "owner_one",
          createdAt: 1_000,
        },
      });
    }

    expect(backend.updateSubthreadOrder).not.toHaveBeenCalled();
    expect(backend.setSubthreadsCollapsed).not.toHaveBeenCalled();
    expect(replies).toMatchObject([
      {
        kind: "error",
        requestId: "order",
        error: {
          code: "capability_denied",
          message: expect.stringContaining("thread_grouping"),
        },
      },
      {
        kind: "error",
        requestId: "collapse",
        error: {
          code: "capability_denied",
          message: expect.stringContaining("thread_grouping"),
        },
      },
    ]);
  });

  it("preserves encoded ACP navigation keys on the protocol-v1 wire", async () => {
    const backend = {
      getNavigationSnapshot: vi.fn(async () => ({
        backend: "all" as const,
        fetchedAt: 1_000,
        unchanged: false,
        threads: [],
        inboxThreadKeys: ["acp:grok:thread-1"],
        directories: [{
          key: "directory-1",
          kind: "directory" as const,
          label: "Project",
          threadKeys: ["acp:grok:thread-1"],
          needsAttentionCount: 0,
        }],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "navigation-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.getNavigationSnapshot,
        params: {},
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(replies[0]).toMatchObject({
      kind: "response",
      result: {
        inboxThreadKeys: ["acp%3Agrok:thread-1"],
        directories: [{
          threadKeys: ["acp%3Agrok:thread-1"],
        }],
      },
    });
  });

  it("filters and bounds jump-search navigation rows before crossing the wire", async () => {
    const threads = Array.from({ length: 1_200 }, (_, index) => ({
      id: `thread-${index}`,
      title: `Unrelated ${index}`,
      titleSource: "explicit" as const,
      linkedDirectories: [],
      source: "codex" as const,
      inbox: { inInbox: false },
      createdAt: index,
      updatedAt: index,
      ...(index === 553
        ? {
            prs: [{
              provider: "github.com",
              number: 553,
              org: "pwrdrvr",
              repo: "PwrAgent",
              state: "pending" as const,
              url: "https://github.com/pwrdrvr/PwrAgent/pull/553",
            }],
          }
        : {}),
    } satisfies NavigationThreadSummary));
    const backend = {
      getNavigationSnapshot: vi.fn(async () => ({
        backend: "all" as const,
        fetchedAt: 1_000,
        unchanged: false,
        threads,
        inboxThreadKeys: [],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })),
      searchNavigationThreads: vi.fn(async (request) => ({
        results: rankThreadJumpMatches(threads, request.query).slice(
          0,
          request.limit ?? 8,
        ),
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "jump-search",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.searchNavigationThreads,
        params: { query: "553", limit: 8 },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(replies[0]).toMatchObject({
      kind: "response",
      result: {
        results: [{ id: "thread-553" }],
      },
    });
    expect(JSON.stringify(replies[0]).length).toBeLessThan(
      JSON.stringify(threads).length / 100,
    );
    expect(backend.searchNavigationThreads).toHaveBeenCalledWith({
      query: "553",
      limit: 8,
    });
    expect(backend.getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("reports bounded search as unsupported without building a full snapshot", async () => {
    const backend = {
      getNavigationSnapshot: vi.fn(),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "jump-search-unsupported",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.searchNavigationThreads,
        params: { query: "553", limit: 8 },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(replies[0]).toMatchObject({
      kind: "error",
      error: { code: "method_not_found" },
    });
    expect(backend.getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("routes generic search filters to a bounded owner response", async () => {
    const match = {
      id: "thread-553",
      title: "Collector result",
      titleSource: "explicit" as const,
      linkedDirectories: [],
      source: "codex" as const,
      projectKey: "PwrSuiteLab",
      updatedAt: 5_000,
    };
    const listThreads = vi.fn();
    const searchFederatedThreads = vi.fn(async () => ({
      threads: [match],
      totalCount: 1_200,
      truncated: true,
    }));
    const backend = {
      getNavigationSnapshot: vi.fn(),
      listThreads,
      searchFederatedThreads,
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["federated_search"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });
    const request = {
      query: "collector",
      backend: "codex" as const,
      includeArchived: true,
      projectKeys: ["PwrSuiteLab"],
      updatedAfter: 4_000,
      updatedBefore: 6_000,
      limit: 10,
    };

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "generic-search",
        deadlineAt: Date.now() + 10_000,
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.searchFederatedThreads,
        params: request,
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(replies[0]).toMatchObject({
      kind: "response",
      result: {
        threads: [{ id: "thread-553" }],
        totalCount: 1_200,
        truncated: true,
      },
    });
    expect(searchFederatedThreads).toHaveBeenCalledWith(request, {
      deadlineAt: expect.any(Number),
    });
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("sends unchanged and sparse navigation responses instead of full Federation payloads", async () => {
    const buildThread = (index: number): NavigationThreadSummary => ({
      id: `thread-${index}`,
      title: `Thread ${index}`,
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      inbox: { inInbox: true, reason: "new-thread" },
      createdAt: index,
      updatedAt: index,
    });
    let threads = Array.from({ length: 1_200 }, (_, index) =>
      buildThread(index),
    );
    let fetchedAt = 1_000;
    const backend = {
      getNavigationSnapshot: vi.fn(async () => ({
        backend: "all" as const,
        fetchedAt: fetchedAt++,
        unchanged: false,
        threads,
        inboxThreadKeys: threads.map((thread) => `codex:${thread.id}`),
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    router.registerConnection({
      peerId: "viewer_two",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });
    const request = async (
      id: string,
      baseRevision?: string,
      peerId = "viewer_one",
      threadKeys?: string[],
    ): Promise<NavigationSnapshotTransportResponse> => {
      await router.routeEnvelope({
        sourcePeerId: peerId,
        envelope: {
          id,
          kind: "request",
          method: FEDERATION_BACKEND_METHODS.getNavigationSnapshot,
          params: {
            transport: {
              protocol: 1,
              ...(baseRevision ? { baseRevision } : {}),
              ...(threadKeys
                ? { selection: { kind: "threads", threadKeys } }
                : {}),
            },
          },
          protocolVersion: 1,
          sourceInstanceId: peerId,
          targetInstanceId: "owner_one",
          createdAt: 1_000,
        },
      });
      return (replies.at(-1) as { result: NavigationSnapshotTransportResponse })
        .result;
    };

    const full = await request("navigation-full");
    if (full.kind !== "full") throw new Error("Expected a full baseline");
    const unchanged = await request(
      "navigation-unchanged",
      full.revision,
      "viewer_two",
    );
    const sparse = await request(
      "navigation-sparse",
      undefined,
      "viewer_two",
      ["codex:thread-3", "codex:thread-9"],
    );

    expect(unchanged).toEqual({
      kind: "unchanged",
      revision: full.revision,
    });
    expect(JSON.stringify(unchanged).length).toBeLessThan(
      JSON.stringify(full).length / 1_000,
    );
    if (sparse.kind !== "full") throw new Error("Expected sparse baseline");
    expect(sparse.revision).toBe(full.revision);
    expect(sparse.snapshot.threads.map((thread) => thread.id)).toEqual([
      "thread-3",
      "thread-9",
    ]);

    threads = threads.map((thread, index) =>
      index < 10
        ? { ...thread, title: `${thread.title} updated` }
        : thread,
    );
    const delta = await request("navigation-delta", full.revision);

    expect(delta.kind).toBe("delta");
    if (delta.kind !== "delta") throw new Error("Expected a sparse delta");
    expect(delta.upsertedThreads).toHaveLength(10);
    expect(delta.removedThreadKeys).toEqual([]);
    expect(delta.threadKeys).toBeUndefined();
    expect(JSON.stringify(delta).length).toBeLessThan(
      JSON.stringify(full).length / 50,
    );
    expect(backend.getNavigationSnapshot).toHaveBeenLastCalledWith({
      forceRefresh: undefined,
      refreshMode: "full",
    });
  });

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

  it("queries on-demand load through thread_navigation with a tight deadline", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);

    const pending = client.getLoadStatus();
    const request = sent.at(-1)!;
    expect(request).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.getLoadStatus,
      params: {},
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.getLoadStatus
      ],
    ).toBe("thread_navigation");
    // Load queries carry the short leash, not the default 30s one —
    // fleet fan-outs degrade on a slow peer instead of stalling.
    expect(request.deadlineAt).toBe(1_000 + FEDERATION_LOAD_STATUS_TIMEOUT_MS);

    rpc.receiveEnvelope({
      id: "response-load",
      kind: "response",
      requestId: request.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: {
        loadAvg1: 2.5,
        loadAvg5: 1.75,
        loadAvg15: 1.5,
        availableMemoryBytes: 8_000_000_000,
        diskFreeBytes: 250_000_000_000,
        sampledAt: 1_050,
      },
    });
    await expect(pending).resolves.toMatchObject({
      loadAvg1: 2.5,
      availableMemoryBytes: 8_000_000_000,
      sampledAt: 1_050,
    });
  });

  it("routes unpublished commit summaries and diffs through thread-detail RPC", async () => {
    const listWorktreeUnpublishedCommits = vi.fn(async () => ({
      commits: [],
      totalCommits: 0,
      truncated: false,
      maxCommits: 20,
      maxFilesPerCommit: 50,
    }));
    const getWorktreeUnpublishedCommitDiff = vi.fn(async () => ({
      detail: undefined,
    }));
    const backend = {
      listWorktreeUnpublishedCommits,
      getWorktreeUnpublishedCommitDiff,
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
    const baseRequest = {
      backend: "codex" as const,
      threadId: "thread-1",
      worktreePath: "/remote/repo",
    };

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "list-unpublished",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.listWorktreeUnpublishedCommits,
        params: baseRequest,
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "read-unpublished-diff",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.getWorktreeUnpublishedCommitDiff,
        params: {
          ...baseRequest,
          commitSha: "a".repeat(40),
          path: "/remote/repo/file.ts",
        },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_100,
      },
    });

    expect(listWorktreeUnpublishedCommits).toHaveBeenCalledWith(baseRequest);
    expect(getWorktreeUnpublishedCommitDiff).toHaveBeenCalledWith({
      ...baseRequest,
      commitSha: "a".repeat(40),
      path: "/remote/repo/file.ts",
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.listWorktreeUnpublishedCommits
      ],
    ).toBe("thread_detail");
    expect(replies).toMatchObject([
      { kind: "response", requestId: "list-unpublished" },
      { kind: "response", requestId: "read-unpublished-diff" },
    ]);
  });

  it("sends unpublished commit reads from the remote backend client", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
    });
    const client = new FederationRemoteBackendClient(rpc);
    const request = {
      backend: "codex" as const,
      threadId: "thread-1",
      worktreePath: "/remote/repo",
    };

    const pending = client.listWorktreeUnpublishedCommits(request);
    const envelope = sent.at(-1)!;
    expect(envelope).toMatchObject({
      method: FEDERATION_BACKEND_METHODS.listWorktreeUnpublishedCommits,
      params: request,
    });
    rpc.receiveEnvelope({
      id: "list-response",
      kind: "response",
      requestId: envelope.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_000,
      result: {
        commits: [],
        totalCommits: 0,
        truncated: false,
        maxCommits: 20,
        maxFilesPerCommit: 50,
      },
    });

    await expect(pending).resolves.toMatchObject({ totalCommits: 0 });
  });

  it("maps federation backend methods to local app-server operations", async () => {
    const backend: FederationBackendOperations = {
      listThreads: vi.fn(async () => ({
        backend: "codex",
        fetchedAt: 1_000,
        threads: [],
      })),
      readThread: vi.fn(),
      analyzeThreadToolHistory: vi.fn(),
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
      readQueuedTurn: vi.fn(),
      cancelQueuedTurn: vi.fn(async ({ queueEntryId }) => ({
        queueEntryId,
        cancelled: true,
      })),
      releaseQueuedTurn: vi.fn(async ({ queueEntryId }) => ({
        queueEntryId,
        disposition: "started" as const,
        turnId: "turn-released-1",
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
    registerFederationBackendHandlers({
      router,
      backend,
      resolveSourceInstance: () => ({
        label: "Client Mac",
        celestialIcon: "moon",
      }),
    });

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
          turn: {
            input: [{ type: "text", text: "Follow up" }],
            messageOrigin: {
              kind: "agent",
              sourceThread: {
                backend: "codex",
                instanceId: "spoofed_instance",
                instanceLabel: "Spoofed Mac",
                celestialIcon: "black-hole",
                threadId: "source-thread",
                title: "Source thread",
              },
            },
          },
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
        id: "request-4",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.releaseQueuedTurn,
        params: { queueEntryId: "held-queue-1" },
        protocolVersion: 1,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 1_300,
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
    expect(backend.releaseQueuedTurn).toHaveBeenCalledWith({
      queueEntryId: "held-queue-1",
    });
    expect(backend.createScheduledThreadAction).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        turn: {
          input: [{ type: "text", text: "Follow up" }],
          messageOrigin: {
            kind: "agent",
            sourceThread: {
              backend: "codex",
              instanceId: "client_one",
              instanceLabel: "Client Mac",
              celestialIcon: "moon",
              threadId: "source-thread",
              title: "Source thread",
            },
          },
        },
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
        requestId: "request-4",
        result: {
          queueEntryId: "held-queue-1",
          disposition: "started",
          turnId: "turn-released-1",
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
          readDurationMs: request.limit === undefined ? 3 : 17,
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
        readDurationMs: 20,
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

  it("hands back a provider cursor when the trim leaves an overlay row leading", async () => {
    // Two entries that together overflow the frame budget while the newer one
    // fits inside it on its own, so the trim has to stop between them. A
    // message's text is measured three times over — in `entries`, in
    // `messages`, and again as `lastUserMessage` / `lastAssistantMessage`.
    const olderLargeText = "o".repeat(
      Math.floor(FEDERATION_RESPONSE_BYTE_BUDGET * 0.28),
    );
    const newestLargeText = "n".repeat(
      Math.floor(FEDERATION_RESPONSE_BYTE_BUDGET * 0.25),
    );
    // What the ACP provider itself holds. `before` is resolved against this,
    // so an id that is not in this list is an id no read can answer.
    const providerEntries: AppServerReadThreadResponse["replay"]["entries"] = [
      { type: "message", id: "entry-1", role: "user", text: "First" },
      { type: "message", id: "entry-2", role: "assistant", text: "Second" },
      { type: "message", id: "entry-3", role: "assistant", text: olderLargeText },
      { type: "message", id: "entry-4", role: "user", text: newestLargeText },
    ];
    // The persisted turn total, spliced in after the provider entry that
    // closes its turn — the same shape `mergeImmutableUsageActivities` builds.
    const usageActivity: AppServerReadThreadResponse["replay"]["entries"][number] = {
      type: "activity",
      id: "live-turn-usage-turn-1",
      summary: "Turn usage: 100 uncached in · 20 out",
      status: "completed",
      details: [],
    };
    const backend = {
      readThread: vi.fn(async (request: AppServerReadThreadRequest) => {
        // Mirrors readAcpThread: page the provider's own replay, then merge
        // the overlay rows in — but only for a live read. readAcpThread gates
        // that merge on `!request.before`, so an older page never carries them.
        const page = pageNormalizedReplay(
          {
            entries: providerEntries,
            messages: providerEntries.flatMap((entry) =>
              entry.type === "message"
                ? [{ id: entry.id, role: entry.role, text: entry.text }]
                : [],
            ),
            pagination: { supportsPagination: false, hasPreviousPage: false },
          },
          request,
        );
        const anchorIndex = request.before === undefined
          ? page.entries.findIndex((entry) => entry.id === "entry-3")
          : -1;
        const entries = anchorIndex === -1
          ? page.entries
          : [
              ...page.entries.slice(0, anchorIndex + 1),
              usageActivity,
              ...page.entries.slice(anchorIndex + 1),
            ];
        return {
          backend: "acp:claude-code" as const,
          fetchedAt: 1_000,
          threadId: "thread-1",
          replay: { ...page, entries },
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
        params: { backend: "acp:claude-code", threadId: "thread-1" },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    const latestReplay = (replies[0] as { result: AppServerReadThreadResponse })
      .result.replay;
    // The trim stopped on the overlay row, which is exactly where naming the
    // page's first entry would mint a cursor the provider has never seen.
    expect(latestReplay.entries.map((entry) => entry.id)).toEqual([
      "live-turn-usage-turn-1",
      "entry-4",
    ]);
    expect(latestReplay.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: true,
      previousCursor: "entry-4",
    });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "older-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.readThread,
        params: {
          backend: "acp:claude-code",
          threadId: "thread-1",
          before: latestReplay.pagination.previousCursor,
        },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_100,
      },
    });

    const olderReplay = (replies[1] as { result: AppServerReadThreadResponse })
      .result.replay;
    // Older history, not the newest page handed back a second time. No overlay
    // row here: readAcpThread merges those only into a live read.
    expect(olderReplay.entries.map((entry) => entry.id)).toEqual([
      "entry-1",
      "entry-2",
      "entry-3",
    ]);
    expect(olderReplay.pagination).toEqual({
      supportsPagination: true,
      hasPreviousPage: false,
    });
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

  it("routes child mounts and parent changes to the owning instance", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer_one",
      remoteInstanceId: "owner_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);
    const ref = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "child_one",
      threadId: "thread-child",
    });
    const summary = {
      source: "codex" as const,
      id: "thread-child",
      title: "Child",
      titleSource: "fallback" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
      parentThreadId: "thread-root",
      parentThreadBackend: "codex" as const,
      parentThreadInstanceId: "owner_one",
    };

    const mountPending = client.mountRemoteChild({
      ref,
      summary,
      instanceLabel: "Child Mac",
    });
    const mountRequest = sent.at(-1)!;
    expect(mountRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.mountRemoteChild,
      params: { ref, summary, instanceLabel: "Child Mac" },
    });
    rpc.receiveEnvelope({
      id: "response-mount-child",
      kind: "response",
      requestId: mountRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_100,
      result: { mounted: true },
    });
    await expect(mountPending).resolves.toEqual({ mounted: true });

    const parentPending = client.setThreadParent({
      backend: "codex",
      threadId: "thread-child",
      parentThreadId: null,
    });
    const parentRequest = sent.at(-1)!;
    expect(parentRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.setThreadParent,
      params: {
        backend: "codex",
        threadId: "thread-child",
        parentThreadId: null,
      },
    });
    rpc.receiveEnvelope({
      id: "response-clear-parent",
      kind: "response",
      requestId: parentRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_200,
      result: { backend: "codex", threadId: "thread-child" },
    });
    await expect(parentPending).resolves.toEqual({
      backend: "codex",
      threadId: "thread-child",
    });

    const orderPending = client.updateSubthreadOrder({
      backend: "codex",
      parentThreadId: "thread-root",
      threadIds: ["thread-child", "thread-sibling"],
    });
    const orderRequest = sent.at(-1)!;
    expect(orderRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.updateSubthreadOrder,
      params: {
        backend: "codex",
        parentThreadId: "thread-root",
        threadIds: ["thread-child", "thread-sibling"],
      },
    });
    rpc.receiveEnvelope({
      id: "response-order-children",
      kind: "response",
      requestId: orderRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_300,
      result: {
        backend: "codex",
        parentThreadId: "thread-root",
        threadIds: ["thread-child", "thread-sibling"],
      },
    });
    await expect(orderPending).resolves.toMatchObject({
      threadIds: ["thread-child", "thread-sibling"],
    });

    const collapsedPending = client.setSubthreadsCollapsed({
      backend: "codex",
      parentThreadId: "thread-root",
      collapsed: false,
    });
    const collapsedRequest = sent.at(-1)!;
    expect(collapsedRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.setSubthreadsCollapsed,
      params: {
        backend: "codex",
        parentThreadId: "thread-root",
        collapsed: false,
      },
    });
    rpc.receiveEnvelope({
      id: "response-expand-children",
      kind: "response",
      requestId: collapsedRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 1_400,
      result: {
        backend: "codex",
        parentThreadId: "thread-root",
        collapsed: false,
      },
    });
    await expect(collapsedPending).resolves.toMatchObject({ collapsed: false });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.mountRemoteChild
      ],
    ).toBe("thread_navigation");
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.setThreadParent
      ],
    ).toBe("thread_navigation");
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.updateSubthreadOrder
      ],
    ).toBe("thread_grouping");
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.setSubthreadsCollapsed
      ],
    ).toBe("thread_grouping");
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

    const refreshPrPending = client.refreshThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      trigger: "user",
    });
    const refreshPrRequest = sent.at(-1)!;
    expect(refreshPrRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.refreshThreadPullRequests,
      params: {
        backend: "codex",
        threadId: "thread-1",
        trigger: "user",
      },
    });
    rpc.receiveEnvelope({
      id: "response-pr-refresh",
      kind: "response",
      requestId: refreshPrRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_350,
      result: {
        backend: "codex",
        threadId: "thread-1",
        provider: "github.com",
        ghAvailable: true,
        prs: [],
      },
    });
    await expect(refreshPrPending).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      prs: [],
    });

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

    const releasePending = client.releaseQueuedTurn({
      queueEntryId: "held-queue-1",
    });
    const releaseRequest = sent.at(-1)!;
    expect(releaseRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.releaseQueuedTurn,
      params: { queueEntryId: "held-queue-1" },
    });
    rpc.receiveEnvelope({
      id: "response-release",
      kind: "response",
      requestId: releaseRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_500,
      result: {
        queueEntryId: "held-queue-1",
        disposition: "started",
        turnId: "turn-released-1",
      },
    });
    await expect(releasePending).resolves.toEqual({
      queueEntryId: "held-queue-1",
      disposition: "started",
      turnId: "turn-released-1",
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

  it("executes pull-request refreshes on the target instance", async () => {
    const refreshThreadPullRequests = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      provider: "github.com" as const,
      ghAvailable: true,
      prs: [],
    }));
    const backend = {
      refreshThreadPullRequests,
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "owner_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "viewer_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "viewer_one",
      envelope: {
        id: "refresh-pr-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.refreshThreadPullRequests,
        params: {
          backend: "codex",
          threadId: "thread-1",
          trigger: "user",
          branch: "fix/remote-pr-hover",
          directoryPaths: ["/remote/repo"],
          federationTarget: {
            scope: "remote",
            instanceId: "untrusted-relay-target",
          },
        },
        protocolVersion: 1,
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
        createdAt: 1_000,
      },
    });

    expect(refreshThreadPullRequests).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      threadId: "thread-1",
      trigger: "user",
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "refresh-pr-request",
        result: {
          backend: "codex",
          threadId: "thread-1",
          provider: "github.com",
          ghAvailable: true,
          prs: [],
        },
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
        analyzeThreadToolHistory: vi.fn(),
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
      analyzeThreadToolHistory: vi.fn(),
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
    registerFederationBackendHandlers({
      router,
      backend,
      resolveSourceInstance: () => ({
        label: "Gateway Mac",
        celestialIcon: "moon",
      }),
    });

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
            sourceThread: {
              backend: "codex",
              instanceId: "spoofed_instance",
              instanceLabel: "Spoofed Mac",
              celestialIcon: "black-hole",
              threadId: "source-thread",
            },
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
        sourceThread: {
          backend: "codex",
          instanceId: "gateway_one",
          instanceLabel: "Gateway Mac",
          celestialIcon: "moon",
          threadId: "source-thread",
        },
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
      analyzeThreadToolHistory: vi.fn(),
      readTranscriptImage: vi.fn(),
      listSkills: vi.fn(),
      listBackends: vi.fn(),
      markThreadSeen: vi.fn(),
      setThreadReaction: vi.fn(),
      setThreadPin: vi.fn(),
      reorderThreadPins: vi.fn(),
      mountRemoteChild: vi.fn(),
      setThreadParent: vi.fn(),
      updateSubthreadOrder: vi.fn(),
      setSubthreadsCollapsed: vi.fn(),
      detachThreadPullRequest: vi.fn(),
      setThreadPrAutoDispatch: vi.fn(),
      cancelThreadPrAutoDispatch: vi.fn(),
      sendThreadPrAutoDispatchNow: vi.fn(),
      archiveThread: vi.fn(),
      startThread: vi.fn(),
      forkThread: vi.fn(),
      startTurn: vi.fn(),
      readQueuedTurn: vi.fn(async () => ({ queueEntryId: "queue-full", contentHash: "hash", input: [{ type: "text" as const, text: "# Full Ω\n\n" + "rich content ".repeat(100) }] })),
      cancelQueuedTurn: vi.fn(),
      releaseQueuedTurn: vi.fn(),
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
      listThreadMcpServers: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        detail: "full" as const,
        servers: [
          {
            name: "atlassian-rovo",
            authStatus: "oAuth" as const,
            tools: ["search"],
            resources: [],
            resourceTemplates: [],
          },
        ],
      })),
      reloadCodexMcpConfig: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        queued: true as const,
      })),
      controlActiveTurn: vi.fn(async (request) => ({
        ok: true as const,
        backend: request.backend,
        threadId: request.threadId,
        requestId: request.requestId,
        turnId: "turn-live",
        disposition: "interrupted" as const,
      })),
      resolveActiveTurn: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "turn-live",
      })),
      interruptTurn: vi.fn(),
      stopSubAgent: vi.fn(),
      steerTurn: vi.fn(),
      setThreadExecutionMode: vi.fn(),
      queueThreadExecutionMode: vi.fn(),
      cancelThreadExecutionModeQueue: vi.fn(),
      setAcpSessionRuntimeOption: vi.fn(),
      setThreadModelSettings: vi.fn(),
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
      refreshThreadPullRequests: vi.fn(),
      materializeDirectoryLaunchpad: vi.fn(),
      refreshDirectoryGitStatuses: vi.fn(),
      ensureDirectoryLaunchpad: vi.fn(),
      listRecentFileReferences: vi.fn(),
      recordRecentFileReferences: vi.fn(),
      listModelSettingsRecents: vi.fn(),
      recordModelSettingsRecent: vi.fn(),
      attachDirectoryToThread: vi.fn(),
      listWorktreeUnpublishedCommits: vi.fn(),
      getWorktreeUnpublishedCommitDiff: vi.fn(),
      handoffThreadWorkspace: vi.fn(),
      renameThread: vi.fn(),
      readApplications: vi.fn(),
      openApplication: vi.fn(),
      readMessagingPlatformStatuses: vi.fn(),
      readPwrSnapConnectionStatus: vi.fn(),
      trustCodexProject: vi.fn(),
      setCelestialIcon: vi.fn(),
      starMapIntake: vi.fn(),
      getLoadStatus: vi.fn(),
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
        "thread_detail",
        "turn_control",
        "pending_request_control",
        "environment_actions",
      ],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({
      router,
      backend,
      resolveSourceInstance: () => ({
        label: "Gateway Mac",
        celestialIcon: "moon",
      }),
    });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "read-queued-request", kind: "request", method: FEDERATION_BACKEND_METHODS.readQueuedTurn,
        params: { backend: "codex", threadId: "thread-1", queueEntryId: "queue-full", forEdit: true },
        protocolVersion: 1, sourceInstanceId: "gateway_one", targetInstanceId: "client_one", createdAt: 1_000,
      },
    });
    expect(backend.readQueuedTurn).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1", queueEntryId: "queue-full", forEdit: true });
    const queuedReply = replies.pop();
    expect(JSON.stringify(queuedReply)).toContain("rich content ".repeat(100));

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
        id: "mcp-inventory-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.listThreadMcpServers,
        params: {
          backend: "codex",
          threadId: "thread-1",
          detail: "full",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_010,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "mcp-reload-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.reloadCodexMcpConfig,
        params: { backend: "codex", threadId: "thread-1" },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_020,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "control-active-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.controlActiveTurn,
        params: {
          operation: "steer",
          backend: "codex",
          threadId: "thread-1",
          requestId: "steer-1",
          expectedTurnId: "turn-live",
          input: [{ type: "text", text: "Report progress." }],
          messageOrigin: {
            kind: "agent",
            sourceThread: {
              backend: "codex",
              instanceId: "spoofed_instance",
              instanceLabel: "Spoofed Mac",
              celestialIcon: "black-hole",
              threadId: "source-thread",
              title: "Source thread",
            },
          },
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_025,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "resolve-active-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.resolveActiveTurn,
        params: { backend: "codex", threadId: "thread-1" },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_050,
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
    expect(backend.listThreadMcpServers).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      detail: "full",
    });
    expect(backend.reloadCodexMcpConfig).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(backend.resolveActiveTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(backend.controlActiveTurn).toHaveBeenCalledWith({
      operation: "steer",
      backend: "codex",
      threadId: "thread-1",
      requestId: "steer-1",
      expectedTurnId: "turn-live",
      input: [{ type: "text", text: "Report progress." }],
      messageOrigin: {
        kind: "agent",
        sourceThread: {
          backend: "codex",
          instanceId: "gateway_one",
          instanceLabel: "Gateway Mac",
          celestialIcon: "moon",
          threadId: "source-thread",
          title: "Source thread",
        },
      },
    });
    expect(
      FEDERATION_BACKEND_METHOD_CAPABILITIES[
        FEDERATION_BACKEND_METHODS.controlActiveTurn
      ],
    ).toBe("turn_control");
    expect(backend.submitServerRequest).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      requestId: "approval-1",
      response: { decision: "approve" },
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
        requestId: "mcp-inventory-request",
        result: {
          detail: "full",
          servers: [
            {
              name: "atlassian-rovo",
              authStatus: "oAuth",
              tools: ["search"],
            },
          ],
        },
      },
      {
        kind: "response",
        requestId: "mcp-reload-request",
        result: { queued: true },
      },
      {
        kind: "response",
        requestId: "control-active-request",
        result: {
          disposition: "interrupted",
          requestId: "steer-1",
          turnId: "turn-live",
        },
      },
      {
        kind: "response",
        requestId: "resolve-active-request",
        result: { turnId: "turn-live" },
      },
      {
        kind: "response",
        requestId: "approval-request",
        result: { requestId: "approval-1" },
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
        analyzeThreadToolHistory: vi.fn(),
        readTranscriptImage: vi.fn(),
        listSkills: vi.fn(),
        listBackends: vi.fn(),
        markThreadSeen: vi.fn(),
        setThreadReaction: vi.fn(),
      setThreadPin: vi.fn(),
      reorderThreadPins: vi.fn(),
        mountRemoteChild: vi.fn(),
        setThreadParent: vi.fn(),
        updateSubthreadOrder: vi.fn(),
        setSubthreadsCollapsed: vi.fn(),
        detachThreadPullRequest: vi.fn(),
        setThreadPrAutoDispatch: vi.fn(),
        cancelThreadPrAutoDispatch: vi.fn(),
        sendThreadPrAutoDispatchNow: vi.fn(),
        archiveThread: vi.fn(),
        startThread: vi.fn(),
        forkThread: vi.fn(),
        startTurn: vi.fn(),
        readQueuedTurn: vi.fn(),
        cancelQueuedTurn: vi.fn(),
        releaseQueuedTurn: vi.fn(),
        startReview: vi.fn(),
        listScheduledThreadActions: vi.fn(),
        createScheduledThreadAction: vi.fn(),
        updateScheduledThreadAction: vi.fn(),
        cancelScheduledThreadAction: vi.fn(),
        sendScheduledThreadActionNow: vi.fn(),
        compactThread: vi.fn(),
        listThreadMcpServers: vi.fn(),
        reloadCodexMcpConfig: vi.fn(),
        resolveActiveTurn: vi.fn(),
        interruptTurn: vi.fn(),
        stopSubAgent: vi.fn(),
        steerTurn: vi.fn(),
        setThreadExecutionMode: vi.fn(),
        queueThreadExecutionMode: vi.fn(),
        cancelThreadExecutionModeQueue: vi.fn(),
        setAcpSessionRuntimeOption: vi.fn(),
        setThreadModelSettings: vi.fn(),
        checkThreadBranchDrift: vi.fn(),
        updateThreadExpectedBranch: vi.fn(),
        retainThreadBranchDrift: vi.fn(),
        submitServerRequest: vi.fn(),
        runCodexEnvironmentAction: vi.fn(),
        stopCodexEnvironmentAction: vi.fn(),
        setCodexThreadEnvironment: vi.fn(),
        refreshThreadPullRequests: vi.fn(),
        refreshDirectoryGitStatuses: vi.fn(),
        ensureDirectoryLaunchpad: vi.fn(),
        listRecentFileReferences: vi.fn(),
        recordRecentFileReferences: vi.fn(),
        listModelSettingsRecents: vi.fn(),
        recordModelSettingsRecent: vi.fn(),
        attachDirectoryToThread: vi.fn(),
        listWorktreeUnpublishedCommits: vi.fn(),
        getWorktreeUnpublishedCommitDiff: vi.fn(),
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
        getLoadStatus: vi.fn(),
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
        git: {
          path: { value: "", source: "default" as const },
          discovery: { candidates: [] },
        },
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
