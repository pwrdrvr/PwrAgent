import { describe, expect, it } from "vitest";
import {
  formatReviewCommand,
  isCodexReviewPromptText,
  normalizeReviewDisplayText,
  parseReviewCommand,
} from "../review-command";
import { pullRequestReviewPrompt, pullRequestReviewUrl } from "./fixtures/pull-request-review";

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
  it("uses the same PR label for the optimistic card and generated review hints", () => {
    const label = parseReviewCommand(`/review --pr ${pullRequestReviewUrl}`)?.displayText;
    expect(normalizeReviewDisplayText(pullRequestReviewPrompt)).toBe(label);
    expect(normalizeReviewDisplayText(pullRequestReviewPrompt.replace(/\s+/g, " "))).toBe(label);
    expect(isCodexReviewPromptText(pullRequestReviewPrompt)).toBe(true);
  });

  it("does not classify quoted, incomplete, or extended PR instructions as generated prompts", () => {
    for (const text of [
      `Explain this: ${pullRequestReviewPrompt}`,
      `${pullRequestReviewPrompt}\nAlso check my local edits.`,
      pullRequestReviewPrompt.split("\n").slice(0, -1).join("\n"),
      "Review the complete pull request diff please.",
    ]) {
      expect(isCodexReviewPromptText(text)).toBe(false);
      expect(normalizeReviewDisplayText(text)).not.toBe(`Review ${pullRequestReviewUrl}`);
    }
  });

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
