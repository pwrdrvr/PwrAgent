import type {
  ClearComposerDraftRequest,
  ClearComposerDraftResponse,
  ListComposerDraftLatestRequest,
  ListComposerDraftLatestResponse,
  ListComposerDraftRecoveryCandidatesRequest,
  ListComposerDraftRecoveryCandidatesResponse,
  RecordComposerDraftHistoryRequest,
  RecordComposerDraftHistoryResponse,
  SaveComposerDraftRequest,
  SaveComposerDraftResponse,
} from "@pwragent/shared";
import { getAppStateDb } from "../state/app-state";
import { ComposerDraftRecoveryStore } from "../state/composer-draft-recovery-store";

function getStore(): ComposerDraftRecoveryStore {
  return new ComposerDraftRecoveryStore(getAppStateDb());
}

export function saveComposerDraft(request: SaveComposerDraftRequest): SaveComposerDraftResponse {
  return { draft: getStore().save(request) };
}

export function recordComposerDraftHistory(request: RecordComposerDraftHistoryRequest): RecordComposerDraftHistoryResponse {
  return { candidate: getStore().recordHistory(request.draft) };
}

export function clearComposerDraft(request: ClearComposerDraftRequest): ClearComposerDraftResponse {
  getStore().clear(request.scopeKey);
  return { scopeKey: request.scopeKey };
}

export function listComposerDraftRecoveryCandidates(request?: ListComposerDraftRecoveryCandidatesRequest): ListComposerDraftRecoveryCandidatesResponse {
  return { candidates: getStore().listCandidates(request) };
}

export function listComposerDraftLatest(request?: ListComposerDraftLatestRequest): ListComposerDraftLatestResponse {
  const store = getStore();
  if (request?.migrateKnownOwners === true) store.migrateKnownOwnerScopes();
  if (request?.migrateLegacyLaunchpads === true) store.migrateLegacyLaunchpadDrafts();
  return { drafts: store.listLatest() };
}
