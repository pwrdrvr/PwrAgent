import { describe, expect, it } from "vitest";
import { normalizeReviewDisplayText, parseReviewCommand } from "../review-command";

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
