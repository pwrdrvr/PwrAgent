import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

/** The Claude Code tools that run a shell command PwrAgent can classify. */
const CLAUDE_COMMAND_TOOLS = new Set(["Bash", "Monitor"]);

export type ClaudeMonitorSuggestionRequest = {
  toolName: string;
  command: string;
  toolUseId?: string;
};

/**
 * Appends PwrAgent's monitor suggestion to a Bash or Monitor result. The
 * suggestion rides on the tool result, so it reaches Claude before it can end
 * the turn, and it never starts or wakes a turn on its own.
 */
export function claudeMonitorSuggestionHooks(
  suggest: (request: ClaudeMonitorSuggestionRequest) => Promise<string | undefined>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PostToolUse: [{
      matcher: "Bash|Monitor",
      hooks: [async (input) => {
        if (input.hook_event_name !== "PostToolUse" || !CLAUDE_COMMAND_TOOLS.has(input.tool_name)) {
          return {};
        }
        const toolInput = input.tool_input as { command?: unknown } | undefined;
        const command = typeof toolInput?.command === "string" ? toolInput.command : "";
        if (!command.trim()) return {};
        const guidance = await suggest({
          toolName: input.tool_name,
          command,
          ...(input.tool_use_id ? { toolUseId: input.tool_use_id } : {}),
        }).catch(() => undefined);
        return guidance
          ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: guidance } }
          : {};
      }],
    }],
  };
}

/** Several hook sets in one `hooks` option, each event's matchers in order. */
export function mergeClaudeHooks(
  ...sets: Partial<Record<HookEvent, HookCallbackMatcher[]>>[]
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const set of sets) {
    for (const [event, matchers] of Object.entries(set) as [HookEvent, HookCallbackMatcher[]][]) {
      merged[event] = [...merged[event] ?? [], ...matchers];
    }
  }
  return merged;
}
