import type { ToolDefinition, ToolExecutionContext } from "./tool-contract.js";
import {
  asObjectArguments,
  readOptionalPositiveInteger,
  readRequiredString,
  requestToolApproval,
} from "./tool-contract.js";
import { runProcess, type ProcessRunResult } from "./process-runner.js";
import { classifyShellCommand } from "./shell-safety.js";
import { requireWorkspacePath } from "./workspace-paths.js";

const TOOL_NAME = "shell_command";
const DEFAULT_TIMEOUT_MS = 30_000;

type ShellCommandArguments = {
  command: string;
  timeoutMs?: number;
};

export function createShellCommandTool(): ToolDefinition<ShellCommandArguments> {
  return {
    name: TOOL_NAME,
    description:
      "Execute a shell command in the current workspace. Safe read-only commands auto-run; mutating or ambiguous commands require approval.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute in the workspace.",
        },
        timeoutMs: {
          type: "integer",
          description: "Optional timeout in milliseconds.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    parseArguments(arguments_) {
      const record = asObjectArguments(TOOL_NAME, arguments_);
      return {
        command: readRequiredString(record, TOOL_NAME, "command"),
        timeoutMs: readOptionalPositiveInteger(record, TOOL_NAME, "timeoutMs"),
      };
    },
    async execute(arguments_, context) {
      const cwd = requireWorkspacePath(context, TOOL_NAME);
      const classification = classifyShellCommand(arguments_.command);
      if (!classification.safe && context.approvalPolicy !== "never") {
        const decision = await requestToolApproval(context, {
          requestId: `${TOOL_NAME}-${Math.random().toString(36).slice(2, 10)}`,
          kind: "commandExecution",
          reason: classification.reason,
          command: arguments_.command,
          commandAction: classification.commandAction,
        });
        if (decision !== "approve") {
          return {
            success: false,
            output:
              decision === "cancel"
                ? `Approval cancelled for shell_command: ${arguments_.command}`
                : `Approval declined for shell_command: ${arguments_.command}`,
            commandAction: classification.commandAction,
            itemType: "commandExecution",
            command: arguments_.command,
          };
        }
      }
      const result = await runShellCommand(
        arguments_.command,
        cwd,
        arguments_.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        context,
      );
      return {
        ...result,
        commandAction: classification.commandAction,
        itemType: "commandExecution",
        command: arguments_.command,
      };
    },
  };
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  context: ToolExecutionContext,
) {
  const result = await runProcess({
    command,
    cwd,
    shell: true,
    timeoutMs,
    signal: context.signal,
    onOutputDelta: context.onOutputDelta,
  });
  const output = result.output || fallbackOutput(result);
  return {
    success: result.status === "completed" && result.exitCode === 0,
    output,
    data: processResultData(result),
  };
}

function fallbackOutput(result: ProcessRunResult): string {
  if (result.status === "completed" && result.exitCode === 0) {
    return "Command executed successfully (no output).";
  }
  if (result.status === "timed_out") {
    return "Command timed out.";
  }
  if (result.status === "cancelled") {
    return "Command was cancelled.";
  }
  return result.error?.message || "Command failed.";
}

function processResultData(result: ProcessRunResult): Record<string, unknown> {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    status: result.status,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    outputLimitBytes: result.outputLimitBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}
