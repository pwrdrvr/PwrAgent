import { ipcMain } from "electron";
import type {
  DismissOperatorQuestionRequest,
  ListOperatorRequestsResponse,
  MarkOperatorItemsSeenRequest,
  OperatorRequestsChangedEvent,
} from "@pwragent/shared";
import { isAppServerBackendKind } from "@pwragent/shared";
import {
  OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL,
  OPERATOR_REQUESTS_DISMISS_QUESTION_CHANNEL,
  OPERATOR_REQUESTS_LIST_CHANNEL,
  OPERATOR_REQUESTS_MARK_SEEN_CHANNEL,
} from "../../shared/ipc";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getMainLogger } from "../log";
import { OperatorRequestService } from "../operator-requests/operator-request-service";
import { OperatorRequestStore } from "../operator-requests/operator-request-store";
import { getAppStateDb } from "../state/app-state";
import { subscribersForChannel } from "../window-channels";

const operatorRequestLog = getMainLogger("pwragent:operator-requests");

/** Seen marks one call may carry; a window marks what is on screen. */
const MAX_SEEN_KEYS_PER_CALL = 500;

let service: OperatorRequestService | undefined;

function broadcastOperatorRequestsChanged(event: OperatorRequestsChangedEvent): void {
  for (const webContents of subscribersForChannel(
    OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL,
  )) {
    if (!webContents.isDestroyed()) {
      webContents.send(OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL, event);
    }
  }
}

export function registerOperatorRequestIpcHandlers(): void {
  service?.stop();
  service = new OperatorRequestService({
    registry: getDesktopBackendRegistry(),
    store: new OperatorRequestStore(getAppStateDb()),
    broadcast: broadcastOperatorRequestsChanged,
  });
  service.start();
  const current = service;

  ipcMain.removeHandler(OPERATOR_REQUESTS_LIST_CHANNEL);
  ipcMain.handle(
    OPERATOR_REQUESTS_LIST_CHANNEL,
    (): ListOperatorRequestsResponse => current.list(),
  );

  ipcMain.removeHandler(OPERATOR_REQUESTS_MARK_SEEN_CHANNEL);
  ipcMain.handle(
    OPERATOR_REQUESTS_MARK_SEEN_CHANNEL,
    (_event, request: MarkOperatorItemsSeenRequest): void => {
      const keys = Array.isArray(request?.keys)
        ? request.keys.filter((key): key is string => typeof key === "string")
        : [];
      try {
        current.markSeen(keys.slice(0, MAX_SEEN_KEYS_PER_CALL));
      } catch (error) {
        operatorRequestLog.warn("could not record seen operator items", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  ipcMain.removeHandler(OPERATOR_REQUESTS_DISMISS_QUESTION_CHANNEL);
  ipcMain.handle(
    OPERATOR_REQUESTS_DISMISS_QUESTION_CHANNEL,
    (_event, request: DismissOperatorQuestionRequest): void => {
      if (
        !isAppServerBackendKind(request?.backend)
        || typeof request.threadId !== "string"
        || typeof request.messageId !== "string"
      ) {
        throw new Error("Invalid question dismissal request.");
      }
      current.dismissQuestion({
        backend: request.backend,
        threadId: request.threadId,
        messageId: request.messageId,
      });
    },
  );
}
