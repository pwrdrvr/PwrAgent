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
import { createComposerDraftStorage } from "../storage/desktop-composer-draft-storage";

export function saveComposerDraft(request: SaveComposerDraftRequest): SaveComposerDraftResponse {
  return { draft: createComposerDraftStorage().save(request) };
}

export function recordComposerDraftHistory(request: RecordComposerDraftHistoryRequest): RecordComposerDraftHistoryResponse {
  return { candidate: createComposerDraftStorage().recordHistory(request.draft) };
}

export function clearComposerDraft(request: ClearComposerDraftRequest): ClearComposerDraftResponse {
  createComposerDraftStorage().clear(request.scopeKey);
  return { scopeKey: request.scopeKey };
}

export function listComposerDraftRecoveryCandidates(request?: ListComposerDraftRecoveryCandidatesRequest): ListComposerDraftRecoveryCandidatesResponse {
  return { candidates: createComposerDraftStorage().listCandidates(request) };
}

export function listComposerDraftLatest(request?: ListComposerDraftLatestRequest): ListComposerDraftLatestResponse {
  const store = createComposerDraftStorage();
  if (request?.migrateKnownOwners === true) store.migrateKnownOwnerScopes();
  if (request?.migrateLegacyLaunchpads === true) store.migrateLegacyLaunchpadDrafts();
  return { drafts: store.listLatest() };
}
