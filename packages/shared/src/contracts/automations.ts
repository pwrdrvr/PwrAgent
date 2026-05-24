import type {
  AppServerBackendKind,
  AppServerThreadReplay,
  ThreadIdentifier,
} from "./normalized-app-server";

export const AUTOMATION_BACKLOG_POLICIES = [
  "coalesce",
  "drop_missed",
] as const;

export type AutomationBacklogPolicy =
  (typeof AUTOMATION_BACKLOG_POLICIES)[number];

export const DEFAULT_AUTOMATION_BACKLOG_POLICY: AutomationBacklogPolicy =
  "coalesce";

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

export const AUTOMATION_RUN_TRIGGERS = ["scheduled", "manual"] as const;

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

export type AutomationScheduleValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

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
  schedule: AutomationScheduleDefinition;
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
  schedule: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
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
  schedule?: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
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
