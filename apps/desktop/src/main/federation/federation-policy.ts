import type {
  FederationCapability,
  FederationPeerSummary,
} from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";
import {
  federationFailure,
  type FederationRedactedFailure,
} from "./federation-redaction";

export type FederationPolicyDecision =
  | {
      accepted: true;
      capabilities: FederationCapability[];
    }
  | {
      accepted: false;
      failure: FederationRedactedFailure;
    };

export function evaluateFederationSessionPolicy(params: {
  peer: FederationPeerSummary | undefined;
  protocolVersion: number;
  requestedCapabilities: readonly FederationCapability[];
}): FederationPolicyDecision {
  if (params.protocolVersion !== FEDERATION_PROTOCOL_VERSION) {
    return {
      accepted: false,
      failure: federationFailure("invalid_protocol_version"),
    };
  }
  if (!params.peer) {
    return {
      accepted: false,
      failure: federationFailure("unknown_peer"),
    };
  }
  if (params.peer.status === "revoked" || params.peer.revokedAt !== undefined) {
    return {
      accepted: false,
      failure: federationFailure("revoked_peer"),
    };
  }

  // Negotiate rather than reject: grant the intersection of what the
  // peer requests and what its enrollment authorized. All-or-nothing
  // rejection would hard-fail every existing pairing whenever a newer
  // build adds a capability to its default request set — the stored
  // allowlist predates the new capability by definition. The peer never
  // receives anything beyond its stored grant; zero overlap still
  // rejects (a peer with no usable capabilities has no business with a
  // session).
  const allowed = new Set(params.peer.capabilities);
  const granted = params.requestedCapabilities.filter((capability) =>
    allowed.has(capability),
  );
  if (granted.length === 0) {
    return {
      accepted: false,
      failure: federationFailure("capability_denied"),
    };
  }

  return {
    accepted: true,
    capabilities: granted,
  };
}
