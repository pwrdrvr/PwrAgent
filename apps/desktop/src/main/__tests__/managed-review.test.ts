import { describe, expect, it } from "vitest";
import { buildManagedReviewPrompt } from "../app-server/managed-review";
import {
  formatReviewOutputText,
  parseReviewOutputText,
} from "../../shared/review-output";
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
    [
      {
        type: "pullRequest" as const,
        url: "https://github.com/pwrdrvr/PwrAgent/pull/4329",
        snapshot: {
          pullRequest: {
            provider: "github.com",
            org: "pwrdrvr",
            repo: "PwrAgent",
            number: 4329,
            url: "https://github.com/pwrdrvr/PwrAgent/pull/4329",
            baseRefName: "main",
            headRefName: "fix/isolate-chromium-trace-filter",
          },
          baseCommit: "f9b74eadf751c9985a0cb0f9b7f7a211699d2fad",
          headCommit: "8de68c9ff70dbd9597f549eddd3f90d59a7ced8a",
          mergeBaseCommit: "f9b74eadf751c9985a0cb0f9b7f7a211699d2fad",
          capturedAt: 1795541744000,
        },
      },
      "git diff --no-ext-diff f9b74eadf751c9985a0cb0f9b7f7a211699d2fad 8de68c9ff70dbd9597f549eddd3f90d59a7ced8a --",
    ],
  ])("preserves the %s review target and core review contract", (target, expected) => {
    const prompt = buildManagedReviewPrompt(target);

    expect(prompt).toContain(expected);
    expect(prompt).toContain("Return only one JSON object");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).not.toContain("Focus on concrete correctness regressions");
    // Static-first, bounded single-agent review posture without CI detours,
    // runtime probe scripts, web rabbit holes, or multi-agent fan-out.
    expect(prompt).toMatch(/static,\s+adversarial/i);
    expect(prompt).toMatch(/do not run lint, typecheck, build, or test suites/i);
    expect(prompt).toMatch(/do not launch ad-hoc reproduction or runtime probe scripts/i);
    expect(prompt).toMatch(/do not search the web/i);
    expect(prompt).not.toMatch(/spawn.*sub-?agent/i);
    // Covers new contracts/telemetry, falsifiable regression tests, and repo rules.
    expect(prompt).toMatch(/new APIs, fields, logs, and telemetry\/metrics/i);
    expect(prompt).toMatch(/if the core fix were reverted to the broken behavior/i);
    expect(prompt).toMatch(/merely invoking the new code path/i);
    expect(prompt).toMatch(/AGENTS\.md/);
    // Noise suppression and clean-patch allowance.
    expect(prompt).toMatch(/do not report style or formatting nitpicks/i);
    expect(prompt).toMatch(/zero findings is valid/i);
    // Static fallback omits the in-memory candidate ledger tools.
    expect(prompt).not.toContain("record_review_candidate");
    expect(prompt).not.toContain("list_review_candidates");
    expect(prompt).not.toContain("dispose_review_candidate");
    expect(prompt).not.toContain("submit_review_output");

    if (target.type === "pullRequest") {
      const filePrompt = buildManagedReviewPrompt(target, { pinnedPatchFile: "pwragent-eval-review.patch" });
      expect(filePrompt).toContain(target.snapshot.mergeBaseCommit);
      expect(filePrompt).toContain(target.snapshot.headCommit);
      expect(filePrompt).toContain('Open "pwragent-eval-review.patch" in the review workspace with a file-reading tool');
      expect(filePrompt).not.toContain(expected);
    }
  });

  it("builds the two-pass candidate ledger prompt when candidateLedger is enabled", () => {
    const prompt = buildManagedReviewPrompt(
      { type: "baseBranch", branch: "main" },
      { candidateLedger: true },
    );

    expect(prompt).toContain("against base branch 'main'");
    expect(prompt).toContain("record_review_candidate");
    expect(prompt).toContain("list_review_candidates");
    expect(prompt).toContain("dispose_review_candidate");
    expect(prompt).toContain("submit_review_output");
    expect(prompt).toContain('"use_ledger":true');
    expect(prompt).toContain("Refine a kept candidate by ID");
    expect(prompt).toContain("Submit even when the ledger is empty or every candidate was dropped.");
    expect(prompt).toContain("for verified findings you could not record");
    expect(prompt).toMatch(/pass 1/i);
    expect(prompt).toMatch(/pass 2/i);
    expect(prompt).toMatch(/do not drop a concrete P2 or P3 defect/i);
    expect(prompt).toMatch(/if the core fix were reverted to the broken behavior/i);
    expect(prompt).toContain('"patch is correct"');
    expect(prompt).toContain('"patch is incorrect"');
    expect(prompt).toContain("Omit the field entirely if you cannot distinguish");
    expect(prompt).not.toContain("Return only one JSON object");
  });

  it("calibrates P0-P3 priorities in the managed review prompt", () => {
    const prompt = buildManagedReviewPrompt({ type: "baseBranch", branch: "main" });

    expect(prompt).toMatch(/0 \(P0\):.*critical|release-blocking/i);
    expect(prompt).toMatch(/1 \(P1\):.*urgent|high-impact/i);
    expect(prompt).toMatch(/2 \(P2\):.*moderate-impact.*non-falsifying/i);
    expect(prompt).toMatch(/3 \(P3\):.*low-impact.*telemetry\/metric/i);
  });

  it("parses the structured review artifact shape", () => {
    expect(parseReviewOutputText(JSON.stringify({
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
      const parsed = parseReviewOutputText(output);

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
      const parsed = parseReviewOutputText(output);
      const formatted = formatReviewOutputText(parsed!);

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
      return parseReviewOutputText(JSON.stringify({
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

describe("managed review confidence", () => {
  const base = {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "Nothing regressed.",
  };

  it("keeps a reported confidence in range", () => {
    expect(
      parseReviewOutputText(JSON.stringify({
        ...base,
        overall_confidence_score: 0.85,
      }))?.overall_confidence_score,
    ).toBeCloseTo(0.85);
  });

  it("keeps the findings when the reviewer omits the score", () => {
    // The prompt now tells a reviewer that cannot distinguish to leave the
    // field out. Rejecting the whole object for a missing score would throw
    // away real findings the moment a model takes that branch.
    const parsed = parseReviewOutputText(JSON.stringify({
      ...base,
      findings: [{
        title: "Unreleased queue",
        body: "The failure path does not release queued work.",
        confidence_score: 0.9,
        code_location: {
          absolute_file_path: "/repo/review.ts",
          line_range: { start: 42, end: 44 },
        },
      }],
      overall_correctness: "patch is incorrect",
    }));

    expect(parsed?.findings).toHaveLength(1);
    expect(parsed?.overall_confidence_score).toBeUndefined();
  });

  it("drops a literal zero rather than printing 0% confidence", () => {
    // The output schema in the prompt has to show the field, and a weaker
    // model copies whatever value it shows. A zero beside "patch is correct"
    // is a transcription, not a reviewer with no confidence.
    expect(
      parseReviewOutputText(JSON.stringify({
        ...base,
        overall_confidence_score: 0,
      }))?.overall_confidence_score,
    ).toBeUndefined();
  });

  it("drops a score outside 0-1 instead of guessing at percent", () => {
    for (const score of [95, 1.5, -0.2, Number.NaN]) {
      expect(
        parseReviewOutputText(JSON.stringify({
          ...base,
          overall_confidence_score: score,
        }))?.overall_confidence_score,
      ).toBeUndefined();
    }
  });

  it("defines the score in the prompt it asks the reviewer to fill", () => {
    const prompt = buildManagedReviewPrompt({ type: "uncommittedChanges" });

    expect(prompt).toContain(
      "that overall_correctness is the right verdict",
    );
    expect(prompt).toContain("Omit the field entirely if you cannot distinguish");
    // The schema example is part of the definition: a 0.0 there is the value
    // that comes back as a 0% badge.
    expect(prompt).not.toContain('"overall_confidence_score":0.0');
  });
});
