import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CodexEnvironmentSetupProgressEvent } from "@pwragent/shared";
import type { CodexThreadEnvironmentRuntime } from "@pwragent/shared";
import type { CodexEnvironmentOption } from "@pwragent/shared";
import { getMainLogger } from "../log";

const environmentRuntimeLog = getMainLogger("pwragent:codex-environment-runtime");

class ShellCommandError extends Error {
  durationMs?: number;
  exitCode?: number;
  output?: string;

  constructor(message: string, details?: {
    durationMs?: number;
    exitCode?: number;
    output?: string;
  }) {
    super(message);
    this.name = "ShellCommandError";
    this.durationMs = details?.durationMs;
    this.exitCode = details?.exitCode;
    this.output = details?.output;
  }
}

export class CodexEnvironmentStartupError extends Error {
  phase: "setup" | "action";
  runtime: CodexThreadEnvironmentRuntime;

  constructor(
    message: string,
    phase: "setup" | "action",
    runtime: CodexThreadEnvironmentRuntime,
  ) {
    super(message);
    this.name = "CodexEnvironmentStartupError";
    this.phase = phase;
    this.runtime = runtime;
  }
}

export type CodexEnvironmentSelection = {
  environment: CodexEnvironmentOption;
  executionTarget: "local" | "remote";
  setupEnabled: boolean;
  action?: CodexEnvironmentOption["actions"][number];
};

export async function applyLocalCodexEnvironmentSelection(params: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSetupProgress?: (
    event: Omit<CodexEnvironmentSetupProgressEvent, "directoryKey">,
  ) => void;
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
    const emitSetupProgress = (
      event: Omit<
        CodexEnvironmentSetupProgressEvent,
        "directoryKey" | "environmentId" | "environmentName" | "command" | "cwd"
      >,
    ) => {
      params.onSetupProgress?.({
        environmentId: selection.environment.id,
        environmentName: selection.environment.name,
        command: selection.environment.setupScript!,
        cwd,
        ...event,
      });
    };

    try {
      emitSetupProgress({
        phase: "started",
        at: Date.now(),
      });
      const result = await runShellCommand({
        cwd,
        command: selection.environment.setupScript,
        env: params.env,
        mode: "wait",
        onProgress: (event) => {
          emitSetupProgress(event);
        },
      });
      runtime.setupStatus = "completed";
      runtime.setupOutput = result.output;
      runtime.setupExitCode = result.exitCode;
      runtime.setupDurationMs = result.durationMs;
      emitSetupProgress({
        phase: "completed",
        output: result.output,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        at: Date.now(),
      });
    } catch (error) {
      runtime.setupStatus = "failed";
      if (error instanceof ShellCommandError) {
        runtime.setupOutput = error.output;
        runtime.setupExitCode = error.exitCode;
        runtime.setupDurationMs = error.durationMs;
      } else if (error instanceof Error) {
        runtime.setupOutput = error.message;
      } else {
        runtime.setupOutput = String(error);
      }
      emitSetupProgress({
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
        output: runtime.setupOutput,
        exitCode: runtime.setupExitCode,
        durationMs: runtime.setupDurationMs,
        at: Date.now(),
      });
      throw new CodexEnvironmentStartupError(
        error instanceof Error ? error.message : String(error),
        "setup",
        runtime,
      );
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
        env: params.env,
        mode: "detach",
      });
      runtime.actionPid = result.pid;
      runtime.actionStatus = "started";
    } catch (error) {
      runtime.actionStatus = "failed";
      throw new CodexEnvironmentStartupError(
        error instanceof Error ? error.message : String(error),
        "action",
        runtime,
      );
    }
  }

  return runtime;
}

export async function startLocalCodexEnvironmentAction(params: {
  actionId: string;
  env?: NodeJS.ProcessEnv;
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
      env: params.env,
      mode: "detach",
    });
    nextRuntime.actionPid = result.pid;
    nextRuntime.actionStatus = "started";
  } catch (error) {
    nextRuntime.actionStatus = "failed";
    throw new CodexEnvironmentStartupError(
      error instanceof Error ? error.message : String(error),
      "action",
      nextRuntime,
    );
  }

  return nextRuntime;
}

function runShellCommand(params: {
  cwd?: string;
  command: string;
  env?: NodeJS.ProcessEnv;
  mode: "wait" | "detach";
  onProgress?: (
    event: Pick<CodexEnvironmentSetupProgressEvent, "phase" | "chunk" | "at">,
  ) => void;
}): Promise<{
  durationMs?: number;
  exitCode?: number;
  output?: string;
  pid?: number;
}> {
  const shell = params.env?.SHELL?.trim() || process.env.SHELL?.trim() || "/bin/sh";
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
      env: params.env ?? process.env,
      stdio: params.mode === "detach" ? "ignore" : "pipe",
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = `${stdout}${text}`.slice(-32_000);
      params.onProgress?.({
        phase: "stdout",
        chunk: text,
        at: Date.now(),
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = `${stderr}${text}`.slice(-4096);
      params.onProgress?.({
        phase: "stderr",
        chunk: text,
        at: Date.now(),
      });
    });

    child.once("error", (error) => {
      environmentRuntimeLog.error("codex-environment-command-error", {
        processId,
        message: error.message,
      });
      reject(error);
    });

    if (params.mode === "detach") {
      child.once("spawn", () => {
        child.unref();
        resolve({ pid: child.pid });
      });
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
        new ShellCommandError(
          `Codex environment command exited with ${code ?? signal ?? "unknown"}${suffix}`,
          {
            durationMs: Date.now() - startedAt,
            exitCode: typeof code === "number" ? code : undefined,
            output: [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n"),
          },
        ),
      );
    });
  });
}
