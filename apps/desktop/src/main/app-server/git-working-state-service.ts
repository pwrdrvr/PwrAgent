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
