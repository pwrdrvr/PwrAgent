import { describe, expect, it } from "vitest";
import {
  buildManagedReviewPrompt,
  parseManagedReviewOutput,
} from "../app-server/managed-review";

describe("managed review", () => {
  it.each([
    [
      { type: "uncommittedChanges" as const },
      "all staged, unstaged, and untracked changes",
    ],
    [
      { type: "baseBranch" as const, branch: "release/main" },
      "against base branch 'release/main'",
    ],
    [
      { type: "commit" as const, sha: "abc123", title: "Fix race" },
      "commit abc123 (Fix race)",
    ],
    [
      { type: "custom" as const, instructions: "Review the retry contract." },
      "Review the retry contract.",
    ],
  ])("preserves the %s review target", (target, expected) => {
    const prompt = buildManagedReviewPrompt(target);

    expect(prompt).toContain(expected);
    expect(prompt).toContain("Return only one JSON object");
    expect(prompt).toContain("Do not modify files");
  });

  it("parses the structured review artifact shape", () => {
    expect(parseManagedReviewOutput(JSON.stringify({
      findings: [{
        title: "[P1] Release the queue",
        body: "The terminal path leaves queued work blocked.",
        confidence_score: 0.98,
        priority: 1,
        code_location: {
          absolute_file_path: "/repo/review.ts",
          line_range: { start: 42, end: 44 },
        },
      }],
      overall_correctness: "patch is incorrect",
      overall_explanation: "The failure path does not release queued work.",
      overall_confidence_score: 0.97,
    }))).toMatchObject({
      findings: [{
        priority: 1,
        code_location: {
          absolute_file_path: "/repo/review.ts",
          line_range: { start: 42, end: 44 },
        },
      }],
      overall_correctness: "patch is incorrect",
    });
  });
});
