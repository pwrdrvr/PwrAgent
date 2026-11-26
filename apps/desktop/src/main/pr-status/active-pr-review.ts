import { buildPullRequestStatusKey } from "@pwragent/shared/contracts/navigation";
import type {
  AppServerReviewContext,
  AppServerReviewPullRequestSnapshot,
} from "@pwragent/shared/contracts/normalized-app-server";

/** Only snapshots bind a review to both a forge PR and its frozen diff head. */
export function reviewPullRequestSnapshots(context: AppServerReviewContext | undefined): readonly AppServerReviewPullRequestSnapshot[] {
  return context?.pullRequestSnapshots ?? (context?.pullRequestSnapshot ? [context.pullRequestSnapshot] : []);
}

export function hasActivePrReview(
  reviews: Iterable<{ context?: AppServerReviewContext }>,
  prKey: string,
  headSha: string | undefined,
): boolean {
  if (!headSha) return false;
  for (const { context } of reviews) {
    if (reviewPullRequestSnapshots(context).some((snapshot) =>
      snapshot.headCommit === headSha && buildPullRequestStatusKey(snapshot.pullRequest) === prKey
    )) return true;
  }
  return false;
}
