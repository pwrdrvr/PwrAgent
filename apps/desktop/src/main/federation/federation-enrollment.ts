import type {
  FederationCapability,
  FederationInstanceId,
  FederationInstanceRole,
  FederationPeerSummary,
} from "@pwragent/shared";
import {
  FEDERATION_INVITE_VERSION,
  FEDERATION_PROTOCOL_VERSION,
  isFederationInstanceId,
} from "@pwragent/shared";
import {
  verifyFederationMessageSignature,
} from "./federation-identity";
import { evaluateFederationSessionPolicy } from "./federation-policy";
import {
  federationFailure,
  type FederationRedactedFailure,
} from "./federation-redaction";
import type {
  FederationEnrollmentEntry,
  FederationStore,
} from "./federation-store";

export type FederationEnrollmentInvite = FederationEnrollmentEntry & {
  token: string;
};

export type FederationInvitePayload = {
  version: typeof FEDERATION_INVITE_VERSION;
  token: string;
  gatewayInstanceId: FederationInstanceId;
  gatewayPublicKeyPem: string;
  gatewayNoisePublicKey: string;
  gatewayUrl: string;
  expiresAt: number;
};

export type FederationAuthDecision =
  | {
      accepted: true;
      peer: FederationPeerSummary;
      capabilities: FederationCapability[];
    }
  | {
      accepted: false;
      failure: FederationRedactedFailure;
    };

export function createFederationEnrollmentInvite(params: {
  store: FederationStore;
  token: string;
  gatewayInstanceId: FederationInstanceId;
  generatedAt: number;
  expiresAt: number;
  label?: string;
  role?: FederationInstanceRole;
  endpoint?: string;
}): FederationEnrollmentInvite {
  const entry = params.store.createEnrollment({
    token: params.token,
    generatedAt: params.generatedAt,
    expiresAt: params.expiresAt,
    label: params.label,
    role: params.role,
    endpoint: params.endpoint,
    gatewayInstanceId: params.gatewayInstanceId,
  });
  return {
    ...entry,
    token: params.token,
  };
}

export function encodeFederationInvite(payload: FederationInvitePayload): string {
  return `pwragent-federation:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function decodeFederationInvite(
  invite: string,
  now = Date.now(),
): FederationInvitePayload {
  const encoded = invite.trim().replace(/^pwragent-federation:/, "");
  const parsed = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as Partial<FederationInvitePayload>;
  if (parsed.version !== FEDERATION_INVITE_VERSION) {
    throw new Error(
      `Unsupported federation invite version. Expected version ${FEDERATION_INVITE_VERSION}.`,
    );
  }
  if (
    typeof parsed.token !== "string" ||
    typeof parsed.gatewayInstanceId !== "string" ||
    typeof parsed.gatewayPublicKeyPem !== "string" ||
    typeof parsed.gatewayNoisePublicKey !== "string" ||
    typeof parsed.gatewayUrl !== "string" ||
    typeof parsed.expiresAt !== "number"
  ) {
    throw new Error("Invalid federation invite.");
  }
  if (parsed.expiresAt <= now) {
    throw new Error("Federation invite has expired.");
  }
  return parsed as FederationInvitePayload;
}

export function completeFederationEnrollment(params: {
  store: FederationStore;
  gatewayInstanceId: FederationInstanceId;
  inviteToken: string;
  now: number;
  /** Base64 Noise handshake hash to bind the identity proof to the channel. */
  channelBinding?: string;
  peer: {
    instanceId: FederationInstanceId;
    label: string;
    role: FederationInstanceRole;
    publicKeyPem: string;
    capabilities: readonly FederationCapability[];
    protocolVersion: number;
    nonce: string;
    signatureBase64: string;
    endpoint?: string;
    profileName?: string;
  };
}): FederationAuthDecision {
  if (!isFederationInstanceId(params.peer.instanceId)) {
    return {
      accepted: false,
      failure: federationFailure("invalid_peer_id"),
    };
  }
  if (params.peer.protocolVersion !== FEDERATION_PROTOCOL_VERSION) {
    return {
      accepted: false,
      failure: federationFailure("invalid_protocol_version"),
    };
  }

  const enrollment = params.store.findMatchingPendingEnrollment({
    token: params.inviteToken,
    now: params.now,
  });
  if (!enrollment) {
    return {
      accepted: false,
      failure: federationFailure("missing_invite"),
    };
  }
  if (
    enrollment.gatewayInstanceId &&
    enrollment.gatewayInstanceId !== params.gatewayInstanceId
  ) {
    return {
      accepted: false,
      failure: federationFailure("wrong_gateway"),
    };
  }

  const message = buildFederationProofMessage({
    purpose: "enroll",
    gatewayInstanceId: params.gatewayInstanceId,
    peerInstanceId: params.peer.instanceId,
    publicKeyPem: params.peer.publicKeyPem,
    protocolVersion: params.peer.protocolVersion,
    nonce: params.peer.nonce,
    capabilities: params.peer.capabilities,
    channelBinding: params.channelBinding,
  });
  const signatureValid = verifyFederationMessageSignature({
    publicKeyPem: params.peer.publicKeyPem,
    message,
    signatureBase64: params.peer.signatureBase64,
  });
  if (!signatureValid) {
    return {
      accepted: false,
      failure: federationFailure("bad_signature"),
    };
  }

  const peer: FederationPeerSummary & { pinnedPublicKeyPem: string } = {
    id: params.peer.instanceId,
    label: params.peer.label,
    role: params.peer.role,
    status: "connected",
    capabilities: params.peer.capabilities.slice(),
    protocolVersion: params.peer.protocolVersion,
    endpoint: params.peer.endpoint ?? enrollment.endpoint,
    profileName: params.peer.profileName,
    lastConnectedAt: params.now,
    lastActivityAt: params.now,
    pinnedPublicKeyPem: params.peer.publicKeyPem,
  };
  params.store.upsertPeer({ peer, updatedAt: params.now });
  params.store.markEnrollmentUsed({
    enrollmentId: enrollment.id,
    peerId: params.peer.instanceId,
    usedAt: params.now,
  });

  return {
    accepted: true,
    peer,
    capabilities: peer.capabilities,
  };
}

export function authenticateFederationReconnect(params: {
  store: FederationStore;
  gatewayInstanceId: FederationInstanceId;
  peerInstanceId: FederationInstanceId;
  protocolVersion: number;
  nonce: string;
  requestedCapabilities: readonly FederationCapability[];
  signatureBase64: string;
  now: number;
  /** Base64 Noise handshake hash to bind the identity proof to the channel. */
  channelBinding?: string;
}): FederationAuthDecision {
  if (!isFederationInstanceId(params.peerInstanceId)) {
    return {
      accepted: false,
      failure: federationFailure("invalid_peer_id"),
    };
  }
  const peer = params.store.getPeer(params.peerInstanceId);
  const policy = evaluateFederationSessionPolicy({
    peer,
    protocolVersion: params.protocolVersion,
    requestedCapabilities: params.requestedCapabilities,
  });
  if (!policy.accepted) {
    return policy;
  }
  if (!peer) {
    return {
      accepted: false,
      failure: federationFailure("unknown_peer"),
    };
  }
  if (!peer.pinnedPublicKeyPem) {
    return {
      accepted: false,
      failure: federationFailure("unknown_peer"),
    };
  }

  const message = buildFederationProofMessage({
    purpose: "reconnect",
    gatewayInstanceId: params.gatewayInstanceId,
    peerInstanceId: params.peerInstanceId,
    publicKeyPem: peer.pinnedPublicKeyPem,
    protocolVersion: params.protocolVersion,
    nonce: params.nonce,
    capabilities: params.requestedCapabilities,
    channelBinding: params.channelBinding,
  });
  const signatureValid = verifyFederationMessageSignature({
    publicKeyPem: peer.pinnedPublicKeyPem,
    message,
    signatureBase64: params.signatureBase64,
  });
  if (!signatureValid) {
    return {
      accepted: false,
      failure: federationFailure("bad_signature"),
    };
  }

  const connectedPeer: FederationPeerSummary & { pinnedPublicKeyPem?: string } = {
    ...peer,
    // Reconnect capabilities are the negotiated session subset, not a new
    // authorization allowlist. Preserve capabilities omitted by this session.
    capabilities: [...peer.capabilities],
    protocolVersion: params.protocolVersion,
    status: "connected",
    lastConnectedAt: params.now,
    lastActivityAt: params.now,
  };
  params.store.upsertPeer({ peer: connectedPeer, updatedAt: params.now });

  return {
    accepted: true,
    peer: connectedPeer,
    capabilities: policy.capabilities,
  };
}

export function buildFederationProofMessage(params: {
  purpose: "enroll" | "reconnect";
  gatewayInstanceId: FederationInstanceId;
  peerInstanceId: FederationInstanceId;
  publicKeyPem: string;
  protocolVersion: number;
  nonce: string;
  capabilities: readonly FederationCapability[];
  /**
   * Base64 Noise handshake hash binding this identity proof to the specific
   * encrypted channel. Empty in tunnel mode. If a MITM splices a different
   * channel, the client and gateway derive different hashes, the reconstructed
   * proof message differs, and the Ed25519 signature fails to verify.
   */
  channelBinding?: string;
}): string {
  return JSON.stringify({
    capabilities: params.capabilities.slice().sort(),
    channelBinding: params.channelBinding ?? "",
    gatewayInstanceId: params.gatewayInstanceId,
    nonce: params.nonce,
    peerInstanceId: params.peerInstanceId,
    protocolVersion: params.protocolVersion,
    publicKeyPem: params.publicKeyPem,
    purpose: params.purpose,
  });
}

export function buildFederationGatewayChallengeMessage(params: {
  gatewayInstanceId: FederationInstanceId;
  gatewayPublicKeyPem: string;
  protocolVersion: number;
  nonce: string;
}): string {
  return JSON.stringify({
    gatewayInstanceId: params.gatewayInstanceId,
    gatewayPublicKeyPem: params.gatewayPublicKeyPem,
    nonce: params.nonce,
    protocolVersion: params.protocolVersion,
    purpose: "gateway_challenge",
  });
}

export function buildFederationGatewayAcceptedMessage(params: {
  gatewayInstanceId: FederationInstanceId;
  peerInstanceId: FederationInstanceId;
  sessionId: string;
  protocolVersion: number;
  nonce: string;
  capabilities: readonly FederationCapability[];
}): string {
  return JSON.stringify({
    capabilities: params.capabilities.slice().sort(),
    gatewayInstanceId: params.gatewayInstanceId,
    nonce: params.nonce,
    peerInstanceId: params.peerInstanceId,
    protocolVersion: params.protocolVersion,
    purpose: "gateway_accepted",
    sessionId: params.sessionId,
  });
}
