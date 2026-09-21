import { describe, expect, it } from "vitest";
import {
  buildInlineReviewPrompt,
  formatReviewCommand,
  isPwrAgentInlineReviewPrompt,
  normalizeReviewDisplayText,
  parseReviewCommand,
} from "../review-command";
import { REVIEW_OUTPUT_INSTRUCTIONS } from "../review-output";

describe("parseReviewCommand", () => {
  it("parses bare review as uncommitted changes", () => {
    expect(parseReviewCommand(" /review ")).toEqual({
      target: { type: "uncommittedChanges" },
      displayText: "Review current changes",
    });
  });

  it("parses a branch argument as a base branch review", () => {
    expect(parseReviewCommand("/review main")).toEqual({
      target: { type: "baseBranch", branch: "main" },
      displayText: "Review changes against main",
    });
  });

  it("parses explicit custom review instructions", () => {
    expect(parseReviewCommand("/review --custom focus on API compatibility")).toEqual({
      target: { type: "custom", instructions: "focus on API compatibility" },
      displayText: "Review custom instructions",
    });
  });

  it("parses explicit commit review", () => {
    expect(parseReviewCommand("/review --commit abc123 Fix title")).toEqual({
      target: { type: "commit", sha: "abc123", title: "Fix title" },
      displayText: "Review commit abc123",
    });
  });

  it("does not parse similar slash commands", () => {
    expect(parseReviewCommand("/reviewer main")).toBeUndefined();
    expect(parseReviewCommand("please /review main")).toBeUndefined();
    expect(parseReviewCommand("/review --custom")).toBeUndefined();
  });
});

describe("formatReviewCommand", () => {
  it("formats every review target as an editable slash command", () => {
    expect(formatReviewCommand({ type: "uncommittedChanges" })).toBe("/review");
    expect(formatReviewCommand({ type: "baseBranch", branch: "main" })).toBe(
      "/review main",
    );
    expect(formatReviewCommand({
      type: "commit",
      sha: "abc123",
      title: "Fix title",
    })).toBe("/review --commit abc123 Fix title");
    expect(formatReviewCommand({
      type: "custom",
      instructions: "focus on API compatibility",
    })).toBe("/review --custom focus on API compatibility");
  });
});

describe("normalizeReviewDisplayText", () => {
  it("normalizes Codex review hints to the composer display text", () => {
    expect(normalizeReviewDisplayText("changes against 'main'")).toBe(
      "Review changes against main"
    );
    expect(normalizeReviewDisplayText("Review changes against \"develop\"")).toBe(
      "Review changes against develop"
    );
    expect(normalizeReviewDisplayText("current changes")).toBe(
      "Review current changes"
    );
  });
});

describe("buildInlineReviewPrompt", () => {
  it("asks for the structured review contract inside the recognised envelope", () => {
    const prompt = buildInlineReviewPrompt({ type: "baseBranch", branch: "main" });
    // The card's verdict, confidence, and findings all come from this reply.
    expect(prompt).toContain(REVIEW_OUTPUT_INSTRUCTIONS);
    // The transcript hides the prompt by its envelope.
    expect(isPwrAgentInlineReviewPrompt(prompt)).toBe(true);
  });
});
