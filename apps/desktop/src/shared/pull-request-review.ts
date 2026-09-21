import type { AppServerReviewTarget, PrSummary } from "@pwragent/shared";

/**
 * The one pull request URL shape an explicit review target accepts. The owner
 * re-checks it before resolving anything, and the composer filters candidates
 * through it so it never offers a target the owner would refuse.
 */
export const EXPLICIT_REVIEW_PULL_REQUEST_URL =
  /^https:\/\/(github\.com)\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/;

/** Navigation filtering is advisory; the owner verifies fresh Git remotes. */
export function attachedPullRequestsForWorkspace(params: {
  prs: PrSummary[];
  cwd?: string;
  repository?: string;
}): PrSummary[] {
  if (!params.cwd) return [];
  const normalizePath = (value: string): string => {
    const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
  };
  const repository = (pr: PrSummary): string => {
    const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url);
    return match ? `${match[1]}/${match[2]}/${match[3]}`.toLowerCase() : "";
  };
  const scoped = params.prs.filter((pr) => pr.linkedDirectoryPaths?.some(
    (path) => normalizePath(path) === normalizePath(params.cwd!),
  ));
  const repositories = new Set(params.repository
    ? [params.repository.toLowerCase()]
    : scoped.map(repository).filter(Boolean));
  return params.prs.filter((pr) => repositories.has(repository(pr)));
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
      `Review the complete pull request diff at the following immutable commits.`,
      `Pull request: ${snapshot.pullRequest.url}; base branch: ${snapshot.pullRequest.baseRefName}; head branch: ${snapshot.pullRequest.headRefName}; captured at: ${snapshot.capturedAt}.`,
      `Base tip: ${snapshot.baseCommit}; head: ${snapshot.headCommit}; merge base: ${snapshot.mergeBaseCommit}.`,
      `Inspect git diff --no-ext-diff ${snapshot.mergeBaseCommit} ${snapshot.headCommit} --`,
      `Read every target file and surrounding context using git show '${snapshot.headCommit}:path/to/file' (substitute the actual path).`,
      "The active checkout may contain another stacked PR and uncommitted work. Do not read working-tree files as the reviewed version, compare against HEAD, or include later commits or local changes.",
      "Do not checkout, switch, reset, stash, or modify the workspace. If an object is unavailable, report that the review cannot proceed; do not substitute another revision.",
      "Report findings against the pinned head's file paths and line numbers.",
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

  return { known: true, matches: differences.length === 0, differences };
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
