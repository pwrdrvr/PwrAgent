import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LinkedDirectorySummary } from "@pwragent/shared";
import { isToolManagedWorktreePath } from "@pwragent/shared";
import { getMainLogger } from "../log";

const execFile = promisify(execFileCallback);
const threadDirectoryLog = getMainLogger("pwragent:thread-directory-enricher");

export type ThreadDirectoryEnrichment = {
  linkedDirectories: LinkedDirectorySummary[];
  observedGitBranch?: string;
};

type CachedEnrichment = {
  expiresAt: number;
  inFlight?: Promise<ThreadDirectoryEnrichment>;
  value?: ThreadDirectoryEnrichment;
};

type GitMetadataEvidence = {
  dotGitKind: "directory" | "file" | "missing" | "unreadable";
  dotGitPath?: string;
  gitdirPath?: string;
  gitdirParentName?: string;
  inferredRepositoryPath?: string;
  inferredWorktreeAdminName?: string;
  error?: string;
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

async function findDotGitPath(startPath: string): Promise<string | undefined> {
  let currentPath = path.resolve(startPath);

  while (true) {
    const dotGitPath = path.join(currentPath, ".git");
    if (await pathExists(dotGitPath)) {
      return dotGitPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

function inferRepositoryFromGitdir(gitdirPath: string): {
  inferredRepositoryPath?: string;
  inferredWorktreeAdminName?: string;
} {
  const normalized = path.resolve(gitdirPath).replace(/[\\/]+$/, "");
  const match = normalized.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/]([^\\/]+)$/);
  if (!match) {
    return {};
  }

  return {
    inferredRepositoryPath: path.resolve(match[1]),
    inferredWorktreeAdminName: match[2],
  };
}

async function readGitMetadataEvidence(
  currentPath: string,
): Promise<GitMetadataEvidence> {
  const dotGitPath = await findDotGitPath(currentPath);
  if (!dotGitPath) {
    return { dotGitKind: "missing" };
  }

  try {
    const dotGitContent = await readFile(dotGitPath, "utf8");
    const gitdirMatch = dotGitContent.match(/^gitdir:\s*(.+?)\s*$/m);
    const gitdirPath = gitdirMatch
      ? path.resolve(path.dirname(dotGitPath), gitdirMatch[1])
      : undefined;
    const inferred = gitdirPath ? inferRepositoryFromGitdir(gitdirPath) : {};

    return {
      dotGitKind: "file",
      dotGitPath,
      gitdirPath,
      gitdirParentName: gitdirPath ? path.basename(path.dirname(gitdirPath)) : undefined,
      ...inferred,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EISDIR") {
      return {
        dotGitKind: "directory",
        dotGitPath,
      };
    }

    return {
      dotGitKind: "unreadable",
      dotGitPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildLinkedDirectoryFromGitMetadata(
  currentPath: string,
): Promise<{ evidence: GitMetadataEvidence; directory?: LinkedDirectorySummary }> {
  const evidence = await readGitMetadataEvidence(currentPath);
  if (!evidence.inferredRepositoryPath) {
    return { evidence };
  }

  const worktreePath = path.dirname(evidence.dotGitPath!);
  const repositoryPath = evidence.inferredRepositoryPath;
  return {
    evidence,
    directory: {
      id: repositoryPath,
      path: repositoryPath,
      worktreePath,
      label: path.basename(repositoryPath) || repositoryPath,
      kind: "worktree",
    },
  };
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
    const [repoRoot, worktreeList, observedGitBranch, gitMetadata] = await Promise.all([
      runGit(currentPath, ["rev-parse", "--show-toplevel"]),
      runGit(currentPath, ["worktree", "list", "--porcelain"]),
      runGit(currentPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined),
      readGitMetadataEvidence(currentPath),
    ]);
    const worktreePaths = parseGitWorktrees(worktreeList);
    const primaryPath = path.resolve(worktreePaths[0] || repoRoot);
    const currentWorktreePath =
      findContainingWorktree(currentPath, worktreePaths) ?? path.resolve(repoRoot);
    const gitFileRepositoryPath = gitMetadata.inferredRepositoryPath
      ? path.resolve(gitMetadata.inferredRepositoryPath)
      : undefined;
    const isWorktree =
      currentWorktreePath !== primaryPath ||
      Boolean(gitFileRepositoryPath && gitFileRepositoryPath !== currentWorktreePath);
    const repositoryPath = isWorktree && gitFileRepositoryPath
      ? gitFileRepositoryPath
      : primaryPath;

    if (isToolManagedWorktreePath(currentPath) && !isWorktree) {
      threadDirectoryLog.warn("managed worktree path classified as local by git", {
        projectKey,
        currentPath,
        repoRoot,
        primaryPath,
        currentWorktreePath,
        worktreePaths,
        gitMetadata,
      });
    }

    return {
      linkedDirectories: [
        {
          id: repositoryPath,
          path: repositoryPath,
          worktreePath: isWorktree ? currentWorktreePath : undefined,
          label: path.basename(repositoryPath) || repositoryPath,
          kind: isWorktree ? "worktree" : "local",
        },
      ],
      observedGitBranch: observedGitBranch?.trim() || undefined,
    };
  } catch (error) {
    const gitMetadataFallback = await buildLinkedDirectoryFromGitMetadata(currentPath);
    if (gitMetadataFallback.directory) {
      threadDirectoryLog.warn("recovered worktree directory relationship from .git metadata", {
        projectKey,
        currentPath,
        error: error instanceof Error ? error.message : String(error),
        gitMetadata: gitMetadataFallback.evidence,
        linkedDirectory: gitMetadataFallback.directory,
      });
      return {
        linkedDirectories: [gitMetadataFallback.directory],
      };
    }

    const fallbackPath = path.resolve(currentPath);
    if (isToolManagedWorktreePath(fallbackPath)) {
      threadDirectoryLog.warn("managed worktree path fell back to local directory", {
        projectKey,
        fallbackPath,
        error: error instanceof Error ? error.message : String(error),
        gitMetadata: gitMetadataFallback.evidence,
      });
    }

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
