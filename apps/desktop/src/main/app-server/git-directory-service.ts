import { execFile as execFileCallback } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
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

function buildWorktreeBranchName(params: {
  baseBranch: string;
  directoryLabel: string;
  timestamp?: number;
}): string {
  const base = sanitizeBranchName(params.baseBranch) || "main";
  const label = sanitizeBranchName(params.directoryLabel.toLowerCase()) || "launchpad";
  const suffix = (params.timestamp ?? Date.now()).toString(36);
  return `pwragnt/${label}-${base.replace(/\//g, "-")}-${suffix}`;
}

function buildWorktreePath(repoRoot: string, branchName: string): string {
  return path.join(repoRoot, ".worktrees", branchName.replace(/[\\/]/g, "-"));
}

export class GitDirectoryService {
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

    try {
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
    } catch (error) {
      return {
        syncState: "status-unavailable",
        statusUnavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
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
    const worktreeBranch = buildWorktreeBranchName({
      baseBranch,
      directoryLabel: launchpad.directoryLabel,
    });
    const worktreePath = buildWorktreePath(repoRoot, worktreeBranch);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["worktree", "add", "-b", worktreeBranch, worktreePath, baseBranch]);

    return {
      cwd: worktreePath,
      workMode: "worktree",
    };
  }
}
