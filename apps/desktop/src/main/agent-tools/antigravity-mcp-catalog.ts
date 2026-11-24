import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import type { AgentMcpTool } from "./agent-tool-router";
import { GET_CURRENT_TURN_INPUT_SOURCE } from "./current-turn-input-source-tool";
import { PWRAGENT_TOOL_SEARCH, PWRAGENT_TOOL_SEARCH_INPUT_SCHEMA } from "./pwragent-tool-search";

export const CALL_PWRAGENT_TOOL = "call_pwragent_tool";
export const ANTIGRAVITY_CALL_PWRAGENT_TOOL = `mcp_${PWRAGENT_TOOL_NAMESPACE}_${CALL_PWRAGENT_TOOL}`;

export function readPwrAgentCallTarget(input: unknown): { name: string; args: Record<string, unknown> } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { toolName, arguments: args } = input as Record<string, unknown>;
  if (typeof toolName !== "string" || !/^[a-z][a-z0-9_]*$/u.test(toolName)
    || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return { name: toolName, args: args as Record<string, unknown> };
}

// Antigravity can cache a large catalog but omit its tools from model turns.
// Keep thread creation, Agent memory, Job Monitor availability and the managed
// MCP gateway directly visible. The discovery pair reaches the other tools.
export const ANTIGRAVITY_DIRECT_MCP_TOOLS: ReadonlySet<string> = new Set([
  "agent_memory",
  "call_mcp_tool",
  "create_monitor_delegation",
  GET_CURRENT_TURN_INPUT_SOURCE,
  "handoff_task",
  "read_tool_guide",
  "search_mcp_tools",
]);

export const ANTIGRAVITY_TOOL_DISCOVERY_INSTRUCTIONS =
  "For other PwrAgent actions, use tool_search for the exact schema and invoke it with call_pwragent_tool.";
export const ANTIGRAVITY_MCP_CONNECTION_INSTRUCTIONS =
  "For selected managed MCP connections, use search_mcp_tools to discover tools and routes to resources, skills, and prompts. Invoke upstream tools with call_mcp_tool.";

export const ANTIGRAVITY_TOOL_DISCOVERY: readonly AgentMcpTool[] = [
  {
    name: PWRAGENT_TOOL_SEARCH,
    description: "Find PwrAgent tools by action or exact name, including to-dos, Federation, thread management, and pull requests. Returns input schemas for call_pwragent_tool. For external connections such as Linear, use search_mcp_tools.",
    inputSchema: PWRAGENT_TOOL_SEARCH_INPUT_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  {
    name: CALL_PWRAGENT_TOOL,
    description: "Run a PwrAgent tool by the exact name from tool_search. Pass an arguments object matching its returned input schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["toolName", "arguments"],
      properties: {
        toolName: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      },
    },
  },
];
