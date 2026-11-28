import type {
  ManageAgentNotificationsRequest,
  ManageAgentNotificationsResponse,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import {
  getAgentNotificationCenter,
  getScheduledThreadActionService,
} from "./scheduled-thread-action-service";

/**
 * This owner's notices: what its own windows ask, and what a peer asks over
 * Federation. `titled` adds thread titles, for a peer's windows, which do
 * not list this owner's threads.
 */
export async function manageLocalAgentNotifications(
  request: ManageAgentNotificationsRequest,
  options: { titled?: boolean } = {},
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
  return { ok: true, snapshot: options.titled ? await center.titledSnapshot() : center.snapshot() };
}
