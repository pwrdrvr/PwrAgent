import type {
  LinkedDirectorySummary,
  PrSummary,
} from "@pwragent/shared";
import type { GithubPrFetcher } from "./github-pr-fetcher";

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
    dirs.map((cwd) =>
      params.fetcher
        .fetchAllPullRequestsForBranch({ cwd, branch })
        .catch(() => []),
    ),
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
