import type {
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
  "Create and start a lightweight PwrAgent-managed monitor thread for long-running asynchronous work or repeatable status checks. Use this instead of polling from the parent agent when the task may take more than one short status check, especially when you are about to sleep/wait/poll every few seconds for a command, job, service, or external operation to finish. If you have checked something for progress for about 30 seconds and the check is repeatable, hand it to this monitor with enough context to run that check for you. The task and monitorContext must include the exact monitoring procedure the parent was about to run itself: cwd or target location, command/status command or wait API, poll cadence, terminal success/failure conditions, and relevant log collection steps. Do not pass parent-local Codex/tool session ids such as exec_command/write_stdin session_id values; monitor threads cannot access those sessions, stdout/stderr streams, stdin, or exit status. For a local build/test/script, delegate before starting it and provide cwd plus the exact command so the monitor starts it and captures output itself. Prefer separate stdout/stderr capture files plus a combined output file when practical, and include those file paths in the final handoff. If the command is already running, provide durable process/log/status files that the monitor can read. Use pollIntervalSeconds as the combined poll and heartbeat cadence; default to 30 seconds unless the delegated procedure clearly needs a different cadence. PwrAgent starts the monitor with the returned preferred model/reasoning settings and the monitor callback tools attached; do not call generic spawnAgent for this flow.";

export const TASK_MONITOR_CREATE_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    task: { type: "string" },
    monitorContext: { type: "string" },
    cwd: { type: "string" },
    pollIntervalSeconds: { type: "number", minimum: 5 },
    preferredModel: { type: "string" },
    preferredReasoningEffort: { type: "string" },
    finalHandoffPrompt: { type: "string" },
  },
  required: ["task"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export type PwrAgentTaskMonitorHandler = (
  request: TaskMonitorRequest<"create_monitor_delegation">,
) =>
  | TaskMonitorResponse<"create_monitor_delegation">
  | Promise<TaskMonitorResponse<"create_monitor_delegation">>;

export function buildPwrAgentTaskMonitorToolDefinitions(
  handler: PwrAgentTaskMonitorHandler | undefined,
): AgentToolDefinition<"create_monitor_delegation">[] {
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

function taskMonitorResponseToAgentToolResult(
  response: TaskMonitorResponse<"create_monitor_delegation">,
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
