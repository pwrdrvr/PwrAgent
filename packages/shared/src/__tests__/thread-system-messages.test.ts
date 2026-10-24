import { describe, expect, it } from "vitest";
import {
  buildThreadCorrespondenceHeading,
  buildThreadMarkdownLink,
  parseThreadCorrespondenceMessage,
  summarizeThreadDependencyPrompt,
} from "../index";

describe("summarizeThreadDependencyPrompt", () => {
  it("ignores text that is not a dependency prompt", () => {
    expect(summarizeThreadDependencyPrompt("Please continue.")).toBeUndefined();
  });

  it("keeps a single prerequisite's name and phrase, and a failure's reason", () => {
    const success = [
      "PwrAgent resumed this thread because its prerequisites were met (all of 1).",
      "- \"Decoder: counters\" finishes its turn: Turn abc completed",
    ].join("\n");
    expect(summarizeThreadDependencyPrompt(success)).toEqual({
      outcome: "success", summary: "\"Decoder: counters\" finishes its turn",
    });
    const failure = [
      "PwrAgent resumed this thread because a prerequisite failed.",
      "- Thread abc passes CI: CI failed; PR: https://github.com/example/fixture/pull/1",
    ].join("\n");
    expect(summarizeThreadDependencyPrompt(failure)).toEqual({
      outcome: "failure", summary: "Thread abc passes CI — CI failed",
    });
  });

  it("falls back to the raw evidence line when no condition phrase matches", () => {
    const text = [
      "PwrAgent resumed this thread because its prerequisites were met (all of 1).",
      "- \"Docs\" reached a future condition: done",
    ].join("\n");
    expect(summarizeThreadDependencyPrompt(text)?.summary).toBe("\"Docs\" reached a future condition: done");
  });
});

describe("parseThreadCorrespondenceMessage", () => {
  const link = buildThreadMarkdownLink({
    backend: "codex", threadId: "recipient", messageId: "user:turn-1", title: "Runpod [GPU] / Verda",
  });

  it("parses the destination, state, and body from the heading it builds", () => {
    const text = `${buildThreadCorrespondenceHeading(link, "queued")}\n\nFirst line.\nSecond line.`;
    expect(parseThreadCorrespondenceMessage(text)).toMatchObject({
      destination: { backend: "codex", threadId: "recipient", messageId: "user:turn-1", title: "Runpod [GPU] / Verda" },
      state: "queued",
      body: "First line.\nSecond line.",
    });
  });

  it("keeps an unknown state label and a heading-only message", () => {
    const parsed = parseThreadCorrespondenceMessage(`**Message to ${link}** · Something new`);
    expect(parsed?.state).toBeUndefined();
    expect(parsed?.body).toBe("");
    expect(parsed?.destination?.threadId).toBe("recipient");
  });

  it("ignores text without the heading", () => {
    expect(parseThreadCorrespondenceMessage("Message to someone")).toBeUndefined();
  });
});
