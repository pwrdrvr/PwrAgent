import type { FederationPeerId, FederationPeerSummary, FederationInstanceRole, FederationSessionId } from "@pwragent/shared";

import type { FederationEnrollmentEntry, FederationSessionAuditEntry, FederationSessionAuditKind } from "@pwragent/shared";
export type { FederationEnrollmentStatus, FederationEnrollmentEntry, FederationSessionAuditKind, FederationSessionAuditEntry } from "@pwragent/shared";

/** Storage supplied by the host; transport never depends on SQLite or secrets. */
export interface FederationStore {
  upsertPeer(params: { peer: FederationPeerSummary & { pinnedPublicKeyPem?: string }; createdAt?: number; updatedAt: number; clearRevocation?: boolean }): void;
  getPeer(peerId: FederationPeerId): (FederationPeerSummary & { pinnedPublicKeyPem?: string }) | undefined;
  createEnrollment(params: { token: string; generatedAt: number; expiresAt: number; label?: string; role?: FederationInstanceRole; endpoint?: string; gatewayInstanceId?: string }): FederationEnrollmentEntry;
  findMatchingPendingEnrollment(params: { token: string; now: number }): FederationEnrollmentEntry | undefined;
  markEnrollmentUsed(params: { enrollmentId: string; peerId: FederationPeerId; usedAt: number }): FederationEnrollmentEntry | undefined;
  appendAudit(params: { peerId?: FederationPeerId; sessionId?: FederationSessionId; kind: FederationSessionAuditKind; createdAt: number; detail?: string }): FederationSessionAuditEntry;
}
