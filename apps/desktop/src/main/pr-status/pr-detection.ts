import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LinkedDirectorySummary, PrSummary } from "@pwragent/shared";
import type { GithubPrFetcher } from "./github-pr-fetcher";

const execFileAsync = promisify(execFile);
const GIT_BRANCH_LOOKUP_TIMEOUT_MS = 2_000;
const FALLBACK_DEFAULT_BRANCHES = [
  "main",
  "master",
  "develop",
  "trunk",
] as const;

type DefaultBranchInfo = {
  defaultsByRemote: Map<string, string>;
  names: Set<string>;
  remotes: Set<string>;
};

type TrackedRemoteBranch = {
  name: string;
  remote: string;
};

/**
 * Detect PRs for a single thread by walking the resolved directory paths
 * and asking `gh pr list --head <branch> --state all` per directory.
 * Aggregates results, dedupes by URL (in case multiple linked dirs point
 * at the same repo).
 *
 * `--state all` is intentional: this is the on-focus / on-selection
 * authoritative fetch, so we want to surface merged/closed PRs too.
 * That state then sticks in the persistence overlay and the IPC layer
 * short-circuits future refreshes once any PR reaches a terminal state.
 */
export async function detectPullRequestsForThread(params: {
  fetcher: GithubPrFetcher;
  branch: string;
  directoryPaths: string[];
}): Promise<PrSummary[]> {
  const branch = params.branch.trim();
  if (!branch || params.directoryPaths.length === 0) {
    return [];
  }

  const dirs = uniqueNonEmpty(params.directoryPaths);
  if (dirs.length === 0) {
    return [];
  }

  const results = await Promise.all(
    dirs.map(async (cwd) => {
      const branches = await resolvePrLookupBranches({ branch, cwd });
      const prsByBranch = await Promise.all(
        branches.map((lookupBranch) =>
          params.fetcher
            .fetchAllPullRequestsForBranch({ cwd, branch: lookupBranch })
            .catch(() => []),
        ),
      );
      return prsByBranch.flat();
    }),
  );

  const seenByUrl = new Map<string, PrSummary>();
  for (const prs of results) {
    for (const pr of prs) {
      if (!seenByUrl.has(pr.url)) {
        seenByUrl.set(pr.url, pr);
      }
    }
  }
  return [...seenByUrl.values()];
}

async function resolvePrLookupBranches(params: {
  branch: string;
  cwd: string;
}): Promise<string[]> {
  const defaultBranchInfo = await readDefaultBranchInfo(params.cwd);

  if (params.branch !== "HEAD") {
    const trackedRemoteBranch = await readTrackedRemoteBranch({
      cwd: params.cwd,
      localBranch: params.branch,
      remotes: defaultBranchInfo.remotes,
    });
    if (defaultBranchInfo.names.has(params.branch)) {
      return [];
    }
    // A local feature branch may track the remote default branch for pulls.
    // Only substitute a tracked branch after verifying that remote's default.
    const trackedRemoteDefault = trackedRemoteBranch
      ? defaultBranchInfo.defaultsByRemote.get(trackedRemoteBranch.remote)
      : undefined;
    return [
      trackedRemoteBranch
      && trackedRemoteDefault
      && trackedRemoteBranch.name !== trackedRemoteDefault
        ? trackedRemoteBranch.name
        : params.branch,
    ];
  }

  return [];
}

async function readTrackedRemoteBranch(params: {
  cwd: string;
  localBranch: string;
  remotes: Set<string>;
}): Promise<TrackedRemoteBranch | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      [
        "for-each-ref",
        "--format=%(refname)%09%(upstream:remotename)%09%(upstream:remoteref)",
        `refs/heads/${params.localBranch}`,
      ],
      {
        cwd: params.cwd,
        maxBuffer: 64 * 1024,
        timeout: GIT_BRANCH_LOOKUP_TIMEOUT_MS,
      },
    ));
  } catch {
    return undefined;
  }

  const expectedRef = `refs/heads/${params.localBranch}`;
  const remoteRefPrefix = "refs/heads/";
  for (const line of stdout.split(/\r?\n/)) {
    const [refName = "", remote = "", remoteRef = ""] = line.split("\t");
    if (
      refName !== expectedRef
      || !params.remotes.has(remote)
      || !remoteRef.startsWith(remoteRefPrefix)
    ) {
      continue;
    }
    const name = remoteRef.slice(remoteRefPrefix.length).trim();
    return name ? { name, remote } : undefined;
  }
  return undefined;
}

async function readDefaultBranchInfo(cwd: string): Promise<DefaultBranchInfo> {
  try {
    const { defaultsByRemote, remotes } = await readRemoteDefaultBranches(cwd);
    const names = new Set(defaultsByRemote.values());

    if (names.size === 0) {
      const fallbackDefaultBranch = await readFallbackDefaultBranchName(cwd);
      if (fallbackDefaultBranch) {
        names.add(fallbackDefaultBranch);
      }
    }

    return { defaultsByRemote, names, remotes };
  } catch {
    return {
      defaultsByRemote: new Map(),
      names: new Set(),
      remotes: new Set(),
    };
  }
}

async function readRemoteDefaultBranches(cwd: string): Promise<{
  defaultsByRemote: Map<string, string>;
  remotes: Set<string>;
}> {
  const { stdout } = await execFileAsync("git", ["remote"], {
    cwd,
    maxBuffer: 64 * 1024,
    timeout: GIT_BRANCH_LOOKUP_TIMEOUT_MS,
  });
  const remotes = uniqueNonEmpty(stdout.split(/\r?\n/));
  const defaults = await Promise.all(
    remotes.map(async (remote) => {
      const remoteHead = await readGitLine(cwd, [
        "symbolic-ref",
        "--quiet",
        "--short",
        `refs/remotes/${remote}/HEAD`,
      ]);
      const prefix = `${remote}/`;
      return remoteHead?.startsWith(prefix)
        ? ([remote, remoteHead.slice(prefix.length)] as const)
        : undefined;
    }),
  );
  return {
    defaultsByRemote: new Map(
      defaults.filter(
        (entry): entry is readonly [string, string] => Boolean(entry?.[1]),
      ),
    ),
    remotes: new Set(remotes),
  };
}

async function readFallbackDefaultBranchName(
  cwd: string,
): Promise<string | undefined> {
  for (const branch of FALLBACK_DEFAULT_BRANCHES) {
    const localBranch = await readGitLine(cwd, [
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${branch}`,
    ]);
    if (localBranch === branch) {
      return branch;
    }
  }
  return undefined;
}

async function readGitLine(
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 64 * 1024,
      timeout: GIT_BRANCH_LOOKUP_TIMEOUT_MS,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pick the cwd to ask `gh` about for each linked directory. Worktree
 * paths are preferred (those are where the branch actually exists
 * checked out); fall back to local paths when no worktree path is
 * recorded. Exposed for the renderer to call before forwarding paths
 * to the IPC layer.
 */
export function resolveFetchableDirectoryPaths(
  linkedDirectories: LinkedDirectorySummary[],
): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const directory of linkedDirectories) {
    const candidate =
      directory.kind === "worktree"
        ? directory.worktreePath ?? directory.path
        : directory.path;
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    dirs.push(candidate);
  }
  return dirs;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
