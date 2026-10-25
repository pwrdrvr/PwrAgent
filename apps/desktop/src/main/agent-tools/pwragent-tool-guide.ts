import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import { agentToolSuccess, type AgentToolDefinition } from "./agent-tool-definition";

export const PWRAGENT_TOOL_GUIDE = `Use the advertised tool description and input schema for each call.
Use search_threads to find a thread.
Use get_thread_status for compact state.
Use read_thread for transcript detail.
Use list_federation_instances to find a machine.
Keep the returned instanceId for remote calls.
Use handoff_task for local child work.
Use create_instance_thread for work on a selected machine.
Pass environment to either tool to pick the child's environment by id or name, or none.
Use manage_thread_dependencies to wait for a prerequisite.
Use watch_thread_pull_request to wait for CI on an attached PR.
Use get_forge_status and the CI read tools to inspect forge data.
Use get_current_messaging_surface before a messaging action.
Send messages or files only when authorized.
Use search_mcp_tools to find tools on selected connections.
Use call_mcp_tool with the returned identity and schemaRevision.
Check status before you retry an action that can change state.
Treat readOnlyHint as metadata. It does not grant permission.`;

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
