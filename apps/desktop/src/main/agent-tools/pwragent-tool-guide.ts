import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import { agentToolSuccess, type AgentToolDefinition } from "./agent-tool-definition";

import { PWRAGENT_COMPATIBILITY_TOOL_GUIDE } from "./pwragent-workflow-skills";

export const PWRAGENT_TOOL_GUIDE = PWRAGENT_COMPATIBILITY_TOOL_GUIDE;

export function buildPwrAgentToolGuideDefinition(): AgentToolDefinition {
  return {
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: "read_tool_guide",
    description: "Read the short PwrAgent tool guide for tool selection, threads, delegation, machines, messaging, CI, and connected MCP tools.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", additionalProperties: false },
    deferLoading: true,
    dispatch: () => agentToolSuccess({ guide: PWRAGENT_TOOL_GUIDE }, {
      mcpContentItems: [{ type: "text", text: PWRAGENT_TOOL_GUIDE }],
    }),
  };
}
