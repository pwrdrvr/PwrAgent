import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppServerThreadSummary,
  AppServerBackendKind,
  ArchiveThreadCleanupResult,
  DesktopWorktreeStorageLocation,
  LaunchpadWorkMode,
  NavigationDirectoryGitStatus,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
} from "@pwragent/shared";
import { DESKTOP_WORKTREE_STORAGE_DEFAULT } from "@pwragent/shared";
import { userHomeWorktreesRoot } from "../settings/desktop-config";

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    env: process.env,
  });
  return stdout.trim();
}

export async function recordCodexWorktreeOwnerThread(params: {
  worktreePath: string;
  threadId: string;
}): Promise<void> {
  const worktreePath = params.worktreePath.trim();
  const threadId = params.threadId.trim();
  if (!worktreePath || !threadId) {
    return;
  }

  const ownerFile = await runGit(worktreePath, [
    "rev-parse",
    "--git-path",
    "codex-thread.json",
  ]);
  if (!ownerFile) {
    throw new Error(`Unable to resolve Codex worktree owner file for ${worktreePath}`);
  }

  await mkdir(path.dirname(ownerFile), { recursive: true });
  await writeFile(
    ownerFile,
    `${JSON.stringify({ version: 1, ownerThreadId: threadId }, null, 2)}\n`,
    "utf8",
  );
}

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
}

function worktreesRootFor(
  repoRoot: string,
  storage: DesktopWorktreeStorageLocation,
  options?: {
    backend?: AppServerBackendKind;
    homeDir?: string;
  },
): string {
  if (storage === "user-home" && options?.backend === "codex") {
    return codexHomeWorktreesRoot(options.homeDir);
  }

  return storage === "user-home"
    ? userHomeWorktreesRoot(options?.homeDir)
    : path.join(repoRoot, ".worktrees");
}

function codexHomeWorktreesRoot(homeDir?: string): string {
  const codexHome =
    homeDir === undefined ? process.env.CODEX_HOME?.trim() : undefined;
  return path.join(codexHome || path.join(homeDir ?? os.homedir(), ".codex"), "worktrees");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function pruneEmptyWorktreeParents(worktreePath: string): Promise<void> {
  const hashParent = path.dirname(worktreePath);
  if (path.basename(hashParent) === ".worktrees" || hashParent === "/") {
    return;
  }
  try {
    await rmdir(hashParent);
  } catch {
    // Parent is non-empty or already gone; either is fine.
  }
}

export async function computeWorktreePath(params: {
  backend?: AppServerBackendKind;
  repoRoot: string;
  storage: DesktopWorktreeStorageLocation;
  homeDir?: string;
  timestamp?: number;
}): Promise<string> {
  const root = worktreesRootFor(params.repoRoot, params.storage, {
    backend: params.backend,
    homeDir: params.homeDir,
  });
  const projectName = path.basename(path.resolve(params.repoRoot)) || "project";
  const baseHash = (params.timestamp ?? Date.now()).toString(36);

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const hash = attempt === 0 ? baseHash : `${baseHash}-${attempt + 1}`;
    const candidate = path.join(root, hash, projectName);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to allocate a unique worktree path under ${root} for ${projectName}`,
  );
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

function parseGitLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveDefaultBranch(params: {
  branches: string[];
  remoteHead: string;
}): string | undefined {
  const remoteHead = params.remoteHead.replace(/^origin\//, "").trim();
  if (remoteHead && params.branches.includes(remoteHead)) {
    return remoteHead;
  }

  return (
    ["main", "master", "develop", "trunk"].find((branch) =>
      params.branches.includes(branch),
    ) ?? params.branches[0]
  );
}

function orderHandoffBranches(params: {
  branches: string[];
  currentBranch: string;
  defaultBranch?: string;
  worktreeList: string;
}): string[] {
  const occupiedBranches = new Set(
    parseGitWorktreeEntries(params.worktreeList)
      .map((entry) => entry.branch)
      .filter((branch): branch is string => Boolean(branch)),
  );
  const candidates = params.branches.filter(
    (branch) =>
      branch &&
      branch !== params.currentBranch &&
      !occupiedBranches.has(branch),
  );
  const defaultBranch =
    params.defaultBranch && candidates.includes(params.defaultBranch)
      ? params.defaultBranch
      : undefined;
  const ordered = defaultBranch
    ? [defaultBranch, ...candidates.filter((branch) => branch !== defaultBranch)]
    : candidates;

  return [...new Set(ordered)];
}

function isProtectedBranch(branch?: string): boolean {
  return !branch || ["main", "master", "develop", "trunk"].includes(branch);
}

type CachedDirectoryStatus = {
  expiresAt: number;
  inFlight?: Promise<NavigationDirectoryGitStatus | undefined>;
  status?: NavigationDirectoryGitStatus;
};

type GitDirectoryServiceOptions = {
  cacheTtlMs?: number;
  resolveWorktreeStorage?: () =>
    | DesktopWorktreeStorageLocation
    | Promise<DesktopWorktreeStorageLocation>;
  homeDir?: string;
};

export class GitDirectoryService {
  private readonly statusCache = new Map<string, CachedDirectoryStatus>();
  private readonly cacheTtlMs: number;
  private readonly resolveStorage: () => Promise<DesktopWorktreeStorageLocation>;
  private readonly homeDir: string;

  constructor(options: GitDirectoryServiceOptions | number = {}) {
    const normalized: GitDirectoryServiceOptions =
      typeof options === "number" ? { cacheTtlMs: options } : options;
    this.cacheTtlMs = normalized.cacheTtlMs ?? 3_000;
    this.homeDir = normalized.homeDir ?? os.homedir();
    const resolveStorage = normalized.resolveWorktreeStorage;
    this.resolveStorage = async () =>
      (await resolveStorage?.()) ?? DESKTOP_WORKTREE_STORAGE_DEFAULT;
  }

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
    const [currentBranch, branchesOutput, remoteHead, worktreeList] = await Promise.all([
      runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      runGit(cwd, [
        "for-each-ref",
        "refs/heads",
        "--sort=-committerdate",
        "--format=%(refname:short)",
      ]).catch(() => ""),
      runGit(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]).catch(
        () => "",
      ),
      runGit(cwd, ["worktree", "list", "--porcelain"]).catch(() => ""),
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

    const branches = parseGitLines(branchesOutput);
    const defaultBranch = resolveDefaultBranch({ branches, remoteHead });
    const handoffBranches = orderHandoffBranches({
      branches,
      currentBranch,
      defaultBranch,
      worktreeList,
    });

    if (!upstreamBranch) {
      return {
        currentBranch,
        defaultBranch,
        branches,
        handoffBranches,
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
      defaultBranch,
      branches,
      handoffBranches,
      syncState,
    };
  }

  async prepareLaunchpadWorkspace(
    launchpad: Pick<
      NavigationLaunchpadDraft,
      "branchName" | "directoryKind" | "directoryLabel" | "directoryPath" | "workMode"
    > &
      Partial<Pick<NavigationLaunchpadDraft, "backend">>,
  ): Promise<{ cwd?: string; workMode: LaunchpadWorkMode }> {
    if (launchpad.directoryKind === "workspace") {
      return {
        cwd: undefined,
        workMode: "local",
      };
    }

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
    const storage = await this.resolveStorage();
    const worktreePath = await computeWorktreePath({
      backend: launchpad.backend,
      repoRoot,
      storage,
      homeDir: this.homeDir,
    });
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["worktree", "add", "--detach", worktreePath, baseBranch]);

    return {
      cwd: worktreePath,
      workMode: "worktree",
    };
  }

  async recordCodexWorktreeOwnerThread(params: {
    worktreePath: string;
    threadId: string;
  }): Promise<void> {
    await recordCodexWorktreeOwnerThread(params);
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
      await pruneEmptyWorktreeParents(worktreePath);

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
