import type { ListThreadReviewsRequest, ThreadReview } from "@pwragent/shared";

export type ThreadReviewPullRequest = {
  provider: string;
  org: string;
  repo: string;
  number: number;
};

/** Durable review records; finding resolution and broadcasts belong to the service. */
export interface ThreadReviewStorage {
  trackingStartedAt(now: () => number): number;
  iterate(request: ListThreadReviewsRequest): Iterable<ThreadReview>;
  getAttachedPullRequests(threadIdentityKey: string): ThreadReviewPullRequest[];
  get(id: string): ThreadReview | undefined;
  insert(review: ThreadReview): void;
  enrollReview(id: string, review: ThreadReview): void;
  update(review: ThreadReview): void;
  /** Run synchronous read/modify/write work under one cross-connection write lock. */
  runExclusive<T>(work: () => T): T;
}
