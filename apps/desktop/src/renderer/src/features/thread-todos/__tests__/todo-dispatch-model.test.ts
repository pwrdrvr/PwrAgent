import { describe, expect, it } from "vitest";
import { resolveThreadTodoModelSettings, sameThreadTodoModelSettings, type ThreadTodoAction } from "@pwragent/shared";

const thread = { backend: "claude" as const, model: "opus", reasoningEffort: "high" };
const lastDispatch = { backend: "codex" as const, model: "sol", reasoningEffort: "high" };
const pick = { backend: "claude" as const, model: "sonnet", reasoningEffort: "medium" };
const action: ThreadTodoAction = { type: "start_thread", prompt: "Build it", reasoningEffort: "xhigh" };

describe("to-do dispatch precedence", () => {
  it("resolves card pick, thread memory, suggestion, then thread settings", () => {
    expect(resolveThreadTodoModelSettings({ thread, action, lastDispatch, pick })).toEqual({ settings: pick, source: "pick" });
    expect(resolveThreadTodoModelSettings({ thread, action, lastDispatch })).toEqual({ settings: lastDispatch, source: "memory" });
    expect(resolveThreadTodoModelSettings({ thread, action })).toEqual({ settings: { ...thread, reasoningEffort: "xhigh" }, source: "suggestion" });
    expect(resolveThreadTodoModelSettings({ thread })).toEqual({ settings: thread, source: "thread" });
  });

  it("inherits just the missing fields of an agent suggestion", () => {
    expect(resolveThreadTodoModelSettings({ thread, action: { ...action, model: "sonnet", reasoningEffort: undefined } }).settings)
      .toEqual({ ...thread, model: "sonnet" });
    expect(sameThreadTodoModelSettings(thread, { ...thread })).toBe(true);
    expect(sameThreadTodoModelSettings(thread, { ...thread, backend: "codex" })).toBe(false);
  });
});
