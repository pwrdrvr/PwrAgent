import { createHash, randomUUID } from "node:crypto";
import type {
  AppServerReviewFindingOutcome,
  AppServerThreadReviewEntry,
  ListThreadReviewsRequest,
  RecordThreadReviewInput,
  ThreadReview,
  ThreadReviewIdentity,
  ThreadReviewResolution,
  ThreadTodosChangedEvent,
  UpdateThreadReviewRequest,
} from "@pwragent/shared";
import {
  THREAD_REVIEW_ITEM_STATUSES,
  buildLegacyEncodedThreadIdentityKey,
  normalizeThreadReview,
  normalizeThreadReviewItemStatus,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db";
import { normalizeReviewCategory, parseReviewOutputText, reviewEntryFindings } from "../../shared/review-output";

/**
 * A review is a work-queue record, not a transcript copy: it keeps enough of
 * each finding to show the card and hand the work to an agent after the
 * transcript has scrolled away. These caps hold that copy to excerpts. See
 * "Tracked review findings" in docs/thread-history-persistence.md.
 */
export const THREAD_REVIEW_TEXT_LIMITS = { title: 300, summary: 1_000, body: 4_000 } as const;
/** Findings one review may track. */
export const THREAD_REVIEW_MAX_FINDINGS = 200;
/** Rows one list returns, as the to-do store caps the cards it is merged with. */
const THREAD_REVIEW_LIST_LIMIT = 500;
const TRACKING_STARTED_KEY = "thread_review_tracking_started_at";
/**
 * Resolution notes for outcomes the reviewer reported about its own findings.
 * Each names the reviewer's own word, so the agent reading `list_reviews` can
 * tell an automatic outcome from one it recorded.
 */
export const REPORTED_FIXED_NOTE = "Addressed automatically: the code review reported it `fixed`.";
export const REPORTED_NO_CHANGE_NOTE = "Declined automatically: the code review reported `no_change_needed`.";
/** A review's note once nothing in it is open. */
export const ALL_FINDINGS_SETTLED_NOTE = "Every finding is addressed, declined, or deferred.";

function excerpt(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** A review's id: its source key, scoped to the thread that owns it. */
function reviewId(identity: ThreadReviewIdentity, sourceKey: string): string {
  return createHash("sha256").update(JSON.stringify([identity.backend, identity.threadId, sourceKey])).digest("hex");
}

export class ThreadReviewError extends Error {
  constructor(readonly code: "not_found" | "invalid_arguments" | "conflict", message: string) {
    super(message);
  }
}

/** One commit per new review or status mutation; replay and no-ops write nothing. */
export class ThreadReviewService {
  private readonly trackingStartedAt: number;

  constructor(
    private readonly db: StateDb,
    private readonly onChanged: (event: ThreadTodosChangedEvent) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    // Shared-profile instances must agree on one boundary, including after a
    // restart. Do not move it forward each time a window or service is opened.
    const stored = db.getMeta(TRACKING_STARTED_KEY);
    this.trackingStartedAt = stored === undefined ? db.raw.transaction(() => {
      const existing = db.getMeta(TRACKING_STARTED_KEY);
      if (existing !== undefined) return Number(existing);
      const startedAt = now();
      db.setMeta(TRACKING_STARTED_KEY, String(startedAt));
      return startedAt;
    }).immediate() : Number(stored);
  }

  list(request: ListThreadReviewsRequest = {}, options: { includeDetached?: boolean } = {}): ThreadReview[] {
    const reviews: ThreadReview[] = [];
    const attachments = new Map<string, Array<{ provider: string; org: string; repo: string; number: number }>>();
    const rows = this.db.raw.prepare(`SELECT payload FROM thread_reviews
      WHERE (? = 'all' OR status = ?)
        AND (? IS NULL OR backend = ?) AND (? IS NULL OR thread_id = ?)
      ORDER BY updated_at DESC, review_id`).iterate(
      request.status ?? "open", request.status ?? "open",
      request.backend ?? null, request.backend ?? null,
      request.threadId ?? null, request.threadId ?? null,
    ) as Iterable<{ payload: string }>;
    for (const row of rows) {
      const review = parseReview(row.payload);
      if (this.isUntriagedLegacyImport(review)) continue;
      // Queue reads follow the current attachment list. Full status reads
      // also serve the transcript, whose resolutions survive PR detachment.
      const pr = review.context?.pullRequest;
      const automatic = review.origin === "automatic"
        || (review.origin === undefined && review.sourceKey.startsWith("managed-review:"));
      if (review.status === "open" && automatic && pr && request.status !== "all" && !options.includeDetached) {
        const key = buildLegacyEncodedThreadIdentityKey(review.backend, review.threadId);
        let prs = attachments.get(key);
        if (!prs) {
          const overlay = this.db.raw.prepare("SELECT json_extract(payload, '$.prs') AS prs FROM threads WHERE thread_id = ?")
            .get(key) as { prs: string | null } | undefined;
          const storedPrs = overlay?.prs ? JSON.parse(overlay.prs) as NonNullable<typeof prs> : [];
          attachments.set(key, storedPrs);
          prs = storedPrs;
        }
        if (!prs.some((attached) => attached.provider === pr.provider && attached.org === pr.org
          && attached.repo === pr.repo && attached.number === pr.number)) continue;
      }
      reviews.push(review);
      if (reviews.length === THREAD_REVIEW_LIST_LIMIT) break;
    }
    return reviews;
  }

  private isUntriagedLegacyImport(review: ThreadReview): boolean {
    // #2685 stored no provenance or observation time. A generic, untouched
    // import could be years old even when createdAt fell back to import time.
    // Retain the record, but do not invent an outstanding obligation from it.
    return review.origin === undefined && review.title === "Code review" && !review.sourceUrl
      && review.updatedAt === review.createdAt
      && review.status === "open" && !review.resolution
      && review.items.every((item) => item.status === "open" && !item.resolution && item.updatedAt === item.createdAt);
  }

  get(id: string): ThreadReview | undefined {
    const row = this.db.raw.prepare("SELECT payload FROM thread_reviews WHERE review_id = ?")
      .get(id) as { payload: string } | undefined;
    return row ? parseReview(row.payload) : undefined;
  }

  record(identity: ThreadReviewIdentity, input: RecordThreadReviewInput, origin: ThreadReview["origin"] = "explicit"): ThreadReview {
    if (!input.sourceKey.trim() || !input.title.trim() || input.items.length > THREAD_REVIEW_MAX_FINDINGS) {
      throw new ThreadReviewError(
        "invalid_arguments",
        `A review needs a source key, title, and at most ${THREAD_REVIEW_MAX_FINDINGS} findings.`,
      );
    }
    const id = reviewId(identity, input.sourceKey);
    const recorded = this.get(id);
    const enroll = (review: ThreadReview): boolean => origin === "explicit" && this.isUntriagedLegacyImport(review);
    if (recorded && !enroll(recorded)) return recorded;
    let changed = false;
    const review = this.db.raw.transaction(() => {
      const existing = this.get(id);
      // An artifact is immutable. Replaying it must never reopen settled work.
      if (existing) {
        // Explicitly recording a legacy artifact opts it into tracking without
        // replacing findings, ids, timestamps, or documented resolutions.
        if (enroll(existing)) {
          existing.origin = "explicit";
          this.db.raw.prepare("UPDATE thread_reviews SET payload = ? WHERE review_id = ?")
            .run(JSON.stringify(existing), id);
          changed = true;
        }
        return existing;
      }
      const now = this.now();
      const createdAt = input.createdAt ?? now;
      const review: ThreadReview = {
        backend: identity.backend, threadId: identity.threadId, origin,
        id, sourceKey: input.sourceKey, title: excerpt(input.title, THREAD_REVIEW_TEXT_LIMITS.title),
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.summary ? { summary: excerpt(input.summary, THREAD_REVIEW_TEXT_LIMITS.summary) } : {}),
        ...(input.context ? { context: input.context } : {}),
        status: input.clean && input.items.length === 0 ? "handled" : "open",
        items: input.items.map((item) => ({
          ...item,
          title: excerpt(item.title, THREAD_REVIEW_TEXT_LIMITS.title),
          ...(item.body === undefined ? {} : { body: excerpt(item.body, THREAD_REVIEW_TEXT_LIMITS.body) }),
          id: randomUUID(), status: "open", createdAt, updatedAt: createdAt,
        })),
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

  importEntry(
    identity: ThreadReviewIdentity,
    entry: AppServerThreadReviewEntry,
    source: "live" | "replay" = "replay",
  ): ThreadReview | undefined {
    if (entry.id.endsWith(":started") || entry.turn?.status === "in_progress"
      || (entry.displayText !== undefined && !entry.output)) return undefined;
    // Reading history is not evidence that a review is still waiting on work.
    // A replay can recover a missed completion only after this profile began
    // tracking. Undated history cannot establish that and stays transcript-only.
    if (source === "replay" && (entry.createdAt === undefined
      || !Number.isFinite(entry.createdAt) || entry.createdAt < this.trackingStartedAt)) return undefined;
    // A tracked one needs no parse.
    const tracked = this.get(reviewId(identity, entry.id));
    if (tracked) return tracked;
    const output = entry.output ?? parseReviewOutputText(entry.review);
    // An interrupted review leaves an artifact with nothing in it: no verdict,
    // no findings and no text. There is nothing to address.
    if (!output && !entry.review.trim()) return undefined;
    return this.record(identity, {
      sourceKey: entry.id,
      title: "Code review",
      summary: output?.overall_explanation ?? entry.review,
      context: entry.context,
      createdAt: entry.createdAt,
      clean: output?.findings.length === 0,
      // Past the cap the rest stay in the transcript; recording none would
      // fail the import again on every read.
      items: reviewEntryFindings({ output, review: entry.review, reviewer: entry.reviewer })
        .slice(0, THREAD_REVIEW_MAX_FINDINGS)
        .map((finding) => ({
          title: finding.title, body: finding.body, priority: finding.priority,
          ...(normalizeReviewCategory(finding.category) ? { category: normalizeReviewCategory(finding.category) } : {}),
          codeLocation: finding.code_location,
        })),
    }, "automatic");
  }

  /**
   * `todo` is the card a deferral names, which the caller has already found
   * on this thread: the service owns reviews, not to-dos.
   */
  update(
    input: UpdateThreadReviewRequest,
    actor: ThreadReviewResolution["actor"],
    identity?: ThreadReviewIdentity,
    todo?: { id: string; title: string },
  ): ThreadReview {
    // A finding takes its older names too; a review keeps its own statuses.
    const request = input.itemId
      ? { ...input, status: normalizeThreadReviewItemStatus(input.status) ?? input.status }
      : input;
    const unchanged = (target: { status: string; resolution?: ThreadReviewResolution } | undefined): boolean =>
      target?.status === request.status
      && (request.note === undefined || request.note === target.resolution?.note)
      && (request.url === undefined || request.url === target.resolution?.url)
      && (request.todoId === undefined || request.todoId === target.resolution?.todo?.id);
    const snapshot = this.get(request.id);
    if (!snapshot || (identity && (snapshot.backend !== identity.backend || snapshot.threadId !== identity.threadId))) {
      throw new ThreadReviewError("not_found", "Review not found on this thread.");
    }
    if (unchanged(request.itemId ? snapshot.items.find((item) => item.id === request.itemId) : snapshot)) return snapshot;
    let changed = false;
    const review = this.db.raw.transaction(() => {
      const review = this.get(request.id);
      if (!review || (identity && (review.backend !== identity.backend || review.threadId !== identity.threadId))) {
        throw new ThreadReviewError("not_found", "Review not found on this thread.");
      }
      const item = request.itemId ? review.items.find((entry) => entry.id === request.itemId) : undefined;
      if (request.itemId && !item) throw new ThreadReviewError("not_found", "Review finding not found.");
      if (item && (request.status as string) === "skipped") {
        throw new ThreadReviewError("invalid_arguments", SKIPPED_IS_NOT_AN_OUTCOME);
      }
      const statuses: readonly string[] = item ? THREAD_REVIEW_ITEM_STATUSES : ["open", "handled", "dismissed"];
      if (!statuses.includes(request.status)) {
        throw new ThreadReviewError("invalid_arguments", item
          ? "A finding's status is open, addressed, declined, or deferred."
          : "A review's status is open, handled, or dismissed.");
      }
      if (unchanged(item ?? review)) return review;
      if (request.status !== "open" && !request.note?.trim()) {
        throw new ThreadReviewError("invalid_arguments", item
          ? "Add a note: what changed for addressed, or the reason for declined or deferred."
          : "Add a note on how the review was handled or why it is dismissed.");
      }
      if (request.url && !/^https?:\/\/[^\s]+$/i.test(request.url)) {
        throw new ThreadReviewError("invalid_arguments", "Resolution links must be HTTP or HTTPS URLs.");
      }
      if (request.status === "deferred" && (!request.todoId || todo?.id !== request.todoId)) {
        throw new ThreadReviewError("invalid_arguments",
          "Deferring a finding needs the to-do card that tracks it: create one with add_todo, then pass its id as todoId.");
      }
      if (request.status !== "deferred" && request.todoId !== undefined) {
        throw new ThreadReviewError("invalid_arguments", "Only a deferred finding takes a todoId.");
      }
      if (!item && request.status === "handled" && review.items.some((entry) => entry.status === "open")) {
        throw new ThreadReviewError("conflict",
          "Settle each open finding before marking the review handled: addressed, declined, or deferred.");
      }
      const now = this.now();
      // An explicit action on a legacy record establishes that it is tracked;
      // never hide it as an untouched historical import after reopening it.
      if (review.origin === undefined) {
        review.origin = !this.isUntriagedLegacyImport(review) && review.sourceKey.startsWith("managed-review:")
          ? "automatic" : "explicit";
      }
      const resolution: ThreadReviewResolution | undefined = request.status === "open" ? undefined : {
        note: request.note!.trim(), ...(request.url ? { url: request.url } : {}),
        ...(request.status === "deferred" && todo ? { todo: { id: todo.id, title: todo.title } } : {}),
        actor, at: now,
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
          review.resolution = { note: ALL_FINDINGS_SETTLED_NOTE, actor: "system", at: now };
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

  /**
   * Records what the reviewer later reported about its own findings, in one
   * commit. Only open findings change: a reviewer's later report never
   * overrides an outcome the operator or an agent already recorded. `fixed`
   * becomes addressed and `no_change_needed` declined. A `skipped` finding
   * stays open, because it is real and still unaddressed: the agent is told
   * to decline or defer it (`claudeSkippedFindingsGuidance`).
   */
  applyReportedOutcomes(
    identity: ThreadReviewIdentity,
    sourceKey: string,
    outcomes: AppServerReviewFindingOutcome[],
  ): ThreadReview | undefined {
    const id = reviewId(identity, sourceKey);
    const settles = (review: ThreadReview) => outcomes.some(({ index, outcome }) =>
      outcome !== "skipped" && review.items[index]?.status === "open");
    const snapshot = this.get(id);
    if (!snapshot || !settles(snapshot)) return snapshot;
    let changed = false;
    const review = this.db.raw.transaction(() => {
      const review = this.get(id);
      if (!review || !settles(review)) return review;
      const now = this.now();
      for (const { index, outcome } of outcomes) {
        const item = review.items[index];
        if (outcome === "skipped" || item?.status !== "open") continue;
        item.status = outcome === "fixed" ? "addressed" : "declined";
        item.updatedAt = now;
        item.resolution = {
          note: outcome === "fixed" ? REPORTED_FIXED_NOTE : REPORTED_NO_CHANGE_NOTE,
          actor: "agent", at: now,
        };
      }
      if (review.status === "open" && review.items.every((entry) => entry.status !== "open")) {
        review.status = "handled";
        review.resolution = { note: ALL_FINDINGS_SETTLED_NOTE, actor: "system", at: now };
      }
      review.updatedAt = now;
      this.db.raw.prepare("UPDATE thread_reviews SET status = ?, updated_at = ?, payload = ? WHERE review_id = ?")
        .run(review.status, now, JSON.stringify(review), review.id);
      changed = true;
      return review;
    }).immediate();
    if (changed && review) this.emit(review);
    return review;
  }

  private emit(review: ThreadReview): void {
    this.onChanged({ backend: review.backend, threadId: review.threadId, at: this.now() });
  }
}

/** Why `skipped` cannot settle a finding, wherever an agent tries it. */
export const SKIPPED_IS_NOT_AN_OUTCOME =
  "`skipped` leaves a finding open. Settle it as declined, with the reason, or as deferred, with the to-do card that tracks it.";

function parseReview(payload: string): ThreadReview {
  // An older build sharing this profile can still write `dismissed`.
  return normalizeThreadReview(JSON.parse(payload) as ThreadReview);
}
