import type { AppServerReviewTarget, PrSummary } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";
import {
  resolveGitHubReposForDirectory,
  type GitHubRepoRef,
} from "../pr-status/git-remote";

export type ReviewGitRunner = (
  cwd: string,
  args: string[],
) => Promise<{ stdout: string }>;

export function normalizeWorkspacePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function prBelongsToWorkspace(pr: PrSummary, cwd: string): boolean {
  const selectedWorkspace = normalizeWorkspacePath(cwd);
  return (pr.linkedDirectoryPaths ?? []).some(
    (directoryPath) => normalizeWorkspacePath(directoryPath) === selectedWorkspace,
  );
}

export function prMatchesRepository(pr: PrSummary, repo: GitHubRepoRef): boolean {
  return pr.provider.trim().toLowerCase() === repo.host.toLowerCase()
    && pr.org.trim().toLowerCase() === repo.owner.toLowerCase()
    && pr.repo.trim().toLowerCase() === repo.repo.toLowerCase();
}

export function normalizeFullRef(ref: string): string {
  const normalized = ref.trim();
  const localMatch = normalized.match(/^refs\/heads\/(.+)$/);
  if (localMatch?.[1]) {
    return localMatch[1];
  }
  const remoteMatch = normalized.match(/^refs\/remotes\/[^/]+\/(.+)$/);
  return remoteMatch?.[1] ?? normalized;
}

async function resolveLocalTargetBranch(
  runGit: ReviewGitRunner,
  cwd: string,
  targetBranch: string,
): Promise<string> {
  const normalized = normalizeFullRef(targetBranch);
  if (normalized !== targetBranch.trim() || !normalized.includes("/")) {
    return normalized;
  }
  try {
    const resolved = await runGit(cwd, [
      "rev-parse",
      "--symbolic-full-name",
      targetBranch,
    ]);
    return normalizeFullRef(resolved.stdout);
  } catch {
    return normalized;
  }
}

function remoteTargetCouldMatchBase(
  targetBranch: string,
  baseBranch: string,
): boolean {
  const target = normalizeFullRef(targetBranch);
  const base = normalizeFullRef(baseBranch);
  return target === base || target.endsWith(`/${base}`);
}

function shortSha(value: string): string {
  return value.slice(0, 10);
}

async function commitIsAncestorOfHead(
  runGit: ReviewGitRunner,
  cwd: string,
  sha: string,
): Promise<boolean> {
  try {
    await runGit(cwd, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A base-branch review always compares the selected workspace's current HEAD.
 * PR discovery records the linked directory that produced each attachment, so
 * only PRs owned by the selected workspace constrain the review. This matters
 * for Git worktrees, which share an object database and therefore cannot use
 * object existence as proof that a PR belongs to a particular checkout.
 *
 * Local reviews resolve remote-qualified refs through Git before comparing the
 * selected base. Remote workspaces are never inspected with local Git; until
 * remote command execution is available here, an applicable review fails
 * closed instead of making a decision against a same-named local path.
 */
export async function assertReviewWorkspaceMatchesAttachedPullRequest(params: {
  cwd?: string;
  executionTarget?: "local" | "remote";
  prs?: PrSummary[];
  resolveGitHubRepos?: (cwd: string) => Promise<GitHubRepoRef[]>;
  runGit?: ReviewGitRunner;
  target: AppServerReviewTarget;
}): Promise<void> {
  const cwd = params.cwd?.trim();
  if (!cwd || params.target.type !== "baseBranch") {
    return;
  }
  const targetBranch = params.target.branch;
  const reviewablePullRequests = (params.prs ?? []).filter((pr) =>
    pr.lifecycleState === "open"
    && Boolean(pr.headSha?.trim())
    && Boolean(pr.baseRefName?.trim())
  );

  if (params.executionTarget === "remote") {
    const matchingRemotePullRequests = reviewablePullRequests.filter((pr) =>
      remoteTargetCouldMatchBase(targetBranch, pr.baseRefName ?? "")
    );
    if (matchingRemotePullRequests.length === 0) {
      return;
    }
    throw new Error(
      "Review not started: this remote workspace cannot be verified from this machine. Start the review from a local checkout or use a review target that does not require workspace verification.",
    );
  }

  let workspacePullRequests = reviewablePullRequests.filter((pr) =>
    prBelongsToWorkspace(pr, cwd)
  );
  if (workspacePullRequests.length === 0) {
    return;
  }

  const resolveGitHubRepos =
    params.resolveGitHubRepos ?? resolveGitHubReposForDirectory;
  const workspaceRepositories = await resolveGitHubRepos(cwd);
  if (workspaceRepositories.length > 0) {
    workspacePullRequests = workspacePullRequests.filter((pr) =>
      workspaceRepositories.some((repo) => prMatchesRepository(pr, repo))
    );
    if (workspacePullRequests.length === 0) {
      return;
    }
  }

  const runGit = params.runGit ?? runGitCommand;
  const resolvedTargetBranch = await resolveLocalTargetBranch(
    runGit,
    cwd,
    targetBranch,
  );
  const matchingPullRequests = workspacePullRequests.filter(
    (pr) => normalizeFullRef(pr.baseRefName ?? "") === resolvedTargetBranch,
  );
  if (matchingPullRequests.length === 0) {
    return;
  }

  const ancestry = await Promise.all(
    matchingPullRequests.map(async (pr) =>
      await commitIsAncestorOfHead(runGit, cwd, pr.headSha ?? "")
    ),
  );
  if (ancestry.some(Boolean)) {
    return;
  }

  const currentHead = await runGit(cwd, ["rev-parse", "HEAD"])
    .then((result) => result.stdout.trim())
    .catch(() => "HEAD");
  const pullRequestLabels = matchingPullRequests.map((pr) =>
    `#${pr.number} head ${shortSha(pr.headSha ?? "")}`
  );
  const headBranches = matchingPullRequests
    .map((pr) => pr.headRefName?.trim())
    .filter((branch): branch is string => Boolean(branch));
  const checkoutHint = headBranches.length === 1
    ? ` Check out '${headBranches[0]}' (or that PR head) in this workspace, then start the review again.`
    : " Check out the intended PR head in this workspace, then start the review again.";

  throw new Error(
    `Review not started: current checkout ${shortSha(currentHead)} does not contain attached ${pullRequestLabels.join(
      ", ",
    )}. Comparing it with base '${targetBranch}' would review a different diff.${checkoutHint}`,
  );
}
