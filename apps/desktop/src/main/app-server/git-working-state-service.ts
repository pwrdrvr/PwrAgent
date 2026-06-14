import path from "node:path";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import type {
  EditGroupCommitInput,
  EditGroupCommitState,
  ThreadGitWorkingState,
} from "@pwragent/shared";
import { runGitCommand } from "./git-executable";

function normalizeAbsolutePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

/** Bounded concurrency for the per-group `git log`/`rev-list` commit probes. */
const EDIT_COMMIT_RESOLVE_CONCURRENCY = 4;

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
  options: { runGit?: GitCommandRunner; gitEnv?: NodeJS.ProcessEnv } = {},
): Promise<ThreadGitWorkingState | undefined> {
  const runGit = options.runGit ?? defaultRunGit;
  const gitEnv = options.gitEnv;
  const runGitNoLocks = (args: string[]): Promise<string> =>
    runGit(worktreePath, ["--no-optional-locks", ...args], gitEnv);

  const [numstatOutput, statusOutput, remotesOutput] = await Promise.all([
    // Staged + unstaged line counts vs HEAD. Fails on an unborn HEAD
    // (fresh repo with no commits) — treated as "no tracked changes".
    runGitNoLocks(["diff", "--numstat", "HEAD"]).catch(() => undefined),
    runGitNoLocks(["status", "--porcelain"]).catch(() => undefined),
    runGitNoLocks(["remote"]).catch(() => undefined),
  ]);
  if (numstatOutput === undefined && statusOutput === undefined) {
    return undefined;
  }

  const numstat = parseNumstat(numstatOutput ?? "");
  const untrackedFiles = (statusOutput ?? "")
    .split("\n")
    .filter((line) => line.startsWith("??")).length;

  // "Unpushed" means reachable from HEAD but on no remote ref. With no
  // remotes configured, every commit would count — meaningless for a
  // local-only repo, so report 0 instead.
  let unpushedCommits = 0;
  if (remotesOutput?.trim()) {
    const count = await runGitNoLocks([
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      "--remotes",
    ]).catch(() => undefined);
    unpushedCommits = count !== undefined ? Number(count) || 0 : 0;
  }

  return {
    dirtyFiles: numstat.files,
    dirtyAdditions: numstat.additions,
    dirtyDeletions: numstat.deletions,
    untrackedFiles,
    unpushedCommits,
  };
}

export type WorktreeWorkingStateEntry = {
  worktreePath: string;
  gitWorkingState?: ThreadGitWorkingState;
};

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
  ): AsyncIterable<WorktreeWorkingStateEntry> {
    return new IterableMapper(
      worktreePaths,
      async (worktreePath): Promise<WorktreeWorkingStateEntry> => ({
        worktreePath,
        gitWorkingState: await this.readWorkingState(worktreePath),
      }),
      {
        concurrency: this.concurrency,
        maxUnread: this.maxUnread,
      },
    );
  }

  async readWorkingState(
    worktreePath: string,
  ): Promise<ThreadGitWorkingState | undefined> {
    const key = worktreePath?.trim();
    if (!key) {
      return undefined;
    }

    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached?.inFlight) {
      return await cached.inFlight;
    }
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inFlight = probeWorktreeWorkingState(key, {
      runGit: this.runGit,
      gitEnv: this.gitEnv,
    })
      .then((value) => {
        this.cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, value });
        return value;
      })
      .catch((error) => {
        this.cache.delete(key);
        throw error;
      });

    this.cache.set(key, {
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
    this.cache.delete(key);
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
  ): Promise<Record<string, EditGroupCommitState>> {
    const cwd = worktreePath?.trim();
    const states: Record<string, EditGroupCommitState> = {};
    if (!cwd || groups.length === 0) {
      return states;
    }

    const gitEnv = this.gitEnv;
    const noLocks = (args: string[]): Promise<string> =>
      this.runGit(cwd, ["--no-optional-locks", ...args], gitEnv);

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

    // Memoize the per-commit remote-reachability check by promise so concurrent
    // groups sharing a commit run `rev-list` once.
    const pushedBySha = new Map<string, Promise<boolean>>();
    const resolvePushed = (sha: string): Promise<boolean> => {
      const existing = pushedBySha.get(sha);
      if (existing) {
        return existing;
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
      if (paths.length === 0) {
        return { key: group.key, state: { committed: false } };
      }
      if (paths.some((value) => dirtyPaths.has(normalizeAbsolutePath(value)))) {
        return { key: group.key, state: { committed: false } };
      }

      const sha = (
        await noLocks(["log", "-1", "--format=%H", "--", ...paths]).catch(
          () => "",
        )
      ).trim();
      // Not dirty AND no commit in history ⇒ the files left the working tree
      // without a commit we can find: almost always `.gitignore`'d files the
      // agent wrote (invisible to both `diff HEAD` and `ls-files --others
      // --exclude-standard`). Don't claim "committed" without a SHA to back it.
      if (!sha) {
        return { key: group.key, state: { committed: false } };
      }

      return {
        key: group.key,
        state: {
          committed: true,
          commitSha: sha,
          shortSha: sha.slice(0, 7),
          pushed: await resolvePushed(sha),
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
