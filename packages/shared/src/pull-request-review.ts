import type { AppServerReviewTarget } from "./contracts/normalized-app-server";
import type { NavigationThreadSummary, PrSummary } from "./contracts/navigation";
import { findPrimaryReviewWorkspaceCwd } from "./review-branches";

/**
 * The one pull request URL shape an explicit review target accepts. The owner
 * re-checks it before resolving anything, and the composer filters candidates
 * through it so it never offers a target the owner would refuse.
 */
export const EXPLICIT_REVIEW_PULL_REQUEST_URL =
  /^https:\/\/(github\.com)\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/;

const PULL_REQUEST_REVIEW_INTRO =
  "Review the complete pull request diff at the following immutable commits.";
const PULL_REQUEST_REVIEW_END =
  "Report findings against the pinned head's file paths and line numbers.";

/** Recognize our generated instructions, including whitespace-folded review hints. */
export function pullRequestReviewPromptUrl(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    !normalized.startsWith(`${PULL_REQUEST_REVIEW_INTRO} Pull request: `)
    || !normalized.endsWith(PULL_REQUEST_REVIEW_END)
  ) {
    return undefined;
  }
  const url = normalized.slice(`${PULL_REQUEST_REVIEW_INTRO} Pull request: `.length)
    .split(";", 1)[0];
  return EXPLICIT_REVIEW_PULL_REQUEST_URL.test(url) ? url : undefined;
}

function normalizeReviewWorkspacePath(value: string): string {
  const path = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}

/** A PR's `host/owner/repo`, lowercased, or "" for a URL that names none. */
export function pullRequestRepositoryKey(pr: Pick<PrSummary, "url">): string {
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url);
  return match ? `${match[1]}/${match[2]}/${match[3]}`.toLowerCase() : "";
}

/** Navigation filtering is advisory; the owner verifies fresh Git remotes. */
export function attachedPullRequestsForWorkspace(params: {
  prs: PrSummary[];
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  /** More `host/owner/repo` identities of the same checkout. */
  repositories?: string[];
}): PrSummary[] {
  if (!params.cwd) return [];
  const scoped = params.prs.filter((pr) => pr.linkedDirectoryPaths?.some(
    (path) => normalizeReviewWorkspacePath(path) === normalizeReviewWorkspacePath(params.cwd!)
      || (params.repositoryPath && normalizeReviewWorkspacePath(path) === normalizeReviewWorkspacePath(params.repositoryPath)),
  ));
  const repositories = new Set([
    ...[params.repository, ...(params.repositories ?? [])]
      .map((value) => value?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value)),
    ...scoped.map(pullRequestRepositoryKey).filter(Boolean),
  ]);
  return params.prs.filter((pr) => repositories.has(pullRequestRepositoryKey(pr)));
}

function sameReviewWorkspacePath(left?: string, right?: string): boolean {
  const normalizedLeft = left ? normalizeReviewWorkspacePath(left) : "";
  return Boolean(normalizedLeft)
    && normalizedLeft === (right ? normalizeReviewWorkspacePath(right) : "");
}

function findReviewLinkedDirectory(
  thread: NavigationThreadSummary | undefined,
  cwd: string | undefined,
): NavigationThreadSummary["linkedDirectories"][number] | undefined {
  return thread?.linkedDirectories.find((directory) =>
    sameReviewWorkspacePath(directory.worktreePath ?? directory.path, cwd)
  );
}

type ReviewWorkspaceScope = {
  cwd?: string;
  directory?: { gitStatus?: { originRepository?: string } };
  thread?: NavigationThreadSummary;
};

/**
 * The thread's attached PRs that belong to one review workspace's repository.
 * A linked worktree often has no directory row of its own, so its linked
 * directory's repository identity counts as much as a directory's origin.
 */
export function reviewWorkspacePullRequests(params: ReviewWorkspaceScope): PrSummary[] {
  const linkedDirectory = findReviewLinkedDirectory(params.thread, params.cwd);
  return attachedPullRequestsForWorkspace({
    cwd: params.cwd,
    prs: params.thread?.prs ?? [],
    repository: params.directory?.gitStatus?.originRepository,
    repositories: linkedDirectory?.repositoryKey
      ? [linkedDirectory.repositoryKey]
      : [],
    repositoryPath: linkedDirectory?.path,
  });
}

/**
 * The thread as seen from one review workspace. The thread's branch, working
 * state and PR list describe its primary checkout and every repository it
 * touched. A base branch inferred from them for another project compares
 * that project with the wrong repository's branch.
 */
export function reviewThreadForWorkspace(
  params: ReviewWorkspaceScope,
): NavigationThreadSummary | undefined {
  const { thread } = params;
  if (!thread || !params.cwd) {
    return thread;
  }
  const linkedDirectory = findReviewLinkedDirectory(thread, params.cwd);
  const prs = reviewWorkspacePullRequests(params);
  if (sameReviewWorkspacePath(params.cwd, findPrimaryReviewWorkspaceCwd(thread))) {
    // The thread's own fields describe the primary checkout. When none of its
    // PRs match by repository (no identity yet, or an origin that still names
    // a renamed repository), every attached PR stays a hint, as it was before
    // workspaces were told apart.
    return prs.length > 0 ? { ...thread, prs } : thread;
  }
  const secondary: NavigationThreadSummary = { ...thread, prs };
  delete secondary.gitWorkingState;
  delete secondary.observedGitBranch;
  const gitBranch = linkedDirectory?.gitBranch?.trim();
  if (gitBranch) {
    secondary.gitBranch = gitBranch;
  } else {
    delete secondary.gitBranch;
  }
  return secondary;
}

/** Translate only at the engine boundary; retain the original target in state. */
export function nativeReviewTarget(
  target: AppServerReviewTarget,
): Exclude<AppServerReviewTarget, { type: "pullRequest" }> {
  if (target.type !== "pullRequest") return target;
  const snapshot = target.snapshot;
  if (!snapshot || ![snapshot.baseCommit, snapshot.headCommit, snapshot.mergeBaseCommit]
    .every((sha) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))) {
    throw new Error("Pull request review requires an owner-resolved commit snapshot.");
  }
  return {
    type: "custom",
    instructions: [
      PULL_REQUEST_REVIEW_INTRO,
      `Pull request: ${snapshot.pullRequest.url}; base branch: ${snapshot.pullRequest.baseRefName}; head branch: ${snapshot.pullRequest.headRefName}; captured at: ${snapshot.capturedAt}.`,
      `Base tip: ${snapshot.baseCommit}; head: ${snapshot.headCommit}; merge base: ${snapshot.mergeBaseCommit}.`,
      `Inspect git diff --no-ext-diff ${snapshot.mergeBaseCommit} ${snapshot.headCommit} --`,
      `Read every target file and surrounding context using git show '${snapshot.headCommit}:path/to/file' (substitute the actual path).`,
      "The active checkout may contain another stacked PR and uncommitted work. Do not read working-tree files as the reviewed version, compare against HEAD, or include later commits or local changes.",
      "Do not checkout, switch, reset, stash, or modify the workspace. If an object is unavailable, report that the review cannot proceed; do not substitute another revision.",
      PULL_REQUEST_REVIEW_END,
    ].join("\n"),
  };
}

/**
 * How the selected workspace compares with an attached pull request.
 *
 * A PR target reviews the provider's published head. A base-branch or
 * current-changes target reviews the checkout in front of the operator. Those
 * are the same review only when the checkout sits exactly on the PR's head
 * with nothing local on top, so the composer has to be able to say which case
 * it is instead of offering two targets that look interchangeable.
 */
export type AttachedPullRequestLocalSync = {
  /** The probe that would answer this landed. `false` means "not known yet". */
  known: boolean;
  /** The checkout reviews exactly what this pull request contains. */
  matches: boolean;
  /** Why the checkout differs, most specific first. Empty when unknown. */
  differences: string[];
};

const UNKNOWN_PULL_REQUEST_SYNC: AttachedPullRequestLocalSync = {
  known: false,
  matches: false,
  differences: [],
};

function countPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function sameBranch(left?: string, right?: string): boolean {
  const normalize = (value?: string): string =>
    value?.trim().replace(/^origin\//, "") ?? "";
  const normalizedLeft = normalize(left);
  return Boolean(normalizedLeft) && normalizedLeft === normalize(right);
}

export function describeAttachedPullRequestLocalSync(params: {
  currentBranch?: string;
  /**
   * Consulted only when it describes this same checkout, which the matching
   * branch name establishes: Git refuses the same branch in two worktrees.
   */
  directoryGitStatus?: {
    behind?: number;
    currentBranch?: string;
    recentCommits?: Array<{ sha: string; shortSha: string }>;
  };
  gitWorkingState?: {
    dirtyFiles: number;
    unpushedCommits: number;
    untrackedFiles: number;
  };
  pr: Pick<PrSummary, "headRefName" | "headSha">;
}): AttachedPullRequestLocalSync {
  const { currentBranch, gitWorkingState, pr } = params;
  if (!pr.headRefName || !currentBranch) {
    return UNKNOWN_PULL_REQUEST_SYNC;
  }
  if (!sameBranch(currentBranch, pr.headRefName)) {
    return {
      known: true,
      matches: false,
      differences: [
        `this checkout is on ${currentBranch}, not the pull request's ${pr.headRefName}`,
      ],
    };
  }
  if (!gitWorkingState) {
    return UNKNOWN_PULL_REQUEST_SYNC;
  }

  const differences: string[] = [];
  if (gitWorkingState.dirtyFiles > 0) {
    differences.push(countPhrase(
      gitWorkingState.dirtyFiles,
      "uncommitted file",
      "uncommitted files",
    ));
  }
  if (gitWorkingState.untrackedFiles > 0) {
    differences.push(countPhrase(
      gitWorkingState.untrackedFiles,
      "untracked file",
      "untracked files",
    ));
  }
  if (gitWorkingState.unpushedCommits > 0) {
    differences.push(countPhrase(
      gitWorkingState.unpushedCommits,
      "unpushed commit",
      "unpushed commits",
    ));
  }

  // The directory row describes this checkout only while it reports the same
  // branch. When it does, its head commit answers the question exactly and
  // the ahead/behind counters stop being a proxy for it.
  const sameCheckout = sameBranch(
    params.directoryGitStatus?.currentBranch,
    pr.headRefName,
  );
  const localHead = sameCheckout
    ? params.directoryGitStatus?.recentCommits?.[0]
    : undefined;
  const behind = sameCheckout ? params.directoryGitStatus?.behind ?? 0 : 0;
  if (localHead && pr.headSha && localHead.sha !== pr.headSha) {
    differences.push(
      `a different head commit (${localHead.shortSha} here,`
      + ` ${pr.headSha.slice(0, 7)} on the pull request)`,
    );
  } else if (!localHead && behind > 0) {
    differences.push(
      countPhrase(
        behind,
        "commit behind the remote branch",
        "commits behind the remote branch",
      ),
    );
  }

  if (differences.length > 0) {
    return { known: true, matches: false, differences };
  }
  if (!localHead?.sha || !pr.headSha) return UNKNOWN_PULL_REQUEST_SYNC;
  return { known: true, matches: localHead.sha === pr.headSha, differences };
}

/**
 * The attached pull request the operator already has checked out, clean and
 * fully pushed. Only then does targeting the pull request review the same
 * commits a local review would, which is what lets the composer default to it
 * instead of making the operator choose between two identical-looking targets.
 */
export function findCheckedOutPullRequest(params: {
  currentBranch?: string;
  directoryGitStatus?: Parameters<
    typeof describeAttachedPullRequestLocalSync
  >[0]["directoryGitStatus"];
  gitWorkingState?: Parameters<
    typeof describeAttachedPullRequestLocalSync
  >[0]["gitWorkingState"];
  prs: PrSummary[];
}): PrSummary | undefined {
  return params.prs.find(
    (pr) =>
      pr.lifecycleState === "open"
      && describeAttachedPullRequestLocalSync({ ...params, pr }).matches,
  );
}
