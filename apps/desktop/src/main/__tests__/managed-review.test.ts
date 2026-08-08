import { describe, expect, it } from "vitest";
import {
  buildManagedReviewPrompt,
  formatManagedReviewOutput,
  parseManagedReviewOutput,
} from "../app-server/managed-review";
import grokReviewSession from "./fixtures/grok-managed-review-session.json";

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

  // Grok Build ignores "do not include prose outside it" and streams three
  // narration chunks before the JSON object, then reports a third correctness
  // phrase the original enum check rejected outright. Rejecting the artifact
  // means the raw prose+JSON blob becomes the review text and gets replayed
  // into the parent thread as a giant user message.
  describe("Grok Build managed review artifact", () => {
    const output = grokReviewSession.reviewAgentMessageChunks.join("\n\n");

    it("keeps the prose narration Grok emits before the JSON object", () => {
      expect(output).toContain("I'll review this branch against");
      expect(output).toContain('"overall_correctness":"patch has issues"');
    });

    it("parses the artifact out of the surrounding narration", () => {
      const parsed = parseManagedReviewOutput(output);

      expect(parsed).toBeDefined();
      expect(parsed?.overall_correctness).toBe("patch is incorrect");
      expect(parsed?.overall_confidence_score).toBeCloseTo(0.86);
      expect(parsed?.findings).toHaveLength(2);
      expect(parsed?.findings[0]).toMatchObject({
        priority: 1,
        code_location: {
          absolute_file_path:
            "/workspaces/wt/PwrAgnt/apps/desktop/src/main/ipc/app-server.ts",
          line_range: { start: 611, end: 614 },
        },
      });
    });

    it("formats the parsed artifact instead of replaying raw model output", () => {
      const parsed = parseManagedReviewOutput(output);
      const formatted = formatManagedReviewOutput(parsed!);

      expect(formatted).not.toContain("I'll review this branch against");
      expect(formatted).not.toContain('"findings"');
      expect(formatted).toContain(
        "[P1] Path separator normalization is wrong",
      );
    });
  });

  it("names the accepted overall_correctness values in the prompt", () => {
    const prompt = buildManagedReviewPrompt({ type: "uncommittedChanges" });

    expect(prompt).toContain('"patch is correct"');
    expect(prompt).toContain('"patch is incorrect"');
  });
});
