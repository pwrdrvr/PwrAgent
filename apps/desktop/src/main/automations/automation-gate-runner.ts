import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { AutomationGateConfig, AutomationGateRunResult } from "@pwragent/shared/contracts/automations";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { isEnvironmentGroupGone } from "../resource-checkouts/checkout-machine-evidence";
import { getResourceCheckoutService } from "../resource-checkouts/checkout-runtime";
import { windowsJobCleanupVerified, wrapCommandInWindowsJob } from "../windows-job-wrapper";
import { resolveWindowsBashShell } from "../windows-shell";

const DEFAULT_GATE_TIMEOUT_MS = 60_000;
const DEFAULT_GATE_OUTPUT_LIMIT_CHARS = 8_000;
// After a timeout fires we kill the child (tree on Windows, process group on
// POSIX) and wait for its `close` event to settle the gate. If `close` never
// arrives — e.g. a Windows grandchild keeps a stdio pipe open after taskkill —
// force-settle the gate as timed-out after this grace window so the caller can
// never hang.
const TIMEOUT_FORCE_SETTLE_GRACE_MS = 3_000;

export type AutomationGateRunner = {
  runGate(config: AutomationGateConfig): Promise<AutomationGateRunResult>;
};

export class ShellAutomationGateRunner implements AutomationGateRunner {
  async runGate(config: AutomationGateConfig): Promise<AutomationGateRunResult> {
    return await runShellGate(config);
  }
}

function runShellGate(config: AutomationGateConfig): Promise<AutomationGateRunResult> {
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
            keepDrainEvidenceOnStop: !!getResourceCheckoutService(),
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

  let checkout;
  try {
    checkout = getResourceCheckoutService()?.admitMachineJob(randomUUID(), "Automation gate");
  } catch (error) {
    windowsJobLaunch?.cleanup();
    return Promise.resolve({
      status: "failed", command, cwd: config.cwd, durationMs: Date.now() - startedAt, output: "",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: config.cwd,
        detached: !windowsJobLaunch && Boolean(timeoutMs),
        env: launch.env,
        stdio: "pipe",
        windowsHide: true,
      });
    } catch (error) {
      checkout?.finish(true);
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
    let closed = false;
    let timedOut = false;
    let groupPoll: ReturnType<typeof setInterval> | undefined;
    let checkoutFinished = false;
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
      if (!groupPoll) clearTimeout(timeoutHandle);
      if (forceSettleHandle) {
        clearTimeout(forceSettleHandle);
        forceSettleHandle = undefined;
      }
      resolve(result);
    };

    const finishCheckout = () => {
      if (!checkout || checkoutFinished) return;
      if (!windowsJobLaunch && child.pid && !isEnvironmentGroupGone(child.pid)) return;
      checkoutFinished = true;
      clearInterval(groupPoll);
      if (settled) clearTimeout(timeoutHandle);
      checkout.finish(!windowsJobLaunch || !child.pid || windowsJobCleanupVerified(windowsJobLaunch));
    };

    const terminateChildTree = (force = false): void => {
      if (!child.pid || checkoutFinished) {
        return;
      }
      try {
        if (windowsJobLaunch) {
          // The wrapper owns the shell and all descendants in a
          // KILL_ON_JOB_CLOSE Job, so terminating this one process is atomic.
          if (checkout && windowsJobLaunch.requestStop) windowsJobLaunch.requestStop();
          else child.kill("SIGKILL");
        } else if (process.platform !== "win32") {
          if (closed) finishCheckout();
          if (checkoutFinished) return;
          process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } else {
          // child.kill only terminates the immediate bash.exe; its children
          // (the actual gate command, e.g. `pnpm test`) linger, which keeps the
          // `close` event from firing (the gate hangs) and holds handles on the
          // workspace. Kill the whole process tree, matching the timeout path in
          // codex-environment-runtime.
          spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            env: buildPwrAgentChildProcessEnv(process.env),
            stdio: "ignore",
          });
        }
      } catch {
        // Best-effort last resort; the force-settle timer below still
        // guarantees the gate promise resolves even if this throws.
        child.kill("SIGKILL");
      }
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminateChildTree(settled);
      if (settled) return;
      forceSettleHandle = setTimeout(() => {
        finish({
          status: "failed",
          command,
          cwd: config.cwd,
          durationMs: Date.now() - startedAt,
          output,
          outputTruncated,
          errorMessage: `Automation gate timed out after ${timeoutMs}ms.`,
        });
      }, TIMEOUT_FORCE_SETTLE_GRACE_MS);
      forceSettleHandle.unref?.();
    }, timeoutMs);
    timeoutHandle.unref?.();

    let checkoutStopped = false;
    if (checkout) {
      checkout.watch(() => {
        checkoutStopped = true;
        terminateChildTree(true);
      });
      child.once("spawn", () => checkout.active(windowsJobLaunch ? undefined : child.pid));
    }

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    child.once("error", (error) => {
      finish({
        status: "failed",
        command,
        cwd: config.cwd,
        durationMs: Date.now() - startedAt,
        output,
        outputTruncated,
        errorMessage: error.message,
      });
    });

    child.once("close", (code, signal) => {
      closed = true;
      finishCheckout();
      if (checkout && !checkoutFinished && !windowsJobLaunch) {
        groupPoll = setInterval(finishCheckout, 50);
        groupPoll.unref();
      }
      windowsJobLaunch?.cleanup();
      const durationMs = Date.now() - startedAt;
      if (checkoutStopped) {
        finish({ status: "failed", command, cwd: config.cwd, durationMs, output, outputTruncated,
          errorMessage: "Automation gate stopped because its machine checkout ended." });
        return;
      }
      if (timedOut) {
        finish({
          status: "failed",
          command,
          cwd: config.cwd,
          durationMs,
          output,
          outputTruncated,
          errorMessage: `Automation gate timed out after ${timeoutMs}ms.`,
        });
        return;
      }
      const exitCode = typeof code === "number" ? code : undefined;
      finish({
        status: exitCode === 0 ? "proceed" : exitCode === 10 ? "skip" : "failed",
        command,
        cwd: config.cwd,
        exitCode,
        durationMs,
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
