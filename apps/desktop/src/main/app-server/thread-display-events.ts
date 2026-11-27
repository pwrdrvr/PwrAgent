import { buildThreadIncidentSummary } from "@pwragent/shared/thread-incident-summary";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerNotification } from "@pwragent/shared/contracts/normalized-app-server";

/** Live display resources invalidate; they never seed a historical accounting baseline. */
export function projectThreadDisplayEvent(event: AgentEvent): AgentEvent {
  const notification = event.notification;
  if (notification.method === "thread/pricing/updated") {
    const params = notification.params as Extract<AppServerNotification, { method: "thread/pricing/updated" }>["params"];
    return { ...event, notification: { method: "thread/pricing/updated", params: {
      threadId: params.threadId,
      ...(params.pricingHistoryRevision ? { pricingHistoryRevision: params.pricingHistoryRevision } : {}),
      ...(params.changedTurnIds ? { changedTurnIds: params.changedTurnIds } : {}),
      triggeredSpendAlerts: params.triggeredSpendAlerts,
      displayInvalidated: true,
      pricing: { lines: [], summaries: [] },
    } } };
  }
  if (notification.method === "thread/toolAccounting/updated") {
    const params = notification.params as Extract<AppServerNotification, { method: "thread/toolAccounting/updated" }>["params"];
    return { ...event, notification: { method: "thread/toolAccounting/updated", params: {
      threadId: params.threadId,
      triggeredAlerts: params.triggeredAlerts,
      incidentSummary: params.incidentSummary ?? (params.triggeredAlerts?.length ? buildThreadIncidentSummary({
        accounting: params.toolAccounting, backend: event.backend, threadId: params.threadId,
        firstWarningAt: params.incidentNotice?.firstWarningAt,
      }) : undefined),
      incidentNotice: params.incidentNotice,
      displayInvalidated: true,
      toolAccounting: { alerts: [], invocations: [], summaries: [] },
    } } };
  }
  if (notification.method === "thread/subAgents/updated") {
    return { ...event, notification: { method: "thread/subAgents/updated", params: { threadId: notification.params.threadId,
      ...(notification.params.navigationChanged === false ? { navigationChanged: false } : {}),
    } } };
  }
  return event;
}
