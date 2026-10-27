import { describe, expect, it } from "vitest";
import type { AppServerPendingRequestNotification } from "@pwragent/shared";
import { buildAutomationMcpConsent, buildMcpToolApprovalConsent } from "../mcp-connections/mcp-approval-consent";

function request(): AppServerPendingRequestNotification {
  return {
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "fixture-thread", turnId: "fixture-turn", requestId: "fixture-request", serverName: "fixture-server",
      mode: "form", message: "Allow a tool?", requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "lookup", persist: ["session", "always"] },
    },
  };
}

describe("MCP tool consent envelopes", () => {
  it("accepts one invocation without retaining a grant", () => {
    expect(buildMcpToolApprovalConsent(request())).toEqual({ action: "accept", content: {}, _meta: null });
  });

  it("preserves automation conversation grants and tool allowlists", () => {
    expect(buildAutomationMcpConsent({ request: request(), serverNames: ["fixture-server"], toolAllowlist: ["lookup"] }))
      .toEqual({ action: "accept", content: {}, _meta: { persist: "session" } });
    expect(buildAutomationMcpConsent({ request: request(), serverNames: ["fixture-server"], toolAllowlist: ["write"] })).toBeUndefined();
  });

  it.each(["input", "url", "confirmation", "unknown-scope"] as const)("does not accept %s as tool consent", (scenario) => {
    const value = request();
    if (scenario === "input") value.params.requestedSchema = { type: "object", properties: { answer: { type: "string" } } };
    if (scenario === "url") value.params.mode = "url";
    if (scenario === "confirmation") value.params._meta = {};
    if (scenario === "unknown-scope") value.params._meta = { codex_approval_kind: "mcp_tool_call", persist: "server-session" };
    expect(buildMcpToolApprovalConsent(value)).toBeUndefined();
  });
});
