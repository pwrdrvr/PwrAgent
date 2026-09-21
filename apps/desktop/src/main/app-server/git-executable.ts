import { execFile as execFileCallback, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { bundledGitEnvironment, validateBundledGit } from "../bundled-git";
import { startWindowsJobReadyPoll, wrapCommandInWindowsJob } from "../windows-job-wrapper";
import { terminateOwnedProcessTree } from "../process-tree";

const execFile = promisify(execFileCallback);

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...bundledGitEnvironment(buildPwrAgentChildProcessEnv(env)),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
}

export async function resolveGitExecutable(_env?: NodeJS.ProcessEnv): Promise<string> {
  return await validateBundledGit();
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
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const env = gitEnvironment(options.env ?? process.env);
  options.signal?.throwIfAborted();
  const git = await resolveGitExecutable(env);
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
  const command = await resolveGitExecutable(env);
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
  }
}
