import {
  projectAllowsPrOffers,
  type ProjectForgeAutomation,
} from "@pwragent/shared/project-forge-automation";
import type { PrReviewOfferThread } from "./pr-review-offer-coordinator";

/** A thread whose primary attached PR is the one being offered. */
export type PrReviewOfferCandidate = PrReviewOfferThread & {
  archived: boolean;
  /** The Forge Automation of the thread's project, when one is stored. */
  automation: ProjectForgeAutomation | undefined;
  /** The project leaves this PR to its maintainers (a hands-off rule). */
  handsOff?: true;
};

/** Whether a thread may hold this PR's review and merge offers at all. */
export function prReviewOfferCandidateQualifies(candidate: PrReviewOfferCandidate): boolean {
  return !candidate.archived
    && !candidate.handsOff
    && projectAllowsPrOffers(candidate.automation);
}

/**
 * The threads showing a PR that may not hold its offers: archived, in a
 * paused project, in a project with PR offers off, or in one that leaves the
 * PR hands-off. An offer card already open on one of them is withdrawn.
 */
export function ineligiblePrReviewOfferThreads(
  candidates: readonly PrReviewOfferCandidate[],
): PrReviewOfferThread[] {
  return candidates
    .filter((candidate) => !prReviewOfferCandidateQualifies(candidate))
    .map(({ backend, threadId }): PrReviewOfferThread => ({ backend, threadId }));
}

/**
 * The one thread a PR's review and merge offers go to, or none. Archived
 * threads, threads in paused projects, threads in projects with PR offers
 * turned off, and threads whose project leaves this PR hands-off never
 * qualify. Among the rest, the elected Auto-fix owner wins;
 * else the first. `readWinner` runs only when more than one qualifies.
 */
export async function selectPrReviewOfferOwner(params: {
  candidates: readonly PrReviewOfferCandidate[];
  readWinner: () => Promise<PrReviewOfferThread | undefined>;
}): Promise<PrReviewOfferThread | undefined> {
  const eligible = params.candidates
    .filter(prReviewOfferCandidateQualifies)
    .map(({ backend, threadId }): PrReviewOfferThread => ({ backend, threadId }));
  if (eligible.length <= 1) return eligible[0];
  const winner = await params.readWinner();
  return eligible.find((thread) =>
    thread.backend === winner?.backend && thread.threadId === winner.threadId
  ) ?? eligible[0];
}
