import type {
  FederationCapability,
  FederationPeerSummary,
} from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION, normalizeFederationPeerRole } from "@pwragent/shared";
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

  // Advertisements negotiate protocol support; receiver-owned roles bound
  // authority. Method decisions additionally constrain contained requests.
  if (params.requestedCapabilities.length === 0) {
    return {
      accepted: false,
      failure: federationFailure("capability_denied"),
    };
  }

  return {
    accepted: true,
    capabilities: params.requestedCapabilities.filter((capability) =>
      normalizeFederationPeerRole(params.peer?.permissionRole) !== "contained" || capability !== "gateway_relay"),
  };
}
