import path from "node:path";
import {
  AGENT_NOTIFICATION_BODY_MAX_CHARS,
  AGENT_NOTIFICATION_TITLE_MAX_CHARS,
  AGENT_NOTIFICATION_WINDOW_MS,
  type AgentNotificationLimits,
  type AgentNotificationLink,
  type AgentNotificationSummary,
  type AgentNotificationUrgency,
  type NotifyOperatorToolArgs,
  type NotifyOperatorToolResult,
  type ScheduledThreadAction,
  type ScheduledThreadNotificationPayload,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import { type PwrAgentThreadInspectionResponse } from "@pwragent/shared/contracts/thread-tools";
import type { AgentNotificationRefusal, AgentNotificationUsage } from "@pwragent/owner-core/scheduled-thread-action-storage";
import type { AgentNotificationToolHandler } from "../app-server/backend-registry-handlers.js";
import { AgentFollowUpRefusal } from "./agent-follow-up-refusal.js";
import type { FollowUpThread } from "./agent-follow-up-tool.js";

const ALLOWED_ARGS = new Set([
  "action", "title", "body", "urgency", "delayMinutes", "at", "url", "filePath", "notificationId",
]);
const LIST_LIMIT = 50;

/** The part of the scheduled-action service the tool drives. */
export type AgentNotificationToolService = {
  agentNotificationLimits(): AgentNotificationLimits;
  agentNotificationUsage(thread: FollowUpThread): AgentNotificationUsage;
  cancelAgentNotification(thread: FollowUpThread, id: string): Promise<ScheduledThreadAction>;
  createAgentNotification(request: FollowUpThread & {
    scheduledFor: number;
    notification: ScheduledThreadNotificationPayload;
  }): Promise<ScheduledThreadAction>;
  listAgentNotifications(request: {
    deliveredSince: number;
    limit: number;
    thread?: FollowUpThread;
  }): ScheduledThreadAction[];
};

/**
 * `notify_operator` over the scheduled-action service. The thread comes from
 * the caller's trusted context; no argument names a thread.
 */
export function buildAgentNotificationToolHandler(
  service: AgentNotificationToolService,
  now: () => number = Date.now,
): AgentNotificationToolHandler {
  return async (args, thread): Promise<PwrAgentThreadInspectionResponse> => {
    if (!args || typeof args !== "object" || Object.keys(args).some((key) => !ALLOWED_ARGS.has(key))) {
      return failure("invalid_arguments", "notify_operator takes action, title, body, urgency, delayMinutes, at, url, filePath and notificationId only. It always notifies from the calling thread.");
    }
    const status = (extra: Partial<NotifyOperatorToolResult>): PwrAgentThreadInspectionResponse => ({
      ok: true,
      data: {
        notifications: {
          ...extra,
          limits: service.agentNotificationLimits(),
          sentInLastDay: service.agentNotificationUsage(thread).threadInWindow,
        },
      },
    });
    try {
      if (args.action === "list") {
        const actions = service.listAgentNotifications({
          deliveredSince: now() - AGENT_NOTIFICATION_WINDOW_MS,
          limit: LIST_LIMIT,
          thread,
        });
        return status({ notifications: actions.map(summarizeAgentNotification) });
      }
      if (args.action === "cancel") {
        if (typeof args.notificationId !== "string" || !args.notificationId.trim()) {
          return failure("invalid_arguments", "Provide notificationId from send or list.");
        }
        return status({ notification: summarizeAgentNotification(await service.cancelAgentNotification(thread, args.notificationId.trim())) });
      }
      if (args.action === "send") {
        const parsed = readNotificationArgs(args, now());
        if (typeof parsed === "string") return failure("invalid_arguments", parsed);
        const action = await service.createAgentNotification({ ...thread, ...parsed });
        return status({ notification: summarizeAgentNotification(action) });
      }
      return failure("invalid_arguments", "action must be send, list or cancel.");
    } catch (error) {
      if (error instanceof AgentFollowUpRefusal) {
        return failure(error.code, error.message);
      }
      return failure("internal_error", error instanceof Error ? error.message : String(error));
    }
  };
}

/** Validates send arguments; a string is the refusal to return. */
export function readNotificationArgs(
  args: NotifyOperatorToolArgs,
  now: number,
): { scheduledFor: number; notification: ScheduledThreadNotificationPayload } | string {
  const title = typeof args.title === "string" ? args.title.trim().replace(/\s+/g, " ") : "";
  if (!title) return "Provide title: a short headline the operator reads first.";
  if (title.length > AGENT_NOTIFICATION_TITLE_MAX_CHARS) {
    return `title is limited to ${AGENT_NOTIFICATION_TITLE_MAX_CHARS} characters.`;
  }
  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (!body) return "Provide body: what happened and what the operator should do, readable without this thread.";
  if (body.length > AGENT_NOTIFICATION_BODY_MAX_CHARS) {
    return `body is limited to ${AGENT_NOTIFICATION_BODY_MAX_CHARS} characters.`;
  }
  if (args.urgency !== undefined && args.urgency !== "normal" && args.urgency !== "high") {
    return "urgency must be normal or high.";
  }
  const urgency: AgentNotificationUrgency = args.urgency ?? "normal";
  const scheduledFor = readDeliveryTime(args, now);
  if (typeof scheduledFor === "string") return scheduledFor;
  const link = readLink(args);
  if (typeof link === "string") return link;
  return {
    scheduledFor,
    notification: { title, body, urgency, ...(link ? { link } : {}) },
  };
}

function readDeliveryTime(args: NotifyOperatorToolArgs, now: number): number | string {
  const hasDelay = args.delayMinutes !== undefined;
  const hasAt = args.at !== undefined;
  if (hasDelay && hasAt) return "Provide delayMinutes or at, not both. Omit both to send now.";
  if (hasDelay) {
    if (typeof args.delayMinutes !== "number" || !Number.isFinite(args.delayMinutes) || args.delayMinutes < 0) {
      return "delayMinutes must be a number of minutes, zero or more.";
    }
    return now + Math.round(args.delayMinutes * 60_000);
  }
  if (hasAt) {
    // A time without an offset would be read in the host's zone, which the
    // agent cannot see.
    const text = typeof args.at === "string" ? args.at.trim() : "";
    const parsed = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? Date.parse(text) : Number.NaN;
    return Number.isFinite(parsed)
      ? parsed
      : "at must be an ISO 8601 time with an offset, such as 2026-11-18T09:00:00-05:00.";
  }
  return now;
}

function readLink(args: NotifyOperatorToolArgs): AgentNotificationLink | undefined | string {
  if (args.url !== undefined && args.filePath !== undefined) {
    return "Provide url or filePath, not both.";
  }
  if (args.url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(typeof args.url === "string" ? args.url.trim() : "");
    } catch {
      return "url must be an absolute http or https URL.";
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "url must be an absolute http or https URL.";
    }
    if (parsed.username || parsed.password) return "url must not carry credentials.";
    return { kind: "url", url: parsed.toString() };
  }
  if (args.filePath !== undefined) {
    const filePath = typeof args.filePath === "string" ? args.filePath.trim() : "";
    // The file viewer that opens it checks the thread's directories again.
    if (!filePath || !path.isAbsolute(filePath) || filePath.includes("\0")) {
      return "filePath must be an absolute path inside this thread's directories.";
    }
    return { kind: "file", path: path.normalize(filePath) };
  }
  return undefined;
}

export function summarizeAgentNotification(action: ScheduledThreadAction): AgentNotificationSummary {
  return {
    notificationId: action.id,
    status: action.status,
    scheduledFor: new Date(action.scheduledFor).toISOString(),
    title: action.notification?.title ?? action.displayText,
    urgency: action.notification?.urgency ?? "normal",
    cancellable: action.status === "scheduled" || action.status === "held",
  };
}

/** The refusal an agent reads when an operator bound stops a notice. */
export function agentNotificationRefusalMessage(
  refused: AgentNotificationRefusal,
  count: number,
  limits: AgentNotificationLimits,
): string {
  const tail = " The operator sets this bound in Settings. Do not retry or work around it; say what you wanted to tell the operator in your reply instead.";
  switch (refused) {
    case "scheduled_limit":
      return `This thread already has ${count} notices waiting; the bound is ${limits.maxScheduledPerThread}. Cancel one or let one be delivered.${tail}`;
    case "thread_limit":
      return `This thread sent ${count} notices in the last 24 hours; the bound is ${limits.maxPerThreadPerDay}.${tail}`;
    case "profile_limit":
      return `Agents sent ${count} notices on this PwrAgent profile in the last 24 hours; the bound is ${limits.maxPerProfilePerDay}.${tail}`;
  }
}

function failure(
  code: "invalid_arguments" | "not_found" | "forbidden" | "internal_error",
  message: string,
): PwrAgentThreadInspectionResponse {
  return { ok: false, error: { code, message } };
}
