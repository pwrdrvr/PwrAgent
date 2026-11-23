import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import { isToolManagedWorktreePath } from "@pwragent/shared/worktree-paths";
import { buildPwrAgentChildProcessEnv } from "../../child-process-env";
import { getMainLogger } from "../../log";
import { runGitCommand } from "../../app-server/git-executable";
import { readBoundedGitPointer } from "./directory-observation";

import {
  directoryEnrichmentDiagnostics,
  type DirectoryEnrichmentContext,
} from "../../diagnostics/directory-enrichment-diagnostics";

const threadDirectoryLog = getMainLogger("pwragent:thread-directory-enricher");
const GIT_DIRECTORY_PROBE_TIMEOUT_MS = 2_000;
const GIT_DIRECTORY_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Normalize a resolved filesystem path to forward slashes for use as a stable,
 * cross-platform directory identifier. No-op on POSIX; on Windows this turns
 * `C:\Users\…` into `C:/Users/…` so directory ids/keys read identically across
 * hosts (and match how `computeWorktreePath` already emits worktree paths).
 */
function toDirectoryId(value: string): string {
  return value.replace(/\\/g, "/");
}

export type ThreadDirectoryEnrichment = {
  linkedDirectories: LinkedDirectorySummary[];
  observedGitBranch?: string;
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

export async function runGit(
  projectKey: string,
  args: string[],
  context: DirectoryEnrichmentContext,
): Promise<string> {
  const finish = directoryEnrichmentDiagnostics.startGit(context, args);
  try {
    const result = await runGitCommand(projectKey, args, {
      purpose: "directory-enrichment",
      env: buildPwrAgentChildProcessEnv(process.env),
      maxBuffer: GIT_DIRECTORY_PROBE_MAX_BUFFER_BYTES,
      timeout: GIT_DIRECTORY_PROBE_TIMEOUT_MS,
    });
    finish(false);
    return result.stdout.trim();
  } catch (error) {
    finish(true);
    throw error;
  }
}

export function buildFallbackLinkedDirectory(currentPath: string): LinkedDirectorySummary {
  const directoryPath = path.resolve(currentPath);
  const isManagedWorktree = isToolManagedWorktreePath(directoryPath);
  return {
    id: toDirectoryId(directoryPath),
    path: toDirectoryId(directoryPath),
    ...(isManagedWorktree ? { worktreePath: toDirectoryId(directoryPath) } : {}),
    label: path.basename(directoryPath) || directoryPath,
    kind: isManagedWorktree ? "worktree" : "local",
  };
}

export function buildCheckoutLinkedDirectory(repositoryPath: string, worktreePath?: string): LinkedDirectorySummary {
  return {
    id: toDirectoryId(repositoryPath),
    path: toDirectoryId(repositoryPath),
    worktreePath: worktreePath && toDirectoryId(worktreePath),
    label: path.basename(repositoryPath) || repositoryPath,
    kind: worktreePath ? "worktree" : "local",
  };
}

// These inputs can make the effective checkout differ from disk discovery.
// Leave identity to an explicit Git read when the process sets one.
export function hasGitDiscoveryOverrides(): boolean {
  return Object.keys(process.env).some((key) =>
    /^(?:GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_IMPLICIT_WORK_TREE|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS)$/i.test(key),
  );
}

export async function pathExists(targetPath: string): Promise<boolean> {
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
  rootOnly = false,
): Promise<GitMetadataEvidence> {
  const dotGitPath = rootOnly ? path.join(currentPath, ".git") : await findDotGitPath(currentPath);
  if (!dotGitPath) {
    return { dotGitKind: "missing" };
  }

  try {
    if (rootOnly) {
      const info = await stat(dotGitPath);
      if (info.isDirectory()) return { dotGitKind: "directory", dotGitPath };
    }
    const dotGitContent = rootOnly ? await readBoundedGitPointer(dotGitPath) : await readFile(dotGitPath, "utf8");
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
  rootOnly = false,
): Promise<{ evidence: GitMetadataEvidence; directory?: LinkedDirectorySummary }> {
  const evidence = await readGitMetadataEvidence(currentPath, rootOnly);
  if (!evidence.inferredRepositoryPath) {
    return { evidence };
  }

  const worktreePath = path.dirname(evidence.dotGitPath!);
  const repositoryPath = evidence.inferredRepositoryPath;
  if (rootOnly && !await hasLiveWorktreeOwner(evidence.dotGitPath!, evidence.gitdirPath!, repositoryPath)) {
    return { evidence };
  }
  return {
    evidence,
    directory: buildCheckoutLinkedDirectory(repositoryPath, worktreePath),
  };
}

export async function readLiveWorktreeCommonDirectory(dotGit: string, admin: string): Promise<string | undefined> {
  try {
    const [backlink, common] = await Promise.all([
      readBoundedGitPointer(path.join(admin, "gitdir")),
      readBoundedGitPointer(path.join(admin, "commondir")),
    ]);
    if (!backlink.trim() || !common.trim()) return undefined;
    const [linkedGit, namedGit, commonGit] = await Promise.all([
      realpath(dotGit), realpath(path.resolve(admin, backlink.trim())), realpath(path.resolve(admin, common.trim())),
    ]);
    return linkedGit === namedGit ? commonGit : undefined;
  } catch {
    return undefined;
  }
}

async function hasLiveWorktreeOwner(dotGit: string, admin: string, repository: string): Promise<boolean> {
  try {
    const [commonGit, primaryGit, hasHead] = await Promise.all([
      readLiveWorktreeCommonDirectory(dotGit, admin),
      realpath(path.join(repository, ".git")),
      pathExists(path.join(repository, ".git", "HEAD")),
    ]);
    return hasHead && commonGit === primaryGit;
  } catch {
    return false;
  }
}

/**
 * Resolve a tool-managed worktree directory to its repository checkout by
 * following the worktree's `.git` gitdir link. Returns a repo-rooted linked
 * directory (`path` = repository, `worktreePath` = worktree) for a linked
 * checkout and undefined when the metadata does not identify its repository.
 * Project rows use the exact root, without walking up a non-repository path.
 */
export async function resolveWorktreeRepositoryDirectory(
  cwd: string,
  rootOnly = false,
): Promise<LinkedDirectorySummary | undefined> {
  const { directory } = await buildLinkedDirectoryFromGitMetadata(path.resolve(cwd), rootOnly);
  return directory;
}

export function parseGitWorktrees(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

export async function loadThreadDirectoryEnrichment(
  projectKey: string,
  context: DirectoryEnrichmentContext,
  readWorktrees: (repoRoot: string) => Promise<string[]>,
): Promise<ThreadDirectoryEnrichment> {
  if (!projectKey?.trim()) {
    return { linkedDirectories: [] };
  }

  const currentPath = path.resolve(projectKey.trim());
  if (!(await pathExists(currentPath))) {
    return { linkedDirectories: [] };
  }

  try {
    // One Git invocation discovers the top-level path and current branch.
    // Keep the separate branch fallback for unborn HEAD or partial results.
    let discovery: string[];
    try {
      discovery = (await runGit(currentPath,
        ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], context)).split("\n");
    } catch {
      discovery = [await runGit(currentPath, ["rev-parse", "--show-toplevel"], context)];
    }
    const repoRoot = discovery[0];
    const [worktreePaths, observedGitBranch, gitMetadata] = await Promise.all([
      readWorktrees(repoRoot),
      discovery[1] || runGit(currentPath, ["rev-parse", "--abbrev-ref", "HEAD"], context).catch(() => undefined),
      readGitMetadataEvidence(currentPath),
    ]);
    const primaryPath = path.resolve(worktreePaths[0] || repoRoot);
    const currentWorktreePath = path.resolve(repoRoot);
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
      linkedDirectories: [buildCheckoutLinkedDirectory(repositoryPath, isWorktree ? currentWorktreePath : undefined)],
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

    const fallbackDirectory = buildFallbackLinkedDirectory(currentPath);
    if (fallbackDirectory.kind === "worktree") {
      threadDirectoryLog.warn("managed worktree repository relationship unavailable", {
        projectKey,
        fallbackPath: fallbackDirectory.worktreePath,
        error: error instanceof Error ? error.message : String(error),
        gitMetadata: gitMetadataFallback.evidence,
      });
    }

    return {
      linkedDirectories: [fallbackDirectory],
    };
  }
}

