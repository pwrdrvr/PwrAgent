import { exec } from "node:child_process";
import type { ToolDefinition, ToolExecutionContext } from "./tool-contract.js";
import {
  asObjectArguments,
  readOptionalPositiveInteger,
  readRequiredString,
  requestToolApproval,
} from "./tool-contract.js";
import { ToolExecutionFailure } from "./tool-errors.js";
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
      let result;
      try {
        result = await runShellCommand(
          arguments_.command,
          cwd,
          arguments_.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          context,
        );
      } catch (error) {
        if (error instanceof ToolExecutionFailure) {
          return {
            success: false,
            output: error.message,
            data: {
              exitCode: null,
            },
            commandAction: classification.commandAction,
            itemType: "commandExecution",
            command: arguments_.command,
          };
        }
        throw error;
      }
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
  return await new Promise<{
    success: boolean;
    output: string;
    data: Record<string, unknown>;
  }>((resolve, reject) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const child = exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: "0" },
      },
      (error, stdout, stderr) => {
        if (settled) {
          return;
        }
        settled = true;
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        context.signal?.removeEventListener("abort", onAbort);
        const combined = [stdout.trim(), stderr.trim() ? `STDERR: ${stderr.trim()}` : ""]
          .filter(Boolean)
          .join("\n");
        if (error) {
          reject(
            new ToolExecutionFailure(
              TOOL_NAME,
              combined || error.message,
              context.signal?.aborted ? "command_cancelled" : "command_failed",
            ),
          );
          return;
        }
        resolve({
          success: true,
          output: combined || "Command executed successfully (no output).",
          data: {
            exitCode: 0,
          },
        });
      },
    );

    const onAbort = () => {
      if (settled) {
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        settled = true;
        reject(new ToolExecutionFailure(TOOL_NAME, "command was cancelled", "command_cancelled"));
        return;
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, 1_000);
    };

    if (context.signal?.aborted) {
      onAbort();
      return;
    }
    context.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
