import type {
  ManageAgentNotificationsRequest,
  ManageAgentNotificationsResponse,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { AgentNotificationCenter } from "./agent-notification-center";
import {
  getAgentNotificationCenter,
  getScheduledThreadActionService,
  type ScheduledThreadActionService,
} from "./scheduled-thread-action-service";

/** The owner's center and scheduler; the running process's unless a test passes its own. */
export type AgentNotificationOwner = {
  center: () => AgentNotificationCenter | undefined;
  service: () => Pick<ScheduledThreadActionService, "get" | "cancel">;
};

const RUNNING_OWNER: AgentNotificationOwner = {
  center: getAgentNotificationCenter,
  service: getScheduledThreadActionService,
};

/**
 * This owner's notices: what its own windows ask, and what a peer asks over
 * Federation. `titled` adds thread titles, for a peer's windows, which do
 * not list this owner's threads.
 */
export async function manageLocalAgentNotifications(
  request: ManageAgentNotificationsRequest,
  options: { titled?: boolean } = {},
  owner: AgentNotificationOwner = RUNNING_OWNER,
): Promise<ManageAgentNotificationsResponse> {
  const center = owner.center();
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
      // This machine's notices only: a peer's are dismissed on the peer.
      await center.dismissAll(Array.isArray(request.ids)
        ? request.ids.filter((ref) => ref && !ref.federationTarget).map((ref) => String(ref.id))
        : undefined);
      break;
    case "cancel": {
      const service = owner.service();
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
