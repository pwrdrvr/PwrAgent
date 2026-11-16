import { navigationQueryEventRequiresRefresh } from "@pwragent/shared";
import type { AgentEvent, NavigationQueryRequest } from "@pwragent/shared";
export type NavigationDiagnosticCause = NonNullable<NavigationQueryRequest["diagnostic"]>["cause"];
const REFRESH_CALLERS = [
  "navigation/refresh", "scheduled/thread-lifecycle", "action/pr-detach", "action/messaging-unbind",
  "action/remote-pin-add", "action/remote-pin-remove", "action/reply-refresh", "action/automation-refresh",
] as const;
export type NavigationRefreshCaller = typeof REFRESH_CALLERS[number];

/** Classify protocol method names only. Never retain notification payloads. */
export function navigationDiagnosticCause(event?: AgentEvent): NavigationDiagnosticCause {
  const params = event?.notification.params as { sourceMethod?: unknown } | undefined;
  const method = event?.notification.method === "navigation/invalidated" && typeof params?.sourceMethod === "string"
    ? params.sourceMethod : event?.notification.method;
  if (!method) return "refresh";
  if (method.startsWith("turn/")) return "turn";
  if (method.startsWith("federation/")) return "federation";
  if (method.startsWith("thread/pin/") || method === "navigation/remoteThreadPins/changed") return "pins";
  if (method.startsWith("thread/")) return "thread";
  if (method.startsWith("navigation/") || method.startsWith("directory/")) return "metadata";
  return "event";
}

/** Only known row-change methods survive; arbitrary approval method prefixes do not. */
export function safeNavigationDiagnosticTrigger(method: unknown): string | undefined {
  if (typeof method !== "string" || method.length > 100) return undefined;
  if (REFRESH_CALLERS.some((caller) => caller === method)) return method;
  if (method === "action/create-thread" || method === "action/materialize-launchpad"
    || method === "action/show-thread" || method === "action/select-subthread-parent"
    || method === "action/pull-request-refresh") return method;
  if (method.endsWith("/requestApproval")) return "approval-request";
  return method === "approval-request" || navigationQueryEventRequiresRefresh(method) ? method : undefined;
}

export function navigationDiagnosticTrigger(event?: AgentEvent): string | undefined {
  const params = event?.notification.params as { sourceMethod?: unknown } | undefined;
  return safeNavigationDiagnosticTrigger(event?.notification.method === "navigation/invalidated"
    ? params?.sourceMethod : event?.notification.method);
}
