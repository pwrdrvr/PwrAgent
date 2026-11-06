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
 *
 * This rank picks the chip's PR only. The popover lists PRs by age, so a row
 * does not jump when its checks change (see `ordered`).
 */
export type PrRollup = {
  /** The PR whose state the chip wears. */
  representative: PrSummary;
  /**
   * Every PR in list order: two stacks, open above finished. Each stack puts
   * its newest entry on top: open PRs by when they were opened, finished PRs
   * by when they merged or closed. A PR that merges moves to the top of the
   * finished stack and keeps that place as later PRs finish above it.
   */
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

type Stacked = { pr: PrSummary; index: number; at: number | undefined };

/**
 * Newest first. An entry without a time goes to the top when `missing` is
 * "top" and to the bottom when it is "bottom". Ties and entries without a
 * time fall back to attachment order, later attachments first.
 */
function newestFirst(
  entries: Stacked[],
  missing: "top" | "bottom",
): PrSummary[] {
  const unknown = missing === "top" ? Infinity : -Infinity;
  return [...entries]
    .sort((a, b) => (b.at ?? unknown) - (a.at ?? unknown) || b.index - a.index)
    .map((entry) => entry.pr);
}

export function resolvePrRollup(prs: readonly PrSummary[]): PrRollup | undefined {
  if (prs.length === 0) {
    return undefined;
  }
  const open: Stacked[] = [];
  const finished: Stacked[] = [];
  prs.forEach((pr, index) => {
    if (resolveLifecycleState(pr) === "open") {
      open.push({ pr, index, at: pr.createdAt });
    } else {
      finished.push({ pr, index, at: pr.mergedAt ?? pr.closedAt });
    }
  });
  // An open PR without `createdAt` has not been polled yet, so it is a fresh
  // attachment: the newest. A finished PR without a time finished before the
  // timestamps existed and is never polled again: the oldest.
  const ordered = [
    ...newestFirst(open, "top"),
    ...newestFirst(finished, "bottom"),
  ];
  // The chip wears the least ready open PR, else merged before closed.
  const representative = open.length > 0
    ? lowestKey(open, openSortKey)
    : lowestKey(finished, finishedSortKey);
  const mergedCount = finished.filter((entry) => finishedSortKey(entry.pr) === 0).length;
  return {
    representative,
    ordered,
    openCount: open.length,
    lead: open.length === 1 ? open[0]!.pr : undefined,
    summary: rollupSummary(representative, open.length, prs.length, mergedCount),
  };
}

/** The entry with the lowest key; the earliest attached wins a tie. */
function lowestKey(entries: Stacked[], key: (pr: PrSummary) => number): PrSummary {
  return entries.reduce((best, entry) => (key(entry.pr) < key(best.pr) ? entry : best)).pr;
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
