import { execFile as execFileCallback, spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { getConfiguredGitCommand } from "../git-command";
import { gitCandidateInputs } from "../settings/git-discovery";
import { startWindowsJobReadyPoll, wrapCommandInWindowsJob } from "../windows-job-wrapper";
import { terminateOwnedProcessTree } from "../process-tree";

const execFile = promisify(execFileCallback);

const resolvedGitExecutableByEnv = new Map<string, string>();
const resolvingGitExecutableByEnv = new Map<string, Promise<string>>();

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...buildPwrAgentChildProcessEnv(env),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
}

/**
 * Ordered git candidates: the `PWRAGENT_GIT_PATH` override first (it is
 * the `env`-sourced entry `gitCandidateInputs` contributes), then the
 * operator's configured path, then the well-known locations. Config sits
 * behind env so the two
 * rank the same way here, in `discoverGitCommands`, and in the Settings
 * pane that shows the result.
 *
 * The configured path also participates in the resolution cache key, so
 * changing it in Settings invalidates a previously resolved executable
 * rather than being masked by it.
 */
function gitExecutableCandidates(env: NodeJS.ProcessEnv): string[] {
  const inputs = gitCandidateInputs(env);
  const normalize = (command: string | undefined): string | undefined =>
    command?.trim() || undefined;
  const envOverride = normalize(
    inputs.find((candidate) => candidate.source === "env")?.command,
  );
  const wellKnown = inputs
    .filter((candidate) => candidate.source !== "env")
    .flatMap((candidate) => {
      const command = normalize(candidate.command);
      return command ? [command] : [];
    });

  return [
    ...new Set(
      [envOverride, getConfiguredGitCommand(), ...wellKnown].filter(
        (command): command is string => Boolean(command),
      ),
    ),
  ];
}

function readPathEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== "win32") {
    return env.PATH;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return pathKey ? env[pathKey] : undefined;
}

function gitResolutionCacheKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({
    candidates: gitExecutableCandidates(env),
    path: readPathEnv(env),
  });
}

function errorText(error: unknown): string {
  const parts = [error instanceof Error ? error.message : String(error)];
  const stderr = (error as { stderr?: unknown })?.stderr;
  if (typeof stderr === "string" && stderr.trim()) {
    parts.push(stderr.trim());
  }
  return parts.join("\n");
}

async function canRunGit(
  candidate: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execFile(candidate, ["--version"], {
      encoding: "utf8",
      env,
      timeout: 2_000,
      windowsHide: true,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function resolveWindowsJobExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (path.win32.isAbsolute(command)) {
    return command;
  }

  const systemRoot = Object.entries(env).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  const where = systemRoot
    ? path.win32.join(systemRoot, "System32", "where.exe")
    : "where.exe";
  const { stdout } = await execFile(where, [command], {
    encoding: "utf8",
    env,
    timeout: 2_000,
    windowsHide: true,
  });
  const resolved = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => path.win32.isAbsolute(candidate));
  if (!resolved) {
    throw new Error(`Unable to resolve an absolute executable path for ${command}.`);
  }
  return resolved;
}

async function resolvePosixExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (path.isAbsolute(command)) {
    return path.normalize(command);
  }
  if (command.includes(path.sep)) {
    const absolute = path.resolve(command);
    const result = await canRunGit(absolute, env);
    if (result.ok) {
      return absolute;
    }
    throw new Error(result.error);
  }

  for (const pathEntry of (readPathEnv(env) ?? "").split(path.delimiter)) {
    const candidate = path.resolve(pathEntry || process.cwd(), command);
    const result = await canRunGit(candidate, env);
    if (result.ok) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve an absolute executable path for ${command}.`);
}

async function resolveExecutableAbsolutePath(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return process.platform === "win32"
    ? await resolveWindowsJobExecutable(command, env)
    : await resolvePosixExecutable(command, env);
}

export async function resolveGitExecutable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const childEnv = buildPwrAgentChildProcessEnv(env);
  const cacheKey = gitResolutionCacheKey(childEnv);
  const resolved = resolvedGitExecutableByEnv.get(cacheKey);
  if (resolved) {
    return resolved;
  }

  let resolving = resolvingGitExecutableByEnv.get(cacheKey);
  if (!resolving) {
    resolving = (async () => {
      const failures: string[] = [];
      for (const candidate of gitExecutableCandidates(childEnv)) {
        const result = await canRunGit(candidate, childEnv);
        if (result.ok) {
          try {
            const absolute = await resolveExecutableAbsolutePath(
              candidate,
              childEnv,
            );
            resolvedGitExecutableByEnv.set(cacheKey, absolute);
            return absolute;
          } catch (error) {
            failures.push(`${candidate}: ${errorText(error)}`);
            continue;
          }
        }
        failures.push(`${candidate}: ${result.error}`);
      }

      throw new Error(`Git executable unavailable. Tried:\n${failures.join("\n")}`);
    })().finally(() => {
      resolvingGitExecutableByEnv.delete(cacheKey);
    });
    resolvingGitExecutableByEnv.set(cacheKey, resolving);
  }

  return await resolving;
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
  const jobExecutable =
    process.platform === "win32" && options.ownProcessTree
      ? await resolveWindowsJobExecutable(git, env)
      : git;
  const windowsJobLaunch =
    process.platform === "win32" && options.ownProcessTree
      ? wrapCommandInWindowsJob({
          args: gitArgs,
          command: jobExecutable,
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
