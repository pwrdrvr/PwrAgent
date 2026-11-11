import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  vi.resetModules();
});

it("loads the Agent SDK once, and retries after a failed load instead of caching the failure", async () => {
  let attempts = 0;
  vi.doMock("@anthropic-ai/claude-agent-sdk", () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient load failure");
    return { query: "fixture-query" };
  });
  const { loadClaudeAgentSdk } = await import("../claude/claude-sdk");

  // Vitest wraps a throwing factory's error in its own message.
  await expect(loadClaudeAgentSdk()).rejects.toThrow();
  await expect(loadClaudeAgentSdk()).resolves.toMatchObject({ query: "fixture-query" });
  await loadClaudeAgentSdk();
  expect(attempts).toBe(2);
});
