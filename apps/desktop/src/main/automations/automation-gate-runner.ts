import { spawn } from "node:child_process";
import type { AutomationGateConfig, AutomationGateRunResult } from "@pwragent/shared";

const DEFAULT_GATE_TIMEOUT_MS = 60_000;
const DEFAULT_GATE_OUTPUT_LIMIT_CHARS = 8_000;

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
  const shell = process.env.SHELL?.trim() || "/bin/sh";

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
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          if (process.platform !== "win32") {
            process.kill(-child.pid, "SIGTERM");
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          child.kill("SIGTERM");
        }
      }
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
