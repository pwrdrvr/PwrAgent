import type { FederationCapability } from "@pwragent/shared/contracts/federation";
import type {
  ManageAgentNotificationsRequest,
  ManageAgentNotificationsResponse,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { FederationRouter } from "./federation-router";

export const FEDERATION_AGENT_NOTIFICATION_METHODS = {
  snapshot: "agentNotifications.snapshot",
  manage: "agentNotifications.manage",
} as const;

/**
 * Reading notices needs `thread_detail`, as their text comes from threads.
 * Dismissing or cancelling one needs `turn_control`. Contained peers are
 * denied by `FederationRouter`.
 */
export const FEDERATION_AGENT_NOTIFICATION_CAPABILITIES: Record<string, FederationCapability> = {
  [FEDERATION_AGENT_NOTIFICATION_METHODS.snapshot]: "thread_detail",
  [FEDERATION_AGENT_NOTIFICATION_METHODS.manage]: "turn_control",
};

export type LocalAgentNotificationOperation = (
  request: ManageAgentNotificationsRequest,
  options: { titled: true },
) => Promise<ManageAgentNotificationsResponse>;

/** The owner's side: a peer's windows read and act on this owner's notices. */
export function registerFederationAgentNotificationHandlers(
  router: FederationRouter,
  local: LocalAgentNotificationOperation,
): void {
  router.registerHandler(FEDERATION_AGENT_NOTIFICATION_METHODS.snapshot, () => local({ action: "snapshot" }, { titled: true }));
  router.registerHandler(FEDERATION_AGENT_NOTIFICATION_METHODS.manage, (envelope) => {
    const request = (envelope.params ?? {}) as ManageAgentNotificationsRequest & { federationTarget?: unknown };
    if (request.federationTarget !== undefined) {
      throw new Error("Notice requests must terminate at their owner.");
    }
    if (request.action === "snapshot") {
      throw new Error("Read notices with agentNotifications.snapshot.");
    }
    return local(request, { titled: true });
  });
}
