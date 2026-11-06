import { describe, expect, it } from "vitest";
import type { ThreadReview, ThreadReviewItem } from "@pwragent/shared";
import { reviewAutoFixMessage } from "../thread-reviews/review-auto-fix";

const item = (id: string, title: string, status: ThreadReviewItem["status"], priority?: number): ThreadReviewItem => ({
  id, title, status, createdAt: 1, updatedAt: 1, ...(priority === undefined ? {} : { priority }),
});

const review = (items: ThreadReviewItem[], status: ThreadReview["status"] = "open"): ThreadReview => ({
  id: "review-1", backend: "codex", threadId: "owner", sourceKey: "artifact", title: "Code review",
  status, createdAt: 1, updatedAt: 1, items,
  context: { workspacePath: "/repo", pullRequest: {
    provider: "github.com", org: "example", repo: "atlas", number: 133, url: "https://github.com/example/atlas/pull/133",
  } },
});

describe("reviewAutoFixMessage", () => {
  it("lists only open findings, most urgent first, under the card's title", () => {
    const message = reviewAutoFixMessage(review([
      item("a", "Name the fixture sizes", "open", 3),
      item("b", "Already fixed", "addressed", 1),
      item("c", "Unranked note", "open"),
      item("d", "Refresh insights first", "open", 2),
    ]));
    expect(message?.messageOrigin).toEqual({
      kind: "pwragent",
      reviewAutoFix: { reviewId: "review-1", title: "Review of PR #133", findingCount: 3 },
    });
    const lines = message!.text.split("\n");
    expect(lines[0]).toBe("Auto-fix the 3 findings from Review of PR #133. Decide which ones to fix.");
    expect(lines.slice(2, 5)).toEqual([
      "1. [P2] Refresh insights first",
      "2. [P3] Name the fixture sizes",
      "3. Unranked note",
    ]);
    expect(message!.text).not.toContain("Already fixed");
  });

  it("sends nothing when no finding is open or the review is settled", () => {
    expect(reviewAutoFixMessage(review([item("a", "Done", "declined", 1)]))).toBeUndefined();
    expect(reviewAutoFixMessage(review([]))).toBeUndefined();
    expect(reviewAutoFixMessage(review([item("a", "Open", "open", 1)], "dismissed"))).toBeUndefined();
  });
});
