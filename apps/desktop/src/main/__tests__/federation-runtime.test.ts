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
  forwardLocalBackendEvent: (event: AgentEvent) => void;
  localInstanceId?: FederationInstanceId;
  publishRemoteBackendEvent: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => boolean;
  registerGatewayConnection: (connection: FederationGatewayConnection) => void;
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
  it("forwards local backend events to remote-capable peers", () => {
    const forwarded: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "child_one",
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
        targetInstanceId: "child_one",
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
        sourceInstanceId: "child_one",
        targetInstanceId: "gateway_one",
        createdAt: 2_000,
      },
      "child_one",
    );

    expect(handled).toBe(true);
    expect(published).toEqual([
      {
        backend: "codex",
        federationTarget: { scope: "remote", instanceId: "child_one" },
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

  it("routes unmatched relayed responses back to the target peer", async () => {
    const relayed: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "child_one",
        sendEnvelope: (envelope) => relayed.push(envelope),
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "child_two",
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
        sourceInstanceId: "child_two",
        targetInstanceId: "child_one",
        createdAt: 2_000,
        result: { ok: true },
      },
      "child_two",
    );

    expect(relayed).toMatchObject([
      {
        kind: "response",
        requestId: "request-1",
        sourceInstanceId: "child_two",
        targetInstanceId: "child_one",
        hopCount: 1,
      },
    ]);
  });

  it("ignores stale disconnects after the peer has reconnected", () => {
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;
    const oldConnection = createConnection({
      peerId: "child_one",
      sendEnvelope: () => undefined,
    });
    const newSendEnvelope = () => undefined;
    const newConnection = createConnection({
      peerId: "child_one",
      sendEnvelope: newSendEnvelope,
    });

    runtime.registerGatewayConnection(oldConnection);
    runtime.registerGatewayConnection(newConnection);
    runtime.unregisterGatewayConnection(oldConnection);

    expect(router.getConnection("child_one")?.sendEnvelope).toBe(newSendEnvelope);

    runtime.unregisterGatewayConnection(newConnection);

    expect(router.getConnection("child_one")).toBeUndefined();
  });
});
