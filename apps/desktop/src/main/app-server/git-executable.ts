import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { noteBundledGitCommand } from "../bundled-git-lfs-advisory";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { gitRuntimeEnvironment, resolveRuntimeGitExecutable } from "../git-runtime";
import { startWindowsJobReadyPoll, wrapCommandInWindowsJob } from "../windows-job-wrapper";
import { collectProcessTreeIds, terminateOwnedProcessTree, waitForProcessTreeGone } from "../process-tree";

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
    beforeSpawn?: () => void;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const env = gitEnvironment(options.env ?? process.env);
  options.signal?.throwIfAborted();
  const git = await resolveGitExecutable(options.env ?? process.env);
  // Admission must survive the executable resolver's asynchronous boundary.
  options.beforeSpawn?.();
  options.signal?.throwIfAborted();
  const gitArgs = ["-C", cwd, ...args];
  const windowsJobLaunch =
    process.platform === "win32" && options.ownProcessTree
      ? wrapCommandInWindowsJob({
          args: gitArgs,
          command: git,
          env,
          cwd: os.tmpdir(),
        })
      : undefined;
  const launch = windowsJobLaunch ?? {
    args: gitArgs,
    command: git,
    env,
  };

  try {
    if (options.ownProcessTree) {
      return await runOwnedGitProcess({
        launch,
        input: options.input,
        maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
        signal: options.signal,
        timeout: options.timeout ?? 120_000,
      });
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
    return {
      stdout,
      stderr: stderr ?? "",
    };
  } finally {
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
  input?: string;
  maxBuffer: number;
  signal?: AbortSignal;
  timeout: number;
}): Promise<{ stdout: string; stderr: string }> {
  const { launch, signal } = params;
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
    const stop = (reason: Error) => {
      if (termination) return;
      failure = reason;
      termination = stopOwnedGitProcessTree(child);
      // Awaited once Git closes; a failure before then is not unhandled.
      termination.catch(() => undefined);
    };
    const onAbort = () => stop(Object.assign(
      new Error("The operation was aborted", { cause: signal?.reason }),
      { name: "AbortError", code: "ABORT_ERR" },
    ));
    const timer = setTimeout(() => stop(Object.assign(
      new Error(`Command failed: ${cmd}`),
      { killed: true, code: null, signal: "SIGTERM", cmd },
    )), params.timeout);
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
      clearTimeout(timer);
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
 * Stop an owned Git run, and wait until no process in it is left. POSIX
 * signals Git's process group. On Windows, killing the Job launcher closes the
 * Job, but its processes release their handles a moment after the launcher
 * exits, and orphans no longer list it as their parent, so they are listed
 * before the kill.
 */
async function stopOwnedGitProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    await terminateOwnedProcessTree(child, { gracefulTimeoutMs: 250, forceTimeoutMs: 1_000 });
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const knownPids = collectProcessTreeIds(child.pid);
  child.kill();
  if (!await waitForProcessTreeGone({ knownPids, timeoutMs: 5_000 })) {
    throw new Error(`Git process tree ${child.pid} did not exit after it was stopped.`);
  }
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
  try {
    const { stdout } = await execFile(git, ["-C", cwd, ...args], {
      encoding: "buffer",
      env,
      cwd: os.tmpdir(),
      windowsHide: true,
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
    });
    return stdout;
  } finally {
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
  try {
    return await new Promise((resolve, reject) => {
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
  } finally {
    job?.cleanup();
    noteBundledGitCommand(cwd, args, options.env ?? process.env);
  }
}
