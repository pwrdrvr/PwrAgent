import { ipcMain } from "electron";
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
import {
  COMPOSER_DRAFT_CLEAR_CHANNEL,
  COMPOSER_DRAFT_LIST_CANDIDATES_CHANNEL,
  COMPOSER_DRAFT_LIST_LATEST_CHANNEL,
  COMPOSER_DRAFT_RECORD_HISTORY_CHANNEL,
  COMPOSER_DRAFT_SAVE_CHANNEL,
} from "../../shared/ipc";
import { getMainLogger } from "../log";
import {
  clearComposerDraft,
  listComposerDraftLatest,
  listComposerDraftRecoveryCandidates,
  recordComposerDraftHistory,
  saveComposerDraft,
} from "../composer-drafts/composer-draft-service";

const log = getMainLogger("pwragent:composer-drafts");

export function registerComposerDraftIpcHandlers(): void {
  ipcMain.removeHandler(COMPOSER_DRAFT_SAVE_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_SAVE_CHANNEL,
    async (
      _event,
      request: SaveComposerDraftRequest,
    ): Promise<SaveComposerDraftResponse> => {
      return saveComposerDraft(request);
    },
  );

  ipcMain.removeHandler(COMPOSER_DRAFT_RECORD_HISTORY_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_RECORD_HISTORY_CHANNEL,
    async (
      _event,
      request: RecordComposerDraftHistoryRequest,
    ): Promise<RecordComposerDraftHistoryResponse> => {
      return recordComposerDraftHistory(request);
    },
  );

  ipcMain.removeHandler(COMPOSER_DRAFT_CLEAR_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_CLEAR_CHANNEL,
    async (
      _event,
      request: ClearComposerDraftRequest,
    ): Promise<ClearComposerDraftResponse> => {
      return clearComposerDraft(request);
    },
  );

  ipcMain.removeHandler(COMPOSER_DRAFT_LIST_CANDIDATES_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_LIST_CANDIDATES_CHANNEL,
    async (
      _event,
      request: ListComposerDraftRecoveryCandidatesRequest | undefined,
    ): Promise<ListComposerDraftRecoveryCandidatesResponse> => {
      return listComposerDraftRecoveryCandidates(request);
    },
  );

  ipcMain.removeHandler(COMPOSER_DRAFT_LIST_LATEST_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_LIST_LATEST_CHANNEL,
    async (_event, request?: ListComposerDraftLatestRequest): Promise<ListComposerDraftLatestResponse> => {
      return listComposerDraftLatest(request);
    },
  );
}

export function disposeComposerDraftIpcHandlers(): void {
  for (const channel of [
    COMPOSER_DRAFT_SAVE_CHANNEL,
    COMPOSER_DRAFT_RECORD_HISTORY_CHANNEL,
    COMPOSER_DRAFT_CLEAR_CHANNEL,
    COMPOSER_DRAFT_LIST_CANDIDATES_CHANNEL,
    COMPOSER_DRAFT_LIST_LATEST_CHANNEL,
  ]) {
    ipcMain.removeHandler(channel);
  }
  log.debug("composer draft ipc handlers disposed");
}
