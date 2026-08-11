import type {
  CancelMonitorDelegationToolArgs,
  CreateMonitorDelegationToolArgs,
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
  "Create a PwrAgent monitor thread for long tasks or repeated status checks. Do not use it for an attached PR when PR automation can wake the thread. Use check_thread_pull_request_status and follow prAutomation.guidance. Use watch_thread_pull_request for one-time PR success or failure notifications. Delegate a repeatable check after about 30 seconds of parent polling. Give the monitor the target, exact check, interval, success and failure conditions, and log steps. Do not pass local tool session IDs. A monitor cannot access parent streams, input, or exit status. Delegate a local command before it starts so the monitor can run and capture it. For an active command, provide durable process, log, or status files. Use pollIntervalSeconds for polling and heartbeats. The default is 30 seconds. Omit preferredModel and preferredReasoningEffort unless the user or project instructions require an override. Do not use backend spawn tools for this workflow.";

export const TASK_MONITOR_CREATE_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    task: { type: "string" },
    monitorContext: { type: "string" },
    cwd: { type: "string" },
    pollIntervalSeconds: { type: "number", minimum: 5 },
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
    finalHandoffPrompt: { type: "string" },
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

type ParentTaskMonitorOperation =
  | "create_monitor_delegation"
  | "cancel_monitor_delegation";

export type PwrAgentTaskMonitorHandler = (
  request: TaskMonitorRequest,
) =>
  | TaskMonitorResponse
  | Promise<TaskMonitorResponse>;

export function buildPwrAgentTaskMonitorToolDefinitions(
  handler: PwrAgentTaskMonitorHandler | undefined,
): AgentToolDefinition<ParentTaskMonitorOperation>[] {
  return [
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
}

export function buildPwrAgentTaskMonitorToolRouter(
  handler: PwrAgentTaskMonitorHandler | undefined,
): AgentToolRouter {
  return new AgentToolRouter(buildPwrAgentTaskMonitorToolDefinitions(handler));
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
