import type {
  LinkedDirectorySummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import type { GithubPrFetcher } from "./github-pr-fetcher";

/**
 * Detect PRs for a single thread by walking its linked directories and
 * asking `gh pr list --head <branch>` per directory. Aggregates results,
 * dedupes by URL (in case multiple linked dirs point at the same repo).
 *
 * Thread → branch resolution: prefer the explicit `gitBranch` field on
 * the thread, fall back to skipping that dir. We never check out the
 * directory ourselves; if the thread doesn't know its branch, neither
 * do we.
 */
export async function detectPullRequestsForThread(params: {
  fetcher: GithubPrFetcher;
  thread: NavigationThreadSummary;
}): Promise<PrSummary[]> {
  const branch = params.thread.gitBranch?.trim();
  if (!branch) {
    return [];
  }

  const dirs = collectFetchableDirectories(params.thread.linkedDirectories);
  if (dirs.length === 0) {
    return [];
  }

  const results = await Promise.all(
    dirs.map((cwd) =>
      params.fetcher.fetchForBranch({ cwd, branch }).catch(() => []),
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
 * Pick the directory paths we should ask `gh` about. Worktree paths are
 * preferred (those are where the branch actually exists checked out);
 * fall back to local paths when no worktree path is recorded.
 */
function collectFetchableDirectories(
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
