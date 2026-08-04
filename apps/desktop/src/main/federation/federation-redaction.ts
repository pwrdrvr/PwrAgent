export type FederationAuthFailureCode =
  | "invalid_protocol_version"
  | "invalid_peer_id"
  | "unknown_peer"
  | "revoked_peer"
  | "missing_invite"
  | "expired_invite"
  | "wrong_gateway"
  | "reused_invite"
  | "bad_signature"
  | "capability_denied"
  | "policy_denied";

export type FederationRedactedFailure = {
  code: FederationAuthFailureCode;
  message: string;
};

const FAILURE_MESSAGES: Record<FederationAuthFailureCode, string> = {
  invalid_protocol_version: "Protocol version is not supported.",
  invalid_peer_id: "Peer id is invalid.",
  unknown_peer: "Peer is not enrolled.",
  revoked_peer: "Peer has been revoked.",
  missing_invite: "Enrollment invite is missing.",
  expired_invite: "Enrollment invite is expired.",
  wrong_gateway: "Enrollment invite belongs to a different gateway.",
  reused_invite: "Enrollment invite has already been used.",
  bad_signature: "Peer proof signature is invalid.",
  capability_denied: "Requested capability is not authorized.",
  policy_denied: "Federation policy denied the session.",
};

export function federationFailure(
  code: FederationAuthFailureCode,
): FederationRedactedFailure {
  return {
    code,
    message: FAILURE_MESSAGES[code],
  };
}

export function redactFederationDiagnostic(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-pem]")
    .replace(/[A-Za-z0-9+/=]{32,}/g, "[redacted-token]");
}
