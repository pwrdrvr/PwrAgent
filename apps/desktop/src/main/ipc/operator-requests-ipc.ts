import { ipcMain } from "electron";
import type {
  DismissOperatorQuestionRequest,
  ListOperatorRequestsResponse,
  MarkOperatorItemsSeenRequest,
  OperatorRequestsChangedEvent,
  OperatorQuestionThreadRequest,
} from "@pwragent/shared";
import {
  OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL,
  OPERATOR_REQUESTS_DISMISS_QUESTION_CHANNEL,
  OPERATOR_REQUESTS_LIST_CHANNEL,
  OPERATOR_QUESTIONS_LIST_DISMISSED_CHANNEL,
  OPERATOR_REQUESTS_MARK_SEEN_CHANNEL,
} from "../../shared/ipc";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getMainLogger } from "../log";
import { OperatorRequestService } from "../operator-requests/operator-request-service";
import { OperatorRequestStore } from "../operator-requests/operator-request-store";
import { installOperatorRequestService, localOperatorQuestionOperations } from "../operator-requests/operator-request-runtime";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getAppStateDb } from "../state/app-state";
import { federationTargetForChannelSubscriber, subscribersForChannel } from "../window-channels";

const operatorRequestLog = getMainLogger("pwragent:operator-requests");

/** Seen marks one call may carry; a window marks what is on screen. */
const MAX_SEEN_KEYS_PER_CALL = 500;

let service: OperatorRequestService | undefined;
let unsubscribeRemote: (() => void) | undefined;
let unsubscribePeers: (() => void) | undefined;

function broadcastOperatorRequestsChanged(event: OperatorRequestsChangedEvent): void {
  for (const webContents of subscribersForChannel(
    OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL,
  )) {
    const target = federationTargetForChannelSubscriber(webContents);
    if (target && target.instanceId !== event.federationTarget?.instanceId) continue;
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
    broadcast: (event) => {
      broadcastOperatorRequestsChanged(event);
      if (event.reason === "questions" && event.backend && event.threadId) {
        getDesktopFederationRuntime().publishOperatorQuestionsChanged({ backend: event.backend, threadId: event.threadId });
      }
    },
  });
  service.start();
  const current = service;
  installOperatorRequestService(current);
  const runtime = getDesktopFederationRuntime();
  unsubscribeRemote?.();
  unsubscribeRemote = runtime.onRemoteBackendEvent((event) => {
    if (event.notification.method !== "thread/operatorQuestions/changed"
      && event.notification.method !== "federation/eventStream/changed") return;
    broadcastOperatorRequestsChanged({ reason: "questions",
      ...(event.notification.method === "thread/operatorQuestions/changed" ? event.notification.params : {}),
      federationTarget: event.federationTarget?.scope === "remote" ? event.federationTarget : undefined,
    });
  });
  unsubscribePeers?.();
  unsubscribePeers = runtime.onPeerStatusChanged(() => {
    // Reconnected viewers reload owner state, including events missed offline.
    for (const webContents of subscribersForChannel(OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL)) {
      if (!webContents.isDestroyed()) webContents.send(OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL, { reason: "questions" });
    }
  });

  ipcMain.removeHandler(OPERATOR_QUESTIONS_LIST_DISMISSED_CHANNEL);
  ipcMain.handle(OPERATOR_QUESTIONS_LIST_DISMISSED_CHANNEL, async (event, request: OperatorQuestionThreadRequest) => {
    const { federationTarget, ...local } = request;
    const target = federationTarget ?? federationTargetForChannelSubscriber(event.sender);
    return target
      ? await runtime.requestOperatorQuestionOperation(target, "listDismissed", local)
      : localOperatorQuestionOperations.listDismissed(local);
  });

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
    async (event, request: DismissOperatorQuestionRequest): Promise<void> => {
      const { federationTarget, ...local } = request;
      const target = federationTarget ?? federationTargetForChannelSubscriber(event.sender);
      if (target) await runtime.requestOperatorQuestionOperation(target, "dismiss", local);
      else localOperatorQuestionOperations.dismiss(local);
    },
  );
}
