import { access, mkdir, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IterableMapper } from "@shutterstock/p-map-iterable";
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
import { runGitCommand } from "./git-executable";

type GitCommandRunner = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

async function defaultRunGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return (await runGitCommand(cwd, args, { env })).stdout;
}

function errorText(error: unknown): string {
  const parts = [error instanceof Error ? error.message : String(error)];
  const stderr = (error as { stderr?: unknown })?.stderr;
  if (typeof stderr === "string") {
    parts.push(stderr);
  }
  return parts.join("\n");
}

function isNotGitRepositoryError(error: unknown): boolean {
  return errorText(error).includes("not a git repository");
}

async function readGitRoot(
  cwd: string,
  runGit: GitCommandRunner = defaultRunGit,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    return await runGit(cwd, ["rev-parse", "--show-toplevel"], env);
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function recordCodexWorktreeOwnerThread(params: {
  worktreePath: string;
  threadId: string;
  gitEnv?: NodeJS.ProcessEnv;
  runGit?: GitCommandRunner;
}): Promise<void> {
  const worktreePath = params.worktreePath.trim();
  const threadId = params.threadId.trim();
  if (!worktreePath || !threadId) {
    return;
  }

  const runGit = params.runGit ?? defaultRunGit;
  const ownerFile = await runGit(
    worktreePath,
    ["rev-parse", "--git-path", "codex-thread.json"],
    params.gitEnv,
  );
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
    codexHome?: string;
    homeDir?: string;
  },
): string {
  if (storage === "user-home" && options?.backend === "codex") {
    return codexHomeWorktreesRoot({
      codexHome: options.codexHome,
      homeDir: options.homeDir,
    });
  }

  return storage === "user-home"
    ? userHomeWorktreesRoot(options?.homeDir)
    : path.join(repoRoot, ".worktrees");
}

function codexHomeWorktreesRoot(options: {
  codexHome?: string;
  homeDir?: string;
}): string {
  const codexHome =
    options.codexHome?.trim() ||
    (options.homeDir === undefined ? process.env.CODEX_HOME?.trim() : undefined);
  return path.join(
    codexHome || path.join(options.homeDir ?? os.homedir(), ".codex"),
    "worktrees",
  );
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
  codexHome?: string;
  repoRoot: string;
  storage: DesktopWorktreeStorageLocation;
  homeDir?: string;
  timestamp?: number;
}): Promise<string> {
  const root = worktreesRootFor(params.repoRoot, params.storage, {
    backend: params.backend,
    codexHome: params.codexHome,
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

function uniqueBranches(branches: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const branch of branches) {
    const value = sanitizeBranchName(branch ?? "");
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
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

async function resolveVerifiedWorktreeBaseBranch(params: {
  repoRoot: string;
  requestedBranch?: string;
  gitEnv?: NodeJS.ProcessEnv;
  runGit?: GitCommandRunner;
}): Promise<string | undefined> {
  const runGit = params.runGit ?? defaultRunGit;
  const requestedBranch = sanitizeBranchName(params.requestedBranch ?? "");
  if (requestedBranch) {
    const commit = await runGit(
      params.repoRoot,
      ["rev-parse", "--verify", `${requestedBranch}^{commit}`],
      params.gitEnv,
    ).catch(() => "");
    return commit ? requestedBranch : undefined;
  }

  const [currentBranch, branchesOutput, remoteHead] = await Promise.all([
    runGit(params.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], params.gitEnv).catch(
      () => "",
    ),
    runGit(
      params.repoRoot,
      [
        "for-each-ref",
        "refs/heads",
        "--sort=-committerdate",
        "--format=%(refname:short)",
      ],
      params.gitEnv,
    ).catch(() => ""),
    runGit(
      params.repoRoot,
      ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      params.gitEnv,
    ).catch(() => ""),
  ]);
  const branches = parseGitLines(branchesOutput);
  const defaultBranch = resolveDefaultBranch({ branches, remoteHead });
  const candidates = uniqueBranches([
    currentBranch,
    defaultBranch,
    ...branches,
  ]);

  for (const branch of candidates) {
    const commit = await runGit(
      params.repoRoot,
      ["rev-parse", "--verify", `${branch}^{commit}`],
      params.gitEnv,
    ).catch(() => "");
    if (commit) {
      return branch;
    }
  }

  return undefined;
}

type CachedDirectoryStatus = {
  expiresAt: number;
  inFlight?: Promise<NavigationDirectoryGitStatus | undefined>;
  status?: NavigationDirectoryGitStatus;
};

export type DirectoryGitStatusEntry = {
  directoryKey: string;
  gitStatus?: NavigationDirectoryGitStatus;
};

type GitDirectoryServiceOptions = {
  cacheTtlMs?: number;
  statusConcurrency?: number;
  statusMaxUnread?: number;
  codexHome?: string;
  gitEnv?: NodeJS.ProcessEnv;
  runGit?: GitCommandRunner;
  resolveWorktreeStorage?: () =>
    | DesktopWorktreeStorageLocation
    | Promise<DesktopWorktreeStorageLocation>;
  homeDir?: string;
};

export class GitDirectoryService {
  private readonly statusCache = new Map<string, CachedDirectoryStatus>();
  private readonly cacheTtlMs: number;
  private readonly statusConcurrency: number;
  private readonly statusMaxUnread: number;
  private readonly codexHome?: string;
  private readonly gitEnv?: NodeJS.ProcessEnv;
  private readonly runGitCommand: GitCommandRunner;
  private readonly resolveStorage: () => Promise<DesktopWorktreeStorageLocation>;
  private readonly homeDir: string;

  constructor(options: GitDirectoryServiceOptions | number = {}) {
    const normalized: GitDirectoryServiceOptions =
      typeof options === "number" ? { cacheTtlMs: options } : options;
    this.cacheTtlMs = normalized.cacheTtlMs ?? 3_000;
    this.statusConcurrency = normalized.statusConcurrency ?? 4;
    this.statusMaxUnread = Math.max(
      normalized.statusMaxUnread ?? 8,
      this.statusConcurrency,
    );
    this.codexHome = normalized.codexHome;
    this.gitEnv = normalized.gitEnv;
    this.runGitCommand = normalized.runGit ?? defaultRunGit;
    this.homeDir = normalized.homeDir ?? os.homedir();
    const resolveStorage = normalized.resolveWorktreeStorage;
    this.resolveStorage = async () =>
      (await resolveStorage?.()) ?? DESKTOP_WORKTREE_STORAGE_DEFAULT;
  }

  async readDirectoryStatuses(
    directories: NavigationDirectorySummary[],
  ): Promise<Record<string, NavigationDirectoryGitStatus | undefined>> {
    const statuses: Record<string, NavigationDirectoryGitStatus | undefined> = {};
    for await (const entry of this.readDirectoryStatusEntries(directories)) {
      statuses[entry.directoryKey] = entry.gitStatus;
    }
    return statuses;
  }

  readDirectoryStatusEntries(
    directories: NavigationDirectorySummary[],
  ): AsyncIterable<DirectoryGitStatusEntry> {
    return new IterableMapper(
      directories,
      async (directory): Promise<DirectoryGitStatusEntry> => ({
        directoryKey: directory.key,
        gitStatus: await this.readDirectoryStatus(directory),
      }),
      {
        concurrency: this.statusConcurrency,
        maxUnread: this.statusMaxUnread,
      },
    );
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
    const runGit = this.runGitCommand;
    const gitEnv = this.gitEnv;
    const repoRoot = await readGitRoot(cwd, runGit, gitEnv);
    if (!repoRoot) {
      return undefined;
    }

    const [currentBranch, branchesOutput, remoteHead, worktreeList] =
      await Promise.all([
        runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], gitEnv).catch(
          () => "",
        ),
        runGit(
          repoRoot,
          [
            "for-each-ref",
            "refs/heads",
            "--sort=-committerdate",
            "--format=%(refname:short)",
          ],
          gitEnv,
        ).catch(() => ""),
        runGit(
          repoRoot,
          ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
          gitEnv,
        ).catch(() => ""),
        runGit(repoRoot, ["worktree", "list", "--porcelain"], gitEnv).catch(
          () => "",
        ),
      ]);
    const upstreamBranch = await runGit(
      repoRoot,
      [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ],
      gitEnv,
    ).catch(() => "");
    const branches = parseGitLines(branchesOutput);
    const defaultBranch = resolveDefaultBranch({ branches, remoteHead });
    if (!currentBranch) {
      return {
        defaultBranch,
        branches,
        handoffBranches: branches,
        syncState: "untracked",
      };
    }

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

    const counts = await runGit(
      cwd,
      ["rev-list", "--left-right", "--count", `HEAD...${upstreamBranch}`],
      gitEnv,
    ).catch(() => "");
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
  ): Promise<{ cwd?: string; repositoryPath?: string; workMode: LaunchpadWorkMode }> {
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

    const repoRoot = await readGitRoot(
      directoryPath,
      this.runGitCommand,
      this.gitEnv,
    );
    if (!repoRoot) {
      return {
        cwd: directoryPath,
        workMode: "local",
      };
    }

    const baseBranch = await resolveVerifiedWorktreeBaseBranch({
      gitEnv: this.gitEnv,
      repoRoot,
      requestedBranch: launchpad.branchName,
      runGit: this.runGitCommand,
    });
    if (!baseBranch) {
      return {
        cwd: directoryPath,
        workMode: "local",
      };
    }

    const storage = await this.resolveStorage();
    const worktreePath = await computeWorktreePath({
      backend: launchpad.backend,
      codexHome: launchpad.backend === "codex" ? this.codexHome : undefined,
      repoRoot,
      storage,
      homeDir: this.homeDir,
    });
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await this.runGitCommand(
      repoRoot,
      ["worktree", "add", "--detach", worktreePath, baseBranch],
      this.gitEnv,
    );

    return {
      cwd: worktreePath,
      repositoryPath: repoRoot,
      workMode: "worktree",
    };
  }

  async recordCodexWorktreeOwnerThread(params: {
    worktreePath: string;
    threadId: string;
  }): Promise<void> {
    await recordCodexWorktreeOwnerThread({
      ...params,
      gitEnv: this.gitEnv,
      runGit: this.runGitCommand,
    });
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
    const runGit = this.runGitCommand;
    const gitEnv = this.gitEnv;
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
      const repoRoot = await runGit(
        repoPath,
        ["rev-parse", "--show-toplevel"],
        gitEnv,
      );
      const worktreeList = await runGit(
        repoRoot,
        ["worktree", "list", "--porcelain"],
        gitEnv,
      );
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
      await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath], gitEnv);
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

      await runGit(repoRoot, ["branch", "-D", branch], gitEnv);

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
