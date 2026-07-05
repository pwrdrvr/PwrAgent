import { spawn, spawnSync } from "node:child_process";
import type {
  AutomationGateConfig,
  AutomationGateRunResult,
} from "@pwragent/shared";
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
  async runGate(
    config: AutomationGateConfig,
  ): Promise<AutomationGateRunResult> {
    return await runShellGate(config);
  }
}

function runShellGate(
  config: AutomationGateConfig,
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
  const outputLimit =
    config.outputLimitChars ?? DEFAULT_GATE_OUTPUT_LIMIT_CHARS;
  const shell =
    process.env.SHELL?.trim()
    || (process.platform === "win32" ? resolveWindowsBashShell() : "/bin/sh");

  return new Promise((resolve) => {
    const child = spawn(shell, ["-lc", command], {
      cwd: config.cwd,
      detached: Boolean(timeoutMs),
      env: process.env,
      stdio: "pipe",
    });

    let output = "";
    let outputTruncated = false;
    let settled = false;
    let timedOut = false;
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
      clearTimeout(timeoutHandle);
      if (forceSettleHandle) {
        clearTimeout(forceSettleHandle);
        forceSettleHandle = undefined;
      }
      resolve(result);
    };

    const terminateChildTree = (): void => {
      if (!child.pid) {
        return;
      }
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, "SIGTERM");
        } else {
          // child.kill only terminates the immediate bash.exe; its children
          // (the actual gate command, e.g. `pnpm test`) linger, which keeps the
          // `close` event from firing (the gate hangs) and holds handles on the
          // workspace. Kill the whole process tree, matching the timeout path in
          // codex-environment-runtime.
          spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
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
      terminateChildTree();
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
      const durationMs = Date.now() - startedAt;
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
        status:
          exitCode === 0 ? "proceed" : exitCode === 10 ? "skip" : "failed",
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
