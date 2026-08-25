import type { AppServerReviewTarget, PrSummary } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";

type ReviewGitRunner = (
  cwd: string,
  args: string[],
) => Promise<{ stdout: string }>;

function baseBranchMatches(targetBranch: string, prBaseBranch: string): boolean {
  const target = targetBranch.trim().replace(/^refs\/heads\//, "");
  const base = prBaseBranch.trim().replace(/^refs\/heads\//, "");
  return (
    target === base
    || target === `origin/${base}`
    || target === `refs/remotes/origin/${base}`
  );
}

function shortSha(value: string): string {
  return value.slice(0, 10);
}

async function commitExists(
  runGit: ReviewGitRunner,
  cwd: string,
  sha: string,
): Promise<boolean> {
  try {
    await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
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
 * An attached PR can suggest its base branch in the renderer, but it does not
 * move the workspace to that PR's head. Refuse the review when the selected
 * base belongs to an attached PR whose head commit is available in this repo
 * but is not contained in the checkout; otherwise the review would silently
 * inspect an unrelated branch-to-base diff.
 *
 * Descendants of the PR head remain valid so an operator can review local
 * follow-up commits before pushing. PRs from another linked repository are
 * ignored because their head objects do not exist in this workspace.
 */
export async function assertReviewWorkspaceMatchesAttachedPullRequest(params: {
  cwd?: string;
  prs?: PrSummary[];
  runGit?: ReviewGitRunner;
  target: AppServerReviewTarget;
}): Promise<void> {
  const cwd = params.cwd?.trim();
  if (!cwd || params.target.type !== "baseBranch") {
    return;
  }
  const targetBranch = params.target.branch;

  const matchingPullRequests = (params.prs ?? []).filter((pr) =>
    pr.lifecycleState === "open"
    && Boolean(pr.headSha?.trim())
    && Boolean(pr.baseRefName?.trim())
    && baseBranchMatches(targetBranch, pr.baseRefName ?? "")
  );
  if (matchingPullRequests.length === 0) {
    return;
  }

  const runGit = params.runGit ?? runGitCommand;
  const repositoryPullRequests = (
    await Promise.all(
      matchingPullRequests.map(async (pr) => ({
        exists: await commitExists(runGit, cwd, pr.headSha ?? ""),
        pr,
      })),
    )
  )
    .filter((candidate) => candidate.exists)
    .map((candidate) => candidate.pr);
  if (repositoryPullRequests.length === 0) {
    return;
  }

  const ancestry = await Promise.all(
    repositoryPullRequests.map(async (pr) =>
      await commitIsAncestorOfHead(runGit, cwd, pr.headSha ?? "")
    ),
  );
  if (ancestry.some(Boolean)) {
    return;
  }

  const currentHead = await runGit(cwd, ["rev-parse", "HEAD"])
    .then((result) => result.stdout.trim())
    .catch(() => "HEAD");
  const pullRequestLabels = repositoryPullRequests.map((pr) =>
    `#${pr.number} head ${shortSha(pr.headSha ?? "")}`
  );
  const headBranches = repositoryPullRequests
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
