import fc from "fast-check";
import { FEDERATION_CAPABILITIES, type FederationPeerRole, type FederationProtocolEnvelope } from "@pwragent/shared";
import { FEDERATION_MEMBER_ROLE_DECLARE_METHOD } from "@pwragent/federation/federation-backend-methods";
import { assertFederationEgress } from "@pwragent/federation/federation-egress";
import { expect, it, onTestFinished, vi } from "vitest";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import type { FederationRouter } from "../federation/federation-router";
import { getOwnerHostServices, installOwnerHostServices } from "../owner-host";
import { createOutpostRuntimePolicy } from "../owner-runtime-policy";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { FederationStore } from "../storage/federation-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Rule: a member's own containment is enforced by its peers, not only by the
// member. A model with Full Access on a contained Outpost can read the
// Outpost's federation keys and connect as it, so the member's own refusal
// is not a boundary. Its peers are: once a member declares itself contained,
// a peer assigns it contained, and nothing the member sends later relaxes
// that. Only the peer's operator does.

vi.mock("../settings/desktop-settings-singleton", () => ({ getDesktopSettingsService: vi.fn() }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({}) }));

type Step =
  | { kind: "declare"; role: FederationPeerRole; relayed: boolean }
  | { kind: "operator"; role: FederationPeerRole };

const role = fc.constantFrom<FederationPeerRole>("full", "contained");
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("declare" as const), role, relayed: fc.boolean() }),
  fc.record({ kind: fc.constant("operator" as const), role }),
);

/** Stand up the real receiver: its store, router and registered handlers. */
async function receiver(initialRole: FederationPeerRole) {
  const db = openInMemoryStateDb();
  const store = new FederationStore(db);
  store.upsertPeer({ peer: { id: "member", label: "Fixture member", role: "client", status: "connected",
    capabilities: [...FEDERATION_CAPABILITIES], pinnedPublicKeyPem: "fixture" }, assignedRole: initialRole, updatedAt: 1 });
  const stop = new Error("Router constructed; no listener needed");
  vi.mocked(getDesktopSettingsService).mockReturnValue({ readFederationConfig: () => ({}),
    getOrCreateFederationNoiseStaticKeyPair: async () => { throw stop; },
  } as unknown as ReturnType<typeof getDesktopSettingsService>);
  const instance = Object.assign(new DesktopFederationRuntime(), { localInstanceId: "receiver", store: () => store,
    durableTurnRequestService: () => ({}), subscribeLocalBackendEvents: () => {},
    broadcastPeerDirectory: () => {}, sendEnvelopeToTarget: () => {}, publishPeerStatus: () => {} }) as unknown as DesktopFederationRuntime;
  const runtime = instance as unknown as { router?: FederationRouter; filePushReceiver?: { dispose(): Promise<void> };
    startAfterLeaseAcquired(mode: string, config: object): Promise<void> };
  await expect(runtime.startAfterLeaseAcquired("disabled", {})).rejects.toBe(stop);
  const router = runtime.router!;
  router.registerConnection({ peerId: "member", capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
  router.registerConnection({ peerId: "relay", capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
  return {
    instance, store,
    declare: async (declared: FederationPeerRole, relayed: boolean) => await router.routeEnvelope({
      sourcePeerId: relayed ? "relay" : "member",
      envelope: { id: `declare-${Math.random()}`, kind: "request", method: FEDERATION_MEMBER_ROLE_DECLARE_METHOD,
        params: { role: declared }, sourceInstanceId: "member", targetInstanceId: "receiver", protocolVersion: 1, createdAt: 1 },
    }),
    close: async () => { await runtime.filePushReceiver?.dispose(); db.close(); },
  };
}

it("a contained declaration is sticky at the receiver, and only its operator relaxes a role", async () => {
  await fc.assert(fc.asyncProperty(role, fc.array(step, { minLength: 1, maxLength: 12 }), async (initialRole, steps) => {
    const host = await receiver(initialRole);
    try {
      // Model: the operator's last choice, tightened by any later direct
      // declaration of contained from the member itself.
      let expected = initialRole;
      for (const next of steps) {
        if (next.kind === "operator") {
          await host.instance.setPeerRole("member", next.role);
          expected = next.role;
        } else {
          const result = await host.declare(next.role, next.relayed);
          // A contained member may always declare over its own connection. A
          // relay hop may be refused; either way it never changes the role.
          if (!next.relayed) expect(result.status, JSON.stringify(result)).not.toBe("rejected");
          if (next.role === "contained" && !next.relayed) expected = "contained";
          if (result.status === "handled" && result.response && "result" in result.response) {
            expect(result.response.result).toEqual({ role: expected });
          }
        }
        expect(host.store.getPeer("member")?.permissionRole).toBe(expected);
      }
    } finally { await host.close(); }
  }), { numRuns: 60 });
});

it("a member declares its own role to every directly connected peer that can hear it, on any host", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("desktop" as const, "outpost" as const), role, fc.boolean(),
    async (hostKind, memberRole, peerSupports) => {
      const previous = getOwnerHostServices();
      onTestFinished(() => installOwnerHostServices(previous));
      if (hostKind === "outpost") {
        installOwnerHostServices({ ...previous, runtimePolicy: createOutpostRuntimePolicy({ PWRAGENT_OUTPOST_FEDERATION_ROLE: memberRole }) });
      } else {
        installOwnerHostServices({ ...previous, runtimePolicy: undefined });
        // A desktop with no member_role is a full member.
        if (memberRole === "contained") return;
      }
      const sent: FederationProtocolEnvelope[] = [];
      const runtime = Object.assign(new DesktopFederationRuntime(), { localInstanceId: "member",
        sendEnvelopeToTarget: (_peer: string, envelope: FederationProtocolEnvelope) => { sent.push(envelope); } }) as unknown as {
          declareMemberRole(peerId: string, capabilities: readonly string[]): void;
        };
      const capabilities = peerSupports ? [...FEDERATION_CAPABILITIES] : FEDERATION_CAPABILITIES.filter(value => value !== "member_role_declaration_v1");
      runtime.declareMemberRole("peer", capabilities);
      const declarations = sent.filter(envelope => envelope.kind === "request" && envelope.method === FEDERATION_MEMBER_ROLE_DECLARE_METHOD);
      expect(declarations.map(envelope => envelope.kind === "request" ? envelope.params : undefined))
        .toEqual(peerSupports ? [{ role: memberRole }] : []);
      // The member's own egress guard lets a contained member send it.
      for (const envelope of declarations) expect(() => assertFederationEgress("contained", envelope)).not.toThrow();
    }), { numRuns: 30 });
});
