import { execFile as execFileCallback, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { noteBundledGitCommand } from "../bundled-git-lfs-advisory";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { gitRuntimeEnvironment, resolveRuntimeGitExecutable } from "../git-runtime";
import { formatWindowsJobStartupTimeout, startWindowsJobReadyPoll, windowsJobCleanupVerified, wrapCommandInWindowsJob } from "../windows-job-wrapper";
import { windowsJobLauncherPath } from "../windows-job-launcher-path";
import { terminateOwnedProcessTree } from "../process-tree";
import { gitSubprocessDiagnostics, type GitSubprocessPurpose } from "../diagnostics/git-subprocess-diagnostics";

const execFile = promisify(execFileCallback);

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...gitRuntimeEnvironment(buildPwrAgentChildProcessEnv(env)),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
}

export async function resolveGitExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return await resolveRuntimeGitExecutable(env);
}

export async function runGitCommand(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    ownProcessTree?: boolean;
    timeout?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
    input?: string;
    beforeSpawn?: (executable: string) => void;
    purpose?: GitSubprocessPurpose;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const env = gitEnvironment(options.env ?? process.env);
  options.signal?.throwIfAborted();
  const git = await resolveGitExecutable(options.env ?? process.env);
  // Admission must survive the executable resolver's asynchronous boundary.
  options.beforeSpawn?.(git);
  options.signal?.throwIfAborted();
  const gitArgs = ["-C", cwd, ...args];
  const windowsJobLaunch =
    process.platform === "win32" && options.ownProcessTree
      ? wrapCommandInWindowsJob({
          args: gitArgs,
          command: git,
          env,
          cwd: os.tmpdir(),
          keepDrainEvidenceOnStop: true,
          compiledLauncher: options.purpose === "stack-checkout" || options.purpose === "stack-status"
            ? windowsJobLauncherPath() : undefined,
        })
      : undefined;
  const launch = windowsJobLaunch ?? {
    args: gitArgs,
    command: git,
    env,
  };

  const finishDiagnostic = gitSubprocessDiagnostics.startGit(cwd, args, options.purpose);
  let failed = true;
  try {
    if (options.ownProcessTree) {
      const result = await runOwnedGitProcess({
        launch,
        windowsJob: windowsJobLaunch,
        input: options.input,
        maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
        signal: options.signal,
        timeout: options.timeout ?? 120_000,
      });
      failed = false;
      return result;
    }
    const execution = execFile(launch.command, launch.args, {
      encoding: "utf8",
      env: launch.env,
      cwd: os.tmpdir(),
      windowsHide: true,
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
      signal: options.signal,
    });
    // Git may exit before reading all revision exclusions. EPIPE is expected
    // then; other stdin failures must not become unhandled process errors.
    execution.child?.stdin?.on("error", () => undefined);
    execution.child?.stdin?.end(options.input);
    const { stdout, stderr } = await execution;
    failed = false;
    return {
      stdout,
      stderr: stderr ?? "",
    };
  } finally {
    finishDiagnostic(failed);
    windowsJobLaunch?.cleanup();
    // After the command: a checkout installs the Git LFS hooks it warns about.
    noteBundledGitCommand(cwd, args, options.env ?? process.env);
  }
}

/**
 * Run Git as an owned process tree: a POSIX process group, or a Windows Job.
 * execFile cannot start a process group, and its abort settles as soon as it
 * sends the kill, while Git, or a Git for Windows descendant, can still hold
 * `cwd` open. Here a timeout, an output overflow, or an abort stops the whole
 * tree, and the run settles once no process in it is left. Failures keep
 * execFile's error shape.
 */
async function runOwnedGitProcess(params: {
  launch: { command: string; args: string[]; env: NodeJS.ProcessEnv };
  windowsJob?: ReturnType<typeof wrapCommandInWindowsJob>;
  input?: string;
  maxBuffer: number;
  signal?: AbortSignal;
  timeout: number;
}): Promise<{ stdout: string; stderr: string }> {
  const { launch, signal, windowsJob } = params;
  const cmd = [launch.command, ...launch.args].join(" ");
  const child = spawn(launch.command, launch.args, {
    env: launch.env,
    cwd: os.tmpdir(),
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let termination: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let forceStop: NodeJS.Timeout | undefined;
    let readyPoll: ReturnType<typeof startWindowsJobReadyPoll> | undefined;
    const cancelDeadline = () => {
      clearTimeout(timer);
      readyPoll?.cancel();
    };
    const stop = (reason: Error) => {
      if (failure) return;
      cancelDeadline();
      failure = reason;
      if (!windowsJob) {
        termination = terminateOwnedProcessTree(child, { gracefulTimeoutMs: 250, forceTimeoutMs: 1_000 });
        // Awaited once Git closes; a failure before then is not unhandled.
        termination.catch(() => undefined);
      } else if (child.pid && child.exitCode === null && child.signalCode === null) {
        // The Job wrapper can stop and drain its descendants without a process
        // snapshot. An unresponsive wrapper is still fenced by KILL_ON_JOB_CLOSE.
        try {
          if (!windowsJob.requestStop) throw new Error("Windows Git Job has no stop channel.");
          windowsJob.requestStop();
          forceStop = setTimeout(() => child.kill("SIGKILL"), 3_000);
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const onAbort = () => stop(Object.assign(
      new Error("The operation was aborted", { cause: signal?.reason }),
      { name: "AbortError", code: "ABORT_ERR" },
    ));
    const timedOut = (message: string) => stop(Object.assign(new Error(message), {
      killed: true, code: null, signal: "SIGTERM", cmd,
    }));
    const startCommandTimeout = () => {
      timer = setTimeout(() => timedOut(`Command failed: ${cmd}`), params.timeout);
    };
    // Job startup has its own progress-aware deadline. Start the command's
    // timeout only once the Job has launched its target.
    if (windowsJob) {
      readyPoll = startWindowsJobReadyPoll({
        launch: windowsJob,
        onReady: startCommandTimeout,
        onTimeout: (timeout) => timedOut(formatWindowsJobStartupTimeout(timeout)),
      });
    } else {
      startCommandTimeout();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (stream: "stdout" | "stderr", chunk: string) => {
      const text = (stream === "stdout" ? stdout : stderr) + chunk;
      const kept = text.length > params.maxBuffer ? text.slice(0, params.maxBuffer) : text;
      if (stream === "stdout") stdout = kept;
      else stderr = kept;
      if (kept !== text) {
        stop(Object.assign(
          new RangeError(`${stream} maxBuffer length exceeded`),
          { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", cmd },
        ));
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: string) => collect("stderr", chunk));
    // Git may exit before reading all revision exclusions. EPIPE is expected
    // then; other stdin failures must not become unhandled process errors.
    child.stdin.on("error", () => undefined);
    child.stdin.end(params.input);
    const finish = () => {
      cancelDeadline();
      clearTimeout(forceStop);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      if (child.pid !== undefined) return void stop(error);
      // Git never started, so there is no tree to wait for.
      finish();
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      finish();
      void (async () => {
        await termination;
        if (failure && windowsJob && child.pid && !windowsJobCleanupVerified(windowsJob)) {
          throw new Error("The Windows Git Job exited without confirming cleanup.", { cause: failure });
        }
        if (failure) throw Object.assign(failure, { stdout, stderr });
        if (code !== 0) {
          throw Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
            code, killed: false, signal: exitSignal, cmd, stdout, stderr,
          });
        }
        return { stdout, stderr };
      })().then(resolve, reject);
    });
  });
}

/**
 * `runGitCommand` for a command whose stdout is bytes rather than text — a
 * blob read with `cat-file blob`. Decoding an image as utf8 replaces every
 * invalid sequence, so the text runner cannot be reused for this.
 */
export async function runGitCommandBinary(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<Buffer> {
  const env = gitEnvironment(options.env ?? process.env);
  const git = await resolveGitExecutable(options.env ?? process.env);
  const finishDiagnostic = gitSubprocessDiagnostics.startGit(cwd, args);
  let failed = true;
  try {
    const { stdout } = await execFile(git, ["-C", cwd, ...args], {
      encoding: "buffer",
      env,
      cwd: os.tmpdir(),
      windowsHide: true,
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
    });
    failed = false;
    return stdout;
  } finally {
    finishDiagnostic(failed);
    noteBundledGitCommand(cwd, args, options.env ?? process.env);
  }
}

/** Bounded metadata streams retain only what their consumer accepts. Returning
 * false stops the owned process tree, and completion waits for cleanup. */
export async function streamGitCommand(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout: number;
    onStdout: (chunk: string) => boolean;
  },
): Promise<{ stopped: boolean }> {
  const env = gitEnvironment(options.env ?? process.env);
  const command = await resolveGitExecutable(options.env ?? process.env);
  const gitArgs = ["-C", cwd, ...args];
  const job = process.platform === "win32"
    ? wrapCommandInWindowsJob({ command, args: gitArgs, env, cwd: os.tmpdir() })
    : undefined;
  const finishDiagnostic = gitSubprocessDiagnostics.startGit(cwd, args);
  let failed = true;
  try {
    const result = await new Promise<{ stopped: boolean }>((resolve, reject) => {
      const child = spawn(job?.command ?? command, job?.args ?? gitArgs, {
        env: job?.env ?? env,
        cwd: os.tmpdir(),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stopped = false;
      let consumerError: unknown;
      let termination: Promise<void> | undefined;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        // Windows owns descendants atomically in the Job, so killing the
        // launcher closes that Job. POSIX uses the dedicated process group.
        termination = process.platform === "win32"
          ? Promise.resolve().then(() => { child.kill(); })
          : terminateOwnedProcessTree(child, { gracefulTimeoutMs: 250, forceTimeoutMs: 1_000 });
        void termination.catch(reject);
      };
      let timer: NodeJS.Timeout | undefined;
      // The metadata budget begins when Git is running. PowerShell startup has
      // its own existing, progress-aware deadline rather than consuming it.
      const readyPoll = job ? startWindowsJobReadyPoll({
        launch: job,
        onReady: () => { timer = setTimeout(stop, options.timeout); },
        onTimeout: stop,
      }) : undefined;
      if (!job) timer = setTimeout(stop, options.timeout);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stopped) return;
        try {
          if (!options.onStdout(chunk)) stop();
        } catch (error) {
          consumerError = error;
          stop();
        }
      });
      // Always drain stderr, including after truncation, to avoid pipe blockage.
      child.stderr.resume();
      child.once("error", (error) => {
        clearTimeout(timer);
        readyPoll?.cancel();
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        readyPoll?.cancel();
        void (async () => {
          await termination;
          if (consumerError) throw consumerError;
          if (!stopped && code !== 0) throw new Error(`git exited with code ${code}`);
          resolve({ stopped });
        })().catch(reject);
      });
    });
    failed = false;
    return result;
  } finally {
    finishDiagnostic(failed);
    job?.cleanup();
    noteBundledGitCommand(cwd, args, options.env ?? process.env);
  }
}
