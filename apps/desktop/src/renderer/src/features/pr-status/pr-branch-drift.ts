import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { resolveLifecycleState } from "./pr-chip-state";

/**
 * How far the thread's branch is from its base, carried to the hover card of
 * the PR on that branch. The branch chip's hover is the other place these
 * counts appear, and Compact and Minimal density hide that chip.
 */
export type PrBranchDrift = {
  /** Canonical PR identity, including when a transcript links to a subpage. */
  prKey: string;
  baseBranch: string;
  /** Commits on the base after the merge base. */
  behind?: number;
  /** Commits on the branch after the merge base. */
  ahead?: number;
  /**
   * The `upstream` remote's default branch, when the base is a fork's copy
   * of it: the fork only moves when the operator syncs it.
   */
  upstreamBranch?: string;
  /** Commits on `upstreamBranch` the branch does not have. */
  upstreamBehind?: number;
};

/**
 * The open PR whose head is the thread's current branch. The counts describe
 * that checkout, so a PR on another branch or repository, or one that has
 * finished, gets none. `isThreadRepository` says whether a PR belongs to the
 * thread's own repository or the fork it pushes to.
 *
 * `baseBranch` is Git's best guess at the branch's base. When the PR names a
 * different base, the counts measure the wrong thing (behind `main` for a PR
 * into `release/1.0`), so that PR gets none either.
 */
export function findBranchDriftPr(params: {
  prs: readonly PrSummary[];
  branch: string | undefined;
  baseBranch: string | undefined;
  isThreadRepository: (pr: PrSummary) => boolean;
}): PrSummary | undefined {
  const branch = params.branch?.trim();
  // A detached HEAD reports "HEAD", which no PR is named after.
  if (!branch || branch === "HEAD") {
    return undefined;
  }
  return params.prs.find((pr) =>
    pr.headRefName?.trim() === branch
    && resolveLifecycleState(pr) === "open"
    && isSameBase(params.baseBranch, pr.baseRefName)
    && params.isThreadRepository(pr));
}

/**
 * Git reports the base as a local or remote-tracking ref (`main`,
 * `origin/main`); the PR names the branch alone. An unknown side cannot
 * disagree.
 */
function isSameBase(gitBase: string | undefined, prBase: string | undefined): boolean {
  const git = gitBase?.trim();
  const pr = prBase?.trim();
  if (!git || !pr) {
    return true;
  }
  return git === pr || git.endsWith(`/${pr}`);
}

/**
 * The drift's counts, or undefined when there is nothing to show. Git state
 * can come from a peer, so anything that is not a whole, non-negative number
 * is treated as unknown rather than rendered.
 */
export function readPrBranchDrift(
  drift: PrBranchDrift | undefined,
): {
  baseBranch: string;
  behind?: number;
  ahead?: number;
  upstream?: { branch: string; behind: number };
} | undefined {
  const baseBranch = drift?.baseBranch.trim();
  if (!drift || !baseBranch) {
    return undefined;
  }
  const behind = readCount(drift.behind);
  const ahead = readCount(drift.ahead);
  const upstreamBranch = drift.upstreamBranch?.trim();
  const upstreamBehind = readCount(drift.upstreamBehind);
  const upstream = upstreamBranch && upstreamBehind !== undefined
    ? { branch: upstreamBranch, behind: upstreamBehind }
    : undefined;
  if (behind === undefined && ahead === undefined && !upstream) {
    return undefined;
  }
  return { baseBranch, behind, ahead, ...(upstream ? { upstream } : {}) };
}

/**
 * The rollup list's short form, `4 behind main`. Only the behind count fits
 * on that line, and only a branch that is behind needs saying. A fork's base
 * that is current says nothing about the upstream, so the upstream count
 * speaks when the base's is 0.
 */
export function prBranchBehindLabel(drift: PrBranchDrift | undefined): string | undefined {
  const counts = readPrBranchDrift(drift);
  if (counts?.behind) {
    return `${counts.behind.toLocaleString()} behind ${counts.baseBranch}`;
  }
  if (counts?.upstream?.behind) {
    return `${counts.upstream.behind.toLocaleString()} behind ${counts.upstream.branch}`;
  }
  return undefined;
}

function readCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}
