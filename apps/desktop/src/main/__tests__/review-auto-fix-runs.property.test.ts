import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ReviewAutoFixRuns, type ReviewAutoFixRunEvent } from "../thread-reviews/review-auto-fix";

/**
 * Rule: a review's Auto-fix run shows what its turn last did, as the owner's
 * queue reported it: waiting behind a running turn, running, finished, or
 * refused with the reason; a cancelled turn leaves no run. Once an agent or
 * the operator settles a finding, a failed send is dropped, while a run that
 * is still going or has ended stays. Viewers are told
 * exactly when what they show changes, so a queue position update that keeps
 * the run queued sends nothing.
 *
 * Oracle: a table of what each queue status means for the card, kept apart
 * from the reducer.
 */

type Shown = { phase: string; reason?: string } | undefined;

const QUEUE_STATUSES = ["queued", "held", "started", "failed", "blocked", "cancelled", "terminal", "updated"];

function shownAfter(current: Shown, event: ReviewAutoFixRunEvent): Shown {
  if (event.kind === "sendFailed") return { phase: "failed", reason: event.reason };
  if (event.kind === "reviewUpdated") return current?.phase === "failed" ? undefined : current;
  if (event.status === "queued" || event.status === "held") return { phase: "queued" };
  if (event.status === "started") return { phase: "running" };
  if (event.status === "failed" || event.status === "blocked") {
    return { phase: "failed", reason: event.errorMessage ?? "The turn could not start." };
  }
  if (event.status === "cancelled") return undefined;
  if (event.status === "terminal") return { phase: "finished" };
  return current;
}

const reviewArb = fc.constantFrom("r1", "r2");
const eventArb: fc.Arbitrary<{ reviewId: string; event: ReviewAutoFixRunEvent }> = fc.oneof(
  fc.record({
    reviewId: reviewArb,
    event: fc.record({
      kind: fc.constant("queue" as const),
      status: fc.constantFrom(...QUEUE_STATUSES),
      errorMessage: fc.option(fc.constantFrom("Thread is locked.", "Model unavailable."), { nil: undefined }),
      at: fc.nat(),
    }).map(({ errorMessage, ...event }) => (errorMessage ? { ...event, errorMessage } : event)),
  }),
  fc.record({
    reviewId: reviewArb,
    event: fc.record({
      kind: fc.constant("sendFailed" as const),
      reason: fc.constantFrom("Thread is locked.", "Handing off."),
      at: fc.nat(),
    }),
  }),
  fc.record({
    reviewId: reviewArb,
    event: fc.record({ kind: fc.constant("reviewUpdated" as const), at: fc.nat() }),
  }),
);

describe("review auto-fix runs", () => {
  it("show each review's last turn step and announce only changes to it", () => {
    fc.assert(fc.property(fc.array(eventArb, { maxLength: 30 }), (steps) => {
      let notices = 0;
      const runs = new ReviewAutoFixRuns(() => { notices++; });
      const thread = { backend: "codex" as const, threadId: "owner" };
      const shown = new Map<string, Shown>();
      for (const { reviewId, event } of steps) {
        const before = shown.get(reviewId);
        const after = shownAfter(before, event);
        shown.set(reviewId, after);
        const noticesBefore = notices;
        runs.record(thread, reviewId, event);
        const changed = JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
        expect(notices - noticesBefore).toBe(changed ? 1 : 0);
        const actual = runs.of(thread)[reviewId];
        expect(actual === undefined ? undefined
          : { phase: actual.phase, ...(actual.phase === "failed" ? { reason: actual.reason } : {}) })
          .toEqual(after);
      }
    }), { numRuns: 1000 });
  });

  it("keeps a queued run's first time across position updates", () => {
    const runs = new ReviewAutoFixRuns();
    const thread = { backend: "codex" as const, threadId: "owner" };
    runs.record(thread, "r1", { kind: "queue", status: "queued", at: 10 });
    runs.record(thread, "r1", { kind: "queue", status: "queued", at: 20 });
    expect(runs.of(thread).r1).toEqual({ phase: "queued", at: 10 });
  });
});
