import type {
  CancelMonitorDelegationToolArgs,
  CompleteMonitoringToolArgs,
  CreateMonitorDelegationToolArgs,
  InjectMonitorProgressToolArgs,
  TaskMonitorRequest,
  TaskMonitorResponse,
} from "@pwragent/shared";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import type {
  AgentToolDefinition,
  AgentToolDispatchResult,
} from "./agent-tool-definition.js";
import {
  agentToolFailure,
  agentToolSuccess,
} from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";

export const TASK_MONITOR_CREATE_TOOL_DESCRIPTION =
  "Create a PwrAgent monitor thread for long tasks or repeated status checks. Use it immediately when the user explicitly requests a Job Monitor. Otherwise, delegate a repeatable check after about 30 seconds of parent polling. A successful response means the monitor thread and turn have started. Do not inspect the monitor thread, poll, or sleep in the parent after success. End the parent turn when no unrelated work remains. Monitor completion wakes the parent by default. Do not use this for an attached PR when PR automation can wake the thread. Use check_thread_pull_request_status and follow prAutomation.guidance. Use watch_thread_pull_request for one-time PR success or failure notifications. Give the monitor the target, exact check, interval, success and failure conditions, and log steps. Do not pass local tool session IDs. A monitor cannot access parent streams, input, or exit status. Delegate a local command before it starts so the monitor can run and capture it. For an active command, provide durable process, log, or status files. Use pollIntervalSeconds for polling and heartbeats. The default is 30 seconds. Omit preferredModel and preferredReasoningEffort unless the user or project instructions require an override. Do not use backend spawn tools for this workflow.";

export const TASK_MONITOR_CREATE_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description:
        "Self-contained polling procedure with the target, exact check, terminal conditions, and required final evidence.",
    },
    monitorContext: {
      type: "string",
      description:
        "Minimal durable identifiers and context needed by the monitor. Never include parent-local tool session handles.",
    },
    cwd: {
      type: "string",
      description:
        "Working directory the monitor should use for local commands and files.",
    },
    pollIntervalSeconds: {
      type: "number",
      minimum: 5,
      description:
        "Polling and heartbeat cadence in seconds. Defaults to 30 and never runs more often than every five seconds.",
    },
    preferredModel: {
      type: "string",
      description:
        "Optional override. Omit it to use the monitor default. Set it only when the user or project instructions require an override.",
    },
    preferredReasoningEffort: {
      type: "string",
      description:
        "Optional override. Omit it to use the monitor default. Set it only when the user or project instructions require an override.",
    },
    finalHandoffPrompt: {
      type: "string",
      description:
        "Instructions for the single parent turn automatically triggered after monitor completion.",
    },
  },
  required: ["task"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export const TASK_MONITOR_CANCEL_TOOL_DESCRIPTION =
  "Cancel an active PwrAgent monitor now. Pass the monitorId from create_monitor_delegation. This interrupts the monitor and records cancellation in the parent thread. It does not start or queue a parent turn. Use this instead of send_message_to_thread to stop a monitor.";

export const TASK_MONITOR_CANCEL_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    monitorId: { type: "string" },
    reason: { type: "string" },
  },
  required: ["monitorId"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export const TASK_MONITOR_PROGRESS_TOOL_DESCRIPTION =
  "Inject a concise monitor update into the parent thread without starting or waking a parent turn.";

export const TASK_MONITOR_PROGRESS_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    monitorId: { type: "string" },
    message: { type: "string" },
    status: {
      type: "string",
      enum: ["pending", "running", "blocked", "failed"],
    },
  },
  required: ["monitorId", "message"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export const TASK_MONITOR_COMPLETE_TOOL_DESCRIPTION =
  "Finish a monitor, inject its final result, and trigger exactly one parent turn by default.";

export const TASK_MONITOR_COMPLETE_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    monitorId: { type: "string" },
    outcome: {
      type: "string",
      enum: ["success", "failure", "cancelled"],
    },
    summary: { type: "string" },
    details: { type: "string" },
    triggerParentTurn: { type: "boolean" },
  },
  required: ["monitorId", "outcome", "summary"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

type TaskMonitorAgentOperation =
  | "create_monitor_delegation"
  | "cancel_monitor_delegation"
  | "inject_progress"
  | "complete_monitoring";

export type PwrAgentTaskMonitorHandler = (
  request: TaskMonitorRequest,
) =>
  | TaskMonitorResponse
  | Promise<TaskMonitorResponse>;

export function buildPwrAgentTaskMonitorToolDefinitions(
  handler: PwrAgentTaskMonitorHandler | undefined,
  role: "parent" | "monitor" | "all" = "parent",
): AgentToolDefinition<TaskMonitorAgentOperation>[] {
  const parentTools: AgentToolDefinition<TaskMonitorAgentOperation>[] = [
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "create_monitor_delegation",
      description: TASK_MONITOR_CREATE_TOOL_DESCRIPTION,
      inputSchema: TASK_MONITOR_CREATE_TOOL_INPUT_SCHEMA,
      deferLoading: false,
      dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
        if (!handler) {
          return agentToolFailure({
            code: "internal_error",
            message: "PwrAgent task monitor tools are not available.",
          });
        }
        const normalizedArgs = normalizeCreateMonitorArgs(args);
        if (!normalizedArgs) {
          return agentToolFailure({
            code: "invalid_arguments",
            message: "create_monitor_delegation requires a non-empty task string.",
          });
        }
        const response = await handler({
          operation: "create_monitor_delegation",
          context: {
            backend: context.backend,
            threadId: context.threadId,
            turnId: context.turnId ?? "",
          },
          args: normalizedArgs,
        });
        return taskMonitorResponseToAgentToolResult(response);
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "cancel_monitor_delegation",
      description: TASK_MONITOR_CANCEL_TOOL_DESCRIPTION,
      inputSchema: TASK_MONITOR_CANCEL_TOOL_INPUT_SCHEMA,
      deferLoading: false,
      dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
        if (!handler) {
          return agentToolFailure({
            code: "internal_error",
            message: "PwrAgent task monitor tools are not available.",
          });
        }
        const normalizedArgs = normalizeCancelMonitorArgs(args);
        if (!normalizedArgs) {
          return agentToolFailure({
            code: "invalid_arguments",
            message: "cancel_monitor_delegation requires a non-empty monitorId string.",
          });
        }
        const response = await handler({
          operation: "cancel_monitor_delegation",
          context: {
            backend: context.backend,
            threadId: context.threadId,
            turnId: context.turnId ?? "",
          },
          args: normalizedArgs,
        });
        return taskMonitorResponseToAgentToolResult(response);
      },
    },
  ];
  const monitorTools: AgentToolDefinition<TaskMonitorAgentOperation>[] = [
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "inject_progress",
      description: TASK_MONITOR_PROGRESS_TOOL_DESCRIPTION,
      inputSchema: TASK_MONITOR_PROGRESS_TOOL_INPUT_SCHEMA,
      deferLoading: false,
      dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
        if (!handler) {
          return agentToolFailure({
            code: "internal_error",
            message: "PwrAgent task monitor tools are not available.",
          });
        }
        const normalizedArgs = normalizeInjectProgressArgs(args);
        if (!normalizedArgs) {
          return agentToolFailure({
            code: "invalid_arguments",
            message: "inject_progress requires non-empty monitorId and message strings.",
          });
        }
        return taskMonitorResponseToAgentToolResult(await handler({
          operation: "inject_progress",
          context: {
            backend: context.backend,
            threadId: context.threadId,
            turnId: context.turnId ?? "",
          },
          args: normalizedArgs,
        }));
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "complete_monitoring",
      description: TASK_MONITOR_COMPLETE_TOOL_DESCRIPTION,
      inputSchema: TASK_MONITOR_COMPLETE_TOOL_INPUT_SCHEMA,
      deferLoading: false,
      dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
        if (!handler) {
          return agentToolFailure({
            code: "internal_error",
            message: "PwrAgent task monitor tools are not available.",
          });
        }
        const normalizedArgs = normalizeCompleteMonitoringArgs(args);
        if (!normalizedArgs) {
          return agentToolFailure({
            code: "invalid_arguments",
            message: "complete_monitoring requires monitorId, outcome, and summary.",
          });
        }
        return taskMonitorResponseToAgentToolResult(await handler({
          operation: "complete_monitoring",
          context: {
            backend: context.backend,
            threadId: context.threadId,
            turnId: context.turnId ?? "",
          },
          args: normalizedArgs,
        }));
      },
    },
  ];
  return role === "parent"
    ? parentTools
    : role === "monitor"
      ? monitorTools
      : [...parentTools, ...monitorTools];
}

export function buildPwrAgentTaskMonitorToolRouter(
  handler: PwrAgentTaskMonitorHandler | undefined,
  role: "parent" | "monitor" | "all" = "parent",
): AgentToolRouter {
  return new AgentToolRouter(
    buildPwrAgentTaskMonitorToolDefinitions(handler, role),
  );
}

function normalizeCreateMonitorArgs(
  args: Record<string, unknown>,
): CreateMonitorDelegationToolArgs | undefined {
  const task = readString(args.task);
  if (!task) {
    return undefined;
  }
  const pollIntervalSeconds =
    typeof args.pollIntervalSeconds === "number" &&
    Number.isFinite(args.pollIntervalSeconds)
      ? args.pollIntervalSeconds
      : undefined;
  return {
    task,
    monitorContext: readString(args.monitorContext),
    cwd: readString(args.cwd),
    pollIntervalSeconds,
    preferredModel: readString(args.preferredModel),
    preferredReasoningEffort: readString(args.preferredReasoningEffort),
    finalHandoffPrompt: readString(args.finalHandoffPrompt),
  };
}

function normalizeCancelMonitorArgs(
  args: Record<string, unknown>,
): CancelMonitorDelegationToolArgs | undefined {
  const monitorId = readString(args.monitorId);
  if (!monitorId) {
    return undefined;
  }
  return {
    monitorId,
    reason: readString(args.reason),
  };
}

function normalizeInjectProgressArgs(
  args: Record<string, unknown>,
): InjectMonitorProgressToolArgs | undefined {
  const monitorId = readString(args.monitorId);
  const message = readString(args.message);
  const status =
    args.status === "pending"
    || args.status === "running"
    || args.status === "blocked"
    || args.status === "failed"
      ? args.status
      : undefined;
  if (!monitorId || !message) {
    return undefined;
  }
  return { monitorId, message, status };
}

function normalizeCompleteMonitoringArgs(
  args: Record<string, unknown>,
): CompleteMonitoringToolArgs | undefined {
  const monitorId = readString(args.monitorId);
  const summary = readString(args.summary);
  const outcome =
    args.outcome === "success"
    || args.outcome === "failure"
    || args.outcome === "cancelled"
      ? args.outcome
      : undefined;
  if (!monitorId || !outcome || !summary) {
    return undefined;
  }
  return {
    monitorId,
    outcome,
    summary,
    details: readString(args.details),
    triggerParentTurn:
      typeof args.triggerParentTurn === "boolean"
        ? args.triggerParentTurn
        : undefined,
  };
}

function taskMonitorResponseToAgentToolResult(
  response: TaskMonitorResponse,
): AgentToolDispatchResult {
  if (response.ok) {
    return agentToolSuccess(response.data);
  }
  return agentToolFailure({
    code: response.error.code,
    message: response.error.message,
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
