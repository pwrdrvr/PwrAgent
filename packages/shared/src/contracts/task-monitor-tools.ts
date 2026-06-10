import type { AppServerBackendKind, ThreadIdentifier } from "./normalized-app-server";

export const TASK_MONITOR_TOOL_NAMESPACE = "pwragent_task_monitors";

export const DEFAULT_TASK_MONITOR_MODEL = "gpt-5.4-mini";
export const DEFAULT_TASK_MONITOR_REASONING_EFFORT = "low";
export const DEFAULT_TASK_MONITOR_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_TASK_MONITOR_STARTUP_TIMEOUT_SECONDS = 45;
export const DEFAULT_TASK_MONITOR_HEARTBEAT_INTERVAL_SECONDS =
  DEFAULT_TASK_MONITOR_POLL_INTERVAL_SECONDS;

export const TASK_MONITOR_OPERATION_NAMES = [
  "create_monitor_delegation",
  "inject_progress",
  "complete_monitoring",
] as const;

export type TaskMonitorOperationName = (typeof TASK_MONITOR_OPERATION_NAMES)[number];

export type TaskMonitorContext = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
};

export type CreateMonitorDelegationToolArgs = {
  task: string;
  monitorContext?: string;
  cwd?: string;
  pollIntervalSeconds?: number;
  heartbeatIntervalSeconds?: number;
  preferredModel?: string;
  preferredReasoningEffort?: string;
  finalHandoffPrompt?: string;
};

export type InjectMonitorProgressToolArgs = {
  monitorId: string;
  message: string;
  status?: "pending" | "running" | "blocked" | "failed";
};

export type CompleteMonitoringToolArgs = {
  monitorId: string;
  outcome: "success" | "failure" | "cancelled";
  summary: string;
  details?: string;
  triggerParentTurn?: boolean;
};

export type TaskMonitorUsageSnapshot = {
  cost?: {
    model: string;
    totalUsd: number;
  };
  model?: string;
  summary: string;
  tokenUsage: {
    cachedInputTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    totalTokens?: number;
    uncachedInputTokens?: number;
  };
};

export type TaskMonitorCompletionSource =
  | {
      type: "monitor_tool";
    }
  | {
      type: "pwragent_fallback";
      reason: string;
      recoveryAttempted: boolean;
      terminalStatus?: "completed" | "failed" | "cancelled";
    };

export type TaskMonitorToolArgsByOperation = {
  create_monitor_delegation: CreateMonitorDelegationToolArgs;
  inject_progress: InjectMonitorProgressToolArgs;
  complete_monitoring: CompleteMonitoringToolArgs;
};

export type TaskMonitorToolArgs<
  TOperation extends TaskMonitorOperationName = TaskMonitorOperationName,
> = TaskMonitorToolArgsByOperation[TOperation];

export type TaskMonitorRequest<
  TOperation extends TaskMonitorOperationName = TaskMonitorOperationName,
> = {
  [TOperationKey in TOperation]: {
    operation: TOperationKey;
    context: TaskMonitorContext;
    args: TaskMonitorToolArgs<TOperationKey>;
  };
}[TOperation];

export type TaskMonitorDelegationData = {
  monitorId: string;
  parentThreadId: ThreadIdentifier;
  preferredModel: string;
  preferredReasoningEffort: string;
  pollIntervalSeconds: number;
  heartbeatIntervalSeconds: number;
  startupTimeoutSeconds: number;
  startedByPwrAgent: boolean;
  monitorThreadId?: string;
  monitorTurnId?: string;
  parentAgentGuidance: string;
  prompt: string;
};

export type TaskMonitorProgressData = {
  monitorId: string;
  parentThreadId: ThreadIdentifier;
  injected: true;
  monitorUsage?: TaskMonitorUsageSnapshot;
};

export type TaskMonitorCompletionData = TaskMonitorProgressData & {
  completionSource?: TaskMonitorCompletionSource;
  outcome: CompleteMonitoringToolArgs["outcome"];
  parentTurn?: {
    status: "started" | "queued";
    turnId?: string;
    queueEntryId?: string;
    position?: number;
  };
};

export type TaskMonitorToolDataByOperation = {
  create_monitor_delegation: TaskMonitorDelegationData;
  inject_progress: TaskMonitorProgressData;
  complete_monitoring: TaskMonitorCompletionData;
};

export type TaskMonitorToolData<
  TOperation extends TaskMonitorOperationName = TaskMonitorOperationName,
> = TaskMonitorToolDataByOperation[TOperation];

export type TaskMonitorErrorCode =
  | "invalid_arguments"
  | "not_found"
  | "forbidden"
  | "unsupported_operation"
  | "internal_error";

export type TaskMonitorSuccess<
  TOperation extends TaskMonitorOperationName = TaskMonitorOperationName,
> = {
  ok: true;
  operation: TOperation;
  data: TaskMonitorToolData<TOperation>;
};

export type TaskMonitorFailure<
  TOperation extends TaskMonitorOperationName = TaskMonitorOperationName,
> = {
  ok: false;
  operation: TOperation;
  error: {
    code: TaskMonitorErrorCode;
    message: string;
  };
};

export type TaskMonitorResponse<
  TOperation extends TaskMonitorOperationName = TaskMonitorOperationName,
> = TaskMonitorSuccess<TOperation> | TaskMonitorFailure<TOperation>;

export function isTaskMonitorOperationName(
  value: unknown,
): value is TaskMonitorOperationName {
  return (
    typeof value === "string" &&
    TASK_MONITOR_OPERATION_NAMES.includes(value as TaskMonitorOperationName)
  );
}
