import { ipcMain } from "electron";
import type {
  DismissOperatorQuestionRequest,
  ListOperatorRequestsRequest,
  MarkOperatorItemsSeenRequest,
  OperatorRequestsChangedEvent,
  OperatorQuestionThreadRequest,
} from "@pwragent/shared/contracts/operator-requests";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import {
  OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL,
  OPERATOR_REQUESTS_DISMISS_QUESTION_CHANNEL,
  OPERATOR_REQUESTS_LIST_CHANNEL,
  OPERATOR_QUESTIONS_LIST_DISMISSED_CHANNEL,
  OPERATOR_REQUESTS_MARK_SEEN_CHANNEL,
} from "../../../shared/ipc";
import { getMainLogger } from "../../log";
import type { OperatorRequestService } from "../../operator-requests/operator-request-service";
import { localOperatorQuestionOperations } from "../../operator-requests/operator-request-runtime";
import type { OwnerQueueEvents } from "../../owner-queue-services";
import { FederatedOperatorRequestService } from "../../federation/federation-operator-requests";
import { getDesktopOverlayStore } from "../../storage/desktop-overlay-store";
import { getDesktopFederationRuntime } from "../../federation/federation-runtime";
import { federationTargetForChannelSubscriber, subscribersForChannel } from "../window-channels";

const operatorRequestLog = getMainLogger("pwragent:operator-requests");

let unsubscribeLocal: (() => void) | undefined;
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

export function registerOperatorRequestIpcHandlers({ operatorRequests, events }: {
  operatorRequests: Pick<OperatorRequestService, "list" | "markSeen">;
  events: OwnerQueueEvents;
}): void {
  unsubscribeLocal?.();
  events.on("operatorRequestsChanged", broadcastOperatorRequestsChanged);
  unsubscribeLocal = () => { events.off("operatorRequestsChanged", broadcastOperatorRequestsChanged); };
  const runtime = getDesktopFederationRuntime();
  const queue = new FederatedOperatorRequestService({
    localList: () => operatorRequests.list(),
    localMarkSeen: (keys) => operatorRequests.markSeen(keys),
    remote: (target, operation, request) => runtime.requestOperatorQuestionOperation(target, operation, request),
    mountedThreads: async () => (await getDesktopOverlayStore().listRemoteThreadPins())
      .filter((pin) => pin.ref.target.scope === "remote")
      .map((pin) => ({ ...pin.ref, target: pin.ref.target as FederationRemoteTarget })),
    onUnavailable: (error) => operatorRequestLog.warn("mounted thread operator requests unavailable", { error: String(error) }),
  });
  unsubscribeRemote?.();
  unsubscribeRemote = runtime.onRemoteBackendEvent((event) => {
    if (event.notification.method !== "thread/operatorQuestions/changed"
      && event.notification.method !== "thread/operatorRequests/changed"
      && event.notification.method !== "thread/operatorRequestDetails/changed"
      && event.notification.method !== "federation/eventStream/changed") return;
    broadcastOperatorRequestsChanged({ reason: "questions",
      ...(event.notification.method !== "federation/eventStream/changed" ? event.notification.params : {}),
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
    (event, request: ListOperatorRequestsRequest = {}) => queue.list(request, federationTargetForChannelSubscriber(event.sender)),
  );

  ipcMain.removeHandler(OPERATOR_REQUESTS_MARK_SEEN_CHANNEL);
  ipcMain.handle(
    OPERATOR_REQUESTS_MARK_SEEN_CHANNEL,
    (event, request: MarkOperatorItemsSeenRequest) => queue.markSeen(request, federationTargetForChannelSubscriber(event.sender)),
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
