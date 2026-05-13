import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CodexThreadEnvironmentRuntime } from "@pwragent/shared";
import type { CodexEnvironmentOption } from "@pwragent/shared";
import { getMainLogger } from "../log";

const environmentRuntimeLog = getMainLogger("pwragent:codex-environment-runtime");

export type CodexEnvironmentSelection = {
  environment: CodexEnvironmentOption;
  executionTarget: "local" | "remote";
  setupEnabled: boolean;
  action?: CodexEnvironmentOption["actions"][number];
};

export async function applyLocalCodexEnvironmentSelection(params: {
  cwd?: string;
  selection?: CodexEnvironmentSelection;
}): Promise<CodexThreadEnvironmentRuntime | undefined> {
  const { cwd, selection } = params;
  if (!selection) {
    return undefined;
  }

  if (selection.executionTarget !== "local") {
    return {
      environmentId: selection.environment.id,
      environmentName: selection.environment.name,
      executionTarget: selection.executionTarget,
      setupEnabled: selection.setupEnabled,
      setupStatus: selection.setupEnabled ? "skipped" : undefined,
      actionId: selection.action?.id,
      actionName: selection.action?.name,
      actionCommand: selection.action?.command,
      sourcePath: selection.environment.sourcePath,
    };
  }

  const runtime: CodexThreadEnvironmentRuntime = {
    environmentId: selection.environment.id,
    environmentName: selection.environment.name,
    executionTarget: "local",
    setupEnabled: selection.setupEnabled,
    sourcePath: selection.environment.sourcePath,
  };

  if (selection.setupEnabled && selection.environment.setupScript) {
    try {
      await runShellCommand({
        cwd,
        command: selection.environment.setupScript,
        mode: "wait",
      });
      runtime.setupStatus = "completed";
    } catch (error) {
      runtime.setupStatus = "failed";
      throw error;
    }
  } else if (selection.setupEnabled) {
    runtime.setupStatus = "skipped";
  }

  if (selection.action) {
    runtime.actionId = selection.action.id;
    runtime.actionName = selection.action.name;
    runtime.actionCommand = selection.action.command;
    try {
      const pid = await runShellCommand({
        cwd,
        command: selection.action.command,
        mode: "detach",
      });
      runtime.actionPid = pid;
      runtime.actionStatus = "started";
    } catch (error) {
      runtime.actionStatus = "failed";
      throw error;
    }
  }

  return runtime;
}

function runShellCommand(params: {
  cwd?: string;
  command: string;
  mode: "wait" | "detach";
}): Promise<number | undefined> {
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  const processId = `pwragent-env-${randomUUID()}`;
  environmentRuntimeLog.info("codex-environment-command-start", {
    processId,
    cwd: params.cwd,
    mode: params.mode,
    command: params.command,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-lc", params.command], {
      cwd: params.cwd,
      detached: params.mode === "detach",
      env: process.env,
      stdio: params.mode === "detach" ? "ignore" : "pipe",
    });

    let stderr = "";
    child.stdout?.on("data", () => {
      // Drain stdout so setup scripts with normal progress output cannot block.
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });

    child.once("error", (error) => {
      environmentRuntimeLog.error("codex-environment-command-error", {
        processId,
        message: error.message,
      });
      reject(error);
    });

    if (params.mode === "detach") {
      child.unref();
      resolve(child.pid);
      return;
    }

    child.once("close", (code, signal) => {
      environmentRuntimeLog.info("codex-environment-command-exit", {
        processId,
        code,
        signal,
      });
      if (code === 0) {
        resolve(child.pid);
        return;
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(
        new Error(
          `Codex environment command exited with ${code ?? signal ?? "unknown"}${suffix}`,
        ),
      );
    });
  });
}
