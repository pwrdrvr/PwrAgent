import { assertFederationEgress } from "@pwragent/federation/federation-egress";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FEDERATION_CAPABILITIES, type FederationProtocolEnvelope, type FederationRequestEnvelope } from "@pwragent/shared";
import { FederationRouter } from "../federation/federation-router";
import * as owner from "@pwragent/federation/federation-backend-methods";
import { evaluateFederationSessionPolicy } from "../federation/federation-policy";

const blocked = [
  ...Object.values(owner.FEDERATION_BACKEND_METHODS),
  "file.push", "file.push.begin", "file.pull", "pty.open", "service.open",
  "thread.handoff.send", "thread.handoff.import", "new.unmapped.method",
];

// Receiver role is the oracle; a peer's complete advertisement cannot widen it.
describe("receiver containment", () => {
  for (const target of ["desktop", "other-peer"]) {
    it(`refuses and audits every blocked method aimed at ${target}`, async () => {
      await fc.assert(fc.asyncProperty(fc.constantFrom(...blocked), fc.jsonValue(), async (method, params) => {
        const audit: unknown[] = [];
        const delivered: unknown[] = [];
        const router = new FederationRouter({
          localInstanceId: "desktop",
          peerRole: () => "contained",
          auditRefusal: (event) => audit.push(event),
          now: () => 42,
        });
        router.registerConnection({ peerId: "outpost", capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
        router.registerConnection({ peerId: "other-peer", capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: (event) => delivered.push(event) });
        router.registerHandler(method, () => { delivered.push(params); });
        const envelope: FederationRequestEnvelope = { id: "request", kind: "request", protocolVersion: 1,
          sourceInstanceId: "outpost", targetInstanceId: target, method, params, createdAt: 1 };
        expect(await router.routeEnvelope({ envelope, sourcePeerId: "outpost" })).toMatchObject({ status: "rejected", code: "capability_denied" });
        expect(delivered).toEqual([]);
        expect(audit).toEqual([{ peerId: "outpost", method, role: "contained", createdAt: 42 }]);
      }));
    });
  }

  it("does not grant gateway relay to a contained peer advertising everything", () => {
    const decision = evaluateFederationSessionPolicy({ peer: { id: "outpost", label: "outpost", role: "client",
      permissionRole: "contained", status: "connected", capabilities: [...FEDERATION_CAPABILITIES] },
    protocolVersion: 1, requestedCapabilities: [...FEDERATION_CAPABILITIES] });
    expect(decision.accepted).toBe(true);
    if (decision.accepted) expect(decision.capabilities).not.toContain("gateway_relay");
  });

  it("requires an explicit contained-role decision for every owner method", () => {
    const decisions = (owner as unknown as { FEDERATION_BACKEND_CONTAINED_DECISIONS?: Record<string, string> }).FEDERATION_BACKEND_CONTAINED_DECISIONS ?? {};
    expect(Object.keys(decisions).sort()).toEqual(Object.values(owner.FEDERATION_BACKEND_METHODS).sort());
    expect(Object.values(decisions).every((decision) => decision === "deny")).toBe(true);
  });
});

it("the Outpost guard denies the same generated request methods as the receiver", () => {
  fc.assert(fc.property(fc.constantFrom(...blocked), (method) => {
    const request: FederationRequestEnvelope = { id: "outgoing", kind: "request", method, params: {},
      sourceInstanceId: "outpost", targetInstanceId: "desktop", protocolVersion: 1, createdAt: 1 };
    expect(() => assertFederationEgress("contained", request)).toThrow("capability_denied");
    expect(() => assertFederationEgress("full", request)).not.toThrow();
    expect(() => assertFederationEgress("contained", { ...request, kind: "response", requestId: "viewer-request", result: {} })).not.toThrow();
  }));
});

it("applies receiver role changes immediately on the existing connection", async () => {
  let role: "full" | "contained" = "full";
  const router = new FederationRouter({ localInstanceId: "desktop", peerRole: () => role });
  router.registerConnection({ peerId: "outpost", capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
  router.registerHandler("backend.startThread", () => ({}));
  router.registerHandler("messaging.destination", () => ({ ok: true }));
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 30 }), async (contained) => {
    for (const value of contained) {
      role = value ? "contained" : "full";
      const request: FederationRequestEnvelope = { id: "request", kind: "request", method: "backend.startThread", params: {},
        sourceInstanceId: "outpost", targetInstanceId: "desktop", protocolVersion: 1, createdAt: 1 };
      expect((await router.routeEnvelope({ envelope: request, sourcePeerId: "outpost" })).status).toBe(value ? "rejected" : "handled");
      expect((await router.routeEnvelope({ envelope: { ...request, method: "messaging.destination" }, sourcePeerId: "outpost" })).status).toBe("handled");
    }
  }));
});

it("malformed receiver roles cannot grant gateway relay", () => {
  fc.assert(fc.property(fc.string().filter((role) => role !== "full"), (role) => {
    const decision = evaluateFederationSessionPolicy({ peer: { id: "outpost", label: "Fixture", role: "client", status: "connected",
      capabilities: [...FEDERATION_CAPABILITIES], permissionRole: role as "contained" }, protocolVersion: 1,
    requestedCapabilities: [...FEDERATION_CAPABILITIES] });
    expect(decision.accepted).toBe(true);
    if (decision.accepted) expect(decision.capabilities).not.toContain("gateway_relay");
  }));
});

// A peer that has seen a refusal must be able to read its audit line. The
// Outpost audits in-process and replies over a socket, so an audit written
// after the reply raced the peer's read (289 of 290 lines on CI).
describe("refusal audit ordering", () => {
  type Case = { role: "full" | "contained"; envelope: FederationProtocolEnvelope; arrange?: (router: FederationRouter) => void };
  const request = (method: string, targetInstanceId = "desktop"): FederationRequestEnvelope => ({ id: "request", kind: "request",
    protocolVersion: 1, sourceInstanceId: "outpost", targetInstanceId, method, params: {}, createdAt: 1 });
  const cases = fc.oneof(
    fc.constantFrom(...blocked).chain((method) => fc.constantFrom("desktop", "other-peer").map((target): Case =>
      ({ role: "contained", envelope: request(method, target) }))),
    fc.constant<Case>({ role: "contained", envelope: { id: "note", kind: "notification", protocolVersion: 1,
      sourceInstanceId: "outpost", targetInstanceId: "desktop", method: "new.unmapped.notification", params: {}, createdAt: 1 } }),
    fc.constant<Case>({ role: "full", envelope: request("new.unmapped.method") }),
    fc.constant<Case>({ role: "full", envelope: request("backend.startThread"),
      arrange: (router) => router.registerHandler("backend.startThread", () => { throw new Error("fixture failure"); }) }),
    fc.constant<Case>({ role: "full", envelope: request("backend.startThread", "absent-peer") }),
    fc.constant<Case>({ role: "full", envelope: { ...request("backend.startThread"), sourceInstanceId: "impostor" } }),
    fc.constant<Case>({ role: "full", envelope: { ...request("backend.startThread"), deadlineAt: 1 } }),
  );

  it("writes the audit line before the refusal reaches the peer", async () => {
    await fc.assert(fc.asyncProperty(cases, async ({ role, envelope, arrange }) => {
      const audit: unknown[] = [];
      const auditedAtReply: number[] = [];
      const router = new FederationRouter({ localInstanceId: "desktop", peerRole: () => role,
        auditRefusal: (event) => audit.push(event), now: () => 42 });
      router.registerConnection({ peerId: "outpost", capabilities: [...FEDERATION_CAPABILITIES],
        sendEnvelope: (reply) => { if (reply.kind === "error") auditedAtReply.push(audit.length); } });
      router.registerConnection({ peerId: "other-peer", capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
      arrange?.(router);
      const result = await router.routeEnvelope({ envelope, sourcePeerId: "outpost" });
      expect(result.status).toBe("rejected");
      expect(audit).toHaveLength(1);
      expect(auditedAtReply).toEqual([1]);
    }));
  });

  it("runs a host's audit before a notification refusal leaves", () => {
    const order: string[] = [];
    const router = new FederationRouter({ localInstanceId: "desktop", peerRole: () => "contained" });
    router.registerConnection({ peerId: "outpost", capabilities: [...FEDERATION_CAPABILITIES],
      sendEnvelope: (reply) => order.push(reply.kind) });
    const notification: FederationProtocolEnvelope = { id: "note", kind: "notification", protocolVersion: 1,
      sourceInstanceId: "outpost", targetInstanceId: "desktop", method: "new.unmapped.notification", params: {}, createdAt: 1 };
    expect(router.checkPeerRole(notification, "outpost", () => order.push("audit"))?.status).toBe("rejected");
    expect(order).toEqual(["audit", "error"]);
  });

  it("still sends the refusal when the audit write fails", async () => {
    const sent: string[] = [];
    const router = new FederationRouter({ localInstanceId: "desktop", peerRole: () => "contained",
      auditRefusal: () => { throw new Error("disk full"); } });
    router.registerConnection({ peerId: "outpost", capabilities: [...FEDERATION_CAPABILITIES],
      sendEnvelope: (reply) => sent.push(reply.kind) });
    await expect(router.routeEnvelope({ envelope: request("backend.startThread"), sourcePeerId: "outpost" })).rejects.toThrow("disk full");
    expect(sent).toEqual(["error"]);
  });
});
