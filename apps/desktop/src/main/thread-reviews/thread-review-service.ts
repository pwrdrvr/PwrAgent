import { createHash, randomUUID } from "node:crypto";
import type {
  AppServerThreadReviewEntry,
  ListThreadReviewsRequest,
  RecordThreadReviewInput,
  ThreadReview,
  ThreadReviewIdentity,
  ThreadReviewResolution,
  ThreadTodosChangedEvent,
  UpdateThreadReviewRequest,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db";
import { parsePlainReview, parseReviewOutputText } from "../../shared/review-output";

export class ThreadReviewError extends Error {
  constructor(readonly code: "not_found" | "invalid_arguments" | "conflict", message: string) {
    super(message);
  }
}

/** One commit per new review or status mutation; replay and no-ops write nothing. */
export class ThreadReviewService {
  constructor(
    private readonly db: StateDb,
    private readonly onChanged: (event: ThreadTodosChangedEvent) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  list(request: ListThreadReviewsRequest = {}): ThreadReview[] {
    return (this.db.raw.prepare(`SELECT payload FROM thread_reviews
      WHERE (? = 'all' OR status = ?)
        AND (? IS NULL OR backend = ?) AND (? IS NULL OR thread_id = ?)
      ORDER BY updated_at DESC, review_id`).all(
      request.status ?? "open", request.status ?? "open",
      request.backend ?? null, request.backend ?? null,
      request.threadId ?? null, request.threadId ?? null,
    ) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as ThreadReview);
  }

  get(id: string): ThreadReview | undefined {
    const row = this.db.raw.prepare("SELECT payload FROM thread_reviews WHERE review_id = ?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ThreadReview : undefined;
  }

  record(identity: ThreadReviewIdentity, input: RecordThreadReviewInput): ThreadReview {
    if (!input.sourceKey.trim() || !input.title.trim() || input.items.length > 200) {
      throw new ThreadReviewError("invalid_arguments", "A review needs a source key, title, and at most 200 findings.");
    }
    const id = createHash("sha256").update(JSON.stringify([identity.backend, identity.threadId, input.sourceKey])).digest("hex");
    const recorded = this.get(id);
    if (recorded) return recorded;
    let changed = false;
    const review = this.db.raw.transaction(() => {
      const existing = this.get(id);
      // An artifact is immutable. Replaying it must never reopen settled work.
      if (existing) return existing;
      const now = this.now();
      const createdAt = input.createdAt ?? now;
      const review: ThreadReview = {
        backend: identity.backend, threadId: identity.threadId,
        id, sourceKey: input.sourceKey, title: input.title,
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.context ? { context: input.context } : {}),
        status: input.clean && input.items.length === 0 ? "handled" : "open",
        items: input.items.map((item) => ({ ...item, id: randomUUID(), status: "open", createdAt, updatedAt: createdAt })),
        createdAt, updatedAt: createdAt,
        ...(input.clean && input.items.length === 0 ? { resolution: {
          note: "Review completed with no findings.", actor: "system", at: createdAt,
        } as ThreadReviewResolution } : {}),
      };
      this.db.raw.prepare(`INSERT INTO thread_reviews
        (review_id, backend, thread_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, identity.backend, identity.threadId, review.status, review.updatedAt, JSON.stringify(review));
      changed = true;
      return review;
    }).immediate();
    if (changed) this.emit(review);
    return review;
  }

  importEntry(identity: ThreadReviewIdentity, entry: AppServerThreadReviewEntry): ThreadReview | undefined {
    if (entry.id.endsWith(":started") || entry.turn?.status === "in_progress"
      || (entry.displayText !== undefined && !entry.output)) return undefined;
    const output = entry.output ?? parseReviewOutputText(entry.review);
    const plain = output ? undefined : parsePlainReview(entry.review);
    return this.record(identity, {
      sourceKey: entry.id,
      title: "Code review",
      summary: output?.overall_explanation ?? entry.review.slice(0, 1_000),
      context: entry.context,
      createdAt: entry.createdAt,
      clean: output?.findings.length === 0,
      items: (output?.findings ?? plain?.findings)?.map((finding) => ({
        title: finding.title, body: finding.body, priority: finding.priority,
        codeLocation: finding.code_location,
      })) ?? [],
    });
  }

  /** Existing managed-review artifacts are PwrAgent-owned overlay metadata. */
  importStoredReviews(): void {
    const rows = this.db.raw.prepare(`SELECT payload FROM threads
      WHERE CASE WHEN json_valid(payload) THEN json_type(payload, '$.managedReviewEntries') END = 'array'`)
      .all() as Array<{ payload: string }>;
    // record() avoids even opening a transaction for a known artifact.
    // This startup scan therefore makes no commits after the first import.
    for (const row of rows) {
      const state = JSON.parse(row.payload) as ThreadReviewIdentity & { managedReviewEntries: AppServerThreadReviewEntry[] };
      for (const entry of state.managedReviewEntries) this.importEntry(state, entry);
    }
  }

  update(
    request: UpdateThreadReviewRequest,
    actor: ThreadReviewResolution["actor"],
    identity?: ThreadReviewIdentity,
  ): ThreadReview {
    const snapshot = this.get(request.id);
    if (!snapshot || (identity && (snapshot.backend !== identity.backend || snapshot.threadId !== identity.threadId))) {
      throw new ThreadReviewError("not_found", "Review not found on this thread.");
    }
    const target = request.itemId ? snapshot.items.find((item) => item.id === request.itemId) : snapshot;
    if (target?.status === request.status
      && (request.note === undefined || request.note === target.resolution?.note)
      && (request.url === undefined || request.url === target.resolution?.url)) return snapshot;
    let changed = false;
    const review = this.db.raw.transaction(() => {
      const review = this.get(request.id);
      if (!review || (identity && (review.backend !== identity.backend || review.threadId !== identity.threadId))) {
        throw new ThreadReviewError("not_found", "Review not found on this thread.");
      }
      const item = request.itemId ? review.items.find((entry) => entry.id === request.itemId) : undefined;
      if (request.itemId && !item) throw new ThreadReviewError("not_found", "Review finding not found.");
      const statuses = item ? ["open", "addressed", "dismissed"] : ["open", "handled", "dismissed"];
      if (!statuses.includes(request.status)) throw new ThreadReviewError("invalid_arguments", "Invalid review status.");
      const target = item ?? review;
      if (target.status === request.status
        && (request.note === undefined || request.note === target.resolution?.note)
        && (request.url === undefined || request.url === target.resolution?.url)) return review;
      if (request.status !== "open" && !request.note?.trim()) {
        throw new ThreadReviewError("invalid_arguments", "Document why this finding or review is addressed or dismissed.");
      }
      if (request.url && !/^https?:\/\/[^\s]+$/i.test(request.url)) {
        throw new ThreadReviewError("invalid_arguments", "Resolution links must be HTTP or HTTPS URLs.");
      }
      if (!item && request.status === "handled" && review.items.some((entry) => entry.status === "open")) {
        throw new ThreadReviewError("conflict", "Address or dismiss each open finding before marking the review handled.");
      }
      const now = this.now();
      const resolution: ThreadReviewResolution | undefined = request.status === "open" ? undefined : {
        note: request.note!.trim(), ...(request.url ? { url: request.url } : {}), actor, at: now,
      };
      if (item) {
        item.status = request.status as typeof item.status;
        item.updatedAt = now;
        item.resolution = resolution;
        if (request.status === "open") {
          review.status = "open";
          review.resolution = undefined;
        } else if (review.status === "open" && review.items.every((entry) => entry.status !== "open")) {
          review.status = "handled";
          review.resolution = { note: "All findings addressed or dismissed.", actor: "system", at: now };
        }
      } else {
        review.status = request.status as typeof review.status;
        review.resolution = resolution;
        // Dismissal applies to the whole review without overwriting individually
        // documented findings. Reopening the review restores its open findings.
      }
      review.updatedAt = now;
      this.db.raw.prepare("UPDATE thread_reviews SET status = ?, updated_at = ?, payload = ? WHERE review_id = ?")
        .run(review.status, now, JSON.stringify(review), review.id);
      changed = true;
      return review;
    }).immediate();
    if (changed) this.emit(review);
    return review;
  }

  private emit(review: ThreadReview): void {
    this.onChanged({ backend: review.backend, threadId: review.threadId, at: this.now() });
  }
}
