import { describe, expect, it, vi } from "vitest";
import type { FederationProtocolEnvelope } from "@pwragent/shared";
import {
  FEDERATION_BACKEND_METHODS,
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";

describe("federation backend bridge", () => {
  it("maps federation backend methods to local app-server operations", async () => {
    const backend: FederationBackendOperations = {
      listThreads: vi.fn(async () => ({
        backend: "codex",
        fetchedAt: 1_000,
        threads: [],
      })),
      readThread: vi.fn(),
      listSkills: vi.fn(),
      startTurn: vi.fn(),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
      now: () => 2_000,
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation"],
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

    expect(backend.listThreads).toHaveBeenCalledWith({ backend: "codex" });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "request-1",
        result: {
          backend: "codex",
          threads: [],
        },
      },
    ]);
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
});
