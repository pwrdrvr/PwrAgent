import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

const STRESS_ARG = "--pwragent-vitest-stress";
const PROCESS_SAMPLES_ARG = "--pwragent-vitest-process-samples";
const TARGET_ARG_PREFIX = "--pwragent-vitest-target=";
const TIMEOUT_ARG_PREFIX = "--pwragent-vitest-timeout-ms=";
const PLAYWRIGHT_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_VITEST_TIMEOUT_MS = 19 * 60 * 1_000;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;
const PROCESS_TREE_EXIT_TIMEOUT_MS = 15_000;
const specDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(specDir, "../../..");

type ProcessSnapshotEntry = {
  commandLine: string;
  executablePath: string;
  id: number;
  name: string;
  parentId: number;
};

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

async function runCommand(
  command: string,
  args: string[],
  timeoutMs?: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error(
          `${path.basename(command)} did not exit within ${timeoutMs}ms.`,
        )));
      }, timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => resolve({ code, signal, stderr, stdout }));
    });
  });
}

async function captureRelevantProcesses(): Promise<ProcessSnapshotEntry[]> {
  const powershell = [
    // Exclude cmd/PowerShell because the lab controller's status probes run
    // concurrently on the guest and are not descendants of the test process.
    "$names = @('bash.exe', 'git.exe', 'git-lfs.exe', 'node.exe', 'sh.exe', 'sleep.exe')",
    "$rows = @(Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name -and $_.ProcessId -ne $PID } | ForEach-Object { [pscustomobject]@{ commandLine = [string]$_.CommandLine; executablePath = [string]$_.ExecutablePath; id = [int]$_.ProcessId; name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name); parentId = [int]$_.ParentProcessId } })",
    "$rows | Sort-Object name, id | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await runCommand("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    powershell,
  ], PROCESS_SNAPSHOT_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new Error(
      `Process snapshot failed with exit ${result.code}: ${result.stderr.trim()}`,
    );
  }
  const output = result.stdout.trim();
  if (!output) {
    return [];
  }
  const parsed = JSON.parse(output) as ProcessSnapshotEntry | ProcessSnapshotEntry[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function processKey(entry: ProcessSnapshotEntry): string {
  return `${entry.name}:${entry.id}`;
}

function newlyRunningProcesses(
  before: ProcessSnapshotEntry[],
  after: ProcessSnapshotEntry[],
): ProcessSnapshotEntry[] {
  const beforeKeys = new Set(before.map(processKey));
  return after.filter((entry) => !beforeKeys.has(processKey(entry)));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateProcessTree(processId: number): Promise<CommandResult> {
  return runCommand(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(processId), "/T", "/F"],
    PROCESS_TREE_EXIT_TIMEOUT_MS,
  );
}

test.skip(
  process.platform !== "win32",
  "This diagnostic exercises the native Windows Vitest shutdown path.",
);

test(
  "runs one complete Windows Vitest workspace iteration @windows-vitest-stress",
  async ({ browserName }, testInfo) => {
    test.setTimeout(PLAYWRIGHT_TIMEOUT_MS);
    test.skip(
      !testInfo.config.argv.includes(STRESS_ARG),
      `Pass ${STRESS_ARG} after Playwright's -- separator to run this diagnostic.`,
    );

    const targetArgument = testInfo.config.argv.find((argument) =>
      argument.startsWith(TARGET_ARG_PREFIX),
    );
    const vitestTarget = targetArgument?.slice(TARGET_ARG_PREFIX.length);
    if (vitestTarget && !/^[A-Za-z0-9_./-]+$/.test(vitestTarget)) {
      throw new Error(`Unsafe Vitest target: ${JSON.stringify(vitestTarget)}`);
    }
    const timeoutArgument = testInfo.config.argv.find((argument) =>
      argument.startsWith(TIMEOUT_ARG_PREFIX),
    );
    const timeoutValue = timeoutArgument?.slice(TIMEOUT_ARG_PREFIX.length);
    if (timeoutValue && !/^\d+$/.test(timeoutValue)) {
      throw new Error(`Invalid Vitest timeout: ${JSON.stringify(timeoutValue)}`);
    }
    const vitestTimeoutMs = timeoutValue
      ? Number(timeoutValue)
      : DEFAULT_VITEST_TIMEOUT_MS;
    if (vitestTimeoutMs < 1_000 || vitestTimeoutMs > DEFAULT_VITEST_TIMEOUT_MS) {
      throw new Error(
        `Vitest timeout must be between 1000 and ${DEFAULT_VITEST_TIMEOUT_MS}ms.`,
      );
    }

    const iteration = testInfo.repeatEachIndex + 1;
    const captureProcessSamples = testInfo.config.argv.includes(
      PROCESS_SAMPLES_ARG,
    );
    const logPath = testInfo.outputPath("vitest.log");
    const log = createWriteStream(logPath, { encoding: "utf8" });
    const before = await captureRelevantProcesses();
    log.write(`iteration=${iteration}\n`);
    log.write(`startedAt=${new Date().toISOString()}\n`);
    log.write(`playwrightBrowserName=${browserName}\n`);
    log.write(`availableParallelism=${os.availableParallelism()}\n`);
    log.write(`totalMemoryBytes=${os.totalmem()}\n`);
    log.write(`vitestTarget=${vitestTarget ?? "(full workspace)"}\n`);
    log.write(`vitestTimeoutMs=${vitestTimeoutMs}\n`);
    log.write(`processesBefore=${JSON.stringify(before)}\n`);
    log.write("\n===== pnpm test =====\n");

    const startedAt = Date.now();
    const vitestCommand = vitestTarget
      ? `pnpm test ${vitestTarget}`
      : "pnpm test";
    const child = spawn(vitestCommand, {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        PWRAGENT_WINDOWS_JOB_STARTUP_DIAGNOSTICS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Windows resolves pnpm through its .cmd shim. The target is validated
      // above before it is added to this constant shell command.
      shell: true,
      windowsHide: true,
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let processSampling = captureProcessSamples;
    const processSampler = (async () => {
      try {
        let previousSample = "";
        while (processSampling) {
          const sample = newlyRunningProcesses(
            before,
            await captureRelevantProcesses(),
          );
          const serialized = JSON.stringify(sample);
          if (serialized !== previousSample) {
            log.write(
              `processSample=${JSON.stringify({
                atMs: Date.now() - startedAt,
                processes: sample,
              })}\n`,
            );
            previousSample = serialized;
          }
          await wait(250);
        }
      } catch (error) {
        log.write(
          `processSamplingError=${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`,
        );
      }
    })();
    const childResult = new Promise<{
      code: number | null;
      error?: Error;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, error, signal: null }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const deadlineResult = await settleWithin(childResult, vitestTimeoutMs);
    const timedOut = deadlineResult.timedOut;
    let processesAtTimeout: ProcessSnapshotEntry[] = [];
    let result = deadlineResult.timedOut ? undefined : deadlineResult.value;
    let childExitObserved = Boolean(result);
    let residueClassified = true;
    let timeoutProcessSnapshotClassified = true;
    const captureForEvidence = async (label: string) => {
      try {
        return await captureRelevantProcesses();
      } catch (error) {
        residueClassified = false;
        log.write(
          `${label}Error=${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`,
        );
        return [];
      }
    };
    const captureOptionalTimeoutEvidence = async () => {
      try {
        return await captureRelevantProcesses();
      } catch (error) {
        timeoutProcessSnapshotClassified = false;
        log.write(
          `timeoutProcessSnapshotError=${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`,
        );
        return [];
      }
    };
    if (deadlineResult.timedOut) {
      // Start the optional snapshot, but do not await it before cleanup.
      // CIM enumeration can stall on the same degraded Windows host this
      // diagnostic is meant to recover, while taskkill is the ownership
      // boundary that must run promptly once Vitest exceeds its deadline.
      const timeoutSnapshot = captureOptionalTimeoutEvidence();
      if (child.pid) {
        try {
          const termination = await terminateProcessTree(child.pid);
          log.write(
            `processTreeTermination=${JSON.stringify({
              code: termination.code,
              signal: termination.signal,
              stderr: termination.stderr.trim(),
              stdout: termination.stdout.trim(),
            })}\n`,
          );
          if (termination.code !== 0) child.kill("SIGKILL");
        } catch (error) {
          log.write(
            `processTreeTerminationError=${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`,
          );
          child.kill("SIGKILL");
        }
      }
      processesAtTimeout = newlyRunningProcesses(
        before,
        await timeoutSnapshot,
      );
      log.write(
        `vitestTimeout=${JSON.stringify({
          atMs: Date.now() - startedAt,
          processes: processesAtTimeout,
          snapshotClassified: timeoutProcessSnapshotClassified,
          timeoutMs: vitestTimeoutMs,
        })}\n`,
      );
      const exitResult = await settleWithin(
        childResult,
        PROCESS_TREE_EXIT_TIMEOUT_MS,
      );
      if (!exitResult.timedOut) {
        result = exitResult.value;
        childExitObserved = true;
      }
    }
    processSampling = false;
    await processSampler;

    const immediate = await captureForEvidence("immediateProcessSnapshot");
    await wait(2_000);
    const settled = await captureForEvidence("settledProcessSnapshot");
    const leakedImmediately = newlyRunningProcesses(before, immediate);
    const leakedAfterTwoSeconds = newlyRunningProcesses(before, settled);
    const durationMs = Date.now() - startedAt;

    log.write("\n===== diagnostic summary =====\n");
    log.write(`finishedAt=${new Date().toISOString()}\n`);
    log.write(`durationMs=${durationMs}\n`);
    log.write(`timedOut=${String(timedOut)}\n`);
    log.write(`timeoutMs=${timedOut ? String(vitestTimeoutMs) : "null"}\n`);
    log.write(`processesAtTimeout=${JSON.stringify(processesAtTimeout)}\n`);
    log.write(`timeoutProcessSnapshotClassified=${String(timeoutProcessSnapshotClassified)}\n`);
    log.write(`childExitObserved=${String(childExitObserved)}\n`);
    log.write(`exitCode=${String(result?.code ?? null)}\n`);
    log.write(`signal=${String(result?.signal ?? null)}\n`);
    log.write(`spawnError=${JSON.stringify(result?.error?.message ?? null)}\n`);
    log.write(`processResidueClassified=${String(residueClassified)}\n`);
    log.write(`newProcessesImmediate=${JSON.stringify(leakedImmediately)}\n`);
    log.write(`newProcessesAfterTwoSeconds=${JSON.stringify(leakedAfterTwoSeconds)}\n`);
    await new Promise<void>((resolve, reject) => {
      log.once("error", reject);
      log.end(resolve);
    });
    await testInfo.attach("vitest log", {
      path: logPath,
      contentType: "text/plain",
    });

    console.log(
      [
        `Windows Vitest stress iteration ${iteration}:`,
        `exit=${String(result?.code ?? null)}`,
        `timedOut=${String(timedOut)}`,
        `durationMs=${durationMs}`,
        `persistentNewProcesses=${JSON.stringify(leakedAfterTwoSeconds)}`,
      ].join(" "),
    );

    if (timedOut) {
      throw new Error(
        `Windows Vitest stress iteration ${iteration} exceeded ${vitestTimeoutMs}ms; active processes before termination: ${JSON.stringify(processesAtTimeout)}`,
      );
    }
    if (result?.error) throw result.error;
    if (result?.code !== 0) {
      throw new Error(
        `Windows Vitest stress iteration ${iteration} exited ${String(result?.code)}.`,
      );
    }
    if (leakedAfterTwoSeconds.length > 0) {
      throw new Error(
        `Windows Vitest stress iteration ${iteration} left processes running: ${JSON.stringify(leakedAfterTwoSeconds)}`,
      );
    }
    if (!residueClassified) {
      throw new Error(
        `Windows Vitest stress iteration ${iteration} could not classify process residue.`,
      );
    }
  },
);
