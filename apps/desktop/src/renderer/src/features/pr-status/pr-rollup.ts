import type { PrSummary } from "@pwragent/shared";
import {
  isPrStatusUnknown,
  prStatusLabel,
  resolveCheckState,
  resolveLifecycleState,
} from "./pr-chip-state";

/**
 * One status for every pull request on a thread: the Minimal density's PR
 * chip. It shows the LEAST ready open PR, because that is the one that needs
 * the operator. A closed-without-merge PR is ignored while any PR is open.
 * Only when every PR has finished does the rollup report that: merged when
 * any merged, else closed.
 *
 * Open PRs rank, least ready first:
 *   0 merge conflict
 *   1 checks failed (settled)
 *   2 checks failing, more still running
 *   3 checks running
 *   4 checks passing (draft before ready for review)
 *   5 status unknown (a fresh attachment that has not been polled)
 *
 * Unknown ranks last so one unpolled attachment does not hide a known
 * failure, and a known pass beats it as the summary.
 */
export type PrRollup = {
  /** The PR whose state the chip wears. */
  representative: PrSummary;
  /** Every PR, least ready first; finished PRs at the end. */
  ordered: PrSummary[];
  openCount: number;
  /**
   * The only open PR, when exactly one is open. The chip names it and counts
   * the rest (`#12 +3`), since it is the one PR the operator is after however
   * many have finished.
   */
  lead: PrSummary | undefined;
  /** The rollup's state in words, for the chip's accessible name. */
  summary: string;
};

const DRAFT_TIEBREAK = 0.5;

function openReadinessRank(pr: PrSummary): number {
  if (isPrStatusUnknown(pr)) {
    return 5;
  }
  if (pr.mergeState === "conflicting") {
    return 0;
  }
  switch (resolveCheckState(pr)) {
    case "failing":
      return pr.checksStillRunning ? 2 : 1;
    case "pending":
      return 3;
    case "passing":
      return 4;
    case "unknown":
      return 5;
  }
}

/** Ranks draft before ready only among otherwise equal PRs. */
function openSortKey(pr: PrSummary): number {
  const rank = openReadinessRank(pr);
  return rank + (pr.reviewState === "draft" ? 0 : DRAFT_TIEBREAK);
}

function finishedSortKey(pr: PrSummary): number {
  return resolveLifecycleState(pr) === "merged" ? 0 : 1;
}

export function resolvePrRollup(prs: readonly PrSummary[]): PrRollup | undefined {
  if (prs.length === 0) {
    return undefined;
  }
  const open: PrSummary[] = [];
  const finished: PrSummary[] = [];
  for (const pr of prs) {
    (resolveLifecycleState(pr) === "open" ? open : finished).push(pr);
  }
  // Array sort is stable, so equal PRs keep their attachment order.
  open.sort((a, b) => openSortKey(a) - openSortKey(b));
  finished.sort((a, b) => finishedSortKey(a) - finishedSortKey(b));
  const ordered = [...open, ...finished];
  const mergedCount = finished.filter((pr) => finishedSortKey(pr) === 0).length;
  const representative = ordered[0]!;
  return {
    representative,
    ordered,
    openCount: open.length,
    lead: open.length === 1 ? open[0] : undefined,
    summary: rollupSummary(representative, open.length, prs.length, mergedCount),
  };
}

function rollupSummary(
  representative: PrSummary,
  openCount: number,
  total: number,
  mergedCount: number,
): string {
  if (openCount > 0 || total === 1) {
    // The popover's rows say each PR's state with the same sentence.
    return prStatusLabel(representative);
  }
  if (mergedCount === total) {
    return "all merged";
  }
  return mergedCount > 0 ? "all merged or closed" : "all closed";
}

/** The rollup chip's visible label: the PR number alone, or the count. */
export function prRollupLabel(prs: readonly PrSummary[]): string {
  return prs.length === 1 ? `#${prs[0]!.number}` : `${prs.length} PRs`;
}

/** A PR's chip label: `#12`, or `org/repo#12` when it needs its repository. */
export function prNumberLabel(pr: PrSummary, showRepoPrefix: boolean): string {
  return showRepoPrefix ? `${pr.org}/${pr.repo}#${pr.number}` : `#${pr.number}`;
}
