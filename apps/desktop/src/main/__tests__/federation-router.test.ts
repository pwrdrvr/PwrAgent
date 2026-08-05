import { describe, expect, it } from "vitest";
import type { FederationProtocolEnvelope } from "@pwragent/shared";
import {
  FEDERATION_BACKEND_METHODS,
  additionalFederationBackendCapabilities,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";

describe("FederationRouter", () => {
  it("handles local requests and replies to the source peer", async () => {
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      methodCapabilities: {
        "thread.list": "thread_navigation",
      },
      now: () => 2_000,
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    router.registerHandler("thread.list", () => ({ threads: [] }));

    await expect(
      router.routeEnvelope({
        sourcePeerId: "client_one",
        envelope: {
          id: "request-1",
          kind: "request",
          method: "thread.list",
          params: {},
          protocolVersion: 1,
          sourceInstanceId: "client_one",
          targetInstanceId: "gateway_one",
          createdAt: 1_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "handled",
      response: {
        kind: "response",
        requestId: "request-1",
        result: { threads: [] },
      },
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "request-1",
        targetInstanceId: "client_one",
      },
    ]);
  });

  it("relays client-to-client envelopes when the source is authorized", async () => {
    const relayed: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["gateway_relay"],
      sendEnvelope: () => undefined,
    });
    router.registerConnection({
      peerId: "client_two",
      capabilities: ["remote_window"],
      sendEnvelope: (envelope) => relayed.push(envelope),
    });

    await expect(
      router.routeEnvelope({
        sourcePeerId: "client_one",
        envelope: {
          id: "request-1",
          kind: "request",
          method: "thread.read",
          params: {},
          protocolVersion: 1,
          sourceInstanceId: "client_one",
          targetInstanceId: "client_two",
          createdAt: 1_000,
        },
      }),
    ).resolves.toEqual({
      status: "relayed",
      targetInstanceId: "client_two",
    });
    expect(relayed).toMatchObject([
      {
        id: "request-1",
        targetInstanceId: "client_two",
        hopCount: 1,
      },
    ]);
  });

  it("requires scheduler authorization before invoking a durable steer fallback", async () => {
    let handled = 0;
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      additionalRequiredCapabilities: additionalFederationBackendCapabilities,
    });
    router.registerHandler(FEDERATION_BACKEND_METHODS.steerTurn, () => {
      handled += 1;
      return { status: "steered" };
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["turn_control"],
      sendEnvelope: () => undefined,
    });
    const request = {
      id: "steer-local-1",
      kind: "request" as const,
      method: FEDERATION_BACKEND_METHODS.steerTurn,
      params: {
        backend: "codex",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        requestId: "request-1",
        input: [{ type: "text", text: "Steer" }],
        fallback: {
          displayText: "Steer",
          turn: { input: [{ type: "text", text: "Steer" }] },
        },
      },
      protocolVersion: 1 as const,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_000,
    };

    await expect(router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: request,
    })).resolves.toMatchObject({
      status: "rejected",
      code: "capability_denied",
    });
    expect(handled).toBe(0);

    router.registerConnection({
      peerId: "client_one",
      capabilities: ["turn_control", "scheduled_actions"],
      sendEnvelope: () => undefined,
    });
    await expect(router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: request,
    })).resolves.toMatchObject({ status: "handled" });
    expect(handled).toBe(1);
  });

  it("requires scheduler authorization while relaying a durable steer fallback", async () => {
    const relayed: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      additionalRequiredCapabilities: additionalFederationBackendCapabilities,
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["gateway_relay", "turn_control"],
      sendEnvelope: () => undefined,
    });
    router.registerConnection({
      peerId: "client_two",
      capabilities: ["turn_control", "scheduled_actions"],
      sendEnvelope: (envelope) => relayed.push(envelope),
    });
    const request = {
      id: "steer-1",
      kind: "request" as const,
      method: FEDERATION_BACKEND_METHODS.steerTurn,
      params: {
        backend: "codex",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        requestId: "request-1",
        input: [{ type: "text", text: "Steer" }],
        fallback: {
          displayText: "Steer",
          turn: { input: [{ type: "text", text: "Steer" }] },
        },
      },
      protocolVersion: 1 as const,
      sourceInstanceId: "client_one",
      targetInstanceId: "client_two",
      createdAt: 1_000,
    };

    await expect(router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: request,
    })).resolves.toMatchObject({
      status: "rejected",
      code: "capability_denied",
    });
    expect(relayed).toEqual([]);

    router.registerConnection({
      peerId: "client_one",
      capabilities: ["gateway_relay", "turn_control", "scheduled_actions"],
      sendEnvelope: () => undefined,
    });
    await expect(router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: request,
    })).resolves.toMatchObject({ status: "relayed" });
    expect(relayed).toHaveLength(1);
  });

  it("fails closed for denied capabilities, unauthorized relay, and expired deadlines", async () => {
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      methodCapabilities: {
        "turn.submit": "turn_control",
      },
      now: () => 2_000,
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    router.registerHandler("turn.submit", () => ({ ok: true }));

    await expect(
      router.routeEnvelope({
        sourcePeerId: "client_one",
        envelope: {
          id: "request-1",
          kind: "request",
          method: "turn.submit",
          params: {},
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

    await expect(
      router.routeEnvelope({
        sourcePeerId: "client_one",
        envelope: {
          id: "request-2",
          kind: "request",
          method: "thread.read",
          params: {},
          protocolVersion: 1,
          sourceInstanceId: "client_one",
          targetInstanceId: "client_two",
          createdAt: 1_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "relay_not_authorized",
    });

    await expect(
      router.routeEnvelope({
        sourcePeerId: "client_one",
        envelope: {
          id: "request-3",
          kind: "request",
          method: "thread.list",
          params: {},
          protocolVersion: 1,
          sourceInstanceId: "client_one",
          targetInstanceId: "gateway_one",
          createdAt: 1_000,
          deadlineAt: 1_500,
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "deadline_expired",
    });

    expect(replies).toMatchObject([
      { kind: "error", error: { code: "capability_denied" } },
      { kind: "error", error: { code: "relay_not_authorized" } },
      { kind: "error", error: { code: "deadline_expired" } },
    ]);
  });
});
