import type { FederationPeerId, FederationPeerSummary, FederationInstanceRole, FederationSessionId } from "@pwragent/shared";

export type FederationEnrollmentStatus =
  | "pending"
  | "used"
  | "expired"
  | "revoked";

export type FederationEnrollmentEntry = {
  id: string;
  status: FederationEnrollmentStatus;
  generatedAt: number;
  expiresAt: number;
  usedAt?: number;
  peerId?: FederationPeerId;
  label?: string;
  role?: FederationInstanceRole;
  endpoint?: string;
  gatewayInstanceId?: string;
};

export type FederationSessionAuditKind =
  | "connect_attempt"
  | "connected"
  | "rejected"
  | "disconnected"
  | "relay"
  | "error"
  | "remote_pty_open"
  | "remote_pty_close";

export type FederationSessionAuditEntry = {
  eventId: number;
  peerId?: FederationPeerId;
  sessionId?: FederationSessionId;
  kind: FederationSessionAuditKind;
  createdAt: number;
  detail?: string;
  repeatCount?: number;
  firstSeenAt?: number;
};

/** Storage supplied by the host; transport never depends on SQLite or secrets. */
export interface FederationStore {
  upsertPeer(params: { peer: FederationPeerSummary & { pinnedPublicKeyPem?: string }; createdAt?: number; updatedAt: number; clearRevocation?: boolean }): void;
  getPeer(peerId: FederationPeerId): (FederationPeerSummary & { pinnedPublicKeyPem?: string }) | undefined;
  findMatchingPendingEnrollment(params: { token: string; now: number }): FederationEnrollmentEntry | undefined;
  markEnrollmentUsed(params: { enrollmentId: string; peerId: FederationPeerId; usedAt: number }): FederationEnrollmentEntry | undefined;
  appendAudit(params: { peerId?: FederationPeerId; sessionId?: FederationSessionId; kind: FederationSessionAuditKind; createdAt: number; detail?: string }): FederationSessionAuditEntry;
}
