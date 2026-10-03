import {
  summarizeApprovalReview,
  type AppServerThreadActivityEntry,
  type AppServerThreadEntry,
  type ThreadApprovalReview,
} from "@pwragent/shared";

export const APPROVAL_REVIEW_ENTRY_PREFIX = "approval-review:";

/**
 * One activity row per approval-reviewer decision. A reviewed request never
 * shows an approval card, so this row is the operator's record of what the
 * reviewer allowed or refused, and why.
 */
export function buildApprovalReviewEntries(
  reviews: ThreadApprovalReview[] | undefined,
): AppServerThreadActivityEntry[] {
  if (!reviews || reviews.length === 0) {
    return [];
  }
  return reviews.map((review) => ({
    type: "activity",
    id: `${APPROVAL_REVIEW_ENTRY_PREFIX}${review.id}`,
    summary: summarizeApprovalReview(review),
    createdAt: review.occurredAt,
    status: "completed",
    tone: review.action === "accept" ? undefined : "warning",
    turn: review.turnId
      ? { id: review.turnId, status: "completed", completedAt: review.occurredAt }
      : undefined,
    details: [
      {
        id: `${APPROVAL_REVIEW_ENTRY_PREFIX}${review.id}:reason`,
        kind: "read",
        label: "Reviewer's reason",
        markdown: review.reason,
        status: "completed",
      },
    ],
  }));
}

export function injectApprovalReviews(
  entries: AppServerThreadEntry[],
  reviews: ThreadApprovalReview[] | undefined,
): AppServerThreadEntry[] {
  const synthetic = buildApprovalReviewEntries(reviews);
  if (synthetic.length === 0) {
    return entries;
  }
  const existingIds = new Set(entries.map((entry) => entry.id));
  const additions = synthetic.filter((entry) => !existingIds.has(entry.id));
  if (additions.length === 0) {
    return entries;
  }
  const merged: AppServerThreadEntry[] = [...entries, ...additions];
  merged.sort((left, right) => {
    const leftAt = left.createdAt ?? 0;
    const rightAt = right.createdAt ?? 0;
    if (leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    // A decision lands after the backend entry stamped at the same moment.
    const leftIsReview = left.id.startsWith(APPROVAL_REVIEW_ENTRY_PREFIX);
    const rightIsReview = right.id.startsWith(APPROVAL_REVIEW_ENTRY_PREFIX);
    if (leftIsReview === rightIsReview) {
      return 0;
    }
    return leftIsReview ? 1 : -1;
  });
  return merged;
}
