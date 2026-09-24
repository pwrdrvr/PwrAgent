import { reviewTargetInstructions } from "../../review-command";

export const pullRequestReviewUrl = "https://github.com/fixture/project/pull/42";
export const pullRequestReviewPrompt = reviewTargetInstructions({
  type: "pullRequest",
  url: pullRequestReviewUrl,
  snapshot: {
    pullRequest: {
      provider: "github.com",
      org: "fixture",
      repo: "project",
      number: 42,
      url: pullRequestReviewUrl,
      baseRefName: "main",
      headRefName: "feature",
    },
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    mergeBaseCommit: "a".repeat(40),
    capturedAt: 1_700_000_000_000,
  },
});
