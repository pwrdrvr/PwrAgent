import { describe, expect, it } from "vitest";
import {
  buildThreadTitlePrompt,
  readThreadTitlePrompt,
} from "../app-server/thread-title-prompt";

describe("thread title prompt", () => {
  it("captures desktop thread title constraints", () => {
    const prompt = readThreadTitlePrompt();

    expect(prompt).toContain("same language as the user's prompt");
    expect(prompt).toContain("under 50 characters");
    expect(prompt).toContain("6 words or fewer");
    expect(prompt).toContain("PROJECT-123");
    expect(prompt).toContain("#123");
    expect(prompt).toContain("issue 123");
    expect(prompt).toContain("PR 456");
    expect(prompt).not.toContain("bare numeric");
    expect(prompt).not.toMatch(/\bfix\b/i);
    expect(prompt).not.toMatch(/\badd\b/i);
    expect(prompt).not.toMatch(/\bimperative\b/i);
    expect(prompt).not.toMatch(/\blocale\b/i);
  });

  it("builds a prompt from the user's first prompt", () => {
    const prompt = buildThreadTitlePrompt("  Investigate PROJECT-123 in pr 456  ");

    expect(prompt).toContain("Investigate PROJECT-123 in pr 456");
    expect(prompt).not.toContain("{{USER_PROMPT}}");
  });
});
