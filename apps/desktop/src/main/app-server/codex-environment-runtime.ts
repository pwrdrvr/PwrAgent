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
      cwd,
      setupEnabled: selection.setupEnabled,
      setupStatus: selection.setupEnabled ? "skipped" : undefined,
      setupCommand: selection.environment.setupScript,
      actions: selection.environment.actions,
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
    cwd,
    setupEnabled: selection.setupEnabled,
    setupCommand: selection.environment.setupScript,
    actions: selection.environment.actions,
    sourcePath: selection.environment.sourcePath,
  };

  if (selection.setupEnabled && selection.environment.setupScript) {
    try {
      const result = await runShellCommand({
        cwd,
        command: selection.environment.setupScript,
        mode: "wait",
      });
      runtime.setupStatus = "completed";
      runtime.setupOutput = result.output;
      runtime.setupExitCode = result.exitCode;
      runtime.setupDurationMs = result.durationMs;
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
      const result = await runShellCommand({
        cwd,
        command: selection.action.command,
        mode: "detach",
      });
      runtime.actionPid = result.pid;
      runtime.actionStatus = "started";
    } catch (error) {
      runtime.actionStatus = "failed";
      throw error;
    }
  }

  return runtime;
}

export async function startLocalCodexEnvironmentAction(params: {
  actionId: string;
  runtime: CodexThreadEnvironmentRuntime;
}): Promise<CodexThreadEnvironmentRuntime> {
  if (params.runtime.executionTarget !== "local") {
    throw new Error("Remote Codex environment actions are not wired yet.");
  }

  const action = params.runtime.actions?.find(
    (candidate) => candidate.id === params.actionId,
  );
  if (!action) {
    throw new Error(`Codex environment action '${params.actionId}' is not available.`);
  }

  const nextRuntime: CodexThreadEnvironmentRuntime = {
    ...params.runtime,
    actionId: action.id,
    actionName: action.name,
    actionCommand: action.command,
  };

  try {
    const result = await runShellCommand({
      cwd: params.runtime.cwd,
      command: action.command,
      mode: "detach",
    });
    nextRuntime.actionPid = result.pid;
    nextRuntime.actionStatus = "started";
  } catch (error) {
    nextRuntime.actionStatus = "failed";
    throw error;
  }

  return nextRuntime;
}

function runShellCommand(params: {
  cwd?: string;
  command: string;
  mode: "wait" | "detach";
}): Promise<{
  durationMs?: number;
  exitCode?: number;
  output?: string;
  pid?: number;
}> {
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  const processId = `pwragent-env-${randomUUID()}`;
  const startedAt = Date.now();
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

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-32_000);
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
      resolve({ pid: child.pid });
      return;
    }

    child.once("close", (code, signal) => {
      environmentRuntimeLog.info("codex-environment-command-exit", {
        processId,
        code,
        signal,
      });
      if (code === 0) {
        resolve({
          durationMs: Date.now() - startedAt,
          exitCode: code,
          output: [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n"),
          pid: child.pid,
        });
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
