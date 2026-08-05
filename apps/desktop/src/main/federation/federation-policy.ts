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

  // Enrollment is identity trust, not a capability allowlist: federation
  // pairs instances owned by the same operator, so an enrolled peer is
  // granted whatever capability set its build advertises. The stored
  // peer row's capabilities are informational (refreshed on reconnect
  // for the UI), never an authorization boundary — pinning them at
  // enrollment time would hard-fail every pairing the moment a newer
  // build adds a capability to its default set. Per-peer narrowing is a
  // future RBAC concern, deliberately out of scope. Unknown capability
  // names from newer builds are filtered at the transport layer before
  // reaching this policy, so the grant below is always within what THIS
  // build understands.
  if (params.requestedCapabilities.length === 0) {
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
