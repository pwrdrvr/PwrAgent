import type { AppServerMcpElicitationRequestNotification } from "./contracts/normalized-app-server";

/**
 * What an `mcpServer/elicitation/request` is for. The method carries four
 * different things, and each surface must name them the same way:
 *
 * - `tool-approval`: an empty form a host (Codex, the PwrAgent gateway, or
 *   the browser tool) sends as permission to run a tool. Not a request for
 *   data, and the only kind that may offer a remembered grant.
 * - `confirmation`: an empty form from an MCP server, such as "Confirm the
 *   refund?".
 * - `form`: an MCP server asks for field values.
 * - `url`: an MCP server asks the operator to open a page outside PwrAgent.
 */
export type McpElicitationPurpose = "tool-approval" | "confirmation" | "form" | "url";

type PurposeInput = Pick<
  AppServerMcpElicitationRequestNotification["params"],
  "mode" | "serverName" | "_meta" | "requestedSchema"
>;

export function mcpElicitationPurpose(params: PurposeInput): McpElicitationPurpose {
  if (params.mode === "url") {
    return "url";
  }
  const properties = params.requestedSchema?.properties;
  const empty = !properties || typeof properties !== "object" || Object.keys(properties).length === 0;
  if (!empty) {
    return "form";
  }
  return isMcpToolApprovalMeta(params.serverName, params._meta) ? "tool-approval" : "confirmation";
}

function isMcpToolApprovalMeta(serverName: string, meta: Record<string, unknown> | null | undefined): boolean {
  return meta?.codex_approval_kind === "mcp_tool_call"
    || meta?.pwragent_approval_kind === "mcp_tool_call"
    || ((serverName === "browser" || serverName === "browser-use")
      && typeof meta?.origin === "string" && meta.origin.trim().length > 0);
}
