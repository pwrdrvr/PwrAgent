import { execFile as execFileCallback } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppServerThreadSummary,
  ArchiveThreadCleanupResult,
  LaunchpadWorkMode,
  NavigationDirectoryGitStatus,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
} from "@pwragnt/shared";

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    env: process.env,
  });
  return stdout.trim();
}

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
}

function buildWorktreeDirectoryName(params: {
  baseBranch: string;
  directoryLabel: string;
  timestamp?: number;
}): string {
  const base = sanitizeBranchName(params.baseBranch) || "main";
  const label = sanitizeBranchName(params.directoryLabel.toLowerCase()) || "launchpad";
  const suffix = (params.timestamp ?? Date.now()).toString(36);
  return `launchpad-${label}-${base.replace(/\//g, "-")}-${suffix}`;
}

function buildWorktreePath(repoRoot: string, worktreeName: string): string {
  return path.join(repoRoot, ".worktrees", worktreeName.replace(/[\\/]/g, "-"));
}

type WorktreeEntry = {
  path: string;
  branch?: string;
};

function parseGitWorktreeEntries(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length).trim(),
      };
      if (current.path) {
        entries.push(current);
      }
      continue;
    }

    if (current && line.startsWith("branch ")) {
      const branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
      current.branch = branch || undefined;
    }
  }

  return entries;
}

function isProtectedBranch(branch?: string): boolean {
  return !branch || ["main", "master", "develop", "trunk"].includes(branch);
}

type CachedDirectoryStatus = {
  expiresAt: number;
  inFlight?: Promise<NavigationDirectoryGitStatus | undefined>;
  status?: NavigationDirectoryGitStatus;
};

export class GitDirectoryService {
  private readonly statusCache = new Map<string, CachedDirectoryStatus>();

  constructor(private readonly cacheTtlMs = 3_000) {}

  async readDirectoryStatuses(
    directories: NavigationDirectorySummary[],
  ): Promise<Record<string, NavigationDirectoryGitStatus | undefined>> {
    const statuses = await Promise.all(
      directories.map(async (directory) => [
        directory.key,
        await this.readDirectoryStatus(directory),
      ] as const),
    );
    return Object.fromEntries(statuses);
  }

  async readDirectoryStatus(
    directory: Pick<NavigationDirectorySummary, "path">,
  ): Promise<NavigationDirectoryGitStatus | undefined> {
    const cwd = directory.path?.trim();
    if (!cwd) {
      return undefined;
    }

    const cached = this.statusCache.get(cwd);
    const now = Date.now();
    if (cached?.inFlight) {
      return await cached.inFlight;
    }

    if (cached && cached.expiresAt > now) {
      return cached.status;
    }

    const inFlight = this.loadDirectoryStatus(cwd)
      .then((status) => {
        this.statusCache.set(cwd, {
          expiresAt: Date.now() + this.cacheTtlMs,
          status,
        });
        return status;
      })
      .catch((error) => {
        const status: NavigationDirectoryGitStatus = {
          syncState: "status-unavailable",
          statusUnavailableReason: error instanceof Error ? error.message : String(error),
        };
        this.statusCache.set(cwd, {
          expiresAt: Date.now() + this.cacheTtlMs,
          status,
        });
        return status;
      });

    this.statusCache.set(cwd, {
      expiresAt: cached?.expiresAt ?? 0,
      inFlight,
      status: cached?.status,
    });

    return await inFlight;
  }

  invalidateDirectoryStatus(directoryPath?: string): void {
    const normalizedPath = directoryPath?.trim();
    if (!normalizedPath) {
      return;
    }

    this.statusCache.delete(normalizedPath);
  }

  private async loadDirectoryStatus(
    cwd: string,
  ): Promise<NavigationDirectoryGitStatus | undefined> {
    const [currentBranch, branches] = await Promise.all([
      runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      runGit(cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]).catch(
        () => "",
      ),
    ]);
    const upstreamBranch = await runGit(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]).catch(() => "");
    if (!currentBranch) {
      return undefined;
    }

    if (!upstreamBranch) {
      return {
        currentBranch,
        branches: branches ? branches.split("\n").filter(Boolean) : [],
        syncState: "untracked",
      };
    }

    const counts = await runGit(cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${upstreamBranch}`,
    ]).catch(() => "");
    const [aheadValue, behindValue] = counts
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));
    const ahead = Number.isFinite(aheadValue) ? aheadValue : 0;
    const behind = Number.isFinite(behindValue) ? behindValue : 0;
    const syncState =
      ahead > 0 && behind > 0
        ? "diverged"
        : ahead > 0
          ? "ahead"
          : behind > 0
            ? "behind"
            : "in-sync";

    return {
      currentBranch,
      upstreamBranch,
      ahead,
      behind,
      branches: branches ? branches.split("\n").filter(Boolean) : [],
      syncState,
    };
  }

  async prepareLaunchpadWorkspace(
    launchpad: Pick<
      NavigationLaunchpadDraft,
      "branchName" | "directoryLabel" | "directoryPath" | "workMode"
    >,
  ): Promise<{ cwd?: string; workMode: LaunchpadWorkMode }> {
    const directoryPath = launchpad.directoryPath?.trim();
    if (!directoryPath) {
      return {
        cwd: undefined,
        workMode: launchpad.workMode,
      };
    }

    if (launchpad.workMode !== "worktree") {
      return {
        cwd: directoryPath,
        workMode: "local",
      };
    }

    const repoRoot = await runGit(directoryPath, ["rev-parse", "--show-toplevel"]);
    const baseBranch =
      sanitizeBranchName(launchpad.branchName ?? "") ||
      sanitizeBranchName(await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])) ||
      "main";
    const worktreeName = buildWorktreeDirectoryName({
      baseBranch,
      directoryLabel: launchpad.directoryLabel,
    });
    const worktreePath = buildWorktreePath(repoRoot, worktreeName);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["worktree", "add", "--detach", worktreePath, baseBranch]);

    return {
      cwd: worktreePath,
      workMode: "worktree",
    };
  }

  async cleanupThreadWorktrees(
    thread: Pick<
      AppServerThreadSummary,
      "gitBranch" | "linkedDirectories" | "observedGitBranch"
    >,
  ): Promise<ArchiveThreadCleanupResult[]> {
    const candidates = thread.linkedDirectories.flatMap((directory) => {
      const worktreePath =
        directory.worktreePath ?? (directory.kind === "worktree" ? directory.path : undefined);
      if (!worktreePath?.trim()) {
        return [];
      }

      return [
        {
          repoPath: directory.path,
          worktreePath,
        },
      ];
    });
    const uniqueCandidates = [
      ...new Map(
        candidates.map((candidate) => [
          `${path.resolve(candidate.repoPath)}:${path.resolve(candidate.worktreePath)}`,
          candidate,
        ]),
      ).values(),
    ];

    return await Promise.all(
      uniqueCandidates.map(async (candidate) =>
        await this.cleanupWorktreeCandidate(candidate, thread),
      ),
    );
  }

  private async cleanupWorktreeCandidate(
    candidate: {
      repoPath: string;
      worktreePath: string;
    },
    thread: Pick<AppServerThreadSummary, "gitBranch" | "observedGitBranch">,
  ): Promise<ArchiveThreadCleanupResult> {
    const repoPath = path.resolve(candidate.repoPath);
    const worktreePath = path.resolve(candidate.worktreePath);
    const base: ArchiveThreadCleanupResult = {
      worktreePath,
      removedWorktree: false,
      deletedBranch: false,
    };

    if (repoPath === worktreePath) {
      return {
        ...base,
        skippedReason: "Refusing to remove the primary repository worktree",
      };
    }

    try {
      const repoRoot = await runGit(repoPath, ["rev-parse", "--show-toplevel"]);
      const worktreeList = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
      const entries = parseGitWorktreeEntries(worktreeList);
      const primaryPath = path.resolve(entries[0]?.path || repoRoot);
      const entry = entries.find((item) => path.resolve(item.path) === worktreePath);

      if (!entry) {
        return {
          ...base,
          skippedReason: "Worktree is not registered with git",
        };
      }

      if (worktreePath === primaryPath) {
        return {
          ...base,
          skippedReason: "Refusing to remove the primary repository worktree",
        };
      }

      const branch = entry.branch ?? thread.observedGitBranch ?? thread.gitBranch;
      await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);

      const result: ArchiveThreadCleanupResult = {
        ...base,
        branch,
        removedWorktree: true,
      };

      if (!branch) {
        return {
          ...result,
          skippedReason: "No local branch was associated with the worktree",
        };
      }

      if (isProtectedBranch(branch)) {
        return {
          ...result,
          skippedReason: `Refusing to delete protected branch ${branch}`,
        };
      }

      await runGit(repoRoot, ["branch", "-D", branch]);

      return {
        ...result,
        deletedBranch: true,
      };
    } catch (error) {
      return {
        ...base,
        branch: thread.observedGitBranch ?? thread.gitBranch,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
