import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

const STRESS_ARG = "--pwragent-vitest-stress";
const PROCESS_SAMPLES_ARG = "--pwragent-vitest-process-samples";
const TARGET_ARG_PREFIX = "--pwragent-vitest-target=";
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
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr, stdout });
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
  ]);
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

test.skip(
  process.platform !== "win32",
  "This diagnostic exercises the native Windows Vitest shutdown path.",
);

test(
  "runs one complete Windows Vitest workspace iteration @windows-vitest-stress",
  async ({ browserName }, testInfo) => {
    test.setTimeout(20 * 60 * 1_000);
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
    })();
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    processSampling = false;
    await processSampler;

    const immediate = await captureRelevantProcesses();
    await wait(2_000);
    const settled = await captureRelevantProcesses();
    const leakedImmediately = newlyRunningProcesses(before, immediate);
    const leakedAfterTwoSeconds = newlyRunningProcesses(before, settled);
    const durationMs = Date.now() - startedAt;

    log.write("\n===== diagnostic summary =====\n");
    log.write(`finishedAt=${new Date().toISOString()}\n`);
    log.write(`durationMs=${durationMs}\n`);
    log.write(`exitCode=${String(result.code)}\n`);
    log.write(`signal=${String(result.signal)}\n`);
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
        `exit=${String(result.code)}`,
        `durationMs=${durationMs}`,
        `persistentNewProcesses=${JSON.stringify(leakedAfterTwoSeconds)}`,
      ].join(" "),
    );

    if (result.code !== 0) {
      throw new Error(
        `Windows Vitest stress iteration ${iteration} exited ${String(result.code)}.`,
      );
    }
    if (leakedAfterTwoSeconds.length > 0) {
      throw new Error(
        `Windows Vitest stress iteration ${iteration} left processes running: ${JSON.stringify(leakedAfterTwoSeconds)}`,
      );
    }
  },
);
