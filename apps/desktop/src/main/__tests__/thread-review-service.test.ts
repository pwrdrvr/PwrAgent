import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, AppServerThreadReviewEntry, ThreadTodosChangedEvent } from "@pwragent/shared";
import { threadReviewTodo } from "@pwragent/shared";
import {
  THREAD_REVIEW_MAX_FINDINGS,
  THREAD_REVIEW_TEXT_LIMITS,
  ThreadReviewService,
} from "../thread-reviews/thread-review-service";
import { completedThreadReview } from "../thread-reviews/thread-review-events";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const THREAD = { backend: "codex" as const, threadId: "review-owner" };
const INPUT = {
  sourceKey: "review-artifact", title: "Code review", summary: "Two correctness findings.",
  items: [{ title: "Handle cancellation", body: "Abort the pending operation." }, { title: "Release the connection" }],
};

describe("persistent thread reviews", () => {
  let db: StateDb;
  let temp: ReturnType<typeof createTempStateDb>;
  let clock: number;
  let events: ThreadTodosChangedEvent[];
  let service: ThreadReviewService;
  let previousMetrics: string | undefined;

  beforeEach(() => {
    previousMetrics = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    temp = createTempStateDb("pwragent-review-tracking-");
    db = StateDb.open(temp.dbPath);
    clock = 1_000;
    events = [];
    service = new ThreadReviewService(db, (event) => events.push(event), () => ++clock);
  });
  afterEach(() => {
    db.close();
    removeTempStateDbDir(temp.tempDir);
    if (previousMetrics === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
    else process.env[SQLITE_WRITE_METRICS_ENV] = previousMetrics;
  });

  it("keeps findings waiting until each is addressed or dismissed, then records the final outcome", () => {
    const review = service.record(THREAD, INPUT);
    expect(threadReviewTodo(review)).toMatchObject({ reviewId: review.id, status: "open", detail: "2 open findings · Two correctness findings." });
    expect(() => service.update({ id: review.id, status: "handled", note: "Done" }, "agent", THREAD)).toThrow("each open finding");
    const addressed = service.update({ id: review.id, itemId: review.items[0]!.id, status: "addressed", note: "Fixed in the cancellation handler.", url: "https://github.com/example/repo/commit/abc" }, "agent", THREAD);
    expect(addressed.status).toBe("open");
    expect(addressed.items[0]!.resolution).toMatchObject({ actor: "agent", note: "Fixed in the cancellation handler.", url: "https://github.com/example/repo/commit/abc" });
    const settled = service.update({ id: review.id, itemId: review.items[1]!.id, status: "dismissed", note: "The caller owns the connection." }, "user");
    expect(settled.status).toBe("handled");
    expect(service.list()).toEqual([]);
    expect(threadReviewTodo(settled).status).toBe("done");
    const documented = service.update({ id: review.id, status: "handled", note: "Review addressed; the ownership finding was dismissed.", url: "https://github.com/example/repo/pull/1#discussion_r123" }, "agent", THREAD);
    expect(documented.resolution?.note).toContain("ownership");
    expect(events).toHaveLength(4);
  });

  it("retains whole-review dismissal and individual outcomes across restart and replay", () => {
    const review = service.record(THREAD, INPUT);
    service.update({ id: review.id, itemId: review.items[0]!.id, status: "addressed", note: "Fixed." }, "agent", THREAD);
    const dismissed = service.update({ id: review.id, status: "dismissed", note: "This work is superseded.", url: "https://example.com/discussion" }, "user");
    db.close();
    db = StateDb.open(temp.dbPath);
    service = new ThreadReviewService(db);
    expect(service.record(THREAD, INPUT)).toEqual(dismissed);
    expect(service.list()).toEqual([]);
    expect(service.list({ status: "dismissed" })[0]?.items[0]?.status).toBe("addressed");
    const reopened = service.update({ id: review.id, status: "open" }, "user");
    expect(reopened.items[0]?.status).toBe("addressed");
    expect(reopened.items[1]?.status).toBe("open");
  });

  it("reopens a handled review when a finding is reopened", () => {
    const review = service.record(THREAD, { ...INPUT, items: [INPUT.items[0]!] });
    service.update({ id: review.id, itemId: review.items[0]!.id, status: "addressed", note: "Fixed." }, "agent", THREAD);
    const reopened = service.update({ id: review.id, itemId: review.items[0]!.id, status: "open" }, "user");
    expect(reopened.status).toBe("open");
    expect(reopened.resolution).toBeUndefined();
    expect(reopened.items[0]?.resolution).toBeUndefined();
  });

  it("scopes identical artifact keys by backend and thread and rejects cross-thread updates", () => {
    const first = service.record(THREAD, INPUT);
    const second = service.record({ ...THREAD, threadId: "other" }, INPUT);
    const third = service.record({ ...THREAD, backend: "acp:claude" }, INPUT);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(() => service.update({ id: first.id, status: "dismissed", note: "Ignore" }, "agent", second)).toThrow("not found on this thread");
    expect(service.list(THREAD)).toHaveLength(1);
  });

  it("requires documented outcomes and rejects invalid statuses and unsafe links", () => {
    const review = service.record(THREAD, INPUT);
    expect(() => service.update({ id: review.id, status: "dismissed" }, "agent", THREAD)).toThrow("Document why");
    expect(() => service.update({ id: review.id, status: "dismissed", note: "Ignore", url: "javascript:alert(1)" }, "agent", THREAD)).toThrow("HTTP or HTTPS");
    expect(() => service.update({ id: review.id, status: "addressed", note: "Fixed" }, "user")).toThrow("Invalid review status");
  });

  it("imports completed structured reviews and skips running review entries", () => {
    const entry: AppServerThreadReviewEntry = {
      type: "review", id: "native-result", review: "Review result", createdAt: 123,
      output: { findings: [], overall_correctness: "patch is correct", overall_explanation: "No findings." },
    };
    expect(service.importEntry(THREAD, { ...entry, id: "started", turn: { id: "turn", status: "in_progress" } })).toBeUndefined();
    const clean = service.importEntry(THREAD, entry)!;
    expect(clean.status).toBe("handled");
    expect(clean.createdAt).toBe(123);
    expect(service.list()).toEqual([]);
  });

  it("records final live artifacts, including snake-case output, without writing streamed or started items", () => {
    const event: AgentEvent = { backend: "codex", notification: {
      method: "item/completed", params: {
        threadId: THREAD.threadId, turnId: "review-turn", item: {
          id: "live-review", type: "exitedReviewMode", created_at: 1_791_600_000,
          data: { review_output: {
            findings: [{ title: "Abort pending work", body: "The owner closed.", confidence_score: 0.9,
              code_location: { absolute_file_path: "/repo/queue.ts", line_range: { start: 1, end: 2 } } }],
            overall_correctness: "patch is incorrect", overall_explanation: "Pending work survives its owner.",
          } },
        },
      },
    } };
    const completed = completedThreadReview(event)!;
    expect(service.importEntry(completed.identity, completed.entry)?.items[0]?.title).toBe("Abort pending work");
    expect(completed.entry.createdAt).toBe(1_791_600_000_000);
    expect(completedThreadReview({ backend: "codex", notification: { method: "item/agentMessage/delta", params: { threadId: THREAD.threadId, turnId: "turn", itemId: "item", delta: "Review text" } } })).toBeUndefined();
    expect(completedThreadReview({ backend: "codex", notification: { method: "item/completed", params: { threadId: THREAD.threadId, turnId: "turn", item: { id: "started", type: "enteredReviewMode" } } } })).toBeUndefined();
  });

  it("does not track an interrupted review that left an empty artifact", () => {
    expect(service.importEntry(THREAD, { type: "review", id: "interrupted", review: "  " })).toBeUndefined();
    expect(service.list({ ...THREAD, status: "all" })).toEqual([]);
  });

  it("keeps excerpts of review text, not whole transcript copies", () => {
    const review = service.record(THREAD, {
      sourceKey: "long", title: "T".repeat(1_000), summary: "S".repeat(5_000),
      items: [{ title: "F".repeat(1_000), body: "B".repeat(50_000) }],
    });
    expect(review.title).toHaveLength(THREAD_REVIEW_TEXT_LIMITS.title);
    expect(review.summary).toHaveLength(THREAD_REVIEW_TEXT_LIMITS.summary);
    expect(review.items[0]!.title).toHaveLength(THREAD_REVIEW_TEXT_LIMITS.title);
    expect(review.items[0]!.body).toHaveLength(THREAD_REVIEW_TEXT_LIMITS.body);
    expect(review.items[0]!.body!.endsWith("…")).toBe(true);
  });

  it("keys a review's project the way every other card's project is keyed", () => {
    const review = service.record(THREAD, {
      ...INPUT, context: { workspacePath: "C:\\work\\atlas\\", projectLabel: "Atlas" },
    });
    expect(threadReviewTodo(review).sourceProject).toEqual({ key: "directory:C:/work/atlas", path: "C:/work/atlas", label: "Atlas" });
  });

  it("tracks native plain-text findings using the transcript's same parser", () => {
    const review = service.importEntry(THREAD, {
      type: "review", id: "native-plain", review: "A cancellation regression.\n\nReview comments:\n- [P1] Handle cancellation — /repo/index.ts:10-12\n  Abort the pending operation.",
    })!;
    expect(review.items).toHaveLength(1);
    expect(review.items[0]).toMatchObject({ title: "Handle cancellation", status: "open", priority: 1, codeLocation: { absolute_file_path: "/repo/index.ts", line_range: { start: 10, end: 12 } } });
  });

  it("drops a title's redundant priority tag, as the transcript does", () => {
    const location = { absolute_file_path: "/repo/index.ts", line_range: { start: 1, end: 1 } };
    const review = service.importEntry(THREAD, {
      type: "review", id: "tagged", review: "Review",
      output: {
        overall_correctness: "patch is incorrect", overall_explanation: "Two findings.",
        findings: [
          { title: "[P1] Handle cancellation", body: "Abort it.", priority: 1, confidence_score: 0.9, code_location: location },
          { title: "[P2] Release the connection", body: "Close it.", confidence_score: 0.9, code_location: location },
        ],
      },
    })!;
    expect(review.items.map(({ title, priority }) => ({ title, priority }))).toEqual([
      { title: "Handle cancellation", priority: 1 },
      { title: "Release the connection", priority: 2 },
    ]);
  });

  it("tracks the first findings of a review past the cap instead of failing every read", () => {
    const location = { absolute_file_path: "/repo/index.ts", line_range: { start: 1, end: 1 } };
    const findings = Array.from({ length: THREAD_REVIEW_MAX_FINDINGS + 5 }, (_, index) => ({
      title: `Finding ${index}`, body: "Body.", priority: 3, confidence_score: 0.5, code_location: location,
    }));
    const review = service.importEntry(THREAD, {
      type: "review", id: "huge", review: "Review",
      output: { overall_correctness: "patch is incorrect", overall_explanation: "Many.", findings },
    })!;
    expect(review.items).toHaveLength(THREAD_REVIEW_MAX_FINDINGS);
    expect(review.items.at(-1)?.title).toBe(`Finding ${THREAD_REVIEW_MAX_FINDINGS - 1}`);
  });

  it("imports old managed artifacts without copying the enclosing thread payload", () => {
    const entry = { type: "review", id: "managed-review:turn:result", review: "An unstructured review to inspect." };
    db.raw.prepare("INSERT INTO threads (thread_id, payload) VALUES (?, ?)").run("codex:review-owner", JSON.stringify({
      ...THREAD, unrelatedThreadMetadata: "must not be copied", managedReviewEntries: [entry, { ...entry, id: "managed-review:turn:started" }],
    }));
    service.importStoredReviews();
    const reviews = service.list();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).not.toHaveProperty("unrelatedThreadMetadata");
    expect(reviews[0]).not.toHaveProperty("managedReviewEntries");
    service.update({ id: reviews[0]!.id, status: "dismissed", note: "Superseded." }, "user");
    service.importStoredReviews();
    expect(service.list()).toEqual([]);
  });

  it("budgets creation and two item resolutions at three commits, with no replay or idle writes", async () => {
    const { writes } = await measureSqliteWrites(() => {
      const review = service.record(THREAD, INPUT);
      for (const item of review.items) service.update({ id: review.id, itemId: item.id, status: "addressed", note: "Fixed." }, "agent", THREAD);
      for (let index = 0; index < 100; index++) {
        service.record(THREAD, INPUT);
        service.update({ id: review.id, itemId: review.items[0]!.id, status: "addressed" }, "agent", THREAD);
        service.list();
      }
    });
    expect(writes.commits).toBe(3);
    expectSqliteWriteBudget({ scenario: "thread-review-lifecycle", note: "One two-finding review, two resolutions (including automatic handling), and 100 duplicate imports/reads. One commit per boundary; no idle writes.", writes });
  });
});
