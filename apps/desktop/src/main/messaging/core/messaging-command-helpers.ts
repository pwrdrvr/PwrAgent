import type { AppServerThreadMessageOrigin } from "@pwragent/shared/contracts/normalized-app-server";
import type { ScheduledThreadAction } from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { MessagingInboundEvent, MessagingJsonValue } from "@pwragent/messaging-interface";
import { type MessagingDefaultAgentScopeKind } from "./messaging-default-agent.js";

export type MonitorCommandAction =
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "refresh" }
  | { kind: "topics-adopt" }
  | { kind: "topics-cleanup" }
  | { kind: "topics-fanout" }
  | { kind: "cycle-interval" }
  | { kind: "cycle-pinned" }
  | { kind: "cycle-recent" }
  | { kind: "toggle-snippet" }
  | { kind: "toggle-status-line" }
  | { kind: "set-pinned"; count: number }
  | { kind: "set-interval"; intervalMs: number }
  | { kind: "set-recent"; count: number }
  | { kind: "set-snippet"; enabled: boolean }
  | { kind: "set-status-line"; enabled: boolean };

export function normalizeMonitorCommandAction(
  args: readonly string[] | undefined,
): MonitorCommandAction {
  const normalized = args?.[0]?.trim().toLowerCase();
  if (normalized === "stop" || normalized === "off" || normalized === "disable") {
    return { kind: "stop" };
  }
  if (normalized === "refresh" || normalized === "now") {
    return { kind: "refresh" };
  }
  if (normalized === "topic" || normalized === "topics") {
    const topicAction = args?.[1]?.trim().toLowerCase();
    if (
      topicAction === "cleanup" ||
      topicAction === "clean" ||
      topicAction === "sweep"
    ) {
      return { kind: "topics-cleanup" };
    }
    if (
      topicAction === "fanout" ||
      topicAction === "fan-out" ||
      topicAction === "attach"
    ) {
      return { kind: "topics-fanout" };
    }
    return { kind: "topics-adopt" };
  }
  if (
    normalized === "interval" ||
    normalized === "every" ||
    normalized === "frequency"
  ) {
    const intervalMs = parseMonitorIntervalArg(args?.[1]);
    return typeof intervalMs === "number"
      ? { kind: "set-interval", intervalMs }
      : { kind: "cycle-interval" };
  }
  if (normalized === "pins" || normalized === "pin") {
    const count = parseMonitorCountArg(args?.[1]);
    return typeof count === "number"
      ? { kind: "set-pinned", count }
      : { kind: "cycle-pinned" };
  }
  if (
    normalized === "recent" ||
    normalized === "recents" ||
    normalized === "threads"
  ) {
    const count = parseMonitorCountArg(args?.[1]);
    return typeof count === "number"
      ? { kind: "set-recent", count }
      : { kind: "cycle-recent" };
  }
  if (
    normalized === "status" ||
    normalized === "details" ||
    normalized === "detail"
  ) {
    const enabled = parseMonitorStatusLineArg(args?.[1]);
    return typeof enabled === "boolean"
      ? { kind: "set-status-line", enabled }
      : { kind: "toggle-status-line" };
  }
  if (
    normalized === "snippet" ||
    normalized === "snippets" ||
    normalized === "response"
  ) {
    const enabled = parseMonitorBooleanArg(args?.[1]);
    return typeof enabled === "boolean"
      ? { kind: "set-snippet", enabled }
      : { kind: "toggle-snippet" };
  }
  return { kind: "start" };
}

export function parseMonitorCountArg(arg: string | undefined): number | undefined {
  if (!arg) {
    return undefined;
  }
  const parsed = Number(arg.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseMonitorIntervalArg(arg: string | undefined): number | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const match = normalized.match(
    /^(\d+(?:\.\d+)?)(?:\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes))?$/,
  );
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const unit = match[2];
  if (unit?.startsWith("m")) {
    return value * 60_000;
  }
  return value * 1000;
}

export function parseMonitorStatusLineArg(arg: string | undefined): boolean | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "line" ||
    normalized === "lines" ||
    normalized === "detail" ||
    normalized === "details"
  ) {
    return true;
  }
  if (normalized === "inline" || normalized === "off") {
    return false;
  }
  return parseMonitorBooleanArg(normalized);
}

export function parseMonitorBooleanArg(arg: string | undefined): boolean | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "on" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "off" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
}

export function scheduledActionFailureMessage(
  action: ScheduledThreadAction,
): string | undefined {
  return action.status === "failed"
    ? action.errorMessage ?? "The scheduled action could not be dispatched."
    : undefined;
}

export function parseDefaultAgentScopeKind(
  value: string | undefined,
): MessagingDefaultAgentScopeKind | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "conversation"
    || normalized === "parent"
    || normalized === "workspace"
    || normalized === "provider"
    || normalized === "profile"
  ) {
    return normalized;
  }
  return undefined;
}

export function readStringValue(
  value: MessagingJsonValue | undefined,
  key: string,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result = value[key];
  return typeof result === "string" ? result : undefined;
}

export function messageOriginForInboundEvent(
  event: MessagingInboundEvent | undefined,
  causalMessagingSource?: AppServerThreadMessageOrigin["causalMessagingSource"],
): AppServerThreadMessageOrigin {
  if (!event) {
    return { kind: "messaging" };
  }

  const conversation = event.channel.conversation;
  return {
    kind: "messaging",
    ...(causalMessagingSource ? { causalMessagingSource } : {}),
    messaging: {
      platform: event.channel.channel,
      ...(event.sourceUrl ? { sourceUrl: event.sourceUrl } : {}),
      surface: {
        id: conversation.id,
        kind: conversation.kind,
        ...(conversation.title ? { title: conversation.title } : {}),
        ...(conversation.parentTitle
          ? { parentTitle: conversation.parentTitle }
          : {}),
        ...(conversation.ancestorTitle
          ? { ancestorTitle: conversation.ancestorTitle }
          : {}),
      },
      actor: {
        platformUserId: event.actor.platformUserId,
        ...(event.actor.displayName
          ? { displayName: event.actor.displayName }
          : {}),
        ...(event.actor.phoneNumber
          ? { phoneNumber: event.actor.phoneNumber }
          : {}),
        ...(event.actor.username ? { username: event.actor.username } : {}),
      },
    },
  };
}
