import { describe, expect, it } from "vitest";
import type { ItemGuardianApprovalReviewCompletedNotification } from "@pwrdrvr/codex-app-server-protocol/v2";
import { normalizeAutoReviewNotification } from "../codex-app-server/auto-review";

const review: ItemGuardianApprovalReviewCompletedNotification = {
  threadId: "thread-1",
  turnId: "turn-1",
  reviewId: "review-1",
  targetItemId: "command-1",
  startedAtMs: 1000,
  completedAtMs: 2000,
  decisionSource: "agent",
  review: { status: "denied", riskLevel: null, userAuthorization: null, rationale: "The destination is outside the authorized scope." },
  action: { type: "networkAccess", target: "example.invalid:443", host: "example.invalid", protocol: "https", port: 443 },
};

describe("Codex automatic approval reviews", () => {
  it.each([
    ["inProgress", "Reviewing", "in_progress"],
    ["approved", "Approved", "completed"],
    ["denied", "Denied", "failed"],
    ["timedOut", "Timed out", "failed"],
    ["aborted", "Aborted", "cancelled"],
  ] as const)("surfaces %s without creating a human approval request", (status, label, activityStatus) => {
    const result = normalizeAutoReviewNotification(
      status === "inProgress" ? "item/autoApprovalReview/started" : "item/autoApprovalReview/completed",
      { ...review, review: { ...review.review, status } },
    );
    expect(result).toMatchObject({
      method: status === "inProgress" ? "item/started" : "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "auto-review-review-1",
          type: "autoApprovalReview",
          text: `Auto review: ${label}`,
          data: { status: activityStatus, detail: expect.stringContaining(review.review.rationale!) },
        },
      },
    });
  });

  it("ignores unrelated or incomplete events", () => {
    expect(normalizeAutoReviewNotification("item/commandExecution/requestApproval", review)).toBeUndefined();
    expect(normalizeAutoReviewNotification("item/autoApprovalReview/completed", {})).toBeUndefined();
  });
});
