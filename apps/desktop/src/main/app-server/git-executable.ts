import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { gitCandidateInputs } from "../settings/git-discovery";

const execFile = promisify(execFileCallback);

let resolvedGitExecutable: string | undefined;
let resolvingGitExecutable: Promise<string> | undefined;

function gitExecutableCandidates(): string[] {
  const candidates = gitCandidateInputs(process.env).flatMap((candidate) => {
    const normalized = candidate.command?.trim();
    return normalized ? [normalized] : [];
  });
  return [...new Set(candidates)];
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execFile(candidate, ["--version"], {
      encoding: "utf8",
      env: process.env,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export async function resolveGitExecutable(): Promise<string> {
  if (resolvedGitExecutable) {
    return resolvedGitExecutable;
  }

  resolvingGitExecutable ??= (async () => {
    const failures: string[] = [];
    for (const candidate of gitExecutableCandidates()) {
      const result = await canRunGit(candidate);
      if (result.ok) {
        resolvedGitExecutable = candidate;
        return candidate;
      }
      failures.push(`${candidate}: ${result.error}`);
    }

    throw new Error(`Git executable unavailable. Tried:\n${failures.join("\n")}`);
  })().finally(() => {
    resolvingGitExecutable = undefined;
  });

  return await resolvingGitExecutable;
}

export async function runGitCommand(cwd: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
}> {
  const git = await resolveGitExecutable();
  const { stdout, stderr } = await execFile(git, ["-C", cwd, ...args], {
    encoding: "utf8",
    env: process.env,
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}
