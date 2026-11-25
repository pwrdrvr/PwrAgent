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
    .filter((candidate) => !candidate.archived
      && !candidate.handsOff
      && projectAllowsPrOffers(candidate.automation))
    .map(({ backend, threadId }): PrReviewOfferThread => ({ backend, threadId }));
  if (eligible.length <= 1) return eligible[0];
  const winner = await params.readWinner();
  return eligible.find((thread) =>
    thread.backend === winner?.backend && thread.threadId === winner.threadId
  ) ?? eligible[0];
}
