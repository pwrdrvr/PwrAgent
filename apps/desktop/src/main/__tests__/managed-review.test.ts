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

  describe("overall_correctness paraphrases", () => {
    function parseWith(params: {
      correctness: unknown;
      withFinding?: boolean;
    }) {
      return parseManagedReviewOutput(JSON.stringify({
        findings: params.withFinding
          ? [{
              title: "Off-by-one",
              body: "The loop reads one past the end.",
              confidence_score: 0.8,
              code_location: {
                absolute_file_path: "/repo/loop.ts",
                line_range: { start: 1, end: 2 },
              },
            }]
          : [],
        overall_correctness: params.correctness,
        overall_explanation: "…",
        overall_confidence_score: 0.5,
      }));
    }

    // The renderer paints anything that is not "patch is correct" as a red
    // "Patch needs work" badge, so a clean review paraphrased as "no issues
    // found" must not collapse to incorrect — that badge next to "0 findings"
    // is worse than no structured output at all.
    it.each([
      "patch is correct",
      "Patch Is Correct",
      "correct",
      "looks correct",
      "no issues found",
    ])("reads %j as correct", (correctness) => {
      expect(parseWith({ correctness })?.overall_correctness).toBe(
        "patch is correct",
      );
    });

    it.each([
      "patch is incorrect",
      "patch has issues",
      "incorrect",
      "there are problems with this patch",
      "patch is not correct",
    ])("reads %j as incorrect", (correctness) => {
      expect(parseWith({ correctness })?.overall_correctness).toBe(
        "patch is incorrect",
      );
    });

    it("breaks an unreadable phrase on whether findings were reported", () => {
      expect(parseWith({ correctness: "¯\\_(ツ)_/¯" })?.overall_correctness)
        .toBe("patch is correct");
      expect(
        parseWith({ correctness: "¯\\_(ツ)_/¯", withFinding: true })
          ?.overall_correctness,
      ).toBe("patch is incorrect");
    });

    it("still rejects an artifact with no correctness verdict at all", () => {
      expect(parseWith({ correctness: undefined })).toBeUndefined();
      expect(parseWith({ correctness: "   " })).toBeUndefined();
      expect(parseWith({ correctness: 3 })).toBeUndefined();
    });
  });

  it("names the accepted overall_correctness values in the prompt", () => {
    const prompt = buildManagedReviewPrompt({ type: "uncommittedChanges" });

    expect(prompt).toContain('"patch is correct"');
    expect(prompt).toContain('"patch is incorrect"');
  });
});
