import { describe, expect, it } from "vitest";
import type { AppServerPendingRequestNotification } from "@pwragent/shared";
import { buildAutomationMcpConsent, buildMcpToolApprovalConsent } from "../mcp-connections/mcp-approval-consent";
import { nativeCodexMcpApprovalFixture } from "./fixtures/native-codex-mcp-approval";

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

  it.each([["lookup"], ["mcp__fixture-server__lookup"]])("requires exact identity for native per-tool consent: %j", (tool) => {
    const wire = nativeCodexMcpApprovalFixture();
    const value = { method: wire.method, params: { ...wire.params, requestId: String(wire.id) } };
    expect(buildMcpToolApprovalConsent(value)).toEqual({ action: "accept", content: {}, _meta: null });
    expect(buildAutomationMcpConsent({ request: value, serverNames: ["fixture-server"], toolAllowlist: [tool] }))
      .toBeUndefined();
  });

  it.each([{ toolAllowlist: undefined }, { toolAllowlist: [] }])("permits native server-wide consent without a tool restriction: $toolAllowlist", ({ toolAllowlist }) => {
    const wire = nativeCodexMcpApprovalFixture();
    const value = { method: wire.method, params: { ...wire.params, requestId: String(wire.id) } };
    expect(buildAutomationMcpConsent({ request: value, serverNames: ["fixture-server"], toolAllowlist }))
      .toEqual({ action: "accept", content: {}, _meta: { persist: "session" } });
  });

  it.each([undefined, null, "", "  ", 7, ["lookup"], { name: "lookup" }].map((toolName) => ({ toolName })))("rejects missing or malformed exact tool identity: $toolName", ({ toolName }) => {
    const wire = nativeCodexMcpApprovalFixture();
    const value = { method: wire.method, params: {
      ...wire.params,
      requestId: String(wire.id),
      _meta: { ...wire.params._meta as Record<string, unknown>, tool_name: toolName, tool_params: { tool_name: "lookup" } },
    } };
    expect(buildAutomationMcpConsent({ request: value, serverNames: ["fixture-server"], toolAllowlist: ["lookup"] }))
      .toBeUndefined();
  });

  it("does not persist native server-wide consent when only a permanent grant is offered", () => {
    const wire = nativeCodexMcpApprovalFixture();
    const value = { method: wire.method, params: {
      ...wire.params, requestId: String(wire.id), _meta: { ...wire.params._meta as Record<string, unknown>, persist: "always" },
    } };
    expect(buildAutomationMcpConsent({ request: value, serverNames: ["fixture-server"] }))
      .toEqual({ action: "accept", content: {}, _meta: null });
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
