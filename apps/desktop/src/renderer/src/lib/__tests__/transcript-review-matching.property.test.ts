import type { AppServerThreadReviewEntry } from "@pwragent/shared/contracts/normalized-app-server";
import fc from "fast-check";
import { expect, it } from "vitest";
import { hasMatchingReplayReview, reviewEntriesMatch } from "../transcript-review-matching";

const labels = fc.constantFrom("Review changes against main", "Code review started", "No findings.", "Other output", " ");
const entry: fc.Arbitrary<AppServerThreadReviewEntry> = fc.record({
  type: fc.constant("review" as const),
  id: fc.constantFrom("review-1", "review-2", "optimistic-review-1", "optimistic-review-2"),
  review: labels,
  displayText: fc.option(labels, { nil: undefined }),
  turn: fc.option(fc.record({
    id: fc.constantFrom("one", "two", "*"),
    status: fc.constantFrom("in_progress" as const, "completed" as const, "cancelled" as const),
  }), { nil: undefined }),
});

it("uses the same ownership and acknowledgment rules as the full review scan", () => {
  fc.assert(fc.property(fc.array(entry, { maxLength: 18 }), entry, fc.boolean(), (replay, optimistic, retainRunning) => {
    const expected = replay.some((candidate) => reviewEntriesMatch(candidate, optimistic)
      && !(retainRunning && candidate.turn?.status === "in_progress"));
    expect(hasMatchingReplayReview(replay, optimistic, retainRunning)).toBe(expected);
  }), { numRuns: 500 });
});
