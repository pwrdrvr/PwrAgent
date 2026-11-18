import {
  AGENT_FOLLOW_UP_MAX_ACTIVE_PER_THREAD,
  AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW,
  AGENT_FOLLOW_UP_MIN_DELAY_MS,
  type AgentFollowUpProtection,
  type AgentFollowUpSummary,
  type AppServerBackendKind,
  type AppServerThreadMessageOrigin,
  type PwrAgentThreadInspectionResponse,
  type ScheduleFollowUpToolArgs,
  type ScheduleFollowUpToolResult,
  type ScheduledThreadAction,
} from "@pwragent/shared";
import type { AgentFollowUpToolHandler } from "../app-server/backend-registry-handlers.js";
import { AgentFollowUpRefusal } from "./agent-follow-up-refusal.js";

const PROMPT_PREVIEW_MAX_CHARS = 600;
const SUSPENDED_NOTICE =
  "Loop protection suspended agent follow-ups on this thread. Nothing fires until the operator rearms them in Waiting for. Tell the operator; do not schedule more to work around it.";

export type FollowUpThread = { backend: AppServerBackendKind; threadId: string };

/** The part of the scheduled-action service the tool drives. */
export type AgentFollowUpToolService = {
  agentFollowUpProtection(thread: FollowUpThread): AgentFollowUpProtection;
  cancelAgentFollowUp(thread: FollowUpThread, id: string): Promise<ScheduledThreadAction>;
  countActiveAgentFollowUps(thread: FollowUpThread): number;
  createAgentFollowUp(request: FollowUpThread & {
    scheduledFor: number;
    prompt: string;
    provenance?: Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">;
  }): Promise<ScheduledThreadAction>;
  list(request: FollowUpThread): { actions: ScheduledThreadAction[] };
};

/**
 * `schedule_follow_up` over the scheduled-action service. The thread and the
 * messaging provenance come from the caller's trusted context.
 */
export function buildAgentFollowUpToolHandler(
  service: AgentFollowUpToolService,
  now: () => number = Date.now,
): AgentFollowUpToolHandler {
  return async (args, thread, provenance): Promise<PwrAgentThreadInspectionResponse> => {
    const allowed = new Set(["action", "delayMinutes", "at", "prompt", "followUpId"]);
    if (!args || typeof args !== "object" || Object.keys(args).some((key) => !allowed.has(key))) {
      return failure("invalid_arguments", "schedule_follow_up takes action, delayMinutes, at, prompt and followUpId only. It always acts on the calling thread.");
    }
    const status = (extra: Partial<ScheduleFollowUpToolResult>): PwrAgentThreadInspectionResponse => {
      const protection = service.agentFollowUpProtection(thread);
      const suspended = protection.suspendedAt !== undefined;
      return {
        ok: true,
        data: {
          followUps: {
            ...extra,
            activeAgentFollowUps: service.countActiveAgentFollowUps(thread),
            limits: {
              maxActive: AGENT_FOLLOW_UP_MAX_ACTIVE_PER_THREAD,
              minDelayMinutes: AGENT_FOLLOW_UP_MIN_DELAY_MS / 60_000,
              maxFiredPerDay: AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW,
            },
            firedInLastDay: protection.firedInWindow,
            ...(suspended ? { suspended: true as const, notice: SUSPENDED_NOTICE } : {}),
          },
        },
      };
    };
    try {
      if (args.action === "list") {
        const actions = service.list({ backend: thread.backend, threadId: thread.threadId }).actions;
        return status({ followUps: actions.map(summarize) });
      }
      if (args.action === "cancel") {
        if (typeof args.followUpId !== "string" || !args.followUpId.trim()) {
          return failure("invalid_arguments", "Provide followUpId from create or list.");
        }
        return status({ followUp: summarize(await service.cancelAgentFollowUp(thread, args.followUpId.trim())) });
      }
      if (args.action === "create") {
        const scheduledFor = readScheduledFor(args, now());
        if (typeof scheduledFor === "string") return failure("invalid_arguments", scheduledFor);
        const action = await service.createAgentFollowUp({
          ...thread,
          scheduledFor,
          prompt: typeof args.prompt === "string" ? args.prompt : "",
          provenance,
        });
        return status({ followUp: summarize(action) });
      }
      return failure("invalid_arguments", "action must be create, list or cancel.");
    } catch (error) {
      if (error instanceof AgentFollowUpRefusal) {
        return failure(error.code, error.message);
      }
      return failure("internal_error", error instanceof Error ? error.message : String(error));
    }
  };
}

function readScheduledFor(args: ScheduleFollowUpToolArgs, now: number): number | string {
  const hasDelay = args.delayMinutes !== undefined;
  const hasAt = args.at !== undefined;
  if (hasDelay === hasAt) return "Provide exactly one of delayMinutes or at.";
  if (hasDelay) {
    if (typeof args.delayMinutes !== "number" || !Number.isFinite(args.delayMinutes)) {
      return "delayMinutes must be a number of minutes.";
    }
    return now + Math.round(args.delayMinutes * 60_000);
  }
  // A time without an offset would be read in the host's zone, which the
  // agent cannot see.
  if (typeof args.at !== "string" || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(args.at.trim())) {
    return "at must be an ISO 8601 time with an offset, such as 2026-11-18T09:00:00-05:00.";
  }
  const parsed = Date.parse(args.at.trim());
  return Number.isFinite(parsed) ? parsed : "at must be an ISO 8601 time with an offset, such as 2026-11-18T09:00:00-05:00.";
}

function summarize(action: ScheduledThreadAction): AgentFollowUpSummary {
  const text = action.displayText.trim().replace(/\s+/g, " ");
  return {
    followUpId: action.id,
    kind: action.kind,
    status: action.status,
    scheduledFor: new Date(action.scheduledFor).toISOString(),
    setBy: action.origin === "agent" ? "agent" : action.origin === "messaging" ? "messaging" : "operator",
    cancellable: action.origin === "agent"
      && (action.status === "scheduled" || action.status === "held" || action.status === "queued"),
    prompt: text.length > PROMPT_PREVIEW_MAX_CHARS ? `${text.slice(0, PROMPT_PREVIEW_MAX_CHARS - 1).trimEnd()}…` : text,
  };
}

function failure(
  code: "invalid_arguments" | "not_found" | "forbidden" | "internal_error",
  message: string,
): PwrAgentThreadInspectionResponse {
  return { ok: false, error: { code, message } };
}
