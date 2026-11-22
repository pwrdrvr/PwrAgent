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
} from "@pwragent/shared/contracts/composer-drafts";
import { createComposerDraftStorage } from "../storage/desktop-composer-draft-storage";
import { findWindowsDirectoryCaseAliases } from "../app-server/navigation-windows-directory-aliases";

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

export async function listComposerDraftRecoveryCandidates(
  request?: ListComposerDraftRecoveryCandidatesRequest,
): Promise<ListComposerDraftRecoveryCandidatesResponse> {
  const storage = createComposerDraftStorage();
  const { directoryKey, scopeKey } = request ?? {};
  if (process.platform !== "win32" || !directoryKey?.startsWith("directory:")
    || (scopeKey && scopeKey !== `launchpad:${directoryKey}`)) {
    return { candidates: storage.listCandidates(request) };
  }
  const aliases = await findWindowsDirectoryCaseAliases(directoryKey, storage.listUnsentProjectDraftKeys());
  return { candidates: storage.listCandidatesWithProjectAliases(request, aliases) };
}

export function listComposerDraftLatest(request?: ListComposerDraftLatestRequest): ListComposerDraftLatestResponse {
  const store = createComposerDraftStorage();
  if (request?.migrateKnownOwners === true) store.migrateKnownOwnerScopes();
  if (request?.migrateLegacyLaunchpads === true) store.migrateLegacyLaunchpadDrafts();
  return { drafts: store.listLatest() };
}
