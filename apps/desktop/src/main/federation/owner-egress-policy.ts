import type { FederationPeerRole, FederationProtocolEnvelope } from "@pwragent/shared";
import { assertFederationEgress } from "@pwragent/federation/federation-egress";
import type { FederationRefusalAudit } from "@pwragent/federation/federation-router";

type Transport = {
  sendEnvelope(envelope: FederationProtocolEnvelope): void;
  sendEnvelopeWithBackpressure?(envelope: FederationProtocolEnvelope): Promise<void>;
};

/** Guard the transport itself, including sends that do not go through the router. */
export function installOwnerEgressPolicy(
  transport: Transport,
  /** A fixed role, or a reader asked on every send so a role change applies at once. */
  memberRole: FederationPeerRole | (() => FederationPeerRole) | undefined,
  localInstanceId: string | (() => string),
  audit: (event: FederationRefusalAudit) => void,
): void {
  if (!memberRole) return;
  const roleNow = typeof memberRole === "function" ? memberRole : () => memberRole;
  const instanceIdNow = typeof localInstanceId === "function" ? localInstanceId : () => localInstanceId;
  const check = (envelope: FederationProtocolEnvelope) => {
    const role = roleNow();
    if (role === "full") return;
    // Relayed envelopes retain the authenticated source's authority.
    const instanceId = instanceIdNow();
    if (envelope.sourceInstanceId !== instanceId) return;
    try { assertFederationEgress(role, envelope); }
    catch (error) {
      audit({ peerId: instanceId, method: "method" in envelope ? envelope.method : envelope.kind, role, createdAt: Date.now() });
      throw error;
    }
  };
  const send = transport.sendEnvelope.bind(transport);
  transport.sendEnvelope = envelope => { check(envelope); send(envelope); };
  const sendWithBackpressure = transport.sendEnvelopeWithBackpressure?.bind(transport);
  if (sendWithBackpressure) {
    transport.sendEnvelopeWithBackpressure = async envelope => { check(envelope); await sendWithBackpressure(envelope); };
  }
}
