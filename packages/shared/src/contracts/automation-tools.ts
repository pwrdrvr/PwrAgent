import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "./normalized-app-server";
import type {
  AutomationBacklogPolicy,
  AutomationDetail,
  AutomationRunArtifact,
  AutomationRunStatus,
  AutomationRunSummary,
  AutomationStatus,
  AutomationTimelineCard,
} from "./automations";

export const AUTOMATION_INSPECTION_TOOL_NAMESPACE = "pwragent_automations";

export const AUTOMATION_INSPECTION_OPERATION_NAMES = [
  "list_automations",
  "summarize_automation_status",
  "list_automation_runs",
  "get_automation_run",
  "get_automation_run_artifact",
] as const;

export type AutomationInspectionOperationName =
  (typeof AUTOMATION_INSPECTION_OPERATION_NAMES)[number];

export const DEFAULT_AUTOMATION_INSPECTION_RUN_LIMIT = 5;
export const MAX_AUTOMATION_INSPECTION_RUN_LIMIT = 25;
export const DEFAULT_AUTOMATION_INSPECTION_EVENT_LIMIT = 25;
export const MAX_AUTOMATION_INSPECTION_EVENT_LIMIT = 100;
export const DEFAULT_AUTOMATION_INSPECTION_TEXT_LIMIT_CHARS = 12_000;
export const MAX_AUTOMATION_INSPECTION_TEXT_LIMIT_CHARS = 40_000;

export const AUTOMATION_INSPECTION_ERROR_CODES = [
  "invalid_arguments",
  "not_found",
  "forbidden",
  "unsupported_operation",
  "internal_error",
] as const;

export type AutomationInspectionErrorCode =
  (typeof AUTOMATION_INSPECTION_ERROR_CODES)[number];

export type AutomationInspectionContext = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  now?: number;
};

export type ListAutomationToolArgs = {
  includePaused?: boolean;
  limit?: number;
};

export type SummarizeAutomationStatusToolArgs = {
  limit?: number;
  since?: number;
};

export type ListAutomationRunsToolArgs = {
  automationId?: string;
  limit?: number;
  since?: number;
  statuses?: AutomationRunStatus[];
};

export type GetAutomationRunToolArgs = {
  runId: string;
};

export type GetAutomationRunArtifactToolArgs = {
  runId: string;
  eventLimit?: number;
  textLimitChars?: number;
};

export type AutomationInspectionToolArgsByOperation = {
  list_automations: ListAutomationToolArgs;
  summarize_automation_status: SummarizeAutomationStatusToolArgs;
  list_automation_runs: ListAutomationRunsToolArgs;
  get_automation_run: GetAutomationRunToolArgs;
  get_automation_run_artifact: GetAutomationRunArtifactToolArgs;
};

export type AutomationInspectionToolArgs<
  TOperation extends AutomationInspectionOperationName =
    AutomationInspectionOperationName,
> = AutomationInspectionToolArgsByOperation[TOperation];

export type AutomationInspectionRequest<
  TOperation extends AutomationInspectionOperationName =
    AutomationInspectionOperationName,
> = {
  [TOperationKey in TOperation]: {
    operation: TOperationKey;
    context: AutomationInspectionContext;
    args: AutomationInspectionToolArgs<TOperationKey>;
  };
}[TOperation];

export type AutomationInspectionAutomationSummary = Pick<
  AutomationDetail,
  | "id"
  | "name"
  | "status"
  | "taskPrompt"
  | "schedule"
  | "scheduleSummary"
  | "backlogPolicy"
  | "nextRunAt"
  | "lastRunAt"
  | "lastRunStatus"
  | "pendingRunCount"
  | "coalescedWindowCount"
  | "updatedAt"
> & {
  latestRun?: AutomationInspectionRunSummary;
};

export type AutomationInspectionRunSummary = AutomationRunSummary & {
  automationName?: string;
  automationStatus?: AutomationStatus;
  automationBacklogPolicy?: AutomationBacklogPolicy;
  outputDecisionKind?: AutomationInspectionOutputDecisionKind;
  outputSummary?: string;
};

export type AutomationInspectionRunDetail = AutomationInspectionRunSummary & {
  automation?: AutomationInspectionAutomationSummary;
};

export type AutomationInspectionArtifact = Omit<
  AutomationRunArtifact,
  "transcriptEvents"
> & {
  transcriptEvents: AutomationRunArtifact["transcriptEvents"];
  transcriptEventsTruncated?: boolean;
  finalTextTruncated?: boolean;
  detailsTextTruncated?: boolean;
  card?: AutomationTimelineCard;
};

export type AutomationInspectionOutputDecisionKind =
  | "post_card"
  | "quiet"
  | "parse_failed";

export type ListAutomationToolData = {
  automations: AutomationInspectionAutomationSummary[];
  truncated?: boolean;
};

export type SummarizeAutomationStatusToolData = {
  summary: string;
  automations: AutomationInspectionAutomationSummary[];
  recentRuns: AutomationInspectionRunSummary[];
  truncated?: boolean;
};

export type ListAutomationRunsToolData = {
  runs: AutomationInspectionRunSummary[];
  truncated?: boolean;
};

export type GetAutomationRunToolData = {
  run: AutomationInspectionRunDetail;
};

export type GetAutomationRunArtifactToolData = {
  artifact: AutomationInspectionArtifact;
};

export type AutomationInspectionToolDataByOperation = {
  list_automations: ListAutomationToolData;
  summarize_automation_status: SummarizeAutomationStatusToolData;
  list_automation_runs: ListAutomationRunsToolData;
  get_automation_run: GetAutomationRunToolData;
  get_automation_run_artifact: GetAutomationRunArtifactToolData;
};

export type AutomationInspectionToolData<
  TOperation extends AutomationInspectionOperationName =
    AutomationInspectionOperationName,
> = AutomationInspectionToolDataByOperation[TOperation];

export type AutomationInspectionSuccess<
  TOperation extends AutomationInspectionOperationName =
    AutomationInspectionOperationName,
> = {
  ok: true;
  operation: TOperation;
  data: AutomationInspectionToolData<TOperation>;
};

export type AutomationInspectionFailure<
  TOperation extends AutomationInspectionOperationName =
    AutomationInspectionOperationName,
> = {
  ok: false;
  operation: TOperation;
  error: {
    code: AutomationInspectionErrorCode;
    message: string;
  };
};

export type AutomationInspectionResponse<
  TOperation extends AutomationInspectionOperationName =
    AutomationInspectionOperationName,
> =
  | AutomationInspectionSuccess<TOperation>
  | AutomationInspectionFailure<TOperation>;

export function isAutomationInspectionOperationName(
  value: unknown,
): value is AutomationInspectionOperationName {
  return (
    typeof value === "string" &&
    AUTOMATION_INSPECTION_OPERATION_NAMES.includes(
      value as AutomationInspectionOperationName,
    )
  );
}

export function normalizeAutomationInspectionLimit(
  value: unknown,
  options: {
    defaultValue: number;
    maxValue: number;
  },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return options.defaultValue;
  }
  return Math.min(options.maxValue, Math.max(1, Math.floor(value)));
}

export function normalizeAutomationInspectionRunLimit(value: unknown): number {
  return normalizeAutomationInspectionLimit(value, {
    defaultValue: DEFAULT_AUTOMATION_INSPECTION_RUN_LIMIT,
    maxValue: MAX_AUTOMATION_INSPECTION_RUN_LIMIT,
  });
}

export function normalizeAutomationInspectionEventLimit(value: unknown): number {
  return normalizeAutomationInspectionLimit(value, {
    defaultValue: DEFAULT_AUTOMATION_INSPECTION_EVENT_LIMIT,
    maxValue: MAX_AUTOMATION_INSPECTION_EVENT_LIMIT,
  });
}

export function normalizeAutomationInspectionTextLimitChars(
  value: unknown,
): number {
  return normalizeAutomationInspectionLimit(value, {
    defaultValue: DEFAULT_AUTOMATION_INSPECTION_TEXT_LIMIT_CHARS,
    maxValue: MAX_AUTOMATION_INSPECTION_TEXT_LIMIT_CHARS,
  });
}
