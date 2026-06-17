import path from "node:path";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import type {
  AppServerThreadActivityDetail,
  EditGroupCommitInput,
  EditGroupCommitState,
  ThreadGitWorkingState,
  WorktreeOtherChangeEntry,
  WorktreeOtherChangeStatus,
} from "@pwragent/shared";
import { resolveGitExecutable, runGitCommand } from "./git-executable";

function normalizeAbsolutePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

/** Bounded concurrency for the per-group `git log`/`rev-list` commit probes. */
const EDIT_COMMIT_RESOLVE_CONCURRENCY = 4;
const DEFAULT_OTHER_CHANGES_MAX_FILES = 50;
const HARD_OTHER_CHANGES_MAX_FILES = 100;
const OTHER_CHANGES_MAX_FILES_PER_TOP_LEVEL = 20;
const DEFAULT_OTHER_CHANGE_DIFF_MAX_BYTES = 200_000;
const HARD_OTHER_CHANGE_DIFF_MAX_BYTES = 500_000;
const UNTRACKED_DIRECTORY_EXPANSION_MAX_BYTES = 128_000;
const UNTRACKED_DIRECTORY_EXPANSION_TIMEOUT_MS = 1_500;

type GitCommandRunner = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<string>;
type UntrackedPathFilter = (repoPath: string) => boolean;

type AcceptedPushedCommitOptions = {
  acceptedPushedCommitShas?: string[];
};

function buildAcceptedPushedCommitSet(
  commitShas: string[] | undefined,
): Set<string> {
  return new Set(
    (commitShas ?? [])
      .map((sha) => sha.trim().toLowerCase())
      .filter((sha) => /^[0-9a-f]{40}$/.test(sha)),
  );
}

function buildWorkingStateCacheKey(
  worktreePath: string,
  acceptedPushedCommitShas: string[] | undefined,
): string {
  const accepted = [...buildAcceptedPushedCommitSet(acceptedPushedCommitShas)]
    .sort()
    .join(",");
  return accepted ? `${worktreePath}\0${accepted}` : worktreePath;
}

async function defaultRunGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return (await runGitCommand(cwd, args, { env })).stdout;
}

function parseNumstat(output: string): {
  files: number;
  additions: number;
  deletions: number;
} {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of output.split("\n")) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) {
      continue;
    }
    files += 1;
    if (match[1] !== "-") {
      additions += Number(match[1]);
    }
    if (match[2] !== "-") {
      deletions += Number(match[2]);
    }
  }
  return { files, additions, deletions };
}

function clampPositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), max));
}

function normalizeGitRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function statusCodeToChangeStatus(
  indexCode: string,
  worktreeCode: string,
): WorktreeOtherChangeStatus {
  const code = indexCode !== " " && indexCode !== "?" ? indexCode : worktreeCode;
  switch (code) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "T":
      return "typechange";
    case "?":
      return "untracked";
    default:
      return "unknown";
  }
}

function parseStatusPorcelainRecord(
  record: string,
  cwd: string,
): WorktreeOtherChangeEntry | undefined {
  if (record.length < 3) {
    return undefined;
  }
  let indexCode = record[0] ?? " ";
  let worktreeCode = record[1] ?? " ";
  let pathStart = 3;
  if (record[1] === " " && record[2] !== " ") {
    // runGitCommand trims stdout; an unstaged-only status record starts with
    // a leading space (` M path`), so after trim the first record can arrive
    // as `M path`. Recover that shape instead of dropping the path's first
    // character (`apps/...` -> `pps/...`).
    indexCode = " ";
    worktreeCode = record[0] ?? " ";
    pathStart = 2;
  }
  let repoPath = record.slice(pathStart);
  const renameSeparator = repoPath.indexOf(" -> ");
  if (renameSeparator >= 0) {
    repoPath = repoPath.slice(renameSeparator + " -> ".length);
  }
  repoPath = normalizeGitRelativePath(repoPath);
  if (!repoPath) {
    return undefined;
  }
  return {
    path: normalizeAbsolutePath(path.resolve(cwd, repoPath)),
    repoPath,
    status: statusCodeToChangeStatus(indexCode, worktreeCode),
    staged: indexCode !== " " && indexCode !== "?",
    unstaged: worktreeCode !== " " || indexCode === "?",
  };
}

function parseStatusPorcelain(
  output: string,
  cwd: string,
): WorktreeOtherChangeEntry[] {
  if (output.includes("\0")) {
    const records = output.split("\0").filter(Boolean);
    const entries: WorktreeOtherChangeEntry[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const entry = parseStatusPorcelainRecord(records[index]!, cwd);
      if (!entry) {
        continue;
      }
      entries.push(entry);
      if (entry.status === "renamed" || entry.status === "copied") {
        index += 1;
      }
    }
    return entries;
  }

  const entries: WorktreeOtherChangeEntry[] = [];
  for (const rawLine of output.split("\n")) {
    if (!rawLine) {
      continue;
    }
    const entry = parseStatusPorcelainRecord(rawLine, cwd);
    if (entry) entries.push(entry);
  }
  return entries;
}

function isCollapsedUntrackedDirectoryEntry(
  entry: WorktreeOtherChangeEntry,
): boolean {
  return entry.status === "untracked" && entry.repoPath.endsWith("/");
}

function topLevelChangeBucket(repoPath: string): string {
  const normalized = normalizeGitRelativePath(repoPath).replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean)[0] ?? normalized;
}

function makeUntrackedEntry(
  cwd: string,
  repoPath: string,
): WorktreeOtherChangeEntry | undefined {
  const normalizedRepoPath = normalizeGitRelativePath(repoPath);
  if (!normalizedRepoPath || normalizedRepoPath.endsWith("/")) {
    return undefined;
  }
  return {
    path: normalizeAbsolutePath(path.resolve(cwd, normalizedRepoPath)),
    repoPath: normalizedRepoPath,
    status: "untracked",
    staged: false,
    unstaged: true,
  };
}

function parseLimitedNulRecords(
  output: string,
  limit: number,
  includeRepoPath: UntrackedPathFilter = () => true,
): { records: string[]; truncated: boolean } {
  const records = output
    .split("\0")
    .map(normalizeGitRelativePath)
    .filter((record) => record && includeRepoPath(record));
  return {
    records: records.slice(0, limit),
    truncated: records.length > limit,
  };
}

function parseNumstatByPath(
  output: string,
): Map<string, { additions?: number; removals?: number; binary?: boolean }> {
  const stats = new Map<
    string,
    { additions?: number; removals?: number; binary?: boolean }
  >();
  for (const line of output.split("\n")) {
    const [rawAdditions, rawRemovals, ...pathParts] = line.split("\t");
    const repoPath = normalizeGitRelativePath(pathParts.join("\t"));
    if (!repoPath) {
      continue;
    }
    if (rawAdditions === "-" || rawRemovals === "-") {
      stats.set(repoPath, { binary: true });
    } else {
      stats.set(repoPath, {
        additions: rawAdditions ? Number(rawAdditions) || 0 : 0,
        removals: rawRemovals ? Number(rawRemovals) || 0 : 0,
      });
    }
  }
  return stats;
}

function isPathInsideWorktree(cwd: string, absolutePath: string): boolean {
  const relative = path.relative(cwd, absolutePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function summarizeDiffText(diff: string): {
  additions: number;
  removals: number;
} {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("\\")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      removals += 1;
    }
  }
  return { additions, removals };
}

function countTextLines(contents: string): number {
  if (contents.length === 0) {
    return 0;
  }
  const lines = contents.split("\n");
  return lines.length > 0 && lines[lines.length - 1] === ""
    ? lines.length - 1
    : lines.length;
}

async function readFileSize(absolutePath: string): Promise<number | undefined> {
  try {
    const fileStat = await stat(absolutePath);
    return fileStat.size;
  } catch {
    return undefined;
  }
}

async function enrichUntrackedChangeStats(
  entry: WorktreeOtherChangeEntry,
): Promise<void> {
  try {
    const fileStat = await stat(entry.path);
    if (!fileStat.isFile()) {
      return;
    }
    entry.sizeBytes = fileStat.size;
    if (fileStat.size > DEFAULT_OTHER_CHANGE_DIFF_MAX_BYTES) {
      return;
    }
    const buffer = await readFile(entry.path);
    if (buffer.includes(0)) {
      entry.binary = true;
      return;
    }
    entry.additions = countTextLines(buffer.toString("utf8"));
    entry.removals = 0;
  } catch {
    // Summary stats are best-effort; expansion can still report a precise
    // omitted/unavailable reason for the single requested file.
  }
}

async function listUntrackedDirectoryFilesWithRunner(
  cwd: string,
  repoPath: string,
  limit: number,
  includeRepoPath: UntrackedPathFilter,
  runGit: GitCommandRunner,
  gitEnv?: NodeJS.ProcessEnv,
): Promise<{ repoPaths: string[]; truncated: boolean }> {
  const output = await runGit(
    cwd,
    [
      "--no-optional-locks",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      repoPath,
    ],
    gitEnv,
  ).catch(() => "");
  const parsed = parseLimitedNulRecords(output, limit, includeRepoPath);
  return {
    repoPaths: parsed.records,
    truncated: parsed.truncated,
  };
}

async function listUntrackedDirectoryFilesLimited(
  cwd: string,
  repoPath: string,
  limit: number,
  includeRepoPath: UntrackedPathFilter,
  gitEnv?: NodeJS.ProcessEnv,
): Promise<{ repoPaths: string[]; truncated: boolean }> {
  if (limit <= 0) {
    return { repoPaths: [], truncated: true };
  }

  const git = await resolveGitExecutable(gitEnv ?? process.env);
  return await new Promise((resolve) => {
    const repoPaths: string[] = [];
    let pending = "";
    let bytesRead = 0;
    let truncated = false;
    let settled = false;

    const child = spawn(
      git,
      [
        "-C",
        cwd,
        "--no-optional-locks",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        repoPath,
      ],
      { env: gitEnv ?? process.env },
    );

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ repoPaths: repoPaths.slice(0, limit), truncated });
    };

    const stop = () => {
      truncated = true;
      child.kill();
    };

    const timeout = setTimeout(stop, UNTRACKED_DIRECTORY_EXPANSION_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || truncated) {
        return;
      }
      bytesRead += Buffer.byteLength(chunk);
      pending += chunk;

      let separatorIndex = pending.indexOf("\0");
      while (separatorIndex >= 0) {
        const record = pending.slice(0, separatorIndex);
        pending = pending.slice(separatorIndex + 1);
        const normalized = normalizeGitRelativePath(record);
        if (normalized && includeRepoPath(normalized)) {
          repoPaths.push(normalized);
          if (repoPaths.length > limit) {
            stop();
            return;
          }
        }
        separatorIndex = pending.indexOf("\0");
      }

      if (bytesRead > UNTRACKED_DIRECTORY_EXPANSION_MAX_BYTES) {
        stop();
      }
    });
    child.once("error", finish);
    child.once("close", finish);
  });
}

async function expandUntrackedDirectoryEntry(
  cwd: string,
  entry: WorktreeOtherChangeEntry,
  limit: number,
  includeRepoPath: UntrackedPathFilter,
  runGit: GitCommandRunner,
  gitEnv?: NodeJS.ProcessEnv,
): Promise<{ changes: WorktreeOtherChangeEntry[]; truncated: boolean }> {
  const listing =
    runGit === defaultRunGit
      ? await listUntrackedDirectoryFilesLimited(
          cwd,
          entry.repoPath,
          limit,
          includeRepoPath,
          gitEnv,
        )
      : await listUntrackedDirectoryFilesWithRunner(
          cwd,
          entry.repoPath,
          limit,
          includeRepoPath,
          runGit,
          gitEnv,
        );
  return {
    changes: listing.repoPaths
      .map((repoPath) => makeUntrackedEntry(cwd, repoPath))
      .filter((change): change is WorktreeOtherChangeEntry => Boolean(change)),
    truncated: listing.truncated,
  };
}

async function summarizeUntrackedChanges(
  cwd: string,
  statusOutput: string,
): Promise<{ files: number; additions: number }> {
  const untrackedEntries = parseStatusPorcelain(statusOutput, cwd).filter(
    (entry) => entry.status === "untracked",
  );
  const visibleEntries = untrackedEntries.slice(0, DEFAULT_OTHER_CHANGES_MAX_FILES);
  await Promise.all(visibleEntries.map((entry) => enrichUntrackedChangeStats(entry)));
  return {
    files: untrackedEntries.length,
    additions: visibleEntries.reduce(
      (sum, entry) => sum + (entry.additions ?? 0),
      0,
    ),
  };
}

function buildUntrackedFileDiff(repoPath: string, contents: string): string {
  const lines = contents.length > 0 ? contents.split("\n") : [];
  const lineCount = countTextLines(contents);
  const body = lines
    .slice(0, lineCount)
    .map((line) => `+${line}`)
    .join("\n");
  return [
    `diff --git a/${repoPath} b/${repoPath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${repoPath}`,
    `@@ -0,0 +1,${lineCount} @@`,
    body,
  ]
    .filter((line, index) => index < 6 || line.length > 0)
    .join("\n");
}

function statusLabel(status: WorktreeOtherChangeStatus): string {
  switch (status) {
    case "added":
      return "Added";
    case "copied":
      return "Copied";
    case "deleted":
      return "Deleted";
    case "modified":
      return "Modified";
    case "renamed":
      return "Renamed";
    case "typechange":
      return "Type changed";
    case "untracked":
      return "Untracked";
    default:
      return "Changed";
  }
}

/**
 * Probe a thread's working directory for its local git working state:
 * uncommitted change totals (staged + unstaged vs HEAD), untracked file
 * count, and commits reachable from HEAD that exist on no remote ref.
 *
 * Read-only and lock-safe: every git invocation passes
 * `--no-optional-locks` so a background probe never takes the index lock
 * out from under an agent running its own git commands in the same
 * worktree. Returns `undefined` when the directory is not a git checkout
 * or every probe failed.
 */
export async function probeWorktreeWorkingState(
  worktreePath: string,
  options: {
    runGit?: GitCommandRunner;
    gitEnv?: NodeJS.ProcessEnv;
  } & AcceptedPushedCommitOptions = {},
): Promise<ThreadGitWorkingState | undefined> {
  const runGit = options.runGit ?? defaultRunGit;
  const gitEnv = options.gitEnv;
  const runGitNoLocks = (args: string[]): Promise<string> =>
    runGit(worktreePath, ["--no-optional-locks", ...args], gitEnv);

  const [numstatOutput, statusOutput, remotesOutput] = await Promise.all([
    // Staged + unstaged line counts vs HEAD. Fails on an unborn HEAD
    // (fresh repo with no commits) — treated as "no tracked changes".
    runGitNoLocks(["diff", "--numstat", "HEAD"]).catch(() => undefined),
    runGitNoLocks([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
    ]).catch(() => undefined),
    runGitNoLocks(["remote"]).catch(() => undefined),
  ]);
  if (numstatOutput === undefined && statusOutput === undefined) {
    return undefined;
  }

  const numstat = parseNumstat(numstatOutput ?? "");
  const untracked = await summarizeUntrackedChanges(worktreePath, statusOutput ?? "");

  // "Unpushed" means reachable from HEAD but on no remote ref. With no
  // remotes configured, every commit would count — meaningless for a
  // local-only repo, so report 0 instead.
  let unpushedCommits = 0;
  if (remotesOutput?.trim()) {
    const acceptedPushedCommitShas = buildAcceptedPushedCommitSet(
      options.acceptedPushedCommitShas,
    );
    if (acceptedPushedCommitShas.size > 0) {
      const output = await runGitNoLocks([
        "rev-list",
        "HEAD",
        "--not",
        "--remotes",
      ]).catch(() => undefined);
      unpushedCommits = output === undefined
        ? 0
        : output
          .split("\n")
          .map((sha) => sha.trim().toLowerCase())
          .filter((sha) => sha && !acceptedPushedCommitShas.has(sha))
          .length;
    } else {
      const count = await runGitNoLocks([
        "rev-list",
        "--count",
        "HEAD",
        "--not",
        "--remotes",
      ]).catch(() => undefined);
      unpushedCommits = count !== undefined ? Number(count) || 0 : 0;
    }
  }

  return {
    dirtyFiles: numstat.files + untracked.files,
    dirtyAdditions: numstat.additions + untracked.additions,
    dirtyDeletions: numstat.deletions,
    untrackedFiles: untracked.files,
    unpushedCommits,
  };
}

export type WorktreeWorkingStateEntry = {
  worktreePath: string;
  gitWorkingState?: ThreadGitWorkingState;
};

export type GitWorkingStateEntryOptions = {
  acceptedPushedCommitShasByWorktreePath?: Record<string, string[] | undefined>;
};

export type ResolveEditCommitStatesOptions = AcceptedPushedCommitOptions;

type CachedWorkingState = {
  expiresAt: number;
  inFlight?: Promise<ThreadGitWorkingState | undefined>;
  value?: ThreadGitWorkingState;
};

type GitWorkingStateServiceOptions = {
  cacheTtlMs?: number;
  concurrency?: number;
  maxUnread?: number;
  gitEnv?: NodeJS.ProcessEnv;
  runGit?: GitCommandRunner;
};

/**
 * Per-worktree git working-state probe with the same in-flight-dedup +
 * short-TTL in-memory cache shape as `GitDirectoryService.readDirectoryStatus`.
 * Keyed by worktree path (a thread's `projectKey`). Concurrent probes of the
 * same path share one in-flight promise; a fresh cache entry short-circuits the
 * git exec. The persistent sqlite layer, refresh scheduling, and push
 * notifications live in `DesktopAppServerService`, mirroring how directory git
 * status is wired.
 */
export class GitWorkingStateService {
  private readonly cache = new Map<string, CachedWorkingState>();
  private readonly cacheTtlMs: number;
  private readonly concurrency: number;
  private readonly maxUnread: number;
  private readonly gitEnv?: NodeJS.ProcessEnv;
  private readonly runGit: GitCommandRunner;

  constructor(options: GitWorkingStateServiceOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 3_000;
    this.concurrency = options.concurrency ?? 4;
    this.maxUnread = Math.max(options.maxUnread ?? 8, this.concurrency);
    this.gitEnv = options.gitEnv;
    this.runGit = options.runGit ?? defaultRunGit;
  }

  readWorkingStateEntries(
    worktreePaths: string[],
    options: GitWorkingStateEntryOptions = {},
  ): AsyncIterable<WorktreeWorkingStateEntry> {
    return new IterableMapper(
      worktreePaths,
      async (worktreePath): Promise<WorktreeWorkingStateEntry> => ({
        worktreePath,
        gitWorkingState: await this.readWorkingState(worktreePath, {
          acceptedPushedCommitShas:
            options.acceptedPushedCommitShasByWorktreePath?.[worktreePath],
        }),
      }),
      {
        concurrency: this.concurrency,
        maxUnread: this.maxUnread,
      },
    );
  }

  async readWorkingState(
    worktreePath: string,
    options: AcceptedPushedCommitOptions = {},
  ): Promise<ThreadGitWorkingState | undefined> {
    const key = worktreePath?.trim();
    if (!key) {
      return undefined;
    }
    const cacheKey = buildWorkingStateCacheKey(key, options.acceptedPushedCommitShas);

    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached?.inFlight) {
      return await cached.inFlight;
    }
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inFlight = probeWorktreeWorkingState(key, {
      runGit: this.runGit,
      gitEnv: this.gitEnv,
      acceptedPushedCommitShas: options.acceptedPushedCommitShas,
    })
      .then((value) => {
        this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheTtlMs, value });
        return value;
      })
      .catch((error) => {
        this.cache.delete(cacheKey);
        throw error;
      });

    this.cache.set(cacheKey, {
      expiresAt: cached?.expiresAt ?? 0,
      inFlight,
      value: cached?.value,
    });

    return await inFlight;
  }

  invalidate(worktreePath?: string): void {
    const key = worktreePath?.trim();
    if (!key) {
      return;
    }
    for (const cacheKey of this.cache.keys()) {
      if (cacheKey === key || cacheKey.startsWith(`${key}\0`)) {
        this.cache.delete(cacheKey);
      }
    }
  }

  /**
   * List worktree changes that are not already represented by turn-level
   * edited-file groups. This is intentionally summary-only: file count is
   * capped overall and per top-level directory, collapsed untracked directories
   * are expanded only up to those caps, and no patch text is generated here.
   */
  async listOtherChanges(
    worktreePath: string,
    options: {
      excludePaths?: string[];
      maxFiles?: number;
    } = {},
  ): Promise<{
    changes: WorktreeOtherChangeEntry[];
    totalChanges: number;
    truncated: boolean;
    maxFiles: number;
  }> {
    const cwd = worktreePath?.trim();
    const maxFiles = clampPositiveInteger(
      options.maxFiles,
      DEFAULT_OTHER_CHANGES_MAX_FILES,
      HARD_OTHER_CHANGES_MAX_FILES,
    );
    if (!cwd) {
      return { changes: [], totalChanges: 0, truncated: false, maxFiles };
    }

    const noLocks = (args: string[]): Promise<string> =>
      this.runGit(cwd, ["--no-optional-locks", ...args], this.gitEnv);
    const output = await noLocks([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
    ]).catch(() => "");
    const excluded = new Set(
      (options.excludePaths ?? [])
        .map((value) => value.trim())
        .filter(Boolean)
        .map(normalizeAbsolutePath),
    );
    const includeRepoPath = (repoPath: string): boolean =>
      !excluded.has(normalizeAbsolutePath(path.resolve(cwd, repoPath)));
    const allChanges: WorktreeOtherChangeEntry[] = [];
    const changesByTopLevel = new Map<string, number>();
    let stoppedBeforeEnd = false;
    let expansionTruncated = false;
    let topLevelTruncated = false;
    const addChange = (
      entry: WorktreeOtherChangeEntry,
    ): "added" | "total-capped" | "top-level-capped" => {
      if (allChanges.length >= maxFiles + 1) {
        return "total-capped";
      }
      const bucket = topLevelChangeBucket(entry.repoPath);
      const bucketCount = changesByTopLevel.get(bucket) ?? 0;
      if (bucketCount >= OTHER_CHANGES_MAX_FILES_PER_TOP_LEVEL) {
        return "top-level-capped";
      }
      changesByTopLevel.set(bucket, bucketCount + 1);
      allChanges.push(entry);
      return "added";
    };
    const parsedChanges = parseStatusPorcelain(output, cwd);
    for (const entry of parsedChanges) {
      if (excluded.has(normalizeAbsolutePath(entry.path))) {
        continue;
      }
      if (!isCollapsedUntrackedDirectoryEntry(entry)) {
        const result = addChange(entry);
        if (result === "top-level-capped") {
          topLevelTruncated = true;
        }
      } else {
        const bucket = topLevelChangeBucket(entry.repoPath);
        const remainingForTopLevel =
          OTHER_CHANGES_MAX_FILES_PER_TOP_LEVEL -
          (changesByTopLevel.get(bucket) ?? 0);
        if (remainingForTopLevel <= 0) {
          topLevelTruncated = true;
          continue;
        }
        const remaining = Math.min(
          maxFiles + 1 - allChanges.length,
          remainingForTopLevel + 1,
        );
        const expanded = await expandUntrackedDirectoryEntry(
          cwd,
          entry,
          remaining,
          includeRepoPath,
          this.runGit,
          this.gitEnv,
        );
        expansionTruncated ||= expanded.truncated;
        for (const expandedEntry of expanded.changes) {
          const result = addChange(expandedEntry);
          if (result === "top-level-capped") {
            topLevelTruncated = true;
          }
          if (result !== "added") {
            break;
          }
        }
      }
      if (allChanges.length > maxFiles) {
        stoppedBeforeEnd = true;
        break;
      }
    }
    const visible = allChanges.slice(0, maxFiles);
    const totalChanges =
      (expansionTruncated || topLevelTruncated) && allChanges.length <= maxFiles
        ? allChanges.length + 1
        : allChanges.length;

    const trackedPaths = visible
      .filter((entry) => entry.status !== "untracked")
      .map((entry) => entry.repoPath);
    if (trackedPaths.length > 0) {
      const numstatOutput = await noLocks([
        "diff",
        "--numstat",
        "HEAD",
        "--",
        ...trackedPaths,
      ]).catch(() => "");
      const statsByPath = parseNumstatByPath(numstatOutput);
      for (const entry of visible) {
        const stats = statsByPath.get(entry.repoPath);
        if (stats) {
          if (stats.binary) {
            entry.binary = true;
            entry.sizeBytes = await readFileSize(entry.path);
          } else {
            entry.additions = stats.additions ?? 0;
            entry.removals = stats.removals ?? 0;
          }
        }
      }
    }

    await Promise.all(
      visible
        .filter((entry) => entry.status === "untracked")
        .map((entry) => enrichUntrackedChangeStats(entry)),
    );

    return {
      changes: visible,
      totalChanges,
      truncated:
        expansionTruncated ||
        topLevelTruncated ||
        stoppedBeforeEnd ||
        allChanges.length > visible.length,
      maxFiles,
    };
  }

  async getOtherChangeDiff(
    worktreePath: string,
    filePath: string,
    options: { maxBytes?: number } = {},
  ): Promise<{ detail?: AppServerThreadActivityDetail }> {
    const cwd = worktreePath?.trim();
    const absolutePath = normalizeAbsolutePath(path.resolve(filePath));
    const maxBytes = clampPositiveInteger(
      options.maxBytes,
      DEFAULT_OTHER_CHANGE_DIFF_MAX_BYTES,
      HARD_OTHER_CHANGE_DIFF_MAX_BYTES,
    );
    if (!cwd || !isPathInsideWorktree(cwd, absolutePath)) {
      return {};
    }

    const repoPath = normalizeGitRelativePath(path.relative(cwd, absolutePath));
    const noLocks = (args: string[]): Promise<string> =>
      this.runGit(cwd, ["--no-optional-locks", ...args], this.gitEnv);
    const status = parseStatusPorcelain(
      await noLocks([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--",
        repoPath,
      ]).catch(() => ""),
      cwd,
    ).find((entry) => normalizeAbsolutePath(entry.path) === absolutePath);
    if (!status) {
      return {};
    }

    let diff = "";
    let omittedReason: string | undefined;
    if (status.status === "untracked") {
      try {
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) {
          return {};
        } else if (fileStat.size > maxBytes) {
          omittedReason = `Diff omitted for large untracked file (${fileStat.size.toLocaleString()} bytes).`;
        } else {
          const buffer = await readFile(absolutePath);
          if (buffer.includes(0)) {
            omittedReason = "Diff omitted for binary untracked file.";
          } else {
            diff = buildUntrackedFileDiff(repoPath, buffer.toString("utf8"));
          }
        }
      } catch {
        omittedReason = "Diff unavailable for this untracked file.";
      }
    } else {
      diff = await noLocks(["diff", "--no-ext-diff", "HEAD", "--", repoPath]).catch(
        () => "",
      );
      if (diff.length > maxBytes) {
        omittedReason = `Diff omitted because it exceeds ${maxBytes.toLocaleString()} bytes.`;
        diff = "";
      }
    }

    const stats = summarizeDiffText(diff);
    const fileDiffKind =
      status.status === "deleted"
        ? "delete"
        : status.status === "untracked" || status.status === "added"
          ? "add"
          : "update";
    return {
      detail: {
        id: `other-change:${absolutePath}`,
        kind: "write",
        label: path.basename(repoPath) || repoPath,
        path: absolutePath,
        fileDiff: {
          kind: fileDiffKind,
          diff,
          additions: status.additions ?? stats.additions,
          removals: status.removals ?? stats.removals,
          ...(omittedReason ? { omittedReason } : {}),
        },
        markdown: statusLabel(status.status),
      },
    };
  }

  /**
   * Resolve the git commit lifecycle of a thread's edited-file groups against
   * the live worktree. For each group: it's `committed` when none of its files
   * still differ from HEAD or sit untracked; if committed, `git log` gives the
   * most recent commit touching those files, and a remote-reachability check
   * marks it pushed vs local-only. Read-only and lock-safe. Git itself
   * normalizes the (absolute) paths, so callers don't path-match.
   */
  async resolveEditCommitStates(
    worktreePath: string,
    groups: EditGroupCommitInput[],
    options: ResolveEditCommitStatesOptions = {},
  ): Promise<Record<string, EditGroupCommitState>> {
    const cwd = worktreePath?.trim();
    const states: Record<string, EditGroupCommitState> = {};
    if (!cwd || groups.length === 0) {
      return states;
    }

    const gitEnv = this.gitEnv;
    const noLocks = (args: string[]): Promise<string> =>
      this.runGit(cwd, ["--no-optional-locks", ...args], gitEnv);
    const acceptedPushedCommitShas = buildAcceptedPushedCommitSet(
      options.acceptedPushedCommitShas,
    );

    // The set of files that still have working-tree changes (tracked diffs vs
    // HEAD + untracked). Clean newline-separated relative paths — easier to
    // parse than `status --porcelain` status codes / rename arrows.
    const [diffOutput, untrackedOutput] = await Promise.all([
      noLocks(["diff", "--name-only", "HEAD"]).catch(() => ""),
      noLocks(["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
    ]);
    const dirtyPaths = new Set<string>();
    for (const line of `${diffOutput}\n${untrackedOutput}`.split("\n")) {
      const relative = line.trim();
      if (relative) {
        dirtyPaths.add(normalizeAbsolutePath(path.resolve(cwd, relative)));
      }
    }

    // Gitignored inputs, resolved in one `check-ignore` over the union of all
    // group paths (relative to cwd, dropping any outside the worktree). These
    // files can never be committed, so they're carried separately rather than
    // letting their absence silently read as "committed". `check-ignore` exits
    // non-zero when nothing matches — treated here as "none ignored".
    const allInputPaths = [
      ...new Set(
        groups.flatMap((group) =>
          group.paths.map((value) => value.trim()).filter(Boolean),
        ),
      ),
    ];
    const ignoredPaths = new Set<string>();
    const relativeInputs = allInputPaths
      .map((value) => path.relative(cwd, value))
      .filter((relative) => relative && !relative.startsWith(".."));
    if (relativeInputs.length > 0) {
      const ignoredOutput = await noLocks([
        "check-ignore",
        "--",
        ...relativeInputs,
      ]).catch(() => "");
      for (const line of ignoredOutput.split("\n")) {
        const relative = line.trim();
        if (relative) {
          ignoredPaths.add(normalizeAbsolutePath(path.resolve(cwd, relative)));
        }
      }
    }

    // Memoize the per-commit remote-reachability check by promise so concurrent
    // groups sharing a commit run `rev-list` once.
    const pushedBySha = new Map<string, Promise<boolean>>();
    const resolvePushed = (sha: string): Promise<boolean> => {
      const existing = pushedBySha.get(sha);
      if (existing) {
        return existing;
      }
      if (acceptedPushedCommitShas.has(sha.trim().toLowerCase())) {
        const promise = Promise.resolve(true);
        pushedBySha.set(sha, promise);
        return promise;
      }
      // `rev-list -1 <sha> --not --remotes` lists sha only when it (or its
      // tip) isn't reachable from any remote ref. Empty ⇒ pushed. With no
      // remotes configured, nothing is excluded ⇒ non-empty ⇒ local-only.
      const promise = noLocks(["rev-list", "-1", sha, "--not", "--remotes"])
        .then((output) => output.trim() === "")
        .catch(() => true);
      pushedBySha.set(sha, promise);
      return promise;
    };

    const resolveGroupState = async (
      group: EditGroupCommitInput,
    ): Promise<{ key: string; state: EditGroupCommitState }> => {
      const paths = [
        ...new Set(group.paths.map((value) => value.trim()).filter(Boolean)),
      ];
      // Ignored files are surfaced separately and excluded from the
      // committed/pushed judgement — only the tracked files decide that.
      const ignored = paths.filter((value) =>
        ignoredPaths.has(normalizeAbsolutePath(value)),
      );
      const ignoredState: Pick<EditGroupCommitState, "ignoredPaths"> =
        ignored.length > 0 ? { ignoredPaths: ignored } : {};
      const trackedPaths = paths.filter(
        (value) => !ignoredPaths.has(normalizeAbsolutePath(value)),
      );

      if (trackedPaths.length === 0) {
        return { key: group.key, state: { committed: false, ...ignoredState } };
      }
      if (
        trackedPaths.some((value) =>
          dirtyPaths.has(normalizeAbsolutePath(value)),
        )
      ) {
        return { key: group.key, state: { committed: false, ...ignoredState } };
      }

      const sha = (
        await noLocks([
          "log",
          "-1",
          "--format=%H",
          "--",
          ...trackedPaths,
        ]).catch(() => "")
      ).trim();
      // Not dirty AND no commit in history ⇒ the files left the working tree
      // without a commit we can find. Don't claim "committed" without a SHA.
      if (!sha) {
        return { key: group.key, state: { committed: false, ...ignoredState } };
      }

      return {
        key: group.key,
        state: {
          committed: true,
          commitSha: sha,
          shortSha: sha.slice(0, 7),
          pushed: await resolvePushed(sha),
          ...ignoredState,
        },
      };
    };

    // Bounded concurrency rather than one git subprocess at a time.
    for await (const entry of new IterableMapper(groups, resolveGroupState, {
      concurrency: EDIT_COMMIT_RESOLVE_CONCURRENCY,
      maxUnread: EDIT_COMMIT_RESOLVE_CONCURRENCY * 2,
    })) {
      states[entry.key] = entry.state;
    }

    return states;
  }
}
