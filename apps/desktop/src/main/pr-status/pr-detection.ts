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
  names: Set<string>;
  upstreams: Set<string>;
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
    const trackedRemoteBranch = await readTrackedRemoteBranchName(
      params.cwd,
      params.branch,
    );
    if (defaultBranchInfo.names.has(params.branch)) {
      return [];
    }
    // A local feature branch may track the remote default branch for pulls.
    // Never query that default name; keep the local feature name instead.
    return [
      trackedRemoteBranch
      && !defaultBranchInfo.names.has(trackedRemoteBranch)
        ? trackedRemoteBranch
        : params.branch,
    ];
  }

  return [];
}

async function readTrackedRemoteBranchName(
  cwd: string,
  localBranch: string,
): Promise<string | undefined> {
  const remoteRef = await readGitLine(cwd, [
    "for-each-ref",
    "--format=%(upstream:remoteref)",
    `refs/heads/${localBranch}`,
  ]);
  const prefix = "refs/heads/";
  if (!remoteRef?.startsWith(prefix)) {
    return undefined;
  }
  return remoteRef.slice(prefix.length).trim() || undefined;
}

async function readDefaultBranchInfo(cwd: string): Promise<DefaultBranchInfo> {
  try {
    const upstreams = await readRemoteDefaultUpstreams(cwd);
    const names = remoteDefaultBranchNames(upstreams);

    if (names.size === 0) {
      const fallbackDefaultBranch = await readFallbackDefaultBranchName(cwd);
      if (fallbackDefaultBranch) {
        names.add(fallbackDefaultBranch);
      }
    }

    return { names, upstreams };
  } catch {
    return { names: new Set(), upstreams: new Set() };
  }
}

async function readRemoteDefaultUpstreams(cwd: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync("git", ["remote"], {
    cwd,
    maxBuffer: 64 * 1024,
    timeout: GIT_BRANCH_LOOKUP_TIMEOUT_MS,
  });
  const remotes = uniqueNonEmpty(stdout.split(/\r?\n/));
  const upstreams = await Promise.all(
    remotes.map(async (remote) => {
      const remoteHead = await readGitLine(cwd, [
        "symbolic-ref",
        "--quiet",
        "--short",
        `refs/remotes/${remote}/HEAD`,
      ]);
      return remoteHead ?? "";
    }),
  );
  return new Set(uniqueNonEmpty(upstreams));
}

function remoteDefaultBranchNames(defaultUpstreams: Set<string>): Set<string> {
  return new Set(
    [...defaultUpstreams].map((upstream) => upstream.replace(/^[^/]+\//, "")),
  );
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
