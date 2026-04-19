import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LinkedDirectorySummary } from "@pwragnt/shared";

const execFile = promisify(execFileCallback);

export type ThreadDirectoryEnrichment = {
  linkedDirectories: LinkedDirectorySummary[];
  observedGitBranch?: string;
};

type CachedEnrichment = {
  expiresAt: number;
  inFlight?: Promise<ThreadDirectoryEnrichment>;
  value?: ThreadDirectoryEnrichment;
};

async function runGit(projectKey: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", projectKey, ...args], {
    env: process.env,
  });
  return result.stdout.trim();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseGitWorktrees(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

function findContainingWorktree(
  currentPath: string,
  worktreePaths: string[],
): string | undefined {
  const matches = worktreePaths
    .map((worktreePath) => path.resolve(worktreePath))
    .filter(
      (worktreePath) =>
        currentPath === worktreePath || currentPath.startsWith(`${worktreePath}${path.sep}`),
    )
    .sort((left, right) => right.length - left.length);

  return matches[0];
}

async function loadThreadDirectoryEnrichment(
  projectKey?: string,
): Promise<ThreadDirectoryEnrichment> {
  if (!projectKey?.trim()) {
    return { linkedDirectories: [] };
  }

  const currentPath = path.resolve(projectKey.trim());
  if (!(await pathExists(currentPath))) {
    return { linkedDirectories: [] };
  }

  try {
    const [repoRoot, worktreeList, observedGitBranch] = await Promise.all([
      runGit(currentPath, ["rev-parse", "--show-toplevel"]),
      runGit(currentPath, ["worktree", "list", "--porcelain"]),
      runGit(currentPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined),
    ]);
    const worktreePaths = parseGitWorktrees(worktreeList);
    const primaryPath = path.resolve(worktreePaths[0] || repoRoot);
    const currentWorktreePath =
      findContainingWorktree(currentPath, worktreePaths) ?? path.resolve(repoRoot);
    const isWorktree = currentWorktreePath !== primaryPath;

    return {
      linkedDirectories: [
        {
          id: primaryPath,
          path: primaryPath,
          worktreePath: isWorktree ? currentWorktreePath : undefined,
          label: path.basename(primaryPath) || primaryPath,
          kind: isWorktree ? "worktree" : "local",
        },
      ],
      observedGitBranch: observedGitBranch?.trim() || undefined,
    };
  } catch {
    const fallbackPath = path.resolve(currentPath);
    return {
      linkedDirectories: [
        {
          id: fallbackPath,
          path: fallbackPath,
          label: path.basename(fallbackPath) || fallbackPath,
          kind: "local",
        },
      ],
    };
  }
}

export function createThreadDirectoryEnricher(params?: {
  cacheTtlMs?: number;
}): (projectKey?: string) => Promise<ThreadDirectoryEnrichment> {
  const cacheTtlMs = params?.cacheTtlMs ?? 5_000;
  const cache = new Map<string, CachedEnrichment>();

  return async (projectKey?: string): Promise<ThreadDirectoryEnrichment> => {
    const normalizedKey = projectKey?.trim();
    if (!normalizedKey) {
      return { linkedDirectories: [] };
    }

    const now = Date.now();
    const cached = cache.get(normalizedKey);
    if (cached?.inFlight) {
      return await cached.inFlight;
    }
    if (cached?.value && cached.expiresAt > now) {
      return cached.value;
    }

    const inFlight = loadThreadDirectoryEnrichment(normalizedKey)
      .then((value) => {
        cache.set(normalizedKey, {
          expiresAt: Date.now() + cacheTtlMs,
          value,
        });
        return value;
      })
      .catch((error) => {
        cache.delete(normalizedKey);
        throw error;
      });

    cache.set(normalizedKey, {
      expiresAt: cached?.expiresAt ?? 0,
      inFlight,
      value: cached?.value,
    });

    return await inFlight;
  };
}
