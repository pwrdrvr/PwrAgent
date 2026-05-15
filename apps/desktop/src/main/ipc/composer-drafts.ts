import { ipcMain } from "electron";
import type {
  ClearComposerDraftRequest,
  ClearComposerDraftResponse,
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
import { getAppStateDb } from "../state/app-state";
import { ComposerDraftRecoveryStore } from "../state/composer-draft-recovery-store";

const log = getMainLogger("pwragent:composer-drafts");

function getStore(): ComposerDraftRecoveryStore {
  return new ComposerDraftRecoveryStore(getAppStateDb());
}

export function registerComposerDraftIpcHandlers(): void {
  ipcMain.removeHandler(COMPOSER_DRAFT_SAVE_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_SAVE_CHANNEL,
    async (
      _event,
      request: SaveComposerDraftRequest,
    ): Promise<SaveComposerDraftResponse> => {
      const draft = getStore().save(request);
      return { draft };
    },
  );

  ipcMain.removeHandler(COMPOSER_DRAFT_RECORD_HISTORY_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_RECORD_HISTORY_CHANNEL,
    async (
      _event,
      request: RecordComposerDraftHistoryRequest,
    ): Promise<RecordComposerDraftHistoryResponse> => {
      const candidate = getStore().recordHistory(request.draft);
      return { candidate };
    },
  );

  ipcMain.removeHandler(COMPOSER_DRAFT_CLEAR_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_CLEAR_CHANNEL,
    async (
      _event,
      request: ClearComposerDraftRequest,
    ): Promise<ClearComposerDraftResponse> => {
      getStore().clear(request.scopeKey);
      return { scopeKey: request.scopeKey };
    },
  );

  ipcMain.removeHandler(COMPOSER_DRAFT_LIST_CANDIDATES_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_LIST_CANDIDATES_CHANNEL,
    async (
      _event,
      request: ListComposerDraftRecoveryCandidatesRequest | undefined,
    ): Promise<ListComposerDraftRecoveryCandidatesResponse> => {
      return { candidates: getStore().listCandidates(request) };
    },
  );

  ipcMain.removeHandler(COMPOSER_DRAFT_LIST_LATEST_CHANNEL);
  ipcMain.handle(
    COMPOSER_DRAFT_LIST_LATEST_CHANNEL,
    async (): Promise<ListComposerDraftLatestResponse> => {
      return { drafts: getStore().listLatest() };
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
