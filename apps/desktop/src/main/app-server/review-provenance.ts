import type {
  AppServerReviewContext,
  AppServerReviewPullRequest,
  AppServerReviewTarget,
  LinkedDirectorySummary,
  PrSummary,
} from "@pwragent/shared";
import { normalizeFullRef } from "../../shared/review-command";
import { runGitCommand } from "./git-executable";
import {
  normalizeWorkspacePath,
  prBelongsToWorkspace,
  prMatchesRepository,
  type ReviewGitRunner,
} from "./review-workspace-guard";
import {
  resolveGitHubReposForDirectory,
  type GitHubRepoRef,
} from "../pr-status/git-remote";

/**
 * Git reports a detached HEAD as the literal string "HEAD" rather than
 * failing, so it has to be rejected by name.
 */
const DETACHED_HEAD = "HEAD";

function directoryMatchesWorkspace(
  directory: LinkedDirectorySummary,
  workspacePath: string,
): boolean {
  const workspace = normalizeWorkspacePath(workspacePath);
  return (
    normalizeWorkspacePath(directory.worktreePath ?? "") === workspace
    || normalizeWorkspacePath(directory.path) === workspace
  );
}

/**
 * The label the operator picked the project by. Falling back to the workspace's
 * own basename keeps a review that ran outside any linked directory nameable
 * without inventing a label the sidebar never showed.
 */
function resolveProjectLabel(
  directory: LinkedDirectorySummary | undefined,
  workspacePath: string,
): string | undefined {
  const label = directory?.label.trim();
  if (label) {
    return label;
  }
  // Not `normalizeWorkspacePath`: it case-folds a Windows drive-letter path so
  // two paths can be compared, which would label `C:\Users\dev\PwrAgent` as
  // "pwragent". A displayed name keeps the casing the operator gave it.
  return workspacePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .pop()
    || undefined;
}

async function resolveCheckedOutBranch(
  runGit: ReviewGitRunner,
  cwd: string,
): Promise<string | undefined> {
  try {
    const result = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = result.stdout.trim();
    return branch && branch !== DETACHED_HEAD ? branch : undefined;
  } catch {
    return undefined;
  }
}

function toReviewPullRequest(pr: PrSummary): AppServerReviewPullRequest {
  return {
    provider: pr.provider,
    org: pr.org,
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    ...(pr.title?.trim() ? { title: pr.title.trim() } : {}),
    ...(pr.headRefName?.trim() ? { headRefName: pr.headRefName.trim() } : {}),
    ...(pr.baseRefName?.trim() ? { baseRefName: pr.baseRefName.trim() } : {}),
  };
}

/**
 * The checked-out branch is the signal. A branch carrying a pull request is
 * strong evidence that the pull request is what was reviewed; nothing else the
 * thread happens to hold says anything about this diff, so a thread's other
 * pull requests are never candidates.
 *
 * `linkedDirectoryPaths` is thread-local provenance recorded by PR discovery.
 * It is what keeps two of the thread's repositories sharing a branch name —
 * `main`, or a shared `agent/...` convention — from crossing over. Where it is
 * absent (an older row, a peer that predates it) the workspace's own Git
 * remotes narrow the field instead.
 */
async function selectPullRequestForBranch(params: {
  cwd: string;
  branch: string;
  prs: PrSummary[];
  resolveGitHubRepos: (cwd: string) => Promise<GitHubRepoRef[]>;
}): Promise<PrSummary | undefined> {
  const branch = normalizeFullRef(params.branch);
  const onBranch = params.prs.filter(
    (pr) =>
      Boolean(pr.headRefName?.trim())
      && normalizeFullRef(pr.headRefName ?? "") === branch,
  );
  if (onBranch.length === 0) {
    return undefined;
  }

  const scoped = onBranch.filter((pr) => pr.linkedDirectoryPaths?.length);
  let candidates = scoped.filter((pr) => prBelongsToWorkspace(pr, params.cwd));
  if (candidates.length === 0) {
    // Only fall back to the unscoped rows. A PR that named its directories and
    // did not name this one has already answered the question.
    candidates = onBranch.filter((pr) => !pr.linkedDirectoryPaths?.length);
  }
  if (candidates.length === 0) {
    return undefined;
  }

  if (candidates.length > 1) {
    const repositories = await params.resolveGitHubRepos(params.cwd).catch(
      () => [] as GitHubRepoRef[],
    );
    if (repositories.length > 0) {
      const inRepository = candidates.filter((pr) =>
        repositories.some((repo) => prMatchesRepository(pr, repo))
      );
      if (inRepository.length > 0) {
        candidates = inRepository;
      }
    }
  }

  // One branch can carry a closed PR and its reopened successor. The open one
  // is the review's subject; ties break on the newer number so the choice is
  // stable rather than dependent on fetch order.
  const open = candidates.filter((pr) => pr.lifecycleState === "open");
  const ranked = open.length > 0 ? open : candidates;
  return ranked.reduce((best, pr) => (pr.number > best.number ? pr : best));
}

/**
 * Freezes what a review card needs to say what it reviewed. Returns undefined
 * only when there is no workspace to name at all — every other unknown is
 * carried as an absent field, because "we could not check" and "we checked and
 * there was none" have to stay distinguishable on the card.
 */
export async function resolveReviewProvenance(params: {
  cwd?: string;
  executionTarget?: "local" | "remote";
  linkedDirectories?: LinkedDirectorySummary[];
  prs?: PrSummary[];
  resolveGitHubRepos?: (cwd: string) => Promise<GitHubRepoRef[]>;
  runGit?: ReviewGitRunner;
  target: AppServerReviewTarget;
}): Promise<AppServerReviewContext | undefined> {
  const cwd = params.cwd?.trim();
  if (!cwd) {
    return undefined;
  }

  const directory = (params.linkedDirectories ?? []).find((candidate) =>
    directoryMatchesWorkspace(candidate, cwd)
  );
  const context: AppServerReviewContext = {
    workspacePath: cwd,
  };
  const projectLabel = resolveProjectLabel(directory, cwd);
  if (projectLabel) {
    context.projectLabel = projectLabel;
  }
  if (
    directory?.kind === "worktree"
    && directory.path.trim()
    && normalizeWorkspacePath(directory.path) !== normalizeWorkspacePath(cwd)
  ) {
    context.repositoryPath = directory.path.trim();
  }
  if (params.target.type === "baseBranch") {
    context.baseBranch = params.target.branch;
  }

  // A commit target reviews that commit, not the branch that happens to be
  // checked out beside it. Naming the branch would attach the review to work it
  // did not look at, and the pull-request match rests on the same signal.
  if (params.target.type === "commit") {
    return context;
  }

  // Local Git is the only workspace inspection available here. A remote
  // workspace keeps whatever branch navigation last observed and stops short of
  // a pull-request claim it cannot verify.
  const branch = params.executionTarget === "remote"
    ? directory?.gitBranch?.trim()
    : await resolveCheckedOutBranch(params.runGit ?? runGitCommand, cwd)
      ?? directory?.gitBranch?.trim();
  if (!branch) {
    return context;
  }
  context.gitBranch = branch;

  if (!params.prs) {
    // No pull-request data was fetched for this thread, so nothing was checked.
    return context;
  }

  const pullRequest = await selectPullRequestForBranch({
    branch,
    cwd,
    prs: params.prs,
    resolveGitHubRepos:
      params.resolveGitHubRepos ?? resolveGitHubReposForDirectory,
  });
  context.pullRequest = pullRequest ? toReviewPullRequest(pullRequest) : null;
  return context;
}
