import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  FederationCapability,
  FederationInstanceId,
  FederationProtocolEnvelope,
} from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";
import { FEDERATION_BACKEND_EVENT_METHOD } from "../federation/federation-backend-bridge";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationRouter } from "../federation/federation-router";
import type { FederationGatewayConnection } from "../federation/federation-transport";

type RuntimeHarness = {
  router?: FederationRouter;
  receiveEnvelope: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => Promise<void>;
  applyPeerDirectory: (envelope: FederationProtocolEnvelope) => boolean;
  forwardLocalBackendEvent: (event: AgentEvent) => void;
  gatewayInstanceId?: FederationInstanceId;
  localInstanceId?: FederationInstanceId;
  publishRemoteBackendEvent: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => boolean;
  remotePeerDirectory: Map<FederationInstanceId, unknown>;
  registerGatewayConnection: (connection: FederationGatewayConnection) => void;
  sendEnvelopeToTarget: (
    targetInstanceId: FederationInstanceId,
    envelope: FederationProtocolEnvelope,
  ) => void;
  setAgentEventPublisher: (publisher: (event: AgentEvent) => void) => void;
  unregisterGatewayConnection: (connection: FederationGatewayConnection) => void;
};

function createConnection(params: {
  peerId: FederationInstanceId;
  capabilities?: FederationCapability[];
  sendEnvelope?: (envelope: FederationProtocolEnvelope) => void;
}): FederationGatewayConnection {
  return {
    peerId: params.peerId,
    sessionId: `session:${params.peerId}`,
    capabilities: params.capabilities ?? ["gateway_relay"],
    sendEnvelope: params.sendEnvelope ?? (() => undefined),
    close: () => undefined,
  };
}

describe("DesktopFederationRuntime", () => {
  it("records gateway-advertised peers for client instance health and opening", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "client_one";

    const handled = runtime.applyPeerDirectory({
      id: "peers-1",
      kind: "notification",
      method: "federation.peerDirectory",
      params: {
        peers: [
          {
            id: "gateway_one",
            label: "Studio",
            role: "gateway",
            status: "connected",
            capabilities: ["remote_window", "gateway_relay"],
          },
          {
            id: "client_two",
            label: "Laptop",
            role: "client",
            status: "connected",
            capabilities: ["remote_window", "thread_detail"],
          },
          {
            id: "client_one",
            label: "Self",
            role: "client",
            status: "connected",
            capabilities: ["remote_window"],
          },
        ],
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "gateway_one",
      targetInstanceId: "client_one",
      createdAt: 2_000,
    });

    expect(handled).toBe(true);
    expect([...runtime.remotePeerDirectory.values()]).toMatchObject([
      {
        id: "gateway_one",
        label: "Studio",
        role: "gateway",
        status: "connected",
      },
      {
        id: "client_two",
        label: "Laptop",
        role: "client",
        status: "connected",
      },
    ]);
  });

  it("falls back to the gateway when a client targets a sibling peer", () => {
    const sentToGateway: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "client_one" });
    router.registerConnection(
      createConnection({
        peerId: "gateway_one",
        capabilities: ["gateway_relay"],
        sendEnvelope: (envelope) => sentToGateway.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.gatewayInstanceId = "gateway_one";
    runtime.localInstanceId = "client_one";
    runtime.router = router;

    const request: FederationProtocolEnvelope = {
      id: "request-1",
      kind: "request",
      method: "backend.listThreads",
      params: {},
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "client_one",
      targetInstanceId: "client_two",
      createdAt: 2_000,
    };

    runtime.sendEnvelopeToTarget("client_two", request);

    expect(sentToGateway).toEqual([request]);
  });

  it("forwards local backend events to remote-capable peers", () => {
    const forwarded: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        capabilities: ["remote_window"],
        sendEnvelope: (envelope) => forwarded.push(envelope),
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "limited_peer",
        capabilities: ["messaging_route"],
        sendEnvelope: (envelope) => forwarded.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;

    runtime.forwardLocalBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "in_progress" },
          turnId: "turn-1",
        },
      },
    } as AgentEvent);

    expect(forwarded).toMatchObject([
      {
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
      },
    ]);
  });

  it("publishes remote backend events with the source peer as federation target", () => {
    const published: AgentEvent[] = [];
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.setAgentEventPublisher((event) => {
      published.push(event);
    });

    const handled = runtime.publishRemoteBackendEvent(
      {
        id: "event-1",
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          backend: "codex",
          notification: {
            method: "item/agentMessage/delta",
            params: {
              delta: "hello",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 2_000,
      },
      "client_one",
    );

    expect(handled).toBe(true);
    expect(published).toEqual([
      {
        backend: "codex",
        federationTarget: { scope: "remote", instanceId: "client_one" },
        notification: {
          method: "item/agentMessage/delta",
          params: {
            delta: "hello",
            itemId: "item-1",
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
    ]);
  });

  it("relays client backend events to sibling peers through the gateway", () => {
    const relayedToSibling: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        capabilities: ["remote_window"],
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "client_two",
        capabilities: ["remote_window"],
        sendEnvelope: (envelope) => relayedToSibling.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;

    runtime.publishRemoteBackendEvent(
      {
        id: "event-1",
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          backend: "codex",
          notification: {
            method: "item/agentMessage/delta",
            params: {
              delta: "hello",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 2_000,
      },
      "client_one",
    );

    expect(relayedToSibling).toMatchObject([
      {
        id: "event-1",
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        sourceInstanceId: "client_one",
        targetInstanceId: "client_two",
        hopCount: 1,
      },
    ]);
  });

  it("routes unmatched relayed responses back to the target peer", async () => {
    const relayed: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        sendEnvelope: (envelope) => relayed.push(envelope),
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "client_two",
        capabilities: ["gateway_relay"],
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;

    await runtime.receiveEnvelope(
      {
        id: "response-1",
        kind: "response",
        requestId: "request-1",
        protocolVersion: 1,
        sourceInstanceId: "client_two",
        targetInstanceId: "client_one",
        createdAt: 2_000,
        result: { ok: true },
      },
      "client_two",
    );

    expect(relayed).toMatchObject([
      {
        kind: "response",
        requestId: "request-1",
        sourceInstanceId: "client_two",
        targetInstanceId: "client_one",
        hopCount: 1,
      },
    ]);
  });

  it("ignores stale disconnects after the peer has reconnected", () => {
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;
    const oldConnection = createConnection({
      peerId: "client_one",
      sendEnvelope: () => undefined,
    });
    const newSendEnvelope = () => undefined;
    const newConnection = createConnection({
      peerId: "client_one",
      sendEnvelope: newSendEnvelope,
    });

    runtime.registerGatewayConnection(oldConnection);
    runtime.registerGatewayConnection(newConnection);
    runtime.unregisterGatewayConnection(oldConnection);

    expect(router.getConnection("client_one")?.sendEnvelope).toBe(newSendEnvelope);

    runtime.unregisterGatewayConnection(newConnection);

    expect(router.getConnection("client_one")).toBeUndefined();
  });
});
