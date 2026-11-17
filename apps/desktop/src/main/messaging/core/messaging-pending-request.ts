import type { AgentEvent, AppServerPendingRequestNotification } from "@pwragent/shared";

/** Classify the event without loading a controller on an unconfigured owner. */
export function isMessagingInteractivePendingRequest(
  notification: AgentEvent["notification"],
): notification is AppServerPendingRequestNotification {
  return (
    notification.method === "item/tool/requestUserInput"
    || notification.method === "mcpServer/elicitation/request"
    || notification.method === "applyPatchApproval"
    || notification.method === "execCommandApproval"
    || notification.method.toLowerCase().includes("requestapproval")
  );
}
