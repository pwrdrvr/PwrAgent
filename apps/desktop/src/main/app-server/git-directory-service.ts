import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import type {
  AppServerThreadSummary,
  AppServerBackendKind,
  ArchiveThreadCleanupResult,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DesktopWorktreeFolder,
  DesktopWorktreeStorageLocation,
} from "@pwragent/shared/contracts/settings";
import type {
  LaunchpadWorkMode,
  LaunchpadWorktreeBase,
  NavigationDirectoryGitStatus,
  NavigationDirectorySummary,
  NavigationGitBranchDetail,
  NavigationGitCommitSummary,
  NavigationLaunchpadDraft,
} from "@pwragent/shared/contracts/navigation";
import { DESKTOP_WORKTREE_STORAGE_DEFAULT } from "@pwragent/shared/contracts/settings";
import { normalizeGitOriginUrl } from "@pwragent/shared/directory-navigation";
import { readStatusWithoutNestedWorktrees } from "@pwragent/shared/nested-worktree-pathspec";
import { WORKTREE_FOLDER_CODEX_SUBFOLDER } from "@pwragent/shared/worktree-paths";
import { userHomeWorktreesRoot } from "../settings/desktop-config";
import { checkWorktreeFolder, markWorktreeFolder } from "../settings/worktree-folder-check";
import { addManagedWorktree, removeManagedWorktree } from "./managed-worktree";
import { lockWorktreeOnSeparateVolume, readWorktreeLockHolder } from "./worktree-volume-lock";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import { GitReadCache, type GitReadRequest } from "../git-info/read-cache";
import { runGitCommand } from "./git-executable";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";

type GitCommandRunner = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

export type GitWorkspaceInspection =
  | { kind: "non_git" }
  | {
      kind: "worktree";
      branch?: string;
      /** Whether any repository ref resolves to a commit. */
      hasCommits: boolean;
      /** Whether the selected workspace's HEAD resolves to a commit. */
      headHasCommit: boolean;
      worktreeCreationAvailable: boolean;
    }
  | {
      kind: "bare" | "git_directory";
      branch?: string;
      hasCommits: boolean;
      worktreeCreationAvailable: false;
    };

export const UNPUBLISHED_BASE_BRANCH_WORKTREE_REASON =
  "Worktrees are unavailable because this repository has no published base branch yet. Create the initial commit in the Local checkout and publish the default branch. Worktrees will be enabled once a remote base branch is available.";

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

export type StackWorktreeReservation = {
  path: string;
  directory: WorktreePathIdentity;
  commonDir: string;
  branch: string;
  tip: string;
};

export type StackWorktreeStart = {
  prepare(): Promise<PreparedLaunchpadWorkspace>;
  admit(submit: () => Promise<{ threadId: string; codexHome?: string }>): Promise<{ threadId: string }>;
};

type WorktreePathIdentity = { dev: string; ino: string; birthtimeNs: string };

function worktreePathIdentity(stats: BigIntStats): WorktreePathIdentity {
  return { dev: String(stats.dev), ino: String(stats.ino), birthtimeNs: String(stats.birthtimeNs) };
}

function matchesWorktreePathIdentity(stats: BigIntStats, expected: WorktreePathIdentity): boolean {
  const actual = worktreePathIdentity(stats);
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.birthtimeNs === expected.birthtimeNs;
}

async function statIfPresent(filename: string) {
  return await lstat(filename, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export class WorktreeBranchAlreadyCheckedOutError extends Error {
  constructor(readonly branch: string, readonly worktreePath: string) {
    super(`Branch ${JSON.stringify(branch)} is already checked out at ${JSON.stringify(worktreePath)}.`);
  }
}

async function defaultRunGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return (await runGitCommand(cwd, args, { env, purpose: "directory-status" })).stdout.trim();
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
  return errorText(error).toLowerCase().includes("not a git repository");
}

export async function inspectGitWorkspace(
  cwd: string,
  options: {
    env?: NodeJS.ProcessEnv;
    runGit?: GitCommandRunner;
  } = {},
): Promise<GitWorkspaceInspection> {
  const runGit = options.runGit ?? defaultRunGit;
  let insideWorktree: string;
  try {
    insideWorktree = (
      await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], options.env)
    ).trim();
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return { kind: "non_git" };
    }
    throw error;
  }
  if (insideWorktree !== "true" && insideWorktree !== "false") {
    throw new Error(
      `Git returned an unexpected workspace probe result for ${cwd}: ${insideWorktree}`,
    );
  }

  let kind: Exclude<GitWorkspaceInspection["kind"], "non_git"> = "worktree";
  if (insideWorktree === "false") {
    const bareRepository = (
      await runGit(cwd, ["rev-parse", "--is-bare-repository"], options.env)
    ).trim();
    if (bareRepository !== "true" && bareRepository !== "false") {
      throw new Error(
        `Git returned an unexpected bare-repository probe result for ${cwd}: ${bareRepository}`,
      );
    }
    kind = bareRepository === "true" ? "bare" : "git_directory";
  }

  const [rawBranch, anyCommit] = await Promise.all([
    runGit(cwd, ["branch", "--show-current"], options.env),
    runGit(cwd, ["rev-list", "--max-count=1", "--all"], options.env),
  ]);
  const hasCommits = Boolean(anyCommit.trim());
  const currentBranch = rawBranch.trim();
  const branch = currentBranch || (hasCommits ? "HEAD" : undefined);
  if (kind !== "worktree") {
    return {
      kind,
      branch,
      hasCommits,
      worktreeCreationAvailable: false,
    };
  }

  let headHasCommit = true;
  try {
    await runGit(
      cwd,
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      options.env,
    );
  } catch (error) {
    if (!currentBranch) {
      throw error;
    }
    const currentBranchObject = await runGit(
      cwd,
      ["for-each-ref", "--format=%(objectname)", `refs/heads/${currentBranch}`],
      options.env,
    );
    if (currentBranchObject.trim()) {
      throw error;
    }
    headHasCommit = false;
  }
  let remoteBranchCommit = "";
  if (!headHasCommit) {
    remoteBranchCommit = await runGit(
      cwd,
      ["rev-list", "--max-count=1", "--remotes"],
      options.env,
    );
  }

  return {
    kind,
    branch,
    hasCommits,
    headHasCommit,
    worktreeCreationAvailable:
      headHasCommit || Boolean(remoteBranchCommit.trim()),
  };
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
  preserveExisting?: boolean;
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
  const content = `${JSON.stringify({ version: 1, ownerThreadId: threadId }, null, 2)}\n`;
  if (!params.preserveExisting) {
    await writeFile(ownerFile, content, "utf8");
    return;
  }
  const temporary = `${ownerFile}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    // A same-directory hard link publishes the completed file without
    // replacing an owner which claimed this checkout concurrently.
    await link(temporary, ownerFile).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" || !await matchesStackWorktreeOwner(ownerFile, threadId)) throw error;
    });
  } finally {
    await unlink(temporary);
  }
}

async function matchesStackWorktreeOwner(ownerFile: string, threadId?: string): Promise<boolean> {
  const stat = await statIfPresent(ownerFile);
  return !stat || (stat.isFile() && stat.size <= 4096n && Boolean(threadId)
    && JSON.parse(await readFile(ownerFile, "utf8")).ownerThreadId === threadId);
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
    worktreeFolder?: DesktopWorktreeFolder;
  },
): string {
  const folder = options?.worktreeFolder;
  if (storage === "user-home" && options?.backend === "codex") {
    // Codex Desktop lists only worktrees under $CODEX_HOME/worktrees, so
    // Codex threads leave it only when the operator opts them in.
    if (folder?.includeCodex) return path.join(folder.directory, WORKTREE_FOLDER_CODEX_SUBFOLDER);
    return codexHomeWorktreesRoot({
      codexHome: options.codexHome,
      homeDir: options.homeDir,
    });
  }

  if (storage !== "user-home") return path.join(repoRoot, ".worktrees");
  // The operator's folder is the root itself: worktrees go straight into it.
  return folder ? folder.directory : userHomeWorktreesRoot(options?.homeDir);
}

/**
 * The operator's worktree folder is used as given, never created: with an
 * external drive unmounted, `mkdir -p /Volumes/<drive>/...` would silently
 * put worktrees on the startup disk. Only the Codex subfolder is created
 * inside it. A folder that already holds other files is refused, and an
 * accepted one is marked as PwrAgent's before its first worktree.
 */
async function assertWorktreeBaseDirectoryAvailable(baseDirectory: string): Promise<void> {
  const status = await checkWorktreeFolder(baseDirectory);
  if (status === "in-use") {
    throw new Error(
      `Worktree folder ${baseDirectory} already holds other files. Choose an empty folder in Settings → Worktrees.`,
    );
  }
  if (status === "not-responding") {
    throw new Error(
      `Worktree folder ${baseDirectory} is not responding. Check the drive or network share, or choose another folder in Settings → Worktrees.`,
    );
  }
  if (status !== "available") {
    throw new Error(
      `Worktree folder ${baseDirectory} is not available. Connect the drive or choose another folder in Settings → Worktrees.`,
    );
  }
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

export async function releaseWorktreePathReservation(
  worktreePath: string,
): Promise<void> {
  await pruneEmptyWorktreeParents(worktreePath);
}

async function removeWorktreeAndPrune(params: {
  gitEnv?: NodeJS.ProcessEnv;
  repoRoot: string;
  runGit: GitCommandRunner;
  worktreePath: string;
}): Promise<void> {
  await removeManagedWorktree({
    worktreePath: params.worktreePath,
    force: true,
    git: (args) => params.runGit(params.repoRoot, args, params.gitEnv),
  });
  await pruneEmptyWorktreeParents(params.worktreePath);
}

export async function computeWorktreePath(params: {
  backend?: AppServerBackendKind;
  codexHome?: string;
  repoRoot: string;
  storage: DesktopWorktreeStorageLocation;
  homeDir?: string;
  timestamp?: number;
  /** Operator-chosen folder that replaces the home folder for `user-home`. */
  worktreeFolder?: DesktopWorktreeFolder;
}): Promise<string> {
  // Resolved, so a trailing slash or `..` cannot slip past the guard below.
  const directory = params.worktreeFolder?.directory.trim();
  const worktreeFolder = directory ? { ...params.worktreeFolder!, directory: path.resolve(directory) } : undefined;
  const root = worktreesRootFor(params.repoRoot, params.storage, {
    backend: params.backend,
    codexHome: params.codexHome,
    homeDir: params.homeDir,
    worktreeFolder,
  });
  const projectName = path.basename(path.resolve(params.repoRoot)) || "project";
  const baseTimestamp = params.timestamp ?? Date.now();
  if (worktreeFolder && (root === worktreeFolder.directory || path.dirname(root) === worktreeFolder.directory)) {
    await assertWorktreeBaseDirectoryAvailable(worktreeFolder.directory);
    await markWorktreeFolder(worktreeFolder.directory);
  }
  await mkdir(root, { recursive: true });

  for (
    let timestampIncrement = 0;
    timestampIncrement <= 10;
    timestampIncrement += 1
  ) {
    const hash = (baseTimestamp + timestampIncrement).toString(36);
    const hashParent = path.join(root, hash);
    try {
      // Reserving the hash directory makes path allocation atomic across
      // concurrent calls and separate PwrAgent processes. Git accepts the
      // still-missing project directory beneath this empty parent.
      await mkdir(hashParent);
      return path.join(hashParent, projectName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
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

function parseGitWorktreeEntries(output: string, separator = "\n"): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const line of output.split(separator)) {
    if (line.startsWith("worktree ")) {
      const worktreePath = line.slice("worktree ".length);
      current = {
        path: separator === "\0" ? worktreePath : worktreePath.trim(),
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

async function readWorktreeEntries(params: {
  repoRoot: string;
  gitEnv?: NodeJS.ProcessEnv;
  runGit: GitCommandRunner;
}): Promise<WorktreeEntry[]> {
  const output = await params.runGit(
    params.repoRoot, ["worktree", "list", "--porcelain", "-z"], params.gitEnv,
  );
  return parseGitWorktreeEntries(output, "\0");
}

function findOtherBranchCheckout(
  entries: WorktreeEntry[], branch: string, worktreePath: string,
): WorktreeEntry | undefined {
  return entries.find((entry) => entry.branch === branch && path.relative(worktreePath, entry.path) !== "");
}

async function addExclusiveAttachedWorktree(params: {
  branch: string;
  repoRoot: string;
  gitEnv?: NodeJS.ProcessEnv;
  runGit: GitCommandRunner;
  worktreePath: string;
}): Promise<void> {
  const { branch, repoRoot, runGit, worktreePath } = params;
  let addSucceeded = false;
  let entries: WorktreeEntry[] | undefined;
  try {
    const env = { ...(params.gitEnv ?? process.env), LC_ALL: "C", LANGUAGE: "C" };
    await addManagedWorktree({
      repoRoot, worktreePath, addArgs: ["--", worktreePath, branch], git: (args) => runGit(repoRoot, args, env),
    });
    addSucceeded = true;
    entries = await readWorktreeEntries(params);
    const checkoutPath = await normalizeFilesystemPath(worktreePath);
    const occupied = findOtherBranchCheckout(entries, branch, checkoutPath);
    if (occupied) {
      throw new WorktreeBranchAlreadyCheckedOutError(branch, occupied.path);
    }
  } catch (error) {
    entries ??= await readWorktreeEntries(params).catch(() => undefined);
    const checkoutPath = await normalizeFilesystemPath(worktreePath);
    const registered = addSucceeded || entries?.some((entry) => path.relative(checkoutPath, entry.path) === "");
    if (registered) {
      // Git may register the checkout before a failing post-checkout hook.
      // Only roll back the path allocated by this operation.
      try {
        await removeWorktreeAndPrune(params);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${errorText(error)}\nCould not remove ${worktreePath}: ${errorText(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }

    await pruneEmptyWorktreeParents(worktreePath);
    const occupied = findOtherBranchCheckout(entries ?? [], branch, checkoutPath);
    // Git reserves branches for operations such as rebase even when the
    // worktree inventory shows that checkout as detached.
    const refusal = /^fatal: '(.+)' is already (?:used by worktree|checked out) at '(.+)'\r?$/m.exec(errorText(error));
    const refusedPath = refusal?.[1] === branch ? refusal[2] : undefined;
    const occupiedPath = occupied?.path ?? refusedPath;
    if (occupiedPath) {
      throw new WorktreeBranchAlreadyCheckedOutError(branch, occupiedPath);
    }
    throw error;
  }
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
  const remoteHead = params.remoteHead.trim();
  const localRemoteHead = remoteHead.replace(/^origin\//, "");
  if (localRemoteHead && params.branches.includes(localRemoteHead)) {
    return localRemoteHead;
  }
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

/**
 * What a worktree starts from when the launchpad names no base branch.
 * `current_branch` follows the source checkout, as the launchpad picker does.
 * `default_branch` skips it: a source worktree's branch can hold another
 * thread's unpublished work, which a standalone follow-up must not inherit.
 */
export type WorktreeBaseSource = LaunchpadWorktreeBase;

async function resolveVerifiedWorktreeBaseBranch(params: {
  repoRoot: string;
  sourceRoot?: string;
  requestedBranch?: string;
  requireLocalBranch?: boolean;
  exactRequestedBranch?: boolean;
  worktreeBase?: WorktreeBaseSource;
  gitEnv?: NodeJS.ProcessEnv;
  runGit?: GitCommandRunner;
}): Promise<string | undefined> {
  const runGit = params.runGit ?? defaultRunGit;
  if (params.exactRequestedBranch) {
    const requested = params.requestedBranch?.trim();
    if (params.requireLocalBranch) {
      const branch = requested?.replace(/^refs\/heads\//, "");
      const ref = `refs/heads/${branch ?? ""}`;
      const refs = branch ? await runGit(
        params.repoRoot,
        ["for-each-ref", "--format=%(refname)", "--", ref],
        params.gitEnv,
      ) : "";
      if (branch && refs.split(/\r?\n/).includes(ref)) {
        return branch;
      }
      throw new Error(`Branch ${JSON.stringify(requested ?? "")} must name an existing local branch for an attached worktree.`);
    }
    if (requested) {
      return await runGit(
        params.sourceRoot ?? params.repoRoot,
        ["rev-parse", "--verify", "--end-of-options", `${requested}^{commit}`],
        params.gitEnv,
      ).catch(() => "");
    }
  }
  const requestedBranch = sanitizeBranchName(params.requestedBranch ?? "");
  if (requestedBranch && requestedBranch !== "HEAD") {
    const requestedRef = params.requireLocalBranch
      ? `refs/heads/${requestedBranch}`
      : requestedBranch;
    const commit = await runGit(
      params.repoRoot,
      ["rev-parse", "--verify", `${requestedRef}^{commit}`],
      params.gitEnv,
    ).catch(() => "");
    return commit ? requestedBranch : undefined;
  }

  const sourceRoot = params.sourceRoot ?? params.repoRoot;
  const followCurrentBranch = params.worktreeBase !== "default_branch";
  const [rawCurrentBranch, baseBranchesOutput, remoteHead] = await Promise.all([
    followCurrentBranch
      ? runGit(sourceRoot, ["rev-parse", "--abbrev-ref", "HEAD"], params.gitEnv).catch(
        () => "",
      )
      : "",
    runGit(
      params.repoRoot,
      [
        "for-each-ref",
        "refs/heads",
        ...(params.requireLocalBranch ? [] : ["refs/remotes"]),
        "--sort=-committerdate",
        "--format=%(refname)%09%(refname:short)%09%(committerdate:unix)%09%(symref)",
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
  const baseBranches = parseGitBaseBranchDetails(baseBranchesOutput).map(
    (detail) => detail.name,
  );
  const defaultBranch = resolveDefaultBranch({
    branches: baseBranches,
    remoteHead,
  });
  const candidates = uniqueBranches([
    currentBranch,
    defaultBranch,
    ...baseBranches,
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
  // A linked worktree nested in this checkout is another checkout, not a
  // change, so it does not block the move.
  const status = await readStatusWithoutNestedWorktrees({
    cwd: params.worktreePath,
    git: (args) => params.runGit(params.worktreePath, args, params.gitEnv),
    statusArgs: ["status", "--porcelain", "--untracked-files=normal"],
    realpath: (value) => realpath(value),
  }).catch(() => "");
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
  /** Folder that replaces the home folder for `user-home` worktrees. */
  resolveWorktreeFolder?: () =>
    | DesktopWorktreeFolder
    | undefined
    | Promise<DesktopWorktreeFolder | undefined>;
  homeDir?: string;
};

export class GitDirectoryService {
  private readonly statusCache: GitReadCache<NavigationDirectoryGitStatus | undefined>;
  private readonly branchInventoryCache = new Map<string, CachedBranchInventory>();
  private readonly commonGitDirByCwd = new Map<string, string>();
  // Git worktree commands update the shared common Git directory. Git for
  // Windows can observe half-initialized worktree metadata when two launchpads
  // mutate that directory at once, so a repository owns its whole launchpad
  // worktree transaction. Different repositories still proceed in parallel.
  private readonly worktreeMutationLocks = new PerKeyAsyncLock();

  withStackWorktreeMutation<T>(commonDir: string, operation: () => Promise<T>): Promise<T> {
    return this.worktreeMutationLocks.run(commonDir, operation);
  }
  private readonly cacheTtlMs: number;
  private readonly statusConcurrency: number;
  private readonly statusMaxUnread: number;
  private readonly codexHome?: string;
  private readonly gitEnv?: NodeJS.ProcessEnv;
  private readonly runGitCommand: GitCommandRunner;
  private readonly resolveStorage: () => Promise<DesktopWorktreeStorageLocation>;
  private readonly resolveWorktreeFolder: () => Promise<DesktopWorktreeFolder | undefined>;
  private readonly homeDir: string;

  constructor(options: GitDirectoryServiceOptions | number = {}) {
    const normalized: GitDirectoryServiceOptions =
      typeof options === "number" ? { cacheTtlMs: options } : options;
    this.cacheTtlMs = normalized.cacheTtlMs ?? 3_000;
    this.statusCache = new GitReadCache({ ttlMs: this.cacheTtlMs });
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
    const resolveWorktreeFolder = normalized.resolveWorktreeFolder;
    this.resolveWorktreeFolder = async () => await resolveWorktreeFolder?.();
  }

  async inspectWorkspaceGit(cwd: string): Promise<GitWorkspaceInspection> {
    return await inspectGitWorkspace(cwd, {
      env: this.gitEnv,
      runGit: this.runGitCommand,
    });
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

  readDirectoryStatusEntries<T extends Pick<NavigationDirectorySummary, "key" | "path">>(
    directories: T[],
    request: GitReadRequest = {},
  ): AsyncIterable<DirectoryGitStatusEntry> {
    return new IterableMapper(
      directories,
      async (directory): Promise<DirectoryGitStatusEntry> => ({
        directoryKey: directory.key,
        gitStatus: await this.readDirectoryStatus(directory, request),
      }),
      {
        concurrency: this.statusConcurrency,
        maxUnread: this.statusMaxUnread,
      },
    );
  }

  async readDirectoryStatus(
    directory: Pick<NavigationDirectorySummary, "path">,
    request: GitReadRequest = {},
  ): Promise<NavigationDirectoryGitStatus | undefined> {
    const cwd = directory.path?.trim() ? path.resolve(directory.path.trim()) : undefined;
    if (!cwd) {
      return undefined;
    }

    return this.statusCache.read(cwd, async ({ userRefresh }) => {
      try {
        return await this.loadDirectoryStatus(cwd, userRefresh);
      } catch (error) {
        return {
          syncState: "status-unavailable",
          statusUnavailableReason: error instanceof Error ? error.message : String(error),
        };
      }
    }, request);
  }

  invalidateDirectoryStatus(directoryPath?: string): void {
    const normalizedPath = directoryPath?.trim() ? path.resolve(directoryPath.trim()) : undefined;
    if (!normalizedPath) {
      return;
    }

    this.statusCache.invalidate(normalizedPath);
    gitSubprocessDiagnostics.observeRepository(normalizedPath);
    const commonGitDir = this.commonGitDirByCwd.get(normalizedPath);
    if (commonGitDir) {
      this.branchInventoryCache.delete(commonGitDir);
      this.commonGitDirByCwd.delete(normalizedPath);
    }
  }

  private async loadDirectoryStatus(
    cwd: string,
    userRefresh: boolean,
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
    gitSubprocessDiagnostics.observeRepository(cwd, commonGitDir);
    gitSubprocessDiagnostics.observeRepository(repoRoot, commonGitDir);

    const [
      rawCurrentBranch,
      branchInventory,
      recentCommitsOutput,
      workspaceInspection,
      rawRemoteUrls,
    ] = await Promise.all([
      runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], gitEnv).catch(
        () => "",
      ),
      this.readBranchInventory({ commonGitDir, repoRoot, userRefresh }),
      runGit(
        repoRoot,
        [
          "log",
          `--max-count=${MAX_TRACKED_COMMITS}`,
          "--format=%H%x1f%h%x1f%ct%x1f%s",
        ],
        gitEnv,
      ).catch(() => ""),
      inspectGitWorkspace(cwd, { env: gitEnv, runGit }),
      // One local config read, no network. Fetch URLs also link a fork to
      // its upstream; push URLs do not establish project identity.
      runGit(repoRoot, ["config", "--get-regexp", "^remote\\..*\\.url$"], gitEnv).catch(
        () => "",
      ),
    ]);
    const currentBranch =
      rawCurrentBranch.trim() === "HEAD" ? "" : rawCurrentBranch.trim();
    const seenRemoteKeys = new Set<string>();
    const remotes = rawRemoteUrls.split(/\r?\n/).flatMap((line) => {
      const match = /^(remote\..*\.url)(?:\s+(.*))?$/.exec(line);
      if (!match || seenRemoteKeys.has(match[1]!)) {
        return [];
      }
      // Git fetches only the first URL of each remote. Later URL entries
      // are push destinations, even when the first URL cannot be advertised.
      seenRemoteKeys.add(match[1]!);
      const remoteUrl = match[2]?.trim() ?? "";
      // A local remote can support a handoff, but its path cannot identify
      // a project on a different machine.
      if (/^(?:[\\/]|\.{1,2}[\\/]|[a-z]:[\\/]|file:)/i.test(remoteUrl)) {
        return [];
      }
      const repository = normalizeGitOriginUrl(remoteUrl);
      return repository ? [{ configKey: match[1]!, repository }] : [];
    });
    const originRepository = remotes.find((remote) => remote.configKey === "remote.origin.url")?.repository;
    const remoteRepositories = [...new Set(remotes.map((remote) => remote.repository))].sort();
    const origin = {
      ...(originRepository ? { originRepository } : {}),
      ...(remoteRepositories.length ? { remoteRepositories } : {}),
    };
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
    // Resolve against the full local + remote list so an unborn checkout can
    // retain its remote default even when a newer remote branch sorts first.
    const defaultBranch = resolveDefaultBranch({
      branches: parsedBaseBranchDetailsAll.map((detail) => detail.name),
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
    const unbornWorktreeAvailability =
      workspaceInspection.kind === "worktree" && !workspaceInspection.headHasCommit
        ? {
            worktreeCreationAvailable:
              workspaceInspection.worktreeCreationAvailable,
            ...(!workspaceInspection.worktreeCreationAvailable
              ? {
                  worktreeCreationUnavailableReason:
                    UNPUBLISHED_BASE_BRANCH_WORKTREE_REASON,
                }
              : {}),
          }
        : {};
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
        ...origin,
        ...unbornWorktreeAvailability,
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
        ...origin,
        ...unbornWorktreeAvailability,
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
      ...origin,
      ...unbornWorktreeAvailability,
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
    userRefresh: boolean;
  }): Promise<BranchInventory> {
    const cached = this.branchInventoryCache.get(params.commonGitDir);
    const now = Date.now();
    if (cached?.inFlight) {
      return await cached.inFlight;
    }

    if (!params.userRefresh && cached?.inventory && cached.expiresAt > now) {
      return cached.inventory;
    }

    const inFlight = this.loadBranchInventory(params.repoRoot)
      .then((inventory) => {
        this.branchInventoryCache.set(params.commonGitDir, {
          expiresAt: Date.now() + this.cacheTtlMs,
          inventory,
        });
        return inventory;
      })
      .catch((error) => {
        const current = this.branchInventoryCache.get(params.commonGitDir);
        if (current?.inFlight === inFlight) {
          if (current.inventory) {
            this.branchInventoryCache.set(params.commonGitDir, {
              expiresAt: current.expiresAt,
              inventory: current.inventory,
            });
          } else {
            this.branchInventoryCache.delete(params.commonGitDir);
          }
        }
        throw error;
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
      ),
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
      ),
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

  /**
   * Reserves a Codex worktree path for `repoRoot` under the operator's
   * Worktrees storage setting, the same location a launchpad worktree gets.
   * The caller creates the worktree and releases the reservation on failure.
   */
  async allocateCodexWorktreePath(repoRoot: string): Promise<string> {
    return await computeWorktreePath({
      backend: "codex",
      codexHome: this.codexHome,
      repoRoot,
      storage: await this.resolveStorage(),
      worktreeFolder: await this.resolveWorktreeFolder(),
      homeDir: this.homeDir,
    });
  }

  // Stack callers hold the clone's worktree mutation lock and the operation
  // journal lock across reservation, checkout creation and provider admission.
  async reserveStackWorktree(params: {
    cwd: string; commonDir: string; backend: AppServerBackendKind; branch: string; tip: string;
  }): Promise<StackWorktreeReservation> {
    const { cwd, commonDir, backend, branch, tip } = params;
    const [primary] = await readWorktreeEntries({ repoRoot: cwd, runGit: this.runGitCommand, gitEnv: this.gitEnv });
    const repoRoot = primary?.path;
    if (!repoRoot) throw new Error("Cannot locate the primary checkout for the stack worktree.");
    const allocated = await computeWorktreePath({
      backend, repoRoot, codexHome: backend === "codex" ? this.codexHome : undefined,
      storage: await this.resolveStorage(), worktreeFolder: await this.resolveWorktreeFolder(), homeDir: this.homeDir,
    });
    const parent = await realpath(path.dirname(allocated));
    const checkout = path.join(parent, path.basename(allocated));
    // Git can populate an existing empty directory without replacing it.
    // Persist its identity before Git runs so a replacement is never ours.
    await mkdir(checkout, { mode: 0o700 });
    return {
      path: checkout,
      directory: worktreePathIdentity(await lstat(checkout, { bigint: true })),
      commonDir, branch, tip,
    };
  }

  async prepareStackWorktree(cwd: string, reservation: StackWorktreeReservation, options: {
    create: boolean; ownerThreadId?: string; onAddFailed?: () => Promise<void>;
  }): Promise<Required<Pick<PreparedLaunchpadWorkspace, "cwd" | "repositoryPath" | "workMode">>> {
    const { path: checkout, commonDir, branch, tip, directory } = reservation;
    const git = (at: string, args: string[]) => this.runGitCommand(at, args, this.gitEnv);
    const verifyClone = async (at: string) => path.relative(commonDir,
      await realpath((await git(at, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim())) === "";
    const refused = () => new Error(`Cannot verify the reserved stack worktree at ${checkout}. Its files were kept.`);
    const directoryMatches = async () => {
      const stat = await statIfPresent(checkout);
      return stat?.isDirectory() && matchesWorktreePathIdentity(stat, directory)
        && path.relative(checkout, await realpath(checkout)) === "";
    };
    if (!path.isAbsolute(checkout) || !await directoryMatches() || !await verifyClone(cwd)) throw refused();

    const readEntries = () => readWorktreeEntries({ repoRoot: cwd, runGit: this.runGitCommand, gitEnv: this.gitEnv });
    let entries = await readEntries();
    const repoRoot = entries[0]?.path;
    if (!repoRoot || path.relative(repoRoot, checkout) === "") throw refused();
    const branchRef = `refs/heads/${branch}`;
    if ((await git(cwd, ["rev-parse", "--verify", branchRef])).trim() !== tip) throw refused();
    const pointer = path.join(checkout, ".git");
    let added = false;
    if (!await statIfPresent(pointer)) {
      if (!options.create || entries.some((entry) => entry.branch === branch
        || path.relative(checkout, entry.path) === "") || (await readdir(checkout)).length !== 0) throw refused();
      // Never detach another checkout or force-remove a partial checkout. Git
      // can finish the add before the host sees its result (e.g. a checkout hook).
      try {
        await addManagedWorktree({ repoRoot, worktreePath: checkout, addArgs: ["--", checkout, branch], git: (args) => git(repoRoot, args) });
      } catch (error) {
        // A failing post-checkout hook can leave a valid-looking checkout.
        if (await statIfPresent(pointer)) await options.onAddFailed?.();
        throw error;
      }
      added = true;
      entries = await readEntries();
    }
    const branchEntries = entries.filter((entry) => entry.branch === branch);
    if (!await directoryMatches() || branchEntries.length !== 1 || path.relative(checkout, branchEntries[0]!.path) !== ""
      || !(await statIfPresent(pointer))?.isFile() || !await verifyClone(checkout)
      || path.relative(checkout, await realpath((await git(checkout, ["rev-parse", "--show-toplevel"])).trim())) !== ""
      || (await git(checkout, ["symbolic-ref", "HEAD"])).trim() !== branchRef
      || (await git(checkout, ["rev-parse", "--verify", "HEAD"])).trim() !== tip) throw refused();
    const gitDir = (await git(checkout, ["rev-parse", "--absolute-git-dir"])).trim();
    if (!(await statIfPresent(path.join(gitDir, "index")))?.isFile() || await readWorktreeLockHolder(gitDir) === "other") throw refused();
    const ownerFile = path.join(gitDir, "codex-thread.json");
    if (!await matchesStackWorktreeOwner(ownerFile, options.ownerThreadId)) throw refused();
    // A crash can leave Git's checkout in place before the managed add locks
    // it against pruning on removal of an external drive.
    if (options.create && !added) await lockWorktreeOnSeparateVolume({ repoRoot, worktreePath: checkout, git: (args) => git(repoRoot, args) });
    return { cwd: toForwardSlashes(checkout), repositoryPath: toForwardSlashes(repoRoot), workMode: "worktree" };
  }

  async prepareLaunchpadWorkspace(
    launchpad: Pick<
      NavigationLaunchpadDraft,
      "branchName" | "directoryKind" | "directoryLabel" | "directoryPath" | "workMode"
    > &
      Partial<Pick<NavigationLaunchpadDraft, "backend">> & {
        excludedWorktreePaths?: string[];
        worktreeBranchMode?: "attached" | "detached";
        rejectOccupiedBranch?: boolean;
        worktreeBase?: WorktreeBaseSource;
      },
  ): Promise<PreparedLaunchpadWorkspace> {
    const prepare = async (): Promise<PreparedLaunchpadWorkspace> =>
      await this.prepareLaunchpadWorkspaceInternal(launchpad);
    const directoryPath = launchpad.directoryPath?.trim();
    const sourceRoot =
      launchpad.directoryKind !== "workspace" &&
      launchpad.workMode === "worktree" &&
      directoryPath
        ? await readGitRoot(directoryPath, this.runGitCommand, this.gitEnv)
        : undefined;
    const prepared = sourceRoot
      ? await this.worktreeMutationLocks.run(
          await readGitCommonDir({
            repoRoot: sourceRoot,
            runGit: this.runGitCommand,
            env: this.gitEnv,
          }),
          prepare,
        )
      : await prepare();
    // Forward-slash the returned identifier fields (no-op on POSIX). The
    // `rollback` closure captured the native worktree path internally, so
    // it keeps operating on the real fs path regardless of this rewrite.
    return {
      ...prepared,
      cwd: toForwardSlashesOptional(prepared.cwd),
      repositoryPath: toForwardSlashesOptional(prepared.repositoryPath),
    };
  }

  async resolvePrimaryWorkspacePath(
    cwd: string | undefined,
    options: { requireRegisteredWorktree?: boolean } = {},
  ): Promise<string | undefined> {
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
    if (options.requireRegisteredWorktree) {
      const worktrees = parseGitWorktreeEntries(
        await this.runGitCommand(sourceRoot, ["worktree", "list", "--porcelain"], this.gitEnv),
      );
      const [resolvedRoot, resolvedDirectory] = await Promise.all([
        realpath(sourceRoot),
        realpath(directoryPath),
      ]);
      // core.worktree can make rev-parse name a root outside the requested
      // directory. Such a root cannot establish trust for the destination.
      const relativeDirectory = path.relative(resolvedRoot, resolvedDirectory);
      if (
        relativeDirectory === ".."
        || relativeDirectory.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeDirectory)
      ) {
        return undefined;
      }
      for (const worktree of worktrees) {
        const registeredPath = await realpath(worktree.path).catch(() => undefined);
        if (registeredPath && path.relative(registeredPath, resolvedRoot) === "") {
          return worktrees[0]?.path ? toForwardSlashes(worktrees[0].path) : undefined;
        }
      }
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
        rejectOccupiedBranch?: boolean;
        worktreeBase?: WorktreeBaseSource;
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
    const workspaceInspection = await inspectGitWorkspace(directoryPath, {
      env: this.gitEnv,
      runGit: this.runGitCommand,
    });
    if (
      workspaceInspection.kind !== "worktree"
      || !workspaceInspection.worktreeCreationAvailable
    ) {
      return {
        cwd: directoryPath,
        workMode: "local",
      };
    }
    const repoRoot =
      (await readPrimaryWorktreePath(sourceRoot, this.runGitCommand, this.gitEnv))
      ?? sourceRoot;

    const strictBranchCheckout = launchpad.worktreeBranchMode === "attached" && launchpad.rejectOccupiedBranch;
    const baseBranch = await resolveVerifiedWorktreeBaseBranch({
      gitEnv: this.gitEnv,
      repoRoot,
      requestedBranch: launchpad.branchName,
      requireLocalBranch: launchpad.worktreeBranchMode === "attached",
      exactRequestedBranch: launchpad.rejectOccupiedBranch,
      runGit: this.runGitCommand,
      sourceRoot,
      worktreeBase: launchpad.worktreeBase,
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
      const worktrees = strictBranchCheckout
        ? await readWorktreeEntries({ repoRoot, gitEnv: this.gitEnv, runGit: this.runGitCommand })
        : parseGitWorktreeEntries(await this.runGitCommand(
          repoRoot,
          ["worktree", "list", "--porcelain"],
          this.gitEnv,
        ).catch(() => ""));
      const existing = worktrees.find((entry) => entry.branch === baseBranch);
      if (existing && strictBranchCheckout) {
        throw new WorktreeBranchAlreadyCheckedOutError(baseBranch, existing.path);
      }
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

      try {
        const storage = await this.resolveStorage();
        const worktreePath = await computeWorktreePath({
          backend: launchpad.backend,
          codexHome: launchpad.backend === "codex" ? this.codexHome : undefined,
          repoRoot,
          storage,
          worktreeFolder: await this.resolveWorktreeFolder(),
          homeDir: this.homeDir,
        });
        if (strictBranchCheckout) {
          await addExclusiveAttachedWorktree({
            branch: baseBranch, repoRoot, worktreePath, gitEnv: this.gitEnv, runGit: this.runGitCommand,
          });
        } else {
          try {
            await mkdir(path.dirname(worktreePath), { recursive: true });
            await addManagedWorktree({
              repoRoot,
              worktreePath,
              addArgs: ["--", worktreePath, baseBranch],
              git: (args) => this.runGitCommand(repoRoot, args, this.gitEnv),
            });
          } catch (error) {
            await pruneEmptyWorktreeParents(worktreePath);
            throw error;
          }
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
    }

    const storage = await this.resolveStorage();
    const worktreePath = await computeWorktreePath({
      backend: launchpad.backend,
      codexHome: launchpad.backend === "codex" ? this.codexHome : undefined,
      repoRoot,
      storage,
      worktreeFolder: await this.resolveWorktreeFolder(),
      homeDir: this.homeDir,
    });
    await mkdir(path.dirname(worktreePath), { recursive: true });
    try {
      await addManagedWorktree({
        repoRoot,
        worktreePath,
        addArgs: ["--detach", worktreePath, baseBranch],
        git: (args) => this.runGitCommand(repoRoot, args, this.gitEnv),
      });
    } catch (error) {
      await pruneEmptyWorktreeParents(worktreePath);
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
      },
      workMode: "worktree",
    };
  }

  async recordCodexWorktreeOwnerThread(params: {
    worktreePath: string;
    threadId: string;
    preserveExisting?: boolean;
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
      await removeManagedWorktree({ worktreePath, force: true, git: (args) => runGit(repoRoot, args, gitEnv) });
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
