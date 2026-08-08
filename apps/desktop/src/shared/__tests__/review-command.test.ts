import { describe, expect, it } from "vitest";
import {
  formatReviewCommand,
  normalizeReviewDisplayText,
  parseReviewCommand,
} from "../review-command";

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

describe("parseReviewCommand reviewer flags", () => {
  it("reads a leading reviewer override before a base branch", () => {
    expect(
      parseReviewCommand("/review --provider grok --reasoning high main")
    ).toEqual({
      target: { type: "baseBranch", branch: "main" },
      displayText: "Review changes against main",
      reviewer: { provider: "grok", reasoningEffort: "high" },
    });
  });

  it("reads a reviewer override with no target", () => {
    expect(parseReviewCommand("/review --provider codex --model gpt-5.6-sol")).toEqual({
      target: { type: "uncommittedChanges" },
      displayText: "Review current changes",
      reviewer: { provider: "codex", model: "gpt-5.6-sol" },
    });
  });

  it("keeps custom instructions verbatim after a reviewer override", () => {
    expect(
      parseReviewCommand(
        "/review --provider grok --custom check the --model wiring"
      )
    ).toEqual({
      target: { type: "custom", instructions: "check the --model wiring" },
      displayText: "Review custom instructions",
      reviewer: { provider: "grok" },
    });
  });

  it("leaves trailing flag-looking text inside a commit title alone", () => {
    expect(parseReviewCommand("/review --commit abc123 fix --model drift")).toEqual({
      target: { type: "commit", sha: "abc123", title: "fix --model drift" },
      displayText: "Review commit abc123",
    });
  });

  it("omits the reviewer when no flags are present", () => {
    expect(parseReviewCommand("/review main")).toEqual({
      target: { type: "baseBranch", branch: "main" },
      displayText: "Review changes against main",
    });
  });
});
