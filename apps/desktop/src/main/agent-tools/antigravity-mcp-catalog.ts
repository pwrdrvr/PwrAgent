import type { AgentMcpTool } from "./agent-tool-router";

export const SEARCH_PWRAGENT_TOOLS = "search_pwragent_tools";
export const CALL_PWRAGENT_TOOL = "call_pwragent_tool";

// Antigravity can cache a large catalog but omit its tools from model turns.
// Keep thread creation, Agent memory, Job Monitor availability and the managed
// MCP gateway directly visible. The discovery pair reaches the other tools.
export const ANTIGRAVITY_DIRECT_MCP_TOOLS: ReadonlySet<string> = new Set([
  "add_todo",
  "agent_memory",
  "call_mcp_tool",
  "create_instance_thread",
  "create_monitor_delegation",
  "handoff_instance_thread",
  "handoff_task",
  "read_tool_guide",
  "search_mcp_tools",
]);

export const ANTIGRAVITY_TOOL_DISCOVERY_INSTRUCTIONS =
  "For other PwrAgent actions, use search_pwragent_tools for the exact schema and invoke it with call_pwragent_tool. "
  + "For enabled PwrAgent MCP connections such as Linear, use search_mcp_tools and call_mcp_tool.";

export const ANTIGRAVITY_TOOL_DISCOVERY: readonly AgentMcpTool[] = [
  {
    name: SEARCH_PWRAGENT_TOOLS,
    description: "Find PwrAgent tools by action or exact name. Returns input schemas for call_pwragent_tool. For external connections such as Linear, use search_mcp_tools.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: CALL_PWRAGENT_TOOL,
    description: "Run a PwrAgent tool by the exact name from search_pwragent_tools. Pass an arguments object matching its returned input schema.",
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
