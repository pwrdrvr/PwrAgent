import type {
  AppServerBackendKind,
  AppServerThreadReplay,
  ThreadIdentifier,
  ThreadExecutionMode,
} from "./normalized-app-server";
import type {
  MessagingChannelKind,
  MessagingConversationKind,
} from "./messaging";

export const AUTOMATION_BACKLOG_POLICIES = [
  "coalesce",
  "drop_missed",
] as const;

export type AutomationBacklogPolicy =
  (typeof AUTOMATION_BACKLOG_POLICIES)[number];

export const DEFAULT_AUTOMATION_BACKLOG_POLICY: AutomationBacklogPolicy =
  "coalesce";

/**
 * Default inbound coalescing window. The first matching message fires a run
 * immediately (leading edge); further messages in the same automation within
 * this window are batched into a single follow-up run, bounding the cost of a
 * burst (or a misconfigured firehose / message loop). Set to 0 to disable and
 * fire one run per message.
 */
export const DEFAULT_AUTOMATION_INBOUND_COALESCE_WINDOW_MS = 60_000;

/**
 * Default cap on how many inbound-triggered runs an automation may START per
 * hour. Enforced as a per-automation token bucket (an idle automation may burst
 * up to the rate, then settles to the steady rate). This is a cost backstop
 * against a misconfigured trigger on a busy channel kicking off a flood of
 * ephemeral agent runs. `undefined` inherits this default; `null` is unlimited.
 */
export const DEFAULT_AUTOMATION_MAX_RUNS_PER_HOUR = 20;

/** Operator-selectable inbound run-rate options surfaced in the editor. */
export const AUTOMATION_RUN_RATE_PER_HOUR_OPTIONS = [5, 20, 45, 60] as const;

/**
 * Resolve the effective inbound run-rate for an automation: the number of run
 * starts allowed per hour, or `null` for unlimited. `undefined` (field absent /
 * legacy row) falls back to the default; `null` and non-positive / non-finite
 * values are unlimited. A positive fraction clamps UP to 1/hour so a sub-1 rate
 * becomes the most restrictive real cap rather than flooring to 0 (a 0-capacity
 * bucket that would block every run).
 */
export function resolveAutomationRunsPerHour(
  maxRunsPerHour: number | null | undefined,
): number | null {
  if (maxRunsPerHour === null) return null;
  if (maxRunsPerHour === undefined) return DEFAULT_AUTOMATION_MAX_RUNS_PER_HOUR;
  if (!Number.isFinite(maxRunsPerHour) || maxRunsPerHour <= 0) return null;
  return Math.max(1, Math.floor(maxRunsPerHour));
}

export const AUTOMATION_STATUSES = ["enabled", "paused", "deleted"] as const;

export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AUTOMATION_RUN_STATUSES = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;

export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const AUTOMATION_RUN_TRIGGERS = [
  "scheduled",
  "manual",
  "inbound_message",
] as const;

export type AutomationRunTrigger = (typeof AUTOMATION_RUN_TRIGGERS)[number];

export const AUTOMATION_INTERVAL_UNITS = ["minutes", "hours"] as const;

export type AutomationIntervalUnit = (typeof AUTOMATION_INTERVAL_UNITS)[number];

export const AUTOMATION_WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type AutomationWeekday = (typeof AUTOMATION_WEEKDAYS)[number];

export type AutomationTimeOfDay = {
  hour: number;
  minute: number;
};

export type AutomationIntervalScheduleDefinition = {
  kind: "interval";
  every: number;
  unit: AutomationIntervalUnit;
  /** Epoch ms used as the recurrence anchor. When omitted, creation time is used. */
  anchorAt?: number;
};

export type AutomationWeeklyScheduleDefinition = {
  kind: "weekly";
  daysOfWeek: AutomationWeekday[];
  timeOfDay: AutomationTimeOfDay;
};

export type AutomationWeekdaysScheduleDefinition = {
  kind: "weekdays";
  timeOfDay: AutomationTimeOfDay;
};

export type AutomationScheduleDefinition =
  | AutomationIntervalScheduleDefinition
  | AutomationWeeklyScheduleDefinition
  | AutomationWeekdaysScheduleDefinition;

/**
 * Every schedule discriminant this build understands. Used by the desktop
 * automation store to recognize — and safely skip — automation rows whose
 * persisted schedule shape this version can't parse (e.g. a row written by a
 * newer build that introduced a new schedule/trigger kind). Keep this in sync
 * with the `AutomationScheduleDefinition` union and the
 * `computeNextAutomationRunAt` switch.
 */
export const AUTOMATION_SCHEDULE_KINDS = [
  "interval",
  "weekly",
  "weekdays",
] as const;
export type AutomationScheduleKind = (typeof AUTOMATION_SCHEDULE_KINDS)[number];

export type AutomationScheduleTriggerDefinition = {
  id: string;
  kind: "schedule";
  schedule: AutomationScheduleDefinition;
};

export const AUTOMATION_INBOUND_TEXT_MATCH_MODES = [
  "contains",
  "equals",
] as const;

export type AutomationInboundTextMatchMode =
  (typeof AUTOMATION_INBOUND_TEXT_MATCH_MODES)[number];

export type AutomationInboundTextFilter = {
  mode: AutomationInboundTextMatchMode;
  text: string;
  caseSensitive?: boolean;
};

export type AutomationInboundSenderFilter = {
  platformUserId?: string;
  isBot?: boolean;
};

export type AutomationMessagingConversationSnapshot = {
  channel: MessagingChannelKind;
  conversationId: string;
  conversationKind?: MessagingConversationKind;
  parentId?: string;
  title?: string;
  parentTitle?: string;
  ancestorTitle?: string;
};

export type AutomationInboundMessageTriggerDefinition = {
  id: string;
  kind: "inbound_message";
  name?: string;
  conversation: AutomationMessagingConversationSnapshot;
  sender?: AutomationInboundSenderFilter;
  textFilter?: AutomationInboundTextFilter;
  includeThreadReplies?: boolean;
};

export type AutomationTriggerDefinition =
  | AutomationScheduleTriggerDefinition
  | AutomationInboundMessageTriggerDefinition;

export type AutomationRunSourceActorSnapshot = {
  platformUserId: string;
  displayName?: string;
  username?: string;
  isBot?: boolean;
};

export type AutomationRunSourceMessage = {
  text?: string;
  textTruncated?: boolean;
};

export type AutomationRunSourceMetadata = {
  kind: "messaging";
  eventId?: string;
  sourceEventKey: string;
  receivedAt: number;
  matchedTriggerId: string;
  matchedTriggerName?: string;
  actor: AutomationRunSourceActorSnapshot;
  conversation: AutomationMessagingConversationSnapshot;
  message?: AutomationRunSourceMessage;
  routingState?: Record<string, unknown>;
  /**
   * Additional messages coalesced into this run within the inbound coalescing
   * window. The primary fields above describe the first message; these are the
   * follow-ups, bounded in count and size.
   */
  batchedEvents?: AutomationRunSourceBatchedEntry[];
};

export type AutomationRunSourceBatchedEntry = {
  sourceEventKey: string;
  receivedAt: number;
  actor: AutomationRunSourceActorSnapshot;
  message?: AutomationRunSourceMessage;
};

export type AutomationExecutionProfile = {
  backend?: AppServerBackendKind;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  cwd?: string;
  mcpAllowlist?: string[];
  skillAllowlist?: string[];
  toolAllowlist?: string[];
};

export type AutomationSourceMessageDestination =
  | "source_thread"
  | "source_channel";

export type AutomationOutputActionDefinition =
  | {
      id: string;
      kind: "agent_context";
      enabled?: boolean;
    }
  | {
      id: string;
      kind: "source_message";
      destination: AutomationSourceMessageDestination;
      broadcast?: boolean;
      enabled?: boolean;
    }
  | {
      id: string;
      kind: "messaging_target";
      target: AutomationMessagingConversationSnapshot;
      enabled?: boolean;
    };

export type AutomationOutputActionStatus =
  | "pending"
  | "completed"
  | "failed"
  | "unsupported"
  | "skipped";

export type AutomationOutputActionResult = {
  actionId: string;
  kind: AutomationOutputActionDefinition["kind"];
  status: AutomationOutputActionStatus;
  attemptedAt?: number;
  completedAt?: number;
  message?: string;
  errorMessage?: string;
};

/**
 * True when an automation delivers its result through an explicit messaging
 * output action (`source_message` or `messaging_target`). Such automations own
 * their messaging delivery deliberately, so the legacy "broadcast the result to
 * every binding of the attached Agent thread" path must be suppressed for them
 * — otherwise the source conversation (which is often also a binding) receives
 * the result twice. `agent_context`-only automations keep the legacy broadcast.
 */
export function automationDeliversViaMessagingActions(
  outputActions: AutomationOutputActionDefinition[] | undefined,
): boolean {
  if (!Array.isArray(outputActions)) {
    return false;
  }
  return outputActions.some(
    (action) =>
      action.enabled !== false &&
      (action.kind === "source_message" || action.kind === "messaging_target"),
  );
}

/**
 * True when an automation's messaging delivery is governed entirely by its
 * configured output actions, so the legacy "broadcast the result to every
 * binding of the attached Agent thread" path must be suppressed. This holds
 * for:
 *   - inbound-triggered automations, whose result destination is always chosen
 *     in the editor (reply to source / a different conversation / agent only),
 *     and
 *   - any automation with an explicit messaging-delivery action.
 *
 * Legacy schedule-only automations that default to `agent_context` keep the
 * broadcast so they continue to surface in their bound conversations.
 */
export function automationSuppressesBindingBroadcast(automation: {
  outputActions?: AutomationOutputActionDefinition[];
  triggers?: AutomationTriggerDefinition[];
}): boolean {
  if (
    Array.isArray(automation.triggers) &&
    automation.triggers.some((trigger) => trigger.kind === "inbound_message")
  ) {
    return true;
  }
  return automationDeliversViaMessagingActions(automation.outputActions);
}

export type AutomationScheduleValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

export type DraftAutomationPromptRequest = {
  description: string;
};

export type DraftAutomationPromptResponse =
  | { status: "generated"; prompt: string }
  | { status: "unavailable" | "invalid" | "failed"; reason: string };

export type AutomationGateConfig = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  outputLimitChars?: number;
};

export type AutomationGateRunResult = {
  status: "proceed" | "skip" | "failed";
  command: string;
  cwd?: string;
  exitCode?: number;
  durationMs: number;
  output: string;
  outputTruncated?: boolean;
  errorMessage?: string;
};

export type AutomationThreadAssignment = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

/**
 * Automations attach to an Agent thread. The backend/thread identity remains
 * the durable pointer because Agent metadata is stored on the thread overlay.
 */
export type AutomationAgentAssignment = AutomationThreadAssignment;

export type AutomationListItemSummary = AutomationThreadAssignment & {
  id: string;
  name: string;
  status: AutomationStatus;
  triggers: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  scheduleSummary: string;
  backlogPolicy: AutomationBacklogPolicy;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunStatus?: AutomationRunStatus;
  pendingRunCount?: number;
  coalescedWindowCount?: number;
  updatedAt: number;
};

export type AutomationDetail = AutomationListItemSummary & {
  taskPrompt: string;
  gate?: AutomationGateConfig;
  executionProfile?: AutomationExecutionProfile;
  outputActions: AutomationOutputActionDefinition[];
  /**
   * Inbound coalescing window in milliseconds. 0 disables coalescing (one run
   * per matching message). Undefined inherits the default.
   */
  inboundCoalesceWindowMs?: number;
  /**
   * Cap on inbound-triggered run starts per hour. Undefined inherits the
   * default; null is unlimited. See {@link resolveAutomationRunsPerHour}.
   */
  maxRunsPerHour?: number | null;
  createdAt: number;
  deletedAt?: number;
};

export type AutomationThreadSummary = {
  totalCount: number;
  enabledCount: number;
  pausedCount: number;
  nextRunAt?: number;
  lastRunAt?: number;
  pendingRunCount: number;
  coalescedWindowCount: number;
  skippedSinceLastCompletedCount: number;
  automations: AutomationListItemSummary[];
};

export type AutomationRunWindow = {
  scheduledFor: number;
};

export type AutomationRunSummary = {
  id: string;
  automationId: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  scheduledFor?: number;
  scheduledWindows: AutomationRunWindow[];
  queuedAt?: number;
  queueEntryId?: string;
  startedAt?: number;
  completedAt?: number;
  backendThreadId?: string;
  backendTurnId?: string;
  errorMessage?: string;
  source?: AutomationRunSourceMetadata;
};

export type AutomationRunOutputDecision =
  | {
      kind: "post_card";
      summary: string;
      details?: string;
    }
  | {
      kind: "quiet";
      summary?: string;
      details?: string;
    }
  | {
      kind: "parse_failed";
      summary?: string;
      details?: string;
    };

export type AutomationRunTranscriptEvent = {
  id: string;
  at: number;
  kind: "invocation" | "gate" | "lifecycle" | "assistant_final" | "error";
  text?: string;
  metadata?: Record<string, unknown>;
};

export type AutomationRunArtifact = {
  runId: string;
  automationId: string;
  status: AutomationRunStatus;
  finalText?: string;
  errorMessage?: string;
  outputDecision?: AutomationRunOutputDecision;
  actionResults: AutomationOutputActionResult[];
  transcriptEvents: AutomationRunTranscriptEvent[];
  createdAt: number;
  updatedAt: number;
};

export type AutomationRunRollout = AutomationAgentAssignment & {
  turnId?: string;
  replay?: AppServerThreadReplay;
  errorMessage?: string;
};

export type AutomationTimelineCard = AutomationAgentAssignment & {
  id: string;
  automationId: string;
  automationName: string;
  runId: string;
  status: AutomationRunStatus;
  summary: string;
  details?: string;
  occurredAt: number;
};

export type CreateAutomationRequest = AutomationAgentAssignment & {
  name: string;
  taskPrompt: string;
  gate?: AutomationGateConfig;
  triggers?: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
  executionProfile?: AutomationExecutionProfile;
  outputActions?: AutomationOutputActionDefinition[];
  inboundCoalesceWindowMs?: number;
  maxRunsPerHour?: number | null;
  enabled?: boolean;
  nextRunAt?: number;
};

export type UpdateAutomationRequest = {
  automationId: string;
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  name?: string;
  taskPrompt?: string;
  gate?: AutomationGateConfig | null;
  triggers?: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
  executionProfile?: AutomationExecutionProfile | null;
  outputActions?: AutomationOutputActionDefinition[];
  inboundCoalesceWindowMs?: number;
  maxRunsPerHour?: number | null;
  enabled?: boolean;
  nextRunAt?: number | null;
};

export type AutomationIdRequest = {
  automationId: string;
};

export type ListAutomationsRequest = {
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
};

export type ListAutomationsResponse = {
  automations: AutomationDetail[];
};

/**
 * One automation row the running build could not load (malformed payload, or a
 * schedule/trigger shape this version doesn't understand). The row is left
 * untouched in storage and excluded from results for this process lifetime —
 * not paused, not deleted — so an older build silently skips data a newer
 * build wrote instead of crashing on it.
 */
export type AutomationLoadIssue = {
  id: string;
  name: string;
  reason: string;
};

export type ListAutomationLoadIssuesResponse = {
  issues: AutomationLoadIssue[];
};

export type AutomationMutationResponse = {
  automation: AutomationDetail;
};

export type ListAutomationRunsRequest = {
  automationId?: string;
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  limit?: number;
};

export type ListAutomationRunsResponse = {
  runs: AutomationRunSummary[];
};

export type ListAutomationCardsRequest = AutomationAgentAssignment & {
  limit?: number;
};

export type ListAutomationCardsResponse = {
  cards: AutomationTimelineCard[];
};

export type GetAutomationRunArtifactRequest = {
  runId: string;
};

export type GetAutomationRunArtifactResponse = {
  artifact?: AutomationRunArtifact;
  rollout?: AutomationRunRollout;
};

export type RunAutomationNowResponse = {
  run: AutomationRunSummary;
  queueStatus: "started" | "queued" | "failed";
  queueEntryId?: string;
  turnId?: string;
};

export function validateAutomationScheduleDefinition(
  schedule: AutomationScheduleDefinition,
): AutomationScheduleValidationResult {
  switch (schedule.kind) {
    case "interval":
      if (!Number.isInteger(schedule.every) || schedule.every < 1) {
        return {
          ok: false,
          error: "Interval schedules must run every whole number greater than zero.",
        };
      }
      if (!AUTOMATION_INTERVAL_UNITS.includes(schedule.unit)) {
        return {
          ok: false,
          error: "Interval schedules must use minutes or hours.",
        };
      }
      return { ok: true };
    case "weekly": {
      const uniqueDays = new Set(schedule.daysOfWeek);
      if (uniqueDays.size === 0) {
        return {
          ok: false,
          error: "Weekly schedules must include at least one day.",
        };
      }
      if (uniqueDays.size !== schedule.daysOfWeek.length) {
        return {
          ok: false,
          error: "Weekly schedules cannot include duplicate days.",
        };
      }
      for (const day of uniqueDays) {
        if (!AUTOMATION_WEEKDAYS.includes(day)) {
          return {
            ok: false,
            error: "Weekly schedules contain an unsupported day.",
          };
        }
      }
      return validateTimeOfDay(schedule.timeOfDay);
    }
    case "weekdays":
      return validateTimeOfDay(schedule.timeOfDay);
    default:
      return assertNeverSchedule(schedule);
  }
}

export function formatAutomationScheduleSummary(
  schedule: AutomationScheduleDefinition,
): string {
  switch (schedule.kind) {
    case "interval":
      if (schedule.every === 1 && schedule.unit === "hours") {
        return "hourly";
      }
      if (schedule.every === 1 && schedule.unit === "minutes") {
        return "every minute";
      }
      return `every ${schedule.every} ${schedule.unit}`;
    case "weekly":
      return `${formatWeekdayList(schedule.daysOfWeek)} at ${formatTimeOfDay(schedule.timeOfDay)}`;
    case "weekdays":
      return `weekdays at ${formatTimeOfDay(schedule.timeOfDay)}`;
    default:
      return assertNeverSchedule(schedule);
  }
}

function validateTimeOfDay(
  timeOfDay: AutomationTimeOfDay,
): AutomationScheduleValidationResult {
  if (!Number.isInteger(timeOfDay.hour) || timeOfDay.hour < 0 || timeOfDay.hour > 23) {
    return {
      ok: false,
      error: "Schedule hour must be a whole number from 0 through 23.",
    };
  }
  if (
    !Number.isInteger(timeOfDay.minute) ||
    timeOfDay.minute < 0 ||
    timeOfDay.minute > 59
  ) {
    return {
      ok: false,
      error: "Schedule minute must be a whole number from 0 through 59.",
    };
  }
  return { ok: true };
}

function formatWeekdayList(daysOfWeek: AutomationWeekday[]): string {
  const labels = daysOfWeek.map((day) => pluralizeWeekday(day));
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function pluralizeWeekday(day: AutomationWeekday): string {
  const label = `${day[0]?.toUpperCase() ?? ""}${day.slice(1)}`;
  return `${label}s`;
}

function formatTimeOfDay(timeOfDay: AutomationTimeOfDay): string {
  const period = timeOfDay.hour >= 12 ? "PM" : "AM";
  const hour12 = timeOfDay.hour % 12 || 12;
  if (timeOfDay.minute === 0) {
    return `${hour12} ${period}`;
  }
  return `${hour12}:${String(timeOfDay.minute).padStart(2, "0")} ${period}`;
}

function assertNeverSchedule(schedule: never): never {
  throw new Error(`Unsupported automation schedule: ${JSON.stringify(schedule)}`);
}
