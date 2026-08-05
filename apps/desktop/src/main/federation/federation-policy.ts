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

  const allowed = new Set(params.peer.capabilities);
  const denied = params.requestedCapabilities.some(
    (capability) => !allowed.has(capability),
  );
  if (denied) {
    return {
      accepted: false,
      failure: federationFailure("capability_denied"),
    };
  }

  return {
    accepted: true,
    capabilities: params.requestedCapabilities.slice(),
  };
}
