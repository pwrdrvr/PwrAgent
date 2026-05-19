import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  CodexEnvironmentActionRun,
  CodexEnvironmentOption,
  CodexEnvironmentSetupProgressEvent,
  CodexThreadEnvironmentRuntime,
} from "@pwragent/shared";
import {
  applyCodexEnvironmentActionRunUpdate,
  readCodexEnvironmentActionRuns,
} from "@pwragent/shared";
import { getMainLogger } from "../log";

const environmentRuntimeLog = getMainLogger("pwragent:codex-environment-runtime");

const MAX_OUTPUT_PREVIEW_CHARS = 4_000;
const EXIT_ERROR_SUFFIX_LINES = 8;

function truncateForLog(value: string | undefined): string | undefined {
  if (!value) return value;
  const trimmed = value.trim();
  if (trimmed.length <= MAX_OUTPUT_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT_PREVIEW_CHARS)}…[truncated ${trimmed.length - MAX_OUTPUT_PREVIEW_CHARS} chars]`;
}

/**
 * Build the suffix attached to `Codex environment command exited with N`.
 *
 * Modern CLIs (pnpm, vite, npm, corepack) commonly print fatal errors on
 * stdout, not stderr — so the previous "stderr.trim() only" suffix would
 * misleadingly headline an exit failure with whatever stale chatter the
 * earlier command in a multi-line setup script happened to leave in the
 * stderr buffer (e.g. nvm's "v24.14.1 is already installed" trailing a
 * pnpm install that exited 1 with ERR_PNPM_IGNORED_BUILDS on stdout).
 *
 * The fix: include the tail of the combined stdout+stderr buffer, the way
 * a user running the script in a terminal would have seen it. The full
 * output is still preserved on `CodexEnvironmentCommandError.output` for
 * the dialog's collapsible details — this is just the headline.
 */
export function buildExitErrorSuffix(stdout: string, stderr: string): string {
  const combined = [stdout.trimEnd(), stderr.trimEnd()]
    .filter(Boolean)
    .join("\n");
  if (!combined) return "";
  const lines = combined.split("\n");
  const tail =
    lines.length <= EXIT_ERROR_SUFFIX_LINES
      ? combined
      : lines.slice(-EXIT_ERROR_SUFFIX_LINES).join("\n");
  return `: ${tail}`;
}

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
  /**
   * For detach mode only: fired when the detached child eventually exits.
   * Lets callers update overlay state with the final exit code / output
   * for the anchored env-action output UI without blocking the initial
   * resolve(). Not invoked for wait mode (use the resolved value instead).
   */
  onDetachedExit?: (event: CodexEnvironmentDetachedExit) => void;
  /**
   * For detach mode only: fired with a snapshot of the running command's
   * accumulated stdout+stderr buffers, throttled to at most one call per
   * `DETACHED_OUTPUT_SNAPSHOT_MS` (default ~500ms) regardless of how
   * chatty the child is. Lets callers stream live output into the
   * anchored UI so users can see what a long-running command is doing
   * before it exits, instead of staring at "(no output yet)" for
   * minutes. The final pre-exit snapshot is also delivered via
   * `onDetachedExit.output`, so callers don't need to merge.
   */
  onDetachedOutput?: (event: CodexEnvironmentDetachedOutput) => void;
};

export type CodexEnvironmentDetachedExit = {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  durationMs: number;
  output: string;
};

export type CodexEnvironmentDetachedOutput = {
  /** Current combined-stdout+stderr snapshot, capped to runShellCommand's buffers. */
  output: string;
};

export const DETACHED_OUTPUT_SNAPSHOT_MS = 500;

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
  onActionDetachedExit?: (event: CodexEnvironmentDetachedExit) => void;
  onActionDetachedOutput?: (event: CodexEnvironmentDetachedOutput) => void;
  /** Optional caller-generated runId for the auto-action; falls back to a fresh UUID. */
  actionRunId?: string;
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
      environmentRuntimeLog.error("codex-environment-setup-failed", {
        environmentId: selection.environment.id,
        environmentName: selection.environment.name,
        cwd,
        command: selection.environment.setupScript,
        exitCode: runtime.setupExitCode,
        durationMs: runtime.setupDurationMs,
        message: error instanceof Error ? error.message : String(error),
        output: truncateForLog(runtime.setupOutput),
      });
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
    const runId = params.actionRunId ?? randomUUID();
    const startedAt = Date.now();
    const run: CodexEnvironmentActionRun = {
      runId,
      actionId: selection.action.id,
      actionName: selection.action.name,
      command: selection.action.command,
      status: "started",
      startedAt,
    };
    try {
      const result = await (params.commandRunner ?? runShellCommand)({
        cwd,
        command: selection.action.command,
        env: params.env,
        mode: "detach",
        onDetachedExit: params.onActionDetachedExit,
        onDetachedOutput: params.onActionDetachedOutput,
      });
      run.pid = result.pid;
      runtime.actionRuns = applyCodexEnvironmentActionRunUpdate(
        readCodexEnvironmentActionRuns(runtime),
        { kind: "append", run },
      );
    } catch (error) {
      run.status = "failed";
      run.exitedAt = Date.now();
      runtime.actionRuns = applyCodexEnvironmentActionRunUpdate(
        readCodexEnvironmentActionRuns(runtime),
        { kind: "append", run },
      );
      environmentRuntimeLog.error("codex-environment-action-failed", {
        environmentId: selection.environment.id,
        environmentName: selection.environment.name,
        actionId: selection.action.id,
        actionName: selection.action.name,
        cwd,
        command: selection.action.command,
        phase: "during-setup",
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
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
  /** Caller-generated runId so output/exit callbacks can be pre-bound to the right run. */
  runId: string;
  commandRunner?: CodexEnvironmentCommandRunner;
  env?: NodeJS.ProcessEnv;
  onDetachedExit?: (event: CodexEnvironmentDetachedExit) => void;
  onDetachedOutput?: (event: CodexEnvironmentDetachedOutput) => void;
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

  const startedAt = Date.now();
  const run: CodexEnvironmentActionRun = {
    runId: params.runId,
    actionId: action.id,
    actionName: action.name,
    command: action.command,
    status: "started",
    startedAt,
  };
  const existingRuns = readCodexEnvironmentActionRuns(params.runtime);

  try {
    const result = await (params.commandRunner ?? runShellCommand)({
      cwd: params.runtime.cwd,
      command: action.command,
      env: params.env,
      mode: "detach",
      onDetachedExit: params.onDetachedExit,
      onDetachedOutput: params.onDetachedOutput,
    });
    run.pid = result.pid;
    return {
      ...params.runtime,
      actionRuns: applyCodexEnvironmentActionRunUpdate(existingRuns, {
        kind: "append",
        run,
      }),
    };
  } catch (error) {
    run.status = "failed";
    run.exitedAt = Date.now();
    const nextRuntime: CodexThreadEnvironmentRuntime = {
      ...params.runtime,
      actionRuns: applyCodexEnvironmentActionRunUpdate(existingRuns, {
        kind: "append",
        run,
      }),
    };
    environmentRuntimeLog.error("codex-environment-action-failed", {
      environmentId: params.runtime.environmentId,
      environmentName: params.runtime.environmentName,
      actionId: action.id,
      actionName: action.name,
      cwd: params.runtime.cwd,
      command: action.command,
      phase: "run-button",
      runId: params.runId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new CodexEnvironmentStartupError(
      error instanceof Error ? error.message : String(error),
      "action",
      nextRuntime,
    );
  }
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
    shell,
    pathPreview: truncateForLog(commandEnv.PATH),
  });

  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-lc", wrapShellCommand(shell, params.command)], {
      cwd: params.cwd,
      detached: params.mode === "detach" || Boolean(params.timeoutMs),
      env: commandEnv,
      // Pipe output even in detach mode so we can drain to a ring buffer,
      // stream to the renderer's anchored output UI, and log non-zero exits.
      // Caller still resolves on spawn for detach mode; we keep listening so
      // long-running children (e.g., `pnpm dev`) report failures.
      stdio: "pipe",
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
        environmentRuntimeLog.error("codex-environment-command-timeout", {
          processId,
          cwd: params.cwd,
          command: params.command,
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

    // Throttled snapshot for detach-mode live output streaming. Coalesces
    // bursts of data events into at most one onDetachedOutput call per
    // DETACHED_OUTPUT_SNAPSHOT_MS, regardless of how chatty the child is.
    let snapshotTimer: NodeJS.Timeout | undefined;
    const scheduleDetachedOutputSnapshot = () => {
      if (params.mode !== "detach" || !params.onDetachedOutput || snapshotTimer) {
        return;
      }
      snapshotTimer = setTimeout(() => {
        snapshotTimer = undefined;
        const snapshotOutput = [stdout.trimEnd(), stderr.trimEnd()]
          .filter(Boolean)
          .join("\n");
        try {
          params.onDetachedOutput?.({ output: snapshotOutput });
        } catch (callbackError) {
          environmentRuntimeLog.warn(
            "codex-environment-detached-output-callback-failed",
            {
              processId,
              message:
                callbackError instanceof Error
                  ? callbackError.message
                  : String(callbackError),
            },
          );
        }
      }, DETACHED_OUTPUT_SNAPSHOT_MS);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = `${stdout}${text}`.slice(-32_000);
      params.onProgress?.({
        phase: "stdout",
        chunk: text,
        at: Date.now(),
      });
      scheduleDetachedOutputSnapshot();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = `${stderr}${text}`.slice(-4096);
      params.onProgress?.({
        phase: "stderr",
        chunk: text,
        at: Date.now(),
      });
      scheduleDetachedOutputSnapshot();
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
        // Let the parent exit independently of this child. child.unref()
        // alone doesn't suffice when stdio is "pipe": the libuv pipe
        // handles on child.stdout/stderr also keep the parent's event
        // loop alive, so unref those too.
        //
        // KNOWN CAVEAT — SIGPIPE on parent exit. With pipes attached, if
        // the parent process exits while a long-survival detached child
        // (e.g. `pnpm dev`) is still writing to stdout/stderr, the child's
        // next write hits a closed pipe and the kernel delivers SIGPIPE,
        // which typically kills the child. Most users don't notice
        // because env-action commands are short-lived, but a "restart
        // PwrAgent while my dev server is running" scenario can lose the
        // dev server.
        //
        // The proper fix is to write detached output to a temp file
        // (so the child doesn't depend on the parent for stdio) and tail
        // that file for the anchored UI. Deferred — see the env-action
        // anchor follow-ups in the original review.
        child.unref();
        // child.stdout / child.stderr are typed as `Readable` but at
        // runtime they're socket-backed pipes that expose .unref(). The
        // cast keeps the call safe-typed and defensive against future
        // Node versions where the type might tighten.
        (child.stdout as { unref?: () => void } | null)?.unref?.();
        (child.stderr as { unref?: () => void } | null)?.unref?.();
        settle(() => {
          resolve({ pid: child.pid });
        });
      });
      // Even in detach mode, log non-zero exits so failed `pnpm dev` /
      // PwrSnap-style launches don't disappear silently, and fire
      // onDetachedExit so callers can persist the exit details to
      // overlay state for the anchored env-action output UI.
      child.once("close", (code, signal) => {
        // Cancel any pending throttled snapshot so it doesn't race past
        // onDetachedExit's final-output write to the overlay.
        if (snapshotTimer) {
          clearTimeout(snapshotTimer);
          snapshotTimer = undefined;
        }
        const durationMs = Date.now() - startedAt;
        const combinedOutput = [stdout.trimEnd(), stderr.trimEnd()]
          .filter(Boolean)
          .join("\n");
        if (code === 0) {
          environmentRuntimeLog.info("codex-environment-detached-exit", {
            processId,
            code,
            signal,
            durationMs,
            command: params.command,
            cwd: params.cwd,
          });
        } else {
          environmentRuntimeLog.error("codex-environment-detached-failed", {
            processId,
            code,
            signal,
            durationMs,
            command: params.command,
            cwd: params.cwd,
            output: truncateForLog(combinedOutput),
          });
        }
        try {
          params.onDetachedExit?.({
            exitCode: typeof code === "number" ? code : null,
            exitSignal: signal ?? null,
            durationMs,
            output: combinedOutput,
          });
        } catch (callbackError) {
          environmentRuntimeLog.warn(
            "codex-environment-detached-exit-callback-failed",
            {
              processId,
              message:
                callbackError instanceof Error
                  ? callbackError.message
                  : String(callbackError),
            },
          );
        }
      });
      return;
    }

    child.once("close", (code, signal) => {
      closed = true;
      if (killHandle) {
        clearTimeout(killHandle);
        killHandle = undefined;
      }
      const durationMs = Date.now() - startedAt;
      const combinedOutput = [stdout.trimEnd(), stderr.trimEnd()]
        .filter(Boolean)
        .join("\n");
      if (timedOut) {
        environmentRuntimeLog.error("codex-environment-command-exit", {
          processId,
          code,
          signal,
          durationMs,
          timedOut: true,
          command: params.command,
          cwd: params.cwd,
          output: truncateForLog(combinedOutput),
        });
        settle(() => {
          reject(
            new CodexEnvironmentCommandError(
              `Codex environment command timed out after ${params.timeoutMs}ms`,
              {
                durationMs,
                output: combinedOutput,
              },
            ),
          );
        });
        return;
      }
      if (code === 0) {
        environmentRuntimeLog.info("codex-environment-command-exit", {
          processId,
          code,
          signal,
          durationMs,
        });
        settle(() => {
          resolve({
            durationMs,
            exitCode: code,
            output: combinedOutput,
            pid: child.pid,
          });
        });
        return;
      }
      environmentRuntimeLog.error("codex-environment-command-exit", {
        processId,
        code,
        signal,
        durationMs,
        command: params.command,
        cwd: params.cwd,
        output: truncateForLog(combinedOutput),
      });
      const suffix = buildExitErrorSuffix(stdout, stderr);
      settle(() => {
        reject(
          new CodexEnvironmentCommandError(
            `Codex environment command exited with ${code ?? signal ?? "unknown"}${suffix}`,
            {
              durationMs,
              exitCode: typeof code === "number" ? code : undefined,
              output: combinedOutput,
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
