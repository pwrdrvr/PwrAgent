import type { FederationPeerId, FederationPeerSummary, FederationInstanceRole, FederationSessionId } from "./federation";

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

/** Profile federation persistence supplied by the host, without a database handle. */
export interface FederationStorage {
  upsertPeer(params: {
    peer: FederationPeerSummary & { pinnedPublicKeyPem?: string };
    createdAt?: number;
    updatedAt: number;
    /** Only verified one-time enrollment may explicitly restore revoked trust. */
    clearRevocation?: boolean;
  }): void;
  getPeer(peerId: FederationPeerId): (FederationPeerSummary & {
    createdAt: number;
    updatedAt: number;
    lastSeenAt?: number;
    pinnedPublicKeyPem?: string;
  }) | undefined;
  listPeers(options?: { includeRevoked?: boolean }): FederationPeerSummary[];
  revokePeer(peerId: FederationPeerId, revokedAt: number): void;
  createEnrollment(params: {
    token: string;
    generatedAt: number;
    expiresAt: number;
    label?: string;
    role?: FederationInstanceRole;
    endpoint?: string;
    gatewayInstanceId?: string;
  }): FederationEnrollmentEntry;
  findMatchingPendingEnrollment(params: { token: string; now: number }): FederationEnrollmentEntry | undefined;
  markEnrollmentUsed(params: { enrollmentId: string; peerId: FederationPeerId; usedAt: number }): FederationEnrollmentEntry | undefined;
  getEnrollment(enrollmentId: string): FederationEnrollmentEntry | undefined;
  revokePendingEnrollment(enrollmentId: string): void;
  expireEnrollments(now: number): void;
  appendAudit(params: {
    peerId?: FederationPeerId;
    sessionId?: FederationSessionId;
    kind: FederationSessionAuditKind;
    createdAt: number;
    detail?: string;
  }): FederationSessionAuditEntry;
  listAudit(params?: { peerId?: FederationPeerId; sessionId?: FederationSessionId; limit?: number }): FederationSessionAuditEntry[];
}
