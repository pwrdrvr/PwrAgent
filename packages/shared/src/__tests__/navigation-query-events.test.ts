import { describe, expect, it } from "vitest";
import {
  navigationInvalidationMayChangeMembership,
  navigationQueryEventRequiresRefresh,
} from "../navigation-query-events";

describe("approval reviewer navigation events", () => {
  const review = {
    id: "review-1", kind: "invocation", action: "accept", subject: "Fixture / lookup",
    reason: "Reads the requested record.", turnId: "turn-1", occurredAt: 1_000,
  };

  it("refreshes the thread a decision was stored on, without changing membership", () => {
    expect(navigationQueryEventRequiresRefresh("thread/approvalReview/updated", { threadId: "thread-1", review })).toBe(true);
    expect(navigationInvalidationMayChangeMembership("thread/approvalReview/updated")).toBe(false);
  });

  it("refreshes nothing for an automation run's decision, which no thread stores", () => {
    expect(navigationQueryEventRequiresRefresh("thread/approvalReview/updated", {
      threadId: "headless-1", review: { ...review, automationRunId: "run-1" },
    })).toBe(false);
  });
});
