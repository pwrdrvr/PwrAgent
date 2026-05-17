import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CodexEnvironmentSetupProgressEvent } from "@pwragent/shared";
import type { CodexThreadEnvironmentRuntime } from "@pwragent/shared";
import type { CodexEnvironmentOption } from "@pwragent/shared";
import { getMainLogger } from "../log";

const environmentRuntimeLog = getMainLogger("pwragent:codex-environment-runtime");

export const DEFAULT_CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS = 10 * 60 * 1_000;
export const CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV =
  "PWRAGENT_CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS";

export class CodexEnvironmentCommandError extends Error {
  durationMs?: number;
  exitCode?: number;
  output?: string;

  constructor(message: string, details?: {
    durationMs?: number;
    exitCode?: number;
    output?: string;
  }) {
    super(message);
    this.name = "CodexEnvironmentCommandError";
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

export type CodexEnvironmentCommandParams = {
  cwd?: string;
  command: string;
  env?: NodeJS.ProcessEnv;
  mode: "wait" | "detach";
  timeoutMs?: number;
  onProgress?: (
    event: Pick<CodexEnvironmentSetupProgressEvent, "phase" | "chunk" | "at">,
  ) => void;
};

export type CodexEnvironmentCommandResult = {
  durationMs?: number;
  exitCode?: number;
  output?: string;
  pid?: number;
};

export type CodexEnvironmentCommandRunner = (
  params: CodexEnvironmentCommandParams,
) => Promise<CodexEnvironmentCommandResult>;

export async function applyLocalCodexEnvironmentSelection(params: {
  commandRunner?: CodexEnvironmentCommandRunner;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSetupProgress?: (
    event: Omit<CodexEnvironmentSetupProgressEvent, "directoryKey">,
  ) => void;
  selection?: CodexEnvironmentSelection;
  setupTimeoutMs?: number;
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
      const result = await (params.commandRunner ?? runShellCommand)({
        cwd,
        command: selection.environment.setupScript,
        env: params.env,
        mode: "wait",
        timeoutMs:
          params.setupTimeoutMs ??
          readCodexEnvironmentSetupTimeoutMs(params.env ?? process.env),
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
      if (error instanceof CodexEnvironmentCommandError) {
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
      const result = await (params.commandRunner ?? runShellCommand)({
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
  commandRunner?: CodexEnvironmentCommandRunner;
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
    const result = await (params.commandRunner ?? runShellCommand)({
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

function runShellCommand(
  params: CodexEnvironmentCommandParams,
): Promise<CodexEnvironmentCommandResult> {
  const commandEnv = sanitizeLocalEnvironmentCommandEnv(params.env ?? process.env);
  const shell = commandEnv.SHELL?.trim() || process.env.SHELL?.trim() || "/bin/sh";
  const processId = `pwragent-env-${randomUUID()}`;
  const startedAt = Date.now();
  environmentRuntimeLog.info("codex-environment-command-start", {
    processId,
    cwd: params.cwd,
    mode: params.mode,
    command: params.command,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-lc", wrapShellCommand(shell, params.command)], {
      cwd: params.cwd,
      detached: params.mode === "detach" || Boolean(params.timeoutMs),
      env: commandEnv,
      stdio: params.mode === "detach" ? "ignore" : "pipe",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let closed = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;

    const terminateChild = (signal: NodeJS.Signals) => {
      if (!child.pid) {
        return;
      }
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        environmentRuntimeLog.warn("codex-environment-command-kill-failed", {
          processId,
          signal,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (killHandle) {
        clearTimeout(killHandle);
        killHandle = undefined;
      }
      callback();
    };

    if (params.mode === "wait" && params.timeoutMs && params.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        const durationMs = Date.now() - startedAt;
        environmentRuntimeLog.warn("codex-environment-command-timeout", {
          processId,
          timeoutMs: params.timeoutMs,
          durationMs,
        });
        timedOut = true;
        timeoutHandle = undefined;
        terminateChild("SIGTERM");
        killHandle = setTimeout(() => {
          if (!closed) {
            terminateChild("SIGKILL");
          }
        }, 2_000);
      }, params.timeoutMs);
    }

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
      settle(() => {
        reject(error);
      });
    });

    if (params.mode === "detach") {
      child.once("spawn", () => {
        child.unref();
        settle(() => {
          resolve({ pid: child.pid });
        });
      });
      return;
    }

    child.once("close", (code, signal) => {
      closed = true;
      if (killHandle) {
        clearTimeout(killHandle);
        killHandle = undefined;
      }
      environmentRuntimeLog.info("codex-environment-command-exit", {
        processId,
        code,
        signal,
      });
      if (timedOut) {
        settle(() => {
          reject(
            new CodexEnvironmentCommandError(
              `Codex environment command timed out after ${params.timeoutMs}ms`,
              {
                durationMs: Date.now() - startedAt,
                output: [stdout.trimEnd(), stderr.trimEnd()]
                  .filter(Boolean)
                  .join("\n"),
              },
            ),
          );
        });
        return;
      }
      if (code === 0) {
        settle(() => {
          resolve({
            durationMs: Date.now() - startedAt,
            exitCode: code,
            output: [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n"),
            pid: child.pid,
          });
        });
        return;
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
      settle(() => {
        reject(
          new CodexEnvironmentCommandError(
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
  });
}

function sanitizeLocalEnvironmentCommandEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (isParentElectronRuntimeEnvKey(key)) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function isParentElectronRuntimeEnvKey(key: string): boolean {
  return (
    key.startsWith("ELECTRON_") ||
    key === "VITE_DEV_SERVER_URL" ||
    key.startsWith("MAIN_VITE_") ||
    key.startsWith("PRELOAD_VITE_") ||
    key.startsWith("RENDERER_VITE_")
  );
}

function readCodexEnvironmentSetupTimeoutMs(env: NodeJS.ProcessEnv): number {
  const rawValue = env[CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV]?.trim();
  if (!rawValue) {
    return DEFAULT_CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    environmentRuntimeLog.warn("codex-environment-setup-timeout-invalid", {
      env: CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV,
      value: rawValue,
    });
    return DEFAULT_CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS;
  }

  return Math.round(parsed);
}

function wrapShellCommand(shell: string, command: string): string {
  return [
    ...shellStartupCommands(shell),
    '[ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
    '[ -z "${NVM_DIR:-}" ] && [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"',
    "set -e",
    command,
  ].join("\n");
}

function shellStartupCommands(shell: string): string[] {
  const shellName = shell.split(/[\\/]/).at(-1) ?? "";
  if (shellName.includes("zsh")) {
    return ['[ -s "$HOME/.zshrc" ] && . "$HOME/.zshrc"'];
  }
  if (shellName.includes("bash")) {
    return ['[ -s "$HOME/.bashrc" ] && . "$HOME/.bashrc"'];
  }
  return [];
}
