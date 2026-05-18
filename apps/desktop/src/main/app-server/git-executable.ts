import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { gitCandidateInputs } from "../settings/git-discovery";

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

export async function resolveGitExecutable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const cacheKey = gitResolutionCacheKey(env);
  const resolved = resolvedGitExecutableByEnv.get(cacheKey);
  if (resolved) {
    return resolved;
  }

  let resolving = resolvingGitExecutableByEnv.get(cacheKey);
  if (!resolving) {
    resolving = (async () => {
      const failures: string[] = [];
      for (const candidate of gitExecutableCandidates(env)) {
        const result = await canRunGit(candidate, env);
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
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const env = options.env ?? process.env;
  const git = await resolveGitExecutable(env);
  const { stdout, stderr } = await execFile(git, ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
  });
  return {
    stdout: stdout.trim(),
    stderr: (stderr ?? "").trim(),
  };
}
