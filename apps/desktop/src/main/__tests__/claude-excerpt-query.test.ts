import type { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import { runClaudeExcerptQuery } from "../claude/claude-excerpt-query";

it.each(["success", "error_max_turns", "error_during_execution"])("accounts for a metered %s result in the user-configured harness", async (subtype) => {
  const close = vi.fn();
  const start = vi.fn(() => ({
    close,
    async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype, result: '{"choice":"1"}', session_id: "helper",
        modelUsage: { "claude-haiku-fixture": { inputTokens: 20, outputTokens: 5, costUSD: 0.021 } } };
    },
  }));
  const params = { model: "haiku", reasoningEffort: "low", system: "Pick an excerpt.", prompt: "fixture",
    schema: { type: "object" }, isMatch: (row: Record<string, unknown>) => row.choice === "1" };
  const run = () => runClaudeExcerptQuery(start as unknown as typeof query, params, { settingSources: ["project"] }, "/scratch");
  await expect(run()).resolves.toMatchObject({ ...(subtype === "success" ? { status: "ok", object: { choice: "1" } } : { status: "failed", reason: subtype }), model: "claude-haiku-fixture",
    tokenUsage: { last: { totalTokens: 25 } } });
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({
    model: "haiku", effort: "low", cwd: "/scratch", tools: [], mcpServers: {}, strictMcpConfig: true,
    settingSources: ["user"], settings: expect.objectContaining({ disableAllHooks: true }), persistSession: false, maxTurns: 1,
  }) }));
  expect(close).toHaveBeenCalledOnce();
});
