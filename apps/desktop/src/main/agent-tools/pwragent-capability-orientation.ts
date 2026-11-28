export const HANDOFF_TASK = "handoff_task";
export const CREATE_JOB_MONITOR = "create_monitor_delegation";
export const READ_TOOL_GUIDE = "read_tool_guide";

export const ORIENTED_PWRAGENT_TOOLS: ReadonlySet<string> = new Set([
  HANDOFF_TASK,
  CREATE_JOB_MONITOR,
  READ_TOOL_GUIDE,
]);

const searchInstructions = {
  codex: "Search exact names with tool_search. In Code Mode use tools.tool_search in exec and invoke the returned tool.",
  codexDirect: "Call the listed PwrAgent tools directly.",
  claude: "Use ToolSearch to load the matching mcp__pwragent__ tool if deferred, then call it.",
  acp: "Search PwrAgent tool_search for the exact schema, then use call_pwragent_tool with arguments matching it.",
  acpDirect: "Call the listed PwrAgent MCP tools directly.",
};

export function buildPwrAgentCapabilityOrientation(
  has: (name: string) => boolean,
  route: keyof typeof searchInstructions,
): string | undefined {
  const handoff = has(HANDOFF_TASK);
  const monitor = has(CREATE_JOB_MONITOR);
  if (!handoff && !monitor) return undefined;
  return [
    "PwrAgent capabilities.",
    ...(handoff ? ["Delegate scoped work to another PwrAgent thread with handoff_task."] : []),
    ...(monitor ? ["When available, use create_monitor_delegation for an explicit Job Monitor or a long command without a built-in wait."] : []),
    searchInstructions[route],
    ...(has(READ_TOOL_GUIDE) ? ["Use read_tool_guide for workflow guidance."] : []),
  ].join(" ");
}
