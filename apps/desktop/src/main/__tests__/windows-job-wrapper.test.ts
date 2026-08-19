import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatWindowsJobStartupTelemetry,
  formatWindowsJobStartupTimeout,
  prewarmWindowsJobWrapper,
  readWindowsJobStartupTelemetry,
  startWindowsJobReadyPoll,
  type WindowsJobStartupTimeout,
  WINDOWS_JOB_OVERALL_READY_TIMEOUT_MS,
  WINDOWS_JOB_POWERSHELL_START_TIMEOUT_MS,
  WINDOWS_JOB_STARTUP_PROGRESS_TIMEOUT_MS,
  wrapCommandInWindowsJob,
} from "../windows-job-wrapper";
import { runGitCommand } from "../app-server/git-executable";
import { resolveWindowsBashShell } from "../windows-shell";

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

async function runWrappedCommand(params: {
  args: string[];
  command: string;
  cwd: string;
}): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  const wrapped = wrapCommandInWindowsJob({
    ...params,
    env: process.env,
  });
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(wrapped.command, wrapped.args, {
        cwd: params.cwd,
        env: wrapped.env,
        windowsHide: true,
      });
      let stderr = "";
      let stdout = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ code, stderr, stdout });
      });
    });
  } finally {
    wrapped.cleanup();
  }
}

describe("wrapCommandInWindowsJob", () => {
  it("bounds host launch, phase progress, and overall readiness", () => {
    expect(WINDOWS_JOB_POWERSHELL_START_TIMEOUT_MS).toBe(20_000);
    expect(WINDOWS_JOB_STARTUP_PROGRESS_TIMEOUT_MS).toBe(10_000);
    expect(WINDOWS_JOB_OVERALL_READY_TIMEOUT_MS).toBe(28_000);
    expect(WINDOWS_JOB_OVERALL_READY_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("launches the shell through an atomic kill-on-close Job wrapper", () => {
    const originalEnv = {
      PATH: "C:\\tools",
      SystemRoot: "C:\\Windows",
    };
    const command = [
      "set -e",
      'printf "quoted value"',
      "while true; do sleep 1; done",
    ].join("\n");

    const wrapped = wrapCommandInWindowsJob({
      args: ["-lc", command],
      command: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      cwd: "C:\\work tree",
      env: originalEnv,
    });

    expect(wrapped.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(wrapped.args.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
    const wrapperScript = readFileSync(wrapped.args.at(-1)!, "utf8");
    expect(wrapperScript).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(wrapperScript).toContain("CREATE_SUSPENDED | CREATE_NO_WINDOW");
    expect(wrapperScript).toContain("AssignProcessToJobObject");
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_EXECUTABLE).toBe(
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    );
    expect(
      JSON.parse(
        decodeBase64(wrapped.env.PWRAGENT_JOB_WRAPPER_ARGUMENTS!),
      ),
    ).toEqual([
      "-lc",
      [
        "trap 'pwragent_exit=$?; trap - EXIT; set +e; pwragent_exit_file=$(/usr/bin/cygpath.exe -u \"$PWRAGENT_JOB_WRAPPER_EXIT_FILE\"); if [ -n \"$pwragent_exit_file\" ]; then printf \"%s\" \"$pwragent_exit\" > \"$pwragent_exit_file\"; fi; exit \"$pwragent_exit\"' EXIT",
        command,
      ].join("\n"),
    ]);
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_CWD).toBe("C:\\work tree");
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_READY_FILE).toBe(
      wrapped.readyFilePath,
    );
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_EXIT_FILE).toMatch(
      /pwragent-windows-job-.*[\\/]exit$/,
    );
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_STARTUP_STATUS_FILE).toBe(
      wrapped.startupStatusFilePath,
    );
    expect(wrapped.env.PWRAGENT_JOB_WRAPPER_STARTED_AT).toBe(
      String(wrapped.startupStartedAt),
    );
    expect(readWindowsJobStartupTelemetry(wrapped)).toEqual({
      phases: [{ detail: undefined, elapsedMs: 0, phase: "wrapper-created" }],
    });
    expect(originalEnv).toEqual({
      PATH: "C:\\tools",
      SystemRoot: "C:\\Windows",
    });
    wrapped.cleanup();
  });

  it("preserves a native command's complete argument vector", () => {
    const args = [
      "-C",
      "C:\\repo with spaces",
      "worktree",
      "remove",
      "--force",
      "C:\\worktrees\\feature with spaces",
    ];
    const wrapped = wrapCommandInWindowsJob({
      args,
      command: "C:\\Program Files\\Git\\cmd\\git.exe",
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(
      JSON.parse(
        decodeBase64(wrapped.env.PWRAGENT_JOB_WRAPPER_ARGUMENTS!),
      ),
    ).toEqual(args);
    wrapped.cleanup();
  });

  it("honors journaled progress inside the overall readiness bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    const wrapped = wrapCommandInWindowsJob({
      args: ["/c", "exit 0"],
      command: "C:\\Windows\\System32\\cmd.exe",
      env: { SystemRoot: "C:\\Windows" },
    });
    let readyPoll: ReturnType<typeof startWindowsJobReadyPoll> | undefined;
    try {
      const telemetryPromise = new Promise<
        ReturnType<typeof readWindowsJobStartupTelemetry>
      >((resolve, reject) => {
        readyPoll = startWindowsJobReadyPoll({
          launch: wrapped,
          onReady: resolve,
          onTimeout: ({ stage }) =>
            reject(new Error(`Delayed readiness timed out during ${stage}`)),
          overallReadyTimeoutMs: 350,
          powershellStartTimeoutMs: 200,
          progressTimeoutMs: 100,
        });
      });
      await vi.advanceTimersByTimeAsync(150);
      appendFileSync(
        wrapped.startupStatusFilePath,
        "150\tpowershell-started\t\n170\thelper-compile-started\t\n",
      );
      await vi.advanceTimersByTimeAsync(90);
      appendFileSync(
        wrapped.startupStatusFilePath,
        "240\thelper-ready\t\n",
      );
      await vi.advanceTimersByTimeAsync(60);
      appendFileSync(
        wrapped.startupStatusFilePath,
        "300\ttarget-assigned\t\n",
      );
      await vi.advanceTimersByTimeAsync(20);
      appendFileSync(wrapped.startupStatusFilePath, "320\tready\t\n");
      writeFileSync(wrapped.readyFilePath, "ready", "utf8");
      await vi.advanceTimersByTimeAsync(5);
      const telemetry = await telemetryPromise;

      expect(telemetry.phases.map(({ phase }) => phase)).toEqual([
        "wrapper-created",
        "powershell-started",
        "helper-compile-started",
        "helper-ready",
        "target-assigned",
        "ready",
      ]);
      expect(formatWindowsJobStartupTelemetry(telemetry)).toBe(
        "wrapper-created@0ms -> powershell-started@150ms -> helper-compile-started@170ms -> helper-ready@240ms -> target-assigned@300ms -> ready@320ms",
      );
    } finally {
      readyPoll?.cancel();
      wrapped.cleanup();
      vi.useRealTimers();
    }
  });

  it("reports a PowerShell host-start timeout before wrapper code runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    const wrapped = wrapCommandInWindowsJob({
      args: ["/c", "exit 0"],
      command: "C:\\Windows\\System32\\cmd.exe",
      env: { SystemRoot: "C:\\Windows" },
    });
    try {
      const startupTimeoutPromise = new Promise<WindowsJobStartupTimeout>(
        (resolve, reject) => {
          startWindowsJobReadyPoll({
            launch: wrapped,
            onReady: () => reject(new Error("Unexpected readiness")),
            onTimeout: resolve,
            overallReadyTimeoutMs: 100,
            powershellStartTimeoutMs: 40,
            progressTimeoutMs: 100,
          });
        },
      );
      await vi.runAllTimersAsync();
      const startupTimeout = await startupTimeoutPromise;
      expect(startupTimeout).toMatchObject({
        stage: "powershell-start",
        timeoutMs: 40,
        telemetry: {
          phases: [{ elapsedMs: 0, phase: "wrapper-created" }],
        },
      });
      expect(formatWindowsJobStartupTimeout(startupTimeout)).toBe(
        "Windows Job PowerShell host did not begin executing within 40ms: wrapper-created@0ms",
      );
    } finally {
      wrapped.cleanup();
      vi.useRealTimers();
    }
  });

  it("reports the last startup phase when progress stalls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    const wrapped = wrapCommandInWindowsJob({
      args: ["/c", "exit 0"],
      command: "C:\\Windows\\System32\\cmd.exe",
      env: { SystemRoot: "C:\\Windows" },
    });
    try {
      appendFileSync(
        wrapped.startupStatusFilePath,
        "12\tpowershell-started\t\n18\thelper-compile-started\t\n",
      );
      const startupTimeoutPromise = new Promise<WindowsJobStartupTimeout>(
        (resolve, reject) => {
          startWindowsJobReadyPoll({
            launch: wrapped,
            onReady: () => reject(new Error("Unexpected readiness")),
            onTimeout: resolve,
            overallReadyTimeoutMs: 200,
            powershellStartTimeoutMs: 100,
            progressTimeoutMs: 40,
          });
        },
      );
      await vi.runAllTimersAsync();
      const startupTimeout = await startupTimeoutPromise;
      expect(startupTimeout).toMatchObject({
        stage: "progress-stall",
        timeoutMs: 40,
      });
      expect(startupTimeout.telemetry.phases.at(-1)).toMatchObject({
        elapsedMs: 18,
        phase: "helper-compile-started",
      });
      expect(formatWindowsJobStartupTimeout(startupTimeout)).toBe(
        "Windows Job startup made no progress for 40ms after helper-compile-started@18ms: wrapper-created@0ms -> powershell-started@12ms -> helper-compile-started@18ms",
      );
    } finally {
      wrapped.cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps progress extensions inside the overall readiness bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    const wrapped = wrapCommandInWindowsJob({
      args: ["/c", "exit 0"],
      command: "C:\\Windows\\System32\\cmd.exe",
      env: { SystemRoot: "C:\\Windows" },
    });
    try {
      appendFileSync(
        wrapped.startupStatusFilePath,
        "12\tpowershell-started\t\n18\thelper-compile-started\t\n25\thelper-ready\t\n",
      );
      const startupTimeoutPromise = new Promise<WindowsJobStartupTimeout>(
        (resolve, reject) => {
          startWindowsJobReadyPoll({
            launch: wrapped,
            onReady: () => reject(new Error("Unexpected readiness")),
            onTimeout: resolve,
            overallReadyTimeoutMs: 40,
            powershellStartTimeoutMs: 100,
            progressTimeoutMs: 100,
          });
        },
      );
      await vi.runAllTimersAsync();
      const startupTimeout = await startupTimeoutPromise;
      expect(startupTimeout).toMatchObject({
        stage: "overall-ready",
        timeoutMs: 40,
      });
      expect(formatWindowsJobStartupTimeout(startupTimeout)).toBe(
        "Windows Job shell ownership did not become ready within 40ms overall: wrapper-created@0ms -> powershell-started@12ms -> helper-compile-started@18ms -> helper-ready@25ms",
      );
    } finally {
      wrapped.cleanup();
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "executes a native command inside the Job",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "pwragent-windows-native-job-test-"),
      );
      try {
        const nativeResult = await runWrappedCommand({
          args: ["/c", "echo job-native"],
          command: path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "cmd.exe",
          ),
          cwd: root,
        });
        expect(nativeResult, nativeResult.stderr).toMatchObject({
          code: 0,
          stderr: "",
        });
        expect(nativeResult.stdout).toContain("job-native");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "executes Git inside the Job",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "pwragent-windows-git-job-test-"),
      );
      try {
        const gitResult = await runGitCommand(root, ["init", "-b", "main"], {
          ownProcessTree: true,
        });
        expect(gitResult.stderr).toBe("");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "executes Git Bash inside the Job",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "pwragent-windows-bash-job-test-"),
      );
      try {
        const bashResult = await runWrappedCommand({
          args: [
            "-lc",
            [
              '[ -s "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
              '[ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
              '[ -z "${NVM_DIR:-}" ] && [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"',
              "set -e",
              ": pwragent-env-integration-test",
              'printf "job-bash"',
            ].join("\n"),
          ],
          command: resolveWindowsBashShell(),
          cwd: root,
        });
        expect(bashResult, bashResult.stderr).toMatchObject({
          code: 0,
          stderr: "",
          stdout: "job-bash",
        });
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "preserves a nonzero Git Bash exit through the status side channel",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "pwragent-windows-job-exit-test-"),
      );
      try {
        const result = await runWrappedCommand({
          args: ["-lc", 'printf "job-bash-failure"; exit 23'],
          command: resolveWindowsBashShell(),
          cwd: root,
        });
        expect(result, result.stderr).toMatchObject({
          code: 23,
          stderr: "",
          stdout: "job-bash-failure",
        });
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    30_000,
  );
});

describe("prewarmWindowsJobWrapper", () => {
  // The prewarm exists to move a cold start, so it must never become a failure
  // path of its own: a machine without `SystemRoot`, a PowerShell that will not
  // launch, and a healthy Windows host all have to settle the same way.
  it(
    "shares one best-effort attempt across callers",
    async () => {
      const attempt = prewarmWindowsJobWrapper();

      expect(prewarmWindowsJobWrapper()).toBe(attempt);
      await expect(attempt).resolves.toBeUndefined();
    },
    60_000,
  );

  // Startup discards this promise with `void`, and a rejection before the main
  // window appears is reported as a fatal boot failure. A host that cannot hand
  // out a temp directory must therefore cost a cold launch, not a startup that
  // refuses to continue.
  it("settles when the wrapper cannot create its state directory", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    vi.stubEnv("SystemRoot", String.raw`C:\Windows`);
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        default: actual,
        mkdtempSync: () => {
          throw new Error("no writable temp directory");
        },
      };
    });

    try {
      const { prewarmWindowsJobWrapper: prewarmWithBrokenTemp } =
        await import("../windows-job-wrapper");

      await expect(prewarmWithBrokenTemp()).resolves.toBeUndefined();
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      vi.unstubAllEnvs();
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });
});
