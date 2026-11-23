import { spawn } from "node:child_process";
import type { AutomationGateConfig, AutomationGateRunResult } from "@pwragent/shared/contracts/automations";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { isOwnedProcessTreeAlive } from "../process-tree";
import { wrapCommandInWindowsJob } from "../windows-job-wrapper";
import { resolveWindowsBashShell } from "../windows-shell";

const DEFAULT_GATE_TIMEOUT_MS = 60_000;
const DEFAULT_GATE_OUTPUT_LIMIT_CHARS = 8_000;
// Bound how long a stopped gate can wait on its stdio pipes.
const STOP_FORCE_SETTLE_GRACE_MS = 3_000;

export type AutomationGateRunner = {
  runGate(config: AutomationGateConfig): Promise<AutomationGateRunResult>;
  stopAll?(): void;
};

export class ShellAutomationGateRunner implements AutomationGateRunner {
  private readonly activeStops = new Set<() => void>();

  async runGate(config: AutomationGateConfig): Promise<AutomationGateRunResult> {
    return await runShellGate(config, this.activeStops);
  }

  stopAll(): void {
    for (const stop of this.activeStops) stop();
  }
}

function runShellGate(
  config: AutomationGateConfig,
  activeStops: Set<() => void>,
): Promise<AutomationGateRunResult> {
  const command = config.command.trim();
  if (!command) {
    return Promise.resolve({
      status: "failed",
      command: config.command,
      cwd: config.cwd,
      durationMs: 0,
      output: "",
      errorMessage: "Automation gate command is empty.",
    });
  }

  const startedAt = Date.now();
  const timeoutMs = config.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const outputLimit = config.outputLimitChars ?? DEFAULT_GATE_OUTPUT_LIMIT_CHARS;
  const childEnv = buildPwrAgentChildProcessEnv(process.env);
  const shell =
    childEnv.SHELL?.trim() ||
    (process.platform === "win32" ? resolveWindowsBashShell() : "/bin/sh");
  let windowsJobLaunch: ReturnType<typeof wrapCommandInWindowsJob> | undefined;
  try {
    windowsJobLaunch =
      process.platform === "win32"
        ? wrapCommandInWindowsJob({
            args: ["-lc", command],
            command: shell,
            cwd: config.cwd,
            env: childEnv,
          })
        : undefined;
  } catch (error) {
    return Promise.resolve({
      status: "failed",
      command,
      cwd: config.cwd,
      durationMs: Date.now() - startedAt,
      output: "",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  const launch = windowsJobLaunch ?? {
    args: ["-lc", command],
    command: shell,
    env: childEnv,
  };

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: config.cwd,
        detached: !windowsJobLaunch,
        env: launch.env,
        stdio: "pipe",
        windowsHide: true,
      });
    } catch (error) {
      windowsJobLaunch?.cleanup();
      resolve({
        status: "failed", command, cwd: config.cwd, durationMs: Date.now() - startedAt, output: "",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let output = "";
    let outputTruncated = false;
    let settled = false;
    let stoppedReason: string | undefined;
    let groupPoll: ReturnType<typeof setInterval> | undefined;
    let forceSettleHandle: ReturnType<typeof setTimeout> | undefined;
    const appendOutput = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > outputLimit) {
        output = output.slice(output.length - outputLimit);
        outputTruncated = true;
      }
    };

    const finish = (result: AutomationGateRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const releaseOwnership = (): void => {
      if (!activeStops.delete(stopForShutdown)) return;
      clearTimeout(timeoutHandle);
      clearInterval(groupPoll);
      clearTimeout(forceSettleHandle);
      windowsJobLaunch?.cleanup();
    };
    const finishFailed = (errorMessage: string): void => {
      finish({
        status: "failed",
        command,
        cwd: config.cwd,
        durationMs: Date.now() - startedAt,
        output,
        outputTruncated,
        errorMessage,
      });
    };

    const stop = (reason: string): void => {
      if (stoppedReason) return;
      stoppedReason = reason;
      try {
        if (windowsJobLaunch) {
          // Closing the launcher's KILL_ON_JOB_CLOSE handle kills the Job.
          child.kill("SIGKILL");
        } else if (child.pid && isOwnedProcessTreeAlive(child)) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // The group can exit between probing and signaling it.
      }
      if (settled) {
        releaseOwnership();
        return;
      }
      forceSettleHandle = setTimeout(() => {
        releaseOwnership();
        finishFailed(reason);
      }, STOP_FORCE_SETTLE_GRACE_MS);
      forceSettleHandle.unref();
    };
    const stopForShutdown = () => stop("Automation gate stopped during owner shutdown.");
    const timeoutHandle = setTimeout(() => stop(`Automation gate timed out after ${timeoutMs}ms.`), timeoutMs);
    timeoutHandle.unref();
    activeStops.add(stopForShutdown);

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    child.once("error", (error) => {
      if (!child.pid) releaseOwnership();
      finishFailed(stoppedReason ?? error.message);
    });

    child.once("close", (code, signal) => {
      if (stoppedReason || windowsJobLaunch || !child.pid || !isOwnedProcessTreeAlive(child)) {
        releaseOwnership();
      } else {
        // Keep the original deadline and the shutdown hook for descendants
        // that closed or redirected their pipes before the shell exited.
        groupPoll = setInterval(() => {
          if (!isOwnedProcessTreeAlive(child)) releaseOwnership();
        }, 50);
        groupPoll.unref();
      }
      if (stoppedReason) {
        finishFailed(stoppedReason);
        return;
      }
      const exitCode = typeof code === "number" ? code : undefined;
      finish({
        status: exitCode === 0 ? "proceed" : exitCode === 10 ? "skip" : "failed",
        command,
        cwd: config.cwd,
        exitCode,
        durationMs: Date.now() - startedAt,
        output,
        outputTruncated,
        errorMessage:
          exitCode === 0 || exitCode === 10
            ? undefined
            : `Automation gate exited with ${code ?? signal ?? "unknown"}.`,
      });
    });
  });
}
