import {
  comparePullRequestStack,
  pullRequestRollupPriority,
  resolveLifecycleState,
} from "@pwragent/shared/pull-request-rollup";
import { type PrSummary } from "@pwragent/shared/contracts/navigation";
import { formatRelativeTime } from "../navigation/thread-time";
import { prStatusLabel } from "./pr-chip-state";

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

export function resolvePrRollup(prs: readonly PrSummary[]): PrRollup | undefined {
  if (prs.length === 0) {
    return undefined;
  }
  const open = prs.filter((pr) => resolveLifecycleState(pr) === "open");
  const mergedCount = prs.filter((pr) => resolveLifecycleState(pr) === "merged").length;
  // Later attachments win age ties. Earliest attachments win readiness ties.
  const ordered = prs.toReversed().sort(comparePullRequestStack);
  const representative = prs.reduce((best, pr) =>
    pullRequestRollupPriority(pr) < pullRequestRollupPriority(best) ? pr : best);
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

/**
 * Mission Control's two PR chips: the lead PR's own chip and a `+N PRs` chip
 * for the rest. The lead is the one open PR when exactly one is open, else
 * the top of the list (`ordered[0]`: the newest open PR, else the newest
 * finished one), so it does not move when a check changes. The overflow chip
 * wears the least ready of the PRs it hides, so a failure behind it still
 * shows.
 */
export type PrOverflow = {
  lead: PrSummary;
  /** Every other PR, in list order. */
  rest: PrSummary[];
  /** The rest's own rollup: the overflow chip wears its representative. */
  restRollup: PrRollup;
};

export function resolvePrOverflow(prs: readonly PrSummary[]): PrOverflow | undefined {
  if (prs.length < 2) {
    return undefined;
  }
  const rollup = resolvePrRollup(prs)!;
  const lead = rollup.lead ?? rollup.ordered[0]!;
  const rest = [...rollup.ordered];
  rest.splice(rest.indexOf(lead), 1);
  return {
    lead,
    rest,
    restRollup: resolvePrRollup(rest)!,
  };
}

/** The overflow chip's label: `+1 PR`, `+3 PRs`. */
export function prOverflowLabel(hiddenCount: number): string {
  return `+${hiddenCount} ${hiddenCount === 1 ? "PR" : "PRs"}`;
}

/** The rollup chip's visible label: the PR number alone, or the count. */
export function prRollupLabel(prs: readonly PrSummary[]): string {
  return prs.length === 1 ? `#${prs[0]!.number}` : `${prs.length} PRs`;
}

/** A PR's chip label: `#12`, or `org/repo#12` when it needs its repository. */
export function prNumberLabel(pr: PrSummary, showRepoPrefix: boolean): string {
  return showRepoPrefix ? `${pr.org}/${pr.repo}#${pr.number}` : `#${pr.number}`;
}

/**
 * The time that places a PR in its stack (see `PrRollup.ordered`), in the
 * sidebar's own age vocabulary: "opened 2h ago", "merged 15h ago",
 * "closed Aug 16". Lists that sort by these times print them, or a merged
 * stack read top to bottom looks like an ascending PR-number sort whenever
 * an older PR merged last. Undefined when the PR carries no such time.
 */
export function prStackTimeLabel(pr: PrSummary): string | undefined {
  const lifecycle = resolveLifecycleState(pr);
  const at = lifecycle === "open"
    ? pr.createdAt
    : lifecycle === "merged"
      ? pr.mergedAt
      : pr.closedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) {
    return undefined;
  }
  const verb = lifecycle === "open" ? "opened" : lifecycle;
  const age = formatRelativeTime(at);
  if (age === "now") {
    return `${verb} just now`;
  }
  return /^\d/.test(age) ? `${verb} ${age} ago` : `${verb} ${age}`;
}
