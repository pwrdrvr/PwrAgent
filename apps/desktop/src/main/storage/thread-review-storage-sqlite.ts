import type { ThreadReviewPullRequest, ThreadReviewStorage } from "@pwragent/owner-core/thread-review-storage";
import type { ListThreadReviewsRequest, ThreadReview } from "@pwragent/shared";
import { normalizeThreadReview } from "@pwragent/shared";
import type { StateDb } from "./state-db";

const TRACKING_STARTED_KEY = "thread_review_tracking_started_at";

export class SqliteThreadReviewStorage implements ThreadReviewStorage {
  constructor(private readonly db: StateDb) {}

  trackingStartedAt(now: () => number): number {
    const stored = this.db.getMeta(TRACKING_STARTED_KEY);
    return stored === undefined ? this.db.raw.transaction(() => {
      const existing = this.db.getMeta(TRACKING_STARTED_KEY);
      if (existing !== undefined) return Number(existing);
      const startedAt = now();
      this.db.setMeta(TRACKING_STARTED_KEY, String(startedAt));
      return startedAt;
    }).immediate() : Number(stored);
  }

  iterate(request: ListThreadReviewsRequest): Iterable<ThreadReview> {
    const rows = this.db.raw.prepare(`SELECT payload FROM thread_reviews
      WHERE (? = 'all' OR status = ?)
        AND (? IS NULL OR backend = ?) AND (? IS NULL OR thread_id = ?)
      ORDER BY updated_at DESC, review_id`).iterate(
      request.status ?? "open", request.status ?? "open",
      request.backend ?? null, request.backend ?? null,
      request.threadId ?? null, request.threadId ?? null,
    ) as Iterable<{ payload: string }>;
    return parseReviews(rows);
  }

  getAttachedPullRequests(threadIdentityKey: string): ThreadReviewPullRequest[] {
    const overlay = this.db.raw.prepare("SELECT json_extract(payload, '$.prs') AS prs FROM threads WHERE thread_id = ?")
      .get(threadIdentityKey) as { prs: string | null } | undefined;
    return overlay?.prs ? JSON.parse(overlay.prs) as ThreadReviewPullRequest[] : [];
  }

  get(id: string): ThreadReview | undefined {
    const row = this.db.raw.prepare("SELECT payload FROM thread_reviews WHERE review_id = ?")
      .get(id) as { payload: string } | undefined;
    return row ? parseReview(row.payload) : undefined;
  }

  insert(review: ThreadReview): void {
    this.db.raw.prepare(`INSERT INTO thread_reviews
        (review_id, backend, thread_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(review.id, review.backend, review.threadId, review.status, review.updatedAt, JSON.stringify(review));
  }

  enrollReview(id: string, review: ThreadReview): void {
    this.db.raw.prepare("UPDATE thread_reviews SET payload = ? WHERE review_id = ?")
      .run(JSON.stringify(review), id);
  }

  update(review: ThreadReview): void {
    this.db.raw.prepare("UPDATE thread_reviews SET status = ?, updated_at = ?, payload = ? WHERE review_id = ?")
      .run(review.status, review.updatedAt, JSON.stringify(review), review.id);
  }

  runExclusive<T>(work: () => T): T {
    return this.db.raw.transaction(work).immediate();
  }
}

function parseReview(payload: string): ThreadReview {
  // An older build sharing this profile can still write `dismissed`.
  return normalizeThreadReview(JSON.parse(payload) as ThreadReview);
}

function* parseReviews(rows: Iterable<{ payload: string }>): Iterable<ThreadReview> {
  for (const row of rows) yield parseReview(row.payload);
}
