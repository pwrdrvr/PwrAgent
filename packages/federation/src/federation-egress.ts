import type { FederationPeerRole, FederationProtocolEnvelope } from "@pwragent/shared";
import { containedFederationMethodAllowed, containedFederationNotificationAllowed } from "./federation-backend-methods";

export function assertFederationEgress(role: FederationPeerRole, envelope: FederationProtocolEnvelope): void {
  if (role === "contained" && (
    (envelope.kind === "request" && !containedFederationMethodAllowed(envelope.method))
    || (envelope.kind === "notification" && !containedFederationNotificationAllowed(envelope.method))
    || envelope.kind === "blob_chunk"
  )) {
    throw new Error("capability_denied: contained Outpost egress");
  }
}
