import fc from "fast-check";
import { expect, it } from "vitest";
import { assertFederationEgress } from "@pwragent/federation/federation-egress";
import type { FederationRequestEnvelope } from "@pwragent/shared";
import { installOwnerEgressPolicy } from "../federation/owner-egress-policy";

it("guards direct and backpressured owner sends with the shared containment oracle, auditing before refusal", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("backend.startThread", "messaging.destination", "pty.open", "file.push", "unknown.method"),
    fc.constantFrom("contained", "full", undefined), fc.boolean(), async (method, role, relayed) => {
      const envelope: FederationRequestEnvelope = { id: "request", kind: "request", method, params: {},
        sourceInstanceId: relayed ? "viewer" : "owner", targetInstanceId: "gateway", protocolVersion: 1, createdAt: 1 };
      let refused = false;
      try { if (role && !relayed) assertFederationEgress(role, envelope); } catch { refused = true; }
      const sent: unknown[] = [], audit: unknown[] = [];
      const connection = { sendEnvelope: (value: unknown) => { sent.push(value); },
        sendEnvelopeWithBackpressure: async (value: unknown) => { sent.push(value); } };
      installOwnerEgressPolicy(connection, role, "owner", event => { expect(sent).toEqual([]); audit.push(event); });
      if (refused) {
        expect(() => connection.sendEnvelope(envelope)).toThrow("capability_denied");
        await expect(connection.sendEnvelopeWithBackpressure(envelope)).rejects.toThrow("capability_denied");
        expect(sent).toEqual([]);
        expect(audit).toHaveLength(2);
        expect(audit[0]).toMatchObject({ peerId: "owner", method, role });
      } else {
        connection.sendEnvelope(envelope);
        await connection.sendEnvelopeWithBackpressure(envelope);
        expect(sent).toEqual([envelope, envelope]);
        expect(audit).toEqual([]);
      }
    }));
});
