import { describe, expect, it } from "vitest";
import type { FederationProtocolEnvelope } from "@pwragent/shared";
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
