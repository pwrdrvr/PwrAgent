import type { ServerRequest } from "@pwrdrvr/codex-app-server-protocol";

/**
 * Contrived Codex 0.159.2 wire request. The six metadata keys follow
 * core/src/mcp_tool_call.rs at openai/codex commit
 * ff6aec96948b70d94983af2641a6b67c94faeff5. Tool identity is deliberately
 * absent, even though the display text names a tool on the allowlist.
 */
export function nativeCodexMcpApprovalFixture(): Extract<ServerRequest, { method: "mcpServer/elicitation/request" }> {
  return {
    method: "mcpServer/elicitation/request",
    id: 41,
    params: {
      threadId: "fixture-thread",
      turnId: "fixture-turn",
      serverName: "fixture-server",
      mode: "form",
      message: "Allow the fixture-server MCP server to run tool \"lookup\"?",
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session", "always"],
        tool_title: "lookup",
        tool_description: "Look up a fixture by its identifier.",
        tool_params: { id: "fixture" },
        tool_params_display: [{ name: "id", value: "fixture" }],
      },
    },
  };
}
