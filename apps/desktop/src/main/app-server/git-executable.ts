import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { gitCandidateInputs } from "../settings/git-discovery";
import { wrapCommandInWindowsJob } from "../windows-job-wrapper";

const execFile = promisify(execFileCallback);

const resolvedGitExecutableByEnv = new Map<string, string>();
const resolvingGitExecutableByEnv = new Map<string, Promise<string>>();

function gitExecutableCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = gitCandidateInputs(env).flatMap((candidate) => {
    const normalized = candidate.command?.trim();
    return normalized ? [normalized] : [];
  });
  return [...new Set(candidates)];
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
          resolvedGitExecutableByEnv.set(cacheKey, candidate);
          return candidate;
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
