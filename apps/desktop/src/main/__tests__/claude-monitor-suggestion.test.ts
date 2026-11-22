import { describe, expect, it, vi } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeMonitorSuggestionHooks,
  mergeClaudeHooks,
} from "../claude/claude-monitor-suggestion";
import { claudeReportFindingsHooks } from "../claude/claude-review-findings";
import { buildPwrAgentMcpInstructions } from "../agent-tools/agent-tool-mcp-server";

function runHook(
  hooks: ReturnType<typeof claudeMonitorSuggestionHooks>,
  tool_name: string,
  tool_input: unknown,
) {
  const [matcher] = hooks.PostToolUse!;
  return matcher!.hooks[0]!({
    hook_event_name: "PostToolUse", tool_name, tool_input, tool_response: "started", tool_use_id: "toolu_1",
    session_id: "session", transcript_path: "/fixture/transcript.jsonl", cwd: "/fixture",
  } as HookInput, "toolu_1", { signal: new AbortController().signal });
}

describe("Claude monitor suggestion hook", () => {
  it("appends the suggestion to a Bash or Monitor result", async () => {
    const suggest = vi.fn(async () => "use watch_thread_pull_request");
    const hooks = claudeMonitorSuggestionHooks(suggest);
    expect(hooks.PostToolUse![0]!.matcher).toBe("Bash|Monitor");

    await expect(runHook(hooks, "Monitor", { command: "gh pr checks 8 --watch" })).resolves.toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "use watch_thread_pull_request" },
    });
    expect(suggest).toHaveBeenCalledWith({
      toolName: "Monitor", command: "gh pr checks 8 --watch", toolUseId: "toolu_1",
    });
  });

  it("adds nothing when PwrAgent has no suggestion or the call fails", async () => {
    await expect(runHook(claudeMonitorSuggestionHooks(async () => undefined), "Bash", { command: "ls" }))
      .resolves.toEqual({});
    await expect(runHook(claudeMonitorSuggestionHooks(async () => { throw new Error("closed"); }), "Bash", { command: "ls" }))
      .resolves.toEqual({});
  });

  it("ignores other tools and commandless input", async () => {
    const suggest = vi.fn(async () => "nudge");
    const hooks = claudeMonitorSuggestionHooks(suggest);
    await expect(runHook(hooks, "Read", { command: "gh pr checks 8 --watch" })).resolves.toEqual({});
    await expect(runHook(hooks, "Bash", {})).resolves.toEqual({});
    expect(suggest).not.toHaveBeenCalled();
  });

  it("keeps the findings hook beside it", () => {
    const merged = mergeClaudeHooks(claudeReportFindingsHooks(), claudeMonitorSuggestionHooks(async () => undefined));
    expect(merged.PostToolUse).toHaveLength(2);
  });
});

describe("PwrAgent MCP instructions", () => {
  it("names PR watches, dependencies, and monitors when offered", () => {
    const text = buildPwrAgentMcpInstructions([
      "read_tool_guide", "watch_thread_pull_request", "manage_thread_dependencies", "create_monitor_delegation",
    ]);
    expect(text).toContain("Read read_tool_guide");
    expect(text).toContain("follow prAutomation.guidance and use watch_thread_pull_request");
    expect(text).toContain("Use manage_thread_dependencies for prerequisites, ci_run for standalone CI");
    expect(text).toContain("Explicit Job Monitor or no built-in wait: create_monitor_delegation.");
    expect(text).toContain("Register the wait and end the turn.");
  });

  it("does not name a tool the catalog lacks", () => {
    const text = buildPwrAgentMcpInstructions(["read_tool_guide"]);
    expect(text).not.toContain("watch_thread_pull_request");
  });
});
