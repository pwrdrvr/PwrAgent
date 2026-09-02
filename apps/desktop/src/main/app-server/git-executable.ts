import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { getConfiguredGitCommand } from "../git-command";
import { gitCandidateInputs } from "../settings/git-discovery";
import { wrapCommandInWindowsJob } from "../windows-job-wrapper";

const execFile = promisify(execFileCallback);

const resolvedGitExecutableByEnv = new Map<string, string>();
const resolvingGitExecutableByEnv = new Map<string, Promise<string>>();

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
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const env = buildPwrAgentChildProcessEnv(options.env ?? process.env);
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
        })
      : undefined;
  const launch = windowsJobLaunch ?? {
    args: gitArgs,
    command: git,
    env,
  };

  try {
    const { stdout, stderr } = await execFile(launch.command, launch.args, {
      encoding: "utf8",
      env: launch.env,
      maxBuffer: 1024 * 1024 * 10,
    });
    return {
      stdout: stdout.trim(),
      stderr: (stderr ?? "").trim(),
    };
  } finally {
    windowsJobLaunch?.cleanup();
  }
}
