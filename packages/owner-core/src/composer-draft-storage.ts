import type {
  ComposerDraftRecoveryCandidate,
  ComposerDraftSnapshotRecord,
  ListComposerDraftRecoveryCandidatesRequest,
  SaveComposerDraftRequest,
} from "@pwragent/shared";

/**
 * Viewer-local composer persistence, including drafts for peer-owned threads.
 * This is an application storage port, never a federated owner projection.
 * Operations are synchronous; the host retains its existing transaction policy.
 */
export interface ComposerDraftStorage {
  save(request: SaveComposerDraftRequest): ComposerDraftSnapshotRecord;
  recordHistory(draft: ComposerDraftSnapshotRecord): ComposerDraftRecoveryCandidate;
  clear(scopeKey: string): void;
  listLatest(): ComposerDraftSnapshotRecord[];
  listCandidates(request?: ListComposerDraftRecoveryCandidatesRequest): ComposerDraftRecoveryCandidate[];
  /** Explicit startup migrations; ordinary reads never initiate them. */
  migrateKnownOwnerScopes(): number;
  migrateLegacyLaunchpadDrafts(): number;
}
