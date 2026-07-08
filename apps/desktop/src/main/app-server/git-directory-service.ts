import { access, mkdir, realpath, rmdir, writeFile } from "node:fs/promises";
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
  NavigationGitBranchDetail,
  NavigationGitCommitSummary,
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

// Directory/worktree identifiers are surfaced to the rest of the app
// (thread links, navigation, cleanup results) as stable string keys.
// `path.resolve`/`path.join` emit backslashes on Windows, so normalize
// these RETURNED identifier strings to forward slashes on every platform.
// No-op on POSIX (no backslashes to replace). This must only touch the
// identifier values placed into returned result objects — never the paths
// passed to git/fs operations, which must stay native.
function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function toForwardSlashesOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : toForwardSlashes(value);
}

export type PreparedLaunchpadWorkspace = {
  cwd?: string;
  repositoryPath?: string;
  rollback?: () => Promise<void>;
  workMode: LaunchpadWorkMode;
};

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

async function readGitCommonDir(params: {
  repoRoot: string;
  runGit: GitCommandRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const commonDir = await params
    .runGit(params.repoRoot, ["rev-parse", "--git-common-dir"], params.env)
    .catch(() => "");
  const trimmed = commonDir.trim();
  if (!trimmed) {
    return path.resolve(params.repoRoot, ".git");
  }
  return path.resolve(params.repoRoot, trimmed);
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

async function normalizeFilesystemPath(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
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

async function removeWorktreeAndPrune(params: {
  gitEnv?: NodeJS.ProcessEnv;
  repoRoot: string;
  runGit: GitCommandRunner;
  worktreePath: string;
}): Promise<void> {
  await params.runGit(
    params.repoRoot,
    ["worktree", "remove", "--force", params.worktreePath],
    params.gitEnv,
  );
  await pruneEmptyWorktreeParents(params.worktreePath);
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

async function readPrimaryWorktreePath(
  cwd: string,
  runGit: GitCommandRunner,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const worktreeList = await runGit(cwd, ["worktree", "list", "--porcelain"], env)
    .catch(() => "");
  return parseGitWorktreeEntries(worktreeList)[0]?.path;
}

function parseGitLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Parses `for-each-ref refs/heads` output formatted as
 * `<short-name>\t<committerdate:unix>`, preserving the input order (which the
 * caller sorts by `-committerdate`, i.e. most recently touched first).
 */
function parseGitBranchDetails(
  output: string,
): { name: string; lastCommitAt?: number }[] {
  const details: { name: string; lastCommitAt?: number }[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) {
      continue;
    }
    const tabIndex = line.indexOf("\t");
    const name = (tabIndex === -1 ? line : line.slice(0, tabIndex)).trim();
    if (!name) {
      continue;
    }
    const unixValue =
      tabIndex === -1
        ? Number.NaN
        : Number.parseInt(line.slice(tabIndex + 1).trim(), 10);
    details.push({
      name,
      lastCommitAt: Number.isFinite(unixValue) ? unixValue : undefined,
    });
  }
  return details;
}

/**
 * Parses `for-each-ref refs/heads refs/remotes` output formatted as
 * `<full-refname>\t<short-name>\t<committerdate:unix>\t<symref>`.
 *
 * Remote HEAD aliases must be filtered before callers see the shortened name:
 * Git can shorten `refs/remotes/origin/HEAD` to `origin`, which otherwise
 * looks like a selectable branch.
 */
function parseGitBaseBranchDetails(
  output: string,
): { name: string; lastCommitAt?: number }[] {
  const details: { name: string; lastCommitAt?: number }[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) {
      continue;
    }
    const [refname = "", shortName = "", unixRaw = "", symref = ""] =
      line.split("\t");
    const fullRefname = refname.trim();
    if (
      fullRefname.startsWith("refs/remotes/") &&
      fullRefname.endsWith("/HEAD")
    ) {
      continue;
    }
    if (symref.trim()) {
      continue;
    }
    const name = shortName.trim();
    if (!name) {
      continue;
    }
    const unixValue = Number.parseInt(unixRaw.trim(), 10);
    details.push({
      name,
      lastCommitAt: Number.isFinite(unixValue) ? unixValue : undefined,
    });
  }
  return details;
}

function parseGitCommitSummaries(output: string): NavigationGitCommitSummary[] {
  const commits: NavigationGitCommitSummary[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) {
      continue;
    }
    const [sha = "", shortSha = "", committedAtRaw = "", subject = ""] =
      line.split("\x1f");
    const fullSha = sha.trim();
    const abbreviatedSha = shortSha.trim();
    if (!fullSha || !abbreviatedSha) {
      continue;
    }
    const committedAtValue = Number.parseInt(committedAtRaw.trim(), 10);
    commits.push({
      sha: fullSha,
      shortSha: abbreviatedSha,
      committedAt: Number.isFinite(committedAtValue)
        ? committedAtValue
        : undefined,
      subject: subject.trim(),
    });
  }
  return commits;
}

/**
 * Upper bound on how many branches we enrich, hold in the navigation
 * snapshot, and persist to the directory git-status cache. Repos can have
 * thousands of branches; the picker (and the messaging / PR-status surfaces
 * that read `branches`) only ever need the most recently touched ones. The
 * git enumeration itself still walks every ref — that cost is transient — but
 * nothing past this many branches is retained or written to disk.
 */
export const MAX_TRACKED_BRANCHES = 100;
export const MAX_TRACKED_COMMITS = 20;

/**
 * Keeps the most recently touched `limit` branches, always retaining the
 * `keep` anchors (current / default) even when they fall outside the cutoff,
 * so pinned anchors and default resolution keep working on busy repos.
 * Input is assumed sorted most-recent-first.
 */
export function capRecentBranchDetails(
  details: { name: string; lastCommitAt?: number }[],
  options: { keep: Array<string | undefined>; limit: number },
): { name: string; lastCommitAt?: number }[] {
  if (details.length <= options.limit) {
    return details;
  }
  const kept = details.slice(0, options.limit);
  const keptNames = new Set(kept.map((detail) => detail.name));
  for (const name of options.keep) {
    if (!name || keptNames.has(name)) {
      continue;
    }
    const detail = details.find((entry) => entry.name === name);
    if (detail) {
      keptNames.add(name);
      kept.push(detail);
    }
  }
  return kept;
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
  sourceRoot?: string;
  requestedBranch?: string;
  gitEnv?: NodeJS.ProcessEnv;
  runGit?: GitCommandRunner;
}): Promise<string | undefined> {
  const runGit = params.runGit ?? defaultRunGit;
  const requestedBranch = sanitizeBranchName(params.requestedBranch ?? "");
  if (requestedBranch && requestedBranch !== "HEAD") {
    const commit = await runGit(
      params.repoRoot,
      ["rev-parse", "--verify", `${requestedBranch}^{commit}`],
      params.gitEnv,
    ).catch(() => "");
    return commit ? requestedBranch : undefined;
  }

  const sourceRoot = params.sourceRoot ?? params.repoRoot;
  const [rawCurrentBranch, branchesOutput, remoteHead] = await Promise.all([
    runGit(sourceRoot, ["rev-parse", "--abbrev-ref", "HEAD"], params.gitEnv).catch(
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
  const currentBranch = rawCurrentBranch.trim() === "HEAD" ? "" : rawCurrentBranch;
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

async function detachCleanWorktreeBranch(params: {
  branchName: string;
  gitEnv?: NodeJS.ProcessEnv;
  runGit: GitCommandRunner;
  worktreePath: string;
}): Promise<void> {
  const status = await params
    .runGit(
      params.worktreePath,
      ["status", "--porcelain", "--untracked-files=normal"],
      params.gitEnv,
    )
    .catch(() => "");
  if (status.trim()) {
    throw new Error(
      `Cannot move branch ${params.branchName} to a destination worktree because ${params.worktreePath} has uncommitted changes.`,
    );
  }
  const baseCommit = await params.runGit(
    params.worktreePath,
    ["rev-parse", "--verify", `${params.branchName}^{commit}`],
    params.gitEnv,
  );
  await params.runGit(
    params.worktreePath,
    ["switch", "--detach", baseCommit.trim()],
    params.gitEnv,
  );
}

async function restoreDetachedWorktreeBranch(params: {
  branchName: string;
  gitEnv?: NodeJS.ProcessEnv;
  runGit: GitCommandRunner;
  worktreePath: string;
}): Promise<void> {
  await params.runGit(
    params.worktreePath,
    ["switch", params.branchName],
    params.gitEnv,
  );
}

type CachedDirectoryStatus = {
  expiresAt: number;
  inFlight?: Promise<NavigationDirectoryGitStatus | undefined>;
  status?: NavigationDirectoryGitStatus;
};

type BranchInventory = {
  branchesOutput: string;
  baseBranchesOutput: string;
  remoteHead: string;
  worktreeList: string;
};

type CachedBranchInventory = {
  expiresAt: number;
  inFlight?: Promise<BranchInventory>;
  inventory?: BranchInventory;
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
  private readonly branchInventoryCache = new Map<string, CachedBranchInventory>();
  private readonly commonGitDirByCwd = new Map<string, string>();
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
    const commonGitDir = this.commonGitDirByCwd.get(normalizedPath);
    if (commonGitDir) {
      this.branchInventoryCache.delete(commonGitDir);
      this.commonGitDirByCwd.delete(normalizedPath);
    }
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

    const commonGitDir = await readGitCommonDir({
      repoRoot,
      runGit,
      env: gitEnv,
    });
    this.commonGitDirByCwd.set(cwd, commonGitDir);

    const [
      rawCurrentBranch,
      branchInventory,
      recentCommitsOutput,
    ] = await Promise.all([
        runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], gitEnv).catch(
          () => "",
        ),
        this.readBranchInventory({ commonGitDir, repoRoot }),
        runGit(
          repoRoot,
          [
            "log",
            `--max-count=${MAX_TRACKED_COMMITS}`,
            "--format=%H%x1f%h%x1f%ct%x1f%s",
          ],
          gitEnv,
        ).catch(() => ""),
      ]);
    const currentBranch =
      rawCurrentBranch.trim() === "HEAD" ? "" : rawCurrentBranch.trim();
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
    const parsedBranchDetailsAll = parseGitBranchDetails(
      branchInventory.branchesOutput,
    );
    const parsedBaseBranchDetailsAll = parseGitBaseBranchDetails(
      branchInventory.baseBranchesOutput,
    );
    const recentCommits = parseGitCommitSummaries(recentCommitsOutput).slice(
      0,
      MAX_TRACKED_COMMITS,
    );
    // Resolve the default branch against the FULL list so a rarely-committed
    // `main` is still found, then cap everything we hold/persist downstream.
    const defaultBranch = resolveDefaultBranch({
      branches: parsedBranchDetailsAll.map((detail) => detail.name),
      remoteHead: branchInventory.remoteHead,
    });
    const parsedBranchDetails = capRecentBranchDetails(parsedBranchDetailsAll, {
      keep: [currentBranch, defaultBranch],
      limit: MAX_TRACKED_BRANCHES,
    });
    const parsedBaseBranchDetails = capRecentBranchDetails(parsedBaseBranchDetailsAll, {
      keep: [currentBranch, defaultBranch, branchInventory.remoteHead.trim()],
      limit: MAX_TRACKED_BRANCHES,
    });
    const branches = parsedBranchDetails.map((detail) => detail.name);
    const baseBranches = parsedBaseBranchDetails.map((detail) => detail.name);
    const worktreeBranchNames = new Set(
      parseGitWorktreeEntries(branchInventory.worktreeList)
        .map((entry) => entry.branch)
        .filter((branch): branch is string => Boolean(branch)),
    );
    const buildBranchDetails = (): NavigationGitBranchDetail[] =>
      parsedBranchDetails.map((detail) =>
        detail.name !== currentBranch && worktreeBranchNames.has(detail.name)
          ? { ...detail, inUse: true }
          : { ...detail },
      );
    const buildBaseBranchDetails = (): NavigationGitBranchDetail[] =>
      parsedBaseBranchDetails.map((detail) =>
        detail.name !== currentBranch && worktreeBranchNames.has(detail.name)
          ? { ...detail, inUse: true }
          : { ...detail },
      );
    if (!currentBranch) {
      return {
        defaultBranch,
        branches,
        baseBranches,
        branchDetails: buildBranchDetails(),
        baseBranchDetails: buildBaseBranchDetails(),
        recentCommits,
        handoffBranches: branches,
        syncState: "untracked",
      };
    }

    const handoffBranches = orderHandoffBranches({
      branches,
      currentBranch,
      defaultBranch,
      worktreeList: branchInventory.worktreeList,
    });

    if (!upstreamBranch) {
      return {
        currentBranch,
        defaultBranch,
        branches,
        baseBranches,
        branchDetails: buildBranchDetails(),
        baseBranchDetails: buildBaseBranchDetails(),
        recentCommits,
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
      baseBranches,
      branchDetails: buildBranchDetails(),
      baseBranchDetails: buildBaseBranchDetails(),
      recentCommits,
      handoffBranches,
      syncState,
    };
  }

  private async readBranchInventory(params: {
    commonGitDir: string;
    repoRoot: string;
  }): Promise<BranchInventory> {
    const cached = this.branchInventoryCache.get(params.commonGitDir);
    const now = Date.now();
    if (cached?.inFlight) {
      return await cached.inFlight;
    }

    if (cached?.inventory && cached.expiresAt > now) {
      return cached.inventory;
    }

    const inFlight = this.loadBranchInventory(params.repoRoot).then((inventory) => {
      this.branchInventoryCache.set(params.commonGitDir, {
        expiresAt: Date.now() + this.cacheTtlMs,
        inventory,
      });
      return inventory;
    });
    this.branchInventoryCache.set(params.commonGitDir, {
      expiresAt: cached?.expiresAt ?? 0,
      inFlight,
      inventory: cached?.inventory,
    });

    return await inFlight;
  }

  private async loadBranchInventory(repoRoot: string): Promise<BranchInventory> {
    const runGit = this.runGitCommand;
    const gitEnv = this.gitEnv;
    const [
      branchesOutput,
      baseBranchesOutput,
      remoteHead,
      worktreeList,
    ] = await Promise.all([
      runGit(
        repoRoot,
        [
          "for-each-ref",
          "refs/heads",
          "--sort=-committerdate",
          "--format=%(refname:short)%09%(committerdate:unix)",
        ],
        gitEnv,
      ).catch(() => ""),
      runGit(
        repoRoot,
        [
          "for-each-ref",
          "refs/heads",
          "refs/remotes",
          "--sort=-committerdate",
          "--format=%(refname)%09%(refname:short)%09%(committerdate:unix)%09%(symref)",
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

    return {
      branchesOutput,
      baseBranchesOutput,
      remoteHead,
      worktreeList,
    };
  }

  async prepareLaunchpadWorkspace(
    launchpad: Pick<
      NavigationLaunchpadDraft,
      "branchName" | "directoryKind" | "directoryLabel" | "directoryPath" | "workMode"
    > &
      Partial<Pick<NavigationLaunchpadDraft, "backend">> & {
        excludedWorktreePaths?: string[];
        worktreeBranchMode?: "attached" | "detached";
      },
  ): Promise<PreparedLaunchpadWorkspace> {
    const prepared = await this.prepareLaunchpadWorkspaceInternal(launchpad);
    // Forward-slash the returned identifier fields (no-op on POSIX). The
    // `rollback` closure captured the native worktree path internally, so
    // it keeps operating on the real fs path regardless of this rewrite.
    return {
      ...prepared,
      cwd: toForwardSlashesOptional(prepared.cwd),
      repositoryPath: toForwardSlashesOptional(prepared.repositoryPath),
    };
  }

  async resolvePrimaryWorkspacePath(cwd: string | undefined): Promise<string | undefined> {
    const directoryPath = cwd?.trim();
    if (!directoryPath) {
      return undefined;
    }
    const sourceRoot = await readGitRoot(
      directoryPath,
      this.runGitCommand,
      this.gitEnv,
    );
    if (!sourceRoot) {
      return undefined;
    }
    const primary =
      (await readPrimaryWorktreePath(sourceRoot, this.runGitCommand, this.gitEnv)) ??
      sourceRoot;
    return toForwardSlashes(primary);
  }

  private async prepareLaunchpadWorkspaceInternal(
    launchpad: Pick<
      NavigationLaunchpadDraft,
      "branchName" | "directoryKind" | "directoryLabel" | "directoryPath" | "workMode"
    > &
      Partial<Pick<NavigationLaunchpadDraft, "backend">> & {
        excludedWorktreePaths?: string[];
        worktreeBranchMode?: "attached" | "detached";
      },
  ): Promise<PreparedLaunchpadWorkspace> {
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

    const sourceRoot = await readGitRoot(
      directoryPath,
      this.runGitCommand,
      this.gitEnv,
    );
    if (!sourceRoot) {
      return {
        cwd: directoryPath,
        workMode: "local",
      };
    }
    const repoRoot =
      (await readPrimaryWorktreePath(sourceRoot, this.runGitCommand, this.gitEnv))
      ?? sourceRoot;

    const baseBranch = await resolveVerifiedWorktreeBaseBranch({
      gitEnv: this.gitEnv,
      repoRoot,
      requestedBranch: launchpad.branchName,
      runGit: this.runGitCommand,
      sourceRoot,
    });
    if (!baseBranch) {
      return {
        cwd: directoryPath,
        workMode: "local",
      };
    }

    if (launchpad.worktreeBranchMode === "attached") {
      let detachedSourceWorktreePath: string | undefined;
      const excludedWorktreePaths = new Set(
        await Promise.all(
          (launchpad.excludedWorktreePaths ?? [])
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => normalizeFilesystemPath(entry)),
        ),
      );
      const worktreeList = await this.runGitCommand(
        repoRoot,
        ["worktree", "list", "--porcelain"],
        this.gitEnv,
      ).catch(() => "");
      const existing = parseGitWorktreeEntries(worktreeList).find(
        (entry) => entry.branch === baseBranch,
      );
      const existingIsRepoRoot =
        existing && path.resolve(existing.path) === path.resolve(repoRoot);
      if (existing && !existingIsRepoRoot) {
        const existingPath = await normalizeFilesystemPath(existing.path);
        if (!excludedWorktreePaths.has(existingPath)) {
          return {
            cwd: existing.path,
            repositoryPath: repoRoot,
            workMode: "worktree",
          };
        }
        detachedSourceWorktreePath = existing.path;
        await detachCleanWorktreeBranch({
          branchName: baseBranch,
          gitEnv: this.gitEnv,
          runGit: this.runGitCommand,
          worktreePath: existing.path,
        });
      } else if (existingIsRepoRoot) {
        detachedSourceWorktreePath = repoRoot;
        await detachCleanWorktreeBranch({
          branchName: baseBranch,
          gitEnv: this.gitEnv,
          runGit: this.runGitCommand,
          worktreePath: repoRoot,
        });
      }

      const storage = await this.resolveStorage();
      const worktreePath = await computeWorktreePath({
        backend: launchpad.backend,
        codexHome: launchpad.backend === "codex" ? this.codexHome : undefined,
        repoRoot,
        storage,
        homeDir: this.homeDir,
      });
      try {
        await mkdir(path.dirname(worktreePath), { recursive: true });
        await this.runGitCommand(
          repoRoot,
          ["worktree", "add", worktreePath, baseBranch],
          this.gitEnv,
        );
      } catch (error) {
        if (detachedSourceWorktreePath) {
          await restoreDetachedWorktreeBranch({
            branchName: baseBranch,
            gitEnv: this.gitEnv,
            runGit: this.runGitCommand,
            worktreePath: detachedSourceWorktreePath,
          });
        }
        throw error;
      }

      return {
        cwd: worktreePath,
        repositoryPath: repoRoot,
        rollback: async () => {
          await removeWorktreeAndPrune({
            gitEnv: this.gitEnv,
            repoRoot,
            runGit: this.runGitCommand,
            worktreePath,
          });
          if (detachedSourceWorktreePath) {
            await restoreDetachedWorktreeBranch({
              branchName: baseBranch,
              gitEnv: this.gitEnv,
              runGit: this.runGitCommand,
              worktreePath: detachedSourceWorktreePath,
            });
          }
        },
        workMode: "worktree",
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
      rollback: async () => {
        await removeWorktreeAndPrune({
          gitEnv: this.gitEnv,
          repoRoot,
          runGit: this.runGitCommand,
          worktreePath,
        });
      },
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
    // Native path is used for the comparison + git/fs operations below; the
    // returned identifier is forward-slashed (no-op on POSIX).
    const worktreePath = path.resolve(candidate.worktreePath);
    const base: ArchiveThreadCleanupResult = {
      worktreePath: toForwardSlashes(worktreePath),
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
