import type { AgentMcpTool } from "../agent-tools/agent-tool-router";
import { FORGE_PR_TOOL_OPERATIONS } from "../pr-status/forge-pr-tool-contract";
import { FORGE_READ_OPERATIONS } from "../pr-status/forge-tool-contract";

/**
 * PwrAgent tools whose calls PwrAgent approves itself: the MCP gateway asks
 * under the connection's tool-approval policy, and forge writes show their
 * own card under the project's forge rules. An ACP agent's prompt for these
 * would be a second card for the same call. Claude pre-allows the same set
 * through `allowedTools`.
 */
const HOST_APPROVED_TOOLS: ReadonlySet<string> = new Set([
  "call_mcp_tool",
  ...FORGE_READ_OPERATIONS,
  ...FORGE_PR_TOOL_OPERATIONS,
]);

/**
 * Whether an ACP agent's permission prompt for one of PwrAgent's own MCP
 * tools can be answered without asking the operator: PwrAgent approves the
 * call itself, or the tool only reads (`readOnlyHint` true and
 * `destructiveHint` not true). Any other tool, or a name PwrAgent's server
 * did not list for this session, still asks.
 */
export function pwragentToolSkipsAgentApproval(tool: Pick<AgentMcpTool, "name" | "annotations"> | undefined): boolean {
  if (!tool) return false;
  if (HOST_APPROVED_TOOLS.has(tool.name)) return true;
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
}
