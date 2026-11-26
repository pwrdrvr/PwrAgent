import type { AgentMcpTool } from "../agent-tools/agent-tool-router";
import { MANAGED_REVIEW_LEDGER_TOOL_NAMES } from "../agent-tools/pwragent-managed-review-ledger-tools";
import { FORGE_PR_TOOL_OPERATIONS } from "../pr-status/forge-pr-tool-contract";
import { FORGE_READ_OPERATIONS } from "../pr-status/forge-tool-contract";

/**
 * PwrAgent tools whose calls PwrAgent approves itself: the MCP gateway asks
 * under the connection's tool-approval policy, forge writes show their own
 * card under the project's forge rules, and the managed-review candidate
 * ledger mutates only an in-memory per-turn scratchpad. An ACP agent's prompt
 * for these would be redundant. Claude pre-allows the gateway/forge set
 * through `allowedTools`.
 */
const HOST_APPROVED_TOOLS: ReadonlySet<string> = new Set([
  "call_mcp_tool",
  ...MANAGED_REVIEW_LEDGER_TOOL_NAMES,
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
