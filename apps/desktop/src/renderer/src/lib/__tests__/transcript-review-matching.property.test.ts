import type { AppServerThreadReviewEntry } from "@pwragent/shared/contracts/normalized-app-server";
import fc from "fast-check";
import { expect, it } from "vitest";
import { hasMatchingReplayReview, reviewEntriesMatch } from "../transcript-review-matching";

const labels = fc.constantFrom("Review changes against main", "Code review started", "No findings.", "Other output", " ");
const timestamp = fc.option(fc.integer({ min: 1_000, max: 1_005 }), { nil: undefined });
const entry: fc.Arbitrary<AppServerThreadReviewEntry> = fc.record({
  type: fc.constant("review" as const),
  id: fc.constantFrom("review-1", "review-2", "optimistic-review-1", "optimistic-review-2"),
  review: labels,
  displayText: fc.option(labels, { nil: undefined }),
  createdAt: timestamp,
  turn: fc.option(fc.record({
    id: fc.constantFrom("one", "two", "*"),
    status: fc.constantFrom("in_progress" as const, "completed" as const, "cancelled" as const, undefined),
    startedAt: timestamp,
    completedAt: timestamp,
  }), { nil: undefined }),
});

it("uses the same ownership and acknowledgment rules as the full review scan", () => {
  fc.assert(fc.property(fc.array(entry, { maxLength: 18 }), entry, fc.boolean(), (replay, optimistic, retainRunning) => {
    const expected = replay.some((candidate) => reviewEntriesMatch(candidate, optimistic)
      && !(retainRunning && candidate.turn?.status === "in_progress"));
    expect(hasMatchingReplayReview(replay, optimistic, retainRunning)).toBe(expected);
  }), { numRuns: 100 });
});

it("matches an unbound optimistic review start against its settled replay start without claiming older reviews", () => {
  const optimisticStart: AppServerThreadReviewEntry = {
    type: "review",
    id: "optimistic-review-1000-abc",
    review: "Review pull request #683",
    displayText: "Review pull request #683",
    createdAt: 1_000,
  };
  const settledCurrentStart: AppServerThreadReviewEntry = {
    type: "review",
    id: "managed-review:turn-2:started",
    review: "Review pull request #683",
    displayText: "Review pull request #683",
    createdAt: 1_005,
    turn: { id: "turn-2", status: "completed", startedAt: 1_005, completedAt: 1_050 },
  };
  const settledOlderStart: AppServerThreadReviewEntry = {
    type: "review",
    id: "managed-review:turn-1:started",
    review: "Review pull request #683",
    displayText: "Review pull request #683",
    createdAt: 500,
    turn: { id: "turn-1", status: "completed", startedAt: 500, completedAt: 600 },
  };

  expect(reviewEntriesMatch(settledCurrentStart, optimisticStart)).toBe(true);
  expect(hasMatchingReplayReview([settledCurrentStart], optimisticStart, true)).toBe(true);
  expect(reviewEntriesMatch(settledOlderStart, optimisticStart)).toBe(false);
  expect(hasMatchingReplayReview([settledOlderStart], optimisticStart, true)).toBe(false);

  // Backward clock skew or second-truncated completedAt must not hide a newer createdAt.
  const skewedCompletedStart: AppServerThreadReviewEntry = {
    type: "review",
    id: "managed-review:turn-3:started",
    review: "Review pull request #683",
    displayText: "Review pull request #683",
    createdAt: 1_005,
    turn: { id: "turn-3", status: "completed", startedAt: 1_005, completedAt: 990 },
  };
  expect(reviewEntriesMatch(skewedCompletedStart, optimisticStart)).toBe(true);
  expect(hasMatchingReplayReview([skewedCompletedStart], optimisticStart, true)).toBe(true);
});
