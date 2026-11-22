import type { PrSummary } from "@pwragent/shared/contracts/navigation";

/**
 * Where an open pull request stands on the way to merge, from PwrAgent's
 * side: has the current head been reviewed, are the findings settled, and is
 * CI green. See docs/pr-review-readiness.md.
 *
 * Only `needs_review` and `ready_to_merge` raise an offer. Every other state
 * waits: CI is running or failing, the branch conflicts, the PR is a draft
 * or already in a merge queue, or a review's findings are still open.
 */
export type PrReviewReadiness =
  | "closed"
  | "draft"
  | "no_head"
  | "queued"
  | "conflicting"
  | "ci_pending"
  | "ci_failing"
  | "ci_untested"
  | "needs_review"
  | "findings_open"
  | "ready_to_merge";

/** One review of this PR, judged against the PR's current head. */
export type PrReviewCoverage = {
  reviewId: string;
  createdAt: number;
  /**
   * The current head carries the same change as what this review saw, or as
   * the head its findings were fixed through. A rebase onto the target or a
   * merge of the target keeps it; a new change does not.
   */
  coversHead: boolean;
  /** Findings neither addressed, declined, nor deferred. */
  openFindings: number;
};

export type PrReadinessPr = Pick<
  PrSummary,
  | "headSha"
  | "state"
  | "checkState"
  | "checksStillRunning"
  | "checksAllSkipped"
  | "lifecycleState"
  | "reviewState"
  | "mergeState"
  | "mergeQueue"
>;

export type PrReviewReadinessResult = {
  readiness: PrReviewReadiness;
  /**
   * The newest review that covers the head, or, when none does, the latest
   * review whose findings are still open.
   */
  reviewId?: string;
  openFindings?: number;
};

const QUEUED_STATES = new Set(["queued", "group_checks_running", "merging", "merged_by_queue"]);

/**
 * The part of readiness that needs no review data and no Git: lifecycle, CI,
 * and mergeability. `undefined` means CI is green on a head that can merge,
 * and only then is a review lookup worth its Git work.
 */
export function prGateReadiness(pr: PrReadinessPr): PrReviewReadiness | undefined {
  if (pr.lifecycleState === "merged" || pr.lifecycleState === "closed") return "closed";
  if (pr.reviewState === "draft") return "draft";
  if (!pr.headSha) return "no_head";
  if (pr.mergeQueue && QUEUED_STATES.has(pr.mergeQueue.state)) return "queued";
  if (pr.mergeState === "conflicting") return "conflicting";
  if (pr.checksStillRunning) return "ci_pending";
  const checkState = pr.checkState ?? pr.state;
  if (checkState === "failing") return "ci_failing";
  if (checkState !== "passing") return "ci_pending";
  // Every check skipped: CI tested nothing, so it is not green.
  if (pr.checksAllSkipped) return "ci_untested";
  return undefined;
}

export function derivePrReviewReadiness(params: {
  pr: PrReadinessPr;
  reviews: readonly PrReviewCoverage[];
}): PrReviewReadinessResult {
  const gate = prGateReadiness(params.pr);
  return gate ? { readiness: gate } : deriveReviewStanding(params.reviews);
}

/**
 * Where the reviews leave the head, whatever CI says: the review side of
 * readiness. The merge-card gate and the status read use it while CI is
 * still running, when `derivePrReviewReadiness` reports only the CI state.
 */
export type ReviewStanding = "needs_review" | "findings_open" | "ready_to_merge";

export function deriveReviewStanding(
  reviews: readonly PrReviewCoverage[],
): { readiness: ReviewStanding; reviewId?: string; openFindings?: number } {
  let newest: PrReviewCoverage | undefined;
  let latest: PrReviewCoverage | undefined;
  for (const review of reviews) {
    if (!latest || review.createdAt > latest.createdAt) latest = review;
    if (!review.coversHead) continue;
    if (!newest || review.createdAt > newest.createdAt) newest = review;
  }
  if (!newest) {
    // Commits pushed while the latest review's findings are open are its
    // fixes, not new work: wait for them to settle rather than ask for
    // another review.
    if (latest && latest.openFindings > 0) {
      return { readiness: "findings_open", reviewId: latest.reviewId, openFindings: latest.openFindings };
    }
    return { readiness: "needs_review" };
  }
  return {
    readiness: newest.openFindings > 0 ? "findings_open" : "ready_to_merge",
    reviewId: newest.reviewId,
    openFindings: newest.openFindings,
  };
}

export type PrOfferKind = "review" | "merge";

/**
 * An offer PwrAgent raises as a to-do card. `offerId` is stored as the card's
 * dependency id, which is unique, so an operator who dismisses or runs an
 * offer is not asked again for the same thing. An offer PwrAgent withdrew
 * itself can come back.
 *
 * A review offer is per change (the head's content identity), so a rebase of
 * an unreviewed PR does not ask again. A merge offer is per head commit,
 * because each new head needs its own green CI.
 */
export type PrOffer = {
  kind: PrOfferKind;
  offerId: string;
  prKey: string;
  headSha: string;
};

const OFFER_PREFIX = "pr-offer:";

/** The card key every offer for one PR shares, so a thread holds one at a time. */
export function prOfferCardKey(prKey: string): string {
  return `${OFFER_PREFIX}${prKey}`;
}

export function desiredPrOffer(params: {
  prKey: string;
  readiness: PrReviewReadiness;
  headSha?: string;
  /** The head's content identity; absent when Git could not compute it. */
  headContentId?: string;
}): PrOffer | undefined {
  const { prKey, readiness, headSha } = params;
  if (!headSha) return undefined;
  if (readiness === "needs_review") {
    const change = params.headContentId ? `patch:${params.headContentId}` : `sha:${headSha}`;
    return { kind: "review", offerId: `${OFFER_PREFIX}review:${prKey}:${change}`, prKey, headSha };
  }
  if (readiness === "ready_to_merge") {
    return { kind: "merge", offerId: `${OFFER_PREFIX}merge:${prKey}:sha:${headSha}`, prKey, headSha };
  }
  return undefined;
}

/** The open offer card a thread holds for a PR, as the reconciler sees it. */
export type OpenPrOffer = {
  cardId: string;
  kind: PrOfferKind;
  offerId: string;
  /** The head a merge offer was raised for. */
  headSha?: string;
};

export type PrOfferRetireReason = "superseded" | "reviewed" | "stale" | "closed";

export type PrOfferPlan = {
  retire?: { cardId: string; reason: PrOfferRetireReason };
  raise?: PrOffer;
};

/**
 * What to do with a PR's offer card. Waiting states (CI running or failing,
 * a conflict, a draft) leave a review offer alone: the change still needs a
 * review whatever CI does next. A merge offer is withdrawn as soon as its
 * head is no longer the one that was reviewed and green.
 */
export function planPrOffer(params: {
  open?: OpenPrOffer;
  desired?: PrOffer;
  readiness: PrReviewReadiness;
  headSha?: string;
  /**
   * A review covers the head. Set while CI still runs when a review offer is
   * open, so a review started some other way withdraws the offer at once.
   */
  headCovered?: boolean;
  /**
   * Where the reviews leave the head, when they were read while CI was not
   * green. A merge offer is withdrawn once it is anything but ready.
   */
  standing?: ReviewStanding;
}): PrOfferPlan {
  const { open, desired, readiness } = params;
  if (desired) {
    if (open?.offerId === desired.offerId) return {};
    return {
      ...(open ? { retire: { cardId: open.cardId, reason: "superseded" as const } } : {}),
      raise: desired,
    };
  }
  if (!open) return {};
  if (readiness === "closed") return { retire: { cardId: open.cardId, reason: "closed" } };
  if (open.kind === "review") {
    return readiness === "findings_open" || params.headCovered
      ? { retire: { cardId: open.cardId, reason: "reviewed" } }
      : {};
  }
  if (
    readiness === "needs_review"
    || readiness === "findings_open"
    || readiness === "draft"
    || readiness === "conflicting"
    || (params.standing !== undefined && params.standing !== "ready_to_merge")
    || open.headSha !== params.headSha
  ) {
    return { retire: { cardId: open.cardId, reason: "stale" } };
  }
  return {};
}

/**
 * Reads an offer back from the card's dependency id; undefined for any other
 * card. `headSha` is present when the id names a commit, as a merge offer's
 * always does.
 */
export function parsePrOfferId(
  offerId: string | undefined,
): { kind: PrOfferKind; prKey: string; headSha?: string } | undefined {
  if (!offerId?.startsWith(OFFER_PREFIX)) return undefined;
  const rest = offerId.slice(OFFER_PREFIX.length);
  const kind = rest.startsWith("review:") ? "review" : rest.startsWith("merge:") ? "merge" : undefined;
  if (!kind) return undefined;
  const body = rest.slice(kind.length + 1);
  const sha = body.lastIndexOf(":sha:");
  const patch = body.lastIndexOf(":patch:");
  if (sha > 0 && sha > patch) {
    return { kind, prKey: body.slice(0, sha), headSha: body.slice(sha + ":sha:".length) };
  }
  if (kind === "review" && patch > 0) return { kind, prKey: body.slice(0, patch) };
  return undefined;
}

export const PR_OFFER_RETIRE_RESULTS: Record<PrOfferRetireReason, string> = {
  superseded: "Replaced by a newer offer",
  reviewed: "Reviewed",
  stale: "Withdrawn: the head changed since this was offered",
  closed: "The pull request closed",
};

/** Every result PwrAgent gives an offer it withdraws, as opposed to one the operator closed. */
export const PR_OFFER_WITHDRAWN_RESULTS: readonly string[] = Object.values(PR_OFFER_RETIRE_RESULTS);

/**
 * One sentence of agent guidance for a PR's readiness. It tells the agent
 * not to offer a merge PwrAgent would not offer.
 */
export function describePrReviewReadiness(params: {
  prNumber: number;
  readiness: PrReviewReadiness;
  headSha?: string;
  reviewed: boolean;
  openFindings?: number;
}): string {
  const name = `#${params.prNumber}`;
  const at = params.headSha ? ` at ${params.headSha.slice(0, 7)}` : "";
  if (params.readiness === "closed") return `${name} is closed.`;
  if ((params.openFindings ?? 0) > 0) {
    return `${name}'s latest review has ${params.openFindings} unsettled finding(s). Commit and push each fix, then settle the finding with update_review_item. PwrAgent offers the merge when every finding is settled and CI is green.`;
  }
  if (!params.reviewed) {
    return `${name} has no review covering its head${at}. Do not offer a merge. PwrAgent offers a review once CI is green.`;
  }
  if (params.readiness === "ready_to_merge") {
    return `${name} is reviewed${at}, its findings are settled, and CI is green. PwrAgent offers the merge; do not raise another merge card.`;
  }
  return `${name} is reviewed${at} and its findings are settled. PwrAgent offers the merge once CI is green and it can merge.`;
}
