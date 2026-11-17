import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerThreadReviewEntry, ThreadReview } from "@pwragent/shared";
import type { ThreadReviewStorage } from "@pwragent/owner-core/thread-review-storage";
import { ThreadReviewService } from "../thread-reviews/thread-review-service";

function reviewService() {
  const records = new Map<string, ThreadReview>();
  const insert = vi.fn((review: ThreadReview) => records.set(review.id, review));
  const storage: ThreadReviewStorage = {
    trackingStartedAt: () => 0,
    iterate: () => records.values(),
    getAttachedPullRequests: () => [],
    get: (id) => records.get(id),
    insert,
    enrollReview: vi.fn(),
    update: vi.fn(),
    runExclusive: (work) => work(),
  };
  return { service: new ThreadReviewService(storage), insert };
}

const thread = { backend: "codex" as const, threadId: "owner" };

it("never tracks an unsuccessful provider turn as a completed review", () => {
  fc.assert(fc.property(
    fc.constantFrom("interrupted" as const, "failed" as const),
    fc.string({ minLength: 1 }),
    fc.boolean(),
    fc.constantFrom("live" as const, "replay" as const),
    (status, text, structured, source) => {
      const { service, insert } = reviewService();
      const entry: AppServerThreadReviewEntry = {
        type: "review", id: "artifact", createdAt: 1, review: text,
        turn: { id: "turn", status },
        ...(structured ? { output: {
          findings: [], overall_correctness: "patch is correct", overall_explanation: text,
        } } : {}),
      };
      expect(service.importEntry(thread, entry, source)).toBeUndefined();
      expect(insert).not.toHaveBeenCalled();
    },
  ));
});

it("does not track Codex's no-response exit before the cancellation notification arrives", () => {
  const { service, insert } = reviewService();
  expect(service.importEntry(thread, {
    type: "review", id: "exit", review: "Reviewer failed to output a response.",
  }, "live")).toBeUndefined();
  expect(insert).not.toHaveBeenCalled();
});

it("hides old automatic no-response cards without deleting them or hiding an explicit review", () => {
  const { service } = reviewService();
  const automatic = service.record(thread, {
    sourceKey: "old-exit", title: "Code review", items: [],
    summary: "Reviewer failed to output a response.",
  }, "automatic");
  const explicit = service.record(thread, {
    sourceKey: "explicit", title: "Investigate reviewer failure", items: [],
    summary: "Reviewer failed to output a response.",
  });
  expect(service.list({ status: "all" })).toEqual([explicit]);
  expect(service.get(automatic.id)).toEqual(automatic);
});

it("still tracks a successful clean review", () => {
  const { service } = reviewService();
  expect(service.importEntry(thread, {
    type: "review", id: "clean", review: "No issues found.",
    turn: { id: "turn", status: "completed" },
    output: { findings: [], overall_correctness: "patch is correct", overall_explanation: "No issues found." },
  }, "live")).toMatchObject({ status: "handled", items: [] });
});
