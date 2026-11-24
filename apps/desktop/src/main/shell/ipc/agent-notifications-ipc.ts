import { ipcMain } from "electron";
import type {
  ManageAgentNotificationsRequest,
  ManageAgentNotificationsResponse,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import { AGENT_NOTIFICATIONS_MANAGE_CHANNEL } from "../../../shared/ipc";
import {
  getAgentNotificationCenter,
  getScheduledThreadActionService,
} from "../../scheduled-actions/scheduled-thread-action-service";
import { isFederationWindowWebContents } from "../window";

const EMPTY_SNAPSHOT = { unread: [], scheduled: [], earlier: [] };

/**
 * A window's view of its owner's agent notices. A window showing a peer
 * gets none: the peer's own windows show its notices.
 */
export function registerAgentNotificationIpcHandlers(): void {
  ipcMain.removeHandler(AGENT_NOTIFICATIONS_MANAGE_CHANNEL);
  ipcMain.handle(AGENT_NOTIFICATIONS_MANAGE_CHANNEL, async (event, request: ManageAgentNotificationsRequest) => {
    if (isFederationWindowWebContents(event.sender)) {
      return { ok: true, snapshot: EMPTY_SNAPSHOT } satisfies ManageAgentNotificationsResponse;
    }
    return await manageAgentNotifications(request);
  });
}

export async function manageAgentNotifications(
  request: ManageAgentNotificationsRequest,
): Promise<ManageAgentNotificationsResponse> {
  const center = getAgentNotificationCenter();
  if (!center) {
    return { ok: false, error: { code: "unavailable", message: "Notices are not available yet." } };
  }
  if (!request || typeof request !== "object") {
    return { ok: false, error: { code: "invalid_request", message: "Unknown request." } };
  }
  switch (request.action) {
    case "snapshot":
      break;
    case "dismiss":
      await center.dismiss(String(request.id));
      break;
    case "dismiss_all":
      await center.dismissAll();
      break;
    case "cancel": {
      const service = getScheduledThreadActionService();
      const action = service.get(String(request.id));
      if (!action || action.kind !== "notification") {
        return { ok: false, error: { code: "not_found", message: "That notice is no longer scheduled." } };
      }
      // The operator may cancel any waiting notice; the agent only its own.
      await service.cancel({ id: action.id });
      break;
    }
    default:
      return { ok: false, error: { code: "invalid_request", message: "Unknown request." } };
  }
  return { ok: true, snapshot: center.snapshot() };
}
