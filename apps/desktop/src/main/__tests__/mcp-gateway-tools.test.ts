import { afterEach, describe, expect, it, vi } from "vitest";
import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { buildMcpGatewayToolDefinitions } from "../agent-tools/pwragent-mcp-gateway-tools";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import { gatewayToolRevision, validateGatewayArguments, type McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import { gatewayInvocationName } from "../mcp-connections/mcp-gateway-attribution";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentToolMcpServer } from "../agent-tools/agent-tool-mcp-server";

const context: AgentToolCallContext = { backend: "codex", threadId: "thread-a", turnId: "turn-a", callId: "call-a", transport: "codex_dynamic_tool" };
function tool(connectionId = "one", name = "lookup"): McpGatewayTool {
  const definition = {
    name, description: "Look up a fixture record.",
    inputSchema: { type: "object" as const, additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
  };
  return { connectionId, serverName: connectionId, toolName: name, schemaRevision: gatewayToolRevision(connectionId, 1, definition), definition };
}
function fixture() {
  const selected = new Map([["thread-a", ["one"]], ["thread-b", ["two"]]]);
  const catalog = new Map([["one", [tool()]], ["two", [tool("two")]]]);
  const approve = vi.fn(async () => true);
  const result: CallToolResult = { content: [{ type: "text", text: "fixture" }] };
  const requestGatewayToolOperation = vi.fn(async (params: Parameters<NonNullable<ConstructorParameters<typeof McpGatewayToolService>[0]>["connections"]["requestGatewayToolOperation"]>[0]) => {
    params.signal.throwIfAborted();
    if (params.operation === "gateway/tools/list") return catalog.get(params.connectionId) ?? [];
    return result;
  });
  const service = new McpGatewayToolService({
    connections: { requestGatewayToolOperation }, approve,
    selectedConnections: async (caller) => selected.get(caller.threadId) ?? [],
  });
  const args = { connectionId: "one", toolName: "lookup", schemaRevision: tool().schemaRevision, arguments: { id: "record" } };
  return { service, args, selected, catalog, approve, requestGatewayToolOperation, result };
}

afterEach(() => vi.restoreAllMocks());

describe("fixed MCP gateway tools", () => {
  it("serves late additions to an already initialized ACP MCP client", async () => {
    const f = fixture();
    const server = new AgentToolMcpServer({
      resolveCatalogs: () => [{ id: "mcp_connections", router: new AgentToolRouter(buildMcpGatewayToolDefinitions(f.service)) }],
      resolveCallContext: (client) => client.threadId ? { ...client, threadId: client.threadId, turnId: "turn-a" } : undefined,
    });
    const client = new Client({ name: "fixture", version: "1" });
    try {
      const registration = await server.registerClient({ backend: "acp:fixture", threadId: "thread-a" });
      await client.connect(new StreamableHTTPClientTransport(new URL(registration.server.url), {
        requestInit: { headers: Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])) },
      }));
      expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(["call_mcp_tool", "search_mcp_tools"]);
      f.catalog.set("one", [tool("one", "late_tool")]);
      const found = await client.callTool({ name: "search_mcp_tools", arguments: { query: "late_tool" } });
      expect(JSON.stringify(found)).toContain("late_tool");
      const entry = f.catalog.get("one")![0];
      const called = await client.callTool({ name: "call_mcp_tool", arguments: {
        connectionId: entry.connectionId, toolName: entry.toolName, schemaRevision: entry.schemaRevision, arguments: { id: "x" },
      } });
      expect(called._meta?.["pwragent/source"]).toMatchObject({ connectionId: "one", toolName: "late_tool" });
      expect(f.approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: "late_tool" }), expect.objectContaining({ backend: "acp:fixture", threadId: "thread-a", turnId: "turn-a" }), expect.any(AbortSignal));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses one registered router to discover and invoke tools added later", async () => {
    const f = fixture();
    const router = new AgentToolRouter(buildMcpGatewayToolDefinitions(f.service));
    const registered = router.buildDynamicToolSpecs();
    f.selected.set("thread-a", []);
    expect((await f.service.search({ query: "lookup" }, context)).tools).toEqual([]);
    f.catalog.set("late", [tool("late", "new_operation")]);
    f.selected.set("thread-a", ["late"]);
    const discovered = await f.service.search({ query: "new_operation" }, context);
    expect(discovered.tools[0]).toMatchObject({ connectionId: "late", invocation: { codeModeName: "pwragent__call_mcp_tool" } });
    const entry = discovered.tools[0];
    const response = await router.handleDynamicToolCall({ backend: "codex", call: {
      threadId: context.threadId, turnId: context.turnId!, callId: "late-call", namespace: "pwragent", tool: "call_mcp_tool",
      arguments: { connectionId: entry.connectionId, toolName: entry.toolName, schemaRevision: entry.schemaRevision, arguments: { id: "x" } },
    } });
    expect(response.success).toBe(true);
    expect(router.buildDynamicToolSpecs()).toEqual(registered);
    expect(router.acceptsDynamicToolCall({ namespace: "pwragent", tool: "new_operation" })).toBe(false);
    expect(f.approve).toHaveBeenCalledOnce();
  });

  it("isolates selected connections and handles same-name tools without alias collisions", async () => {
    const f = fixture();
    await expect(f.service.call(f.args, { ...context, threadId: "thread-b" })).rejects.toThrow("selected");
    f.selected.set("thread-a", ["one", "two"]);
    const result = await f.service.search({ query: "lookup" }, context);
    expect(result.tools.map((entry) => entry.connectionId)).toEqual(["one", "two"]);
    expect(f.requestGatewayToolOperation.mock.calls.every(([call]) => call.scopeKey === '["gateway","codex","thread-a"]')).toBe(true);
    expect(f.approve).not.toHaveBeenCalled();
  });

  it("rechecks selection after discovery and after approval, without an upstream action", async () => {
    const f = fixture();
    await f.service.search({ query: "lookup" }, context);
    f.approve.mockImplementation(async () => { f.selected.set("thread-a", []); return true; });
    await expect(f.service.call(f.args, context)).rejects.toThrow("no longer selected");
    expect(f.requestGatewayToolOperation.mock.calls.some(([call]) => call.operation === "gateway/tools/call")).toBe(false);
  });

  it("rejects stale schemas, invalid arguments and denied approvals before dispatch", async () => {
    const f = fixture();
    await expect(f.service.call({ ...f.args, schemaRevision: "stale" }, context)).rejects.toThrow("changed");
    await expect(f.service.call({ ...f.args, arguments: { id: 42 } }, context)).rejects.toThrow("validated");
    expect(f.approve).not.toHaveBeenCalled();
    f.approve.mockResolvedValue(false);
    await expect(f.service.call(f.args, context)).rejects.toThrow("not approved");
    expect(f.requestGatewayToolOperation.mock.calls.some(([call]) => call.operation === "gateway/tools/call")).toBe(false);
  });

  it("keeps schema $id validation isolated across connections and revisions", () => {
    const a = tool();
    a.definition.inputSchema.$id = "https://fixture.invalid/schema";
    const b = structuredClone(a);
    b.definition.inputSchema.properties = { id: { type: "number" } };
    expect(() => validateGatewayArguments(a.definition, { id: "text" })).not.toThrow();
    expect(() => validateGatewayArguments(b.definition, { id: "text" })).toThrow("validated");
    expect(() => validateGatewayArguments(b.definition, { id: 4 })).not.toThrow();
    b.definition.inputSchema.$async = true;
    expect(() => validateGatewayArguments(b.definition, { id: "invalid" })).toThrow("Asynchronous schemas");
  });

  it("cancels a pending approval on thread changes", async () => {
    const f = fixture();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const service = new McpGatewayToolService({
      connections: { requestGatewayToolOperation: f.requestGatewayToolOperation },
      selectedConnections: async () => ["one"],
      approve: async (_invocation, _context, signal) => await new Promise<boolean>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        entered();
      }),
    });
    const call = service.call(f.args, context);
    const rejected = expect(call).rejects.toThrow("cancelled");
    await waiting;
    service.cancel("codex", "thread-b");
    service.cancel("codex", "thread-a");
    await rejected;
    expect(f.requestGatewayToolOperation.mock.calls.some(([request]) => request.operation === "gateway/tools/call")).toBe(false);
  });

  it("does not publish partially truncated schemas or expose deselected inventories", async () => {
    const f = fixture();
    f.catalog.get("one")![0].definition.description = "lookup ".repeat(5_000);
    const result = await f.service.search({ query: "lookup" }, context);
    expect(result.tools).toEqual([]);
    expect(result.unavailable[0].message).toContain("size budget");
    await expect(f.service.search({ query: "lookup", connectionId: "two" }, context)).rejects.toThrow("not selected");
  });

  it("preserves MCP content and structured errors, with one copy of multimodal data", async () => {
    const f = fixture();
    f.result.content = [
      { type: "text", text: "fixture" }, { type: "image", data: "YWJj", mimeType: "image/png" },
      { type: "resource_link", name: "record", uri: "https://fixture.invalid/record" },
    ];
    f.result.structuredContent = { value: 4 };
    f.result.isError = true;
    const router = new AgentToolRouter(buildMcpGatewayToolDefinitions(f.service));
    const mcp = await router.handleMcpToolCall({ backend: "acp:fixture", threadId: "thread-a", turnId: "turn-a", tool: "call_mcp_tool", args: f.args });
    expect(mcp).toMatchObject(f.result);
    const direct = await router.handleDynamicToolCall({ backend: "codex", call: { threadId: "thread-a", turnId: "turn-a", callId: "m", namespace: "pwragent", tool: "call_mcp_tool", arguments: f.args } });
    expect(direct.success).toBe(false);
    expect(JSON.stringify(direct).match(/YWJj/g)).toHaveLength(1);
    expect(direct.contentItems.some((item) => item.type === "inputImage")).toBe(true);
    f.requestGatewayToolOperation.mockRejectedValue(new McpError(-32602, "fixture error", { reason: "bad argument" }));
    const failed = await router.handleMcpToolCall({ backend: "codex", threadId: "thread-a", turnId: "turn-a", tool: "call_mcp_tool", args: f.args });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).toContain("-32602");
    expect(JSON.stringify(failed)).toContain("bad argument");
  });

  it("retains original source attribution without confusing delimiters", () => {
    expect(gatewayInvocationName("pwragent__call_mcp_tool", { connectionId: "one", toolName: "search" })).toBe('mcp:["one","search"]');
    expect(gatewayInvocationName("pwragent", { tool: "call_mcp_tool", arguments: { connectionId: "one", toolName: "search" } })).toBe('mcp:["one","search"]');
    expect(gatewayInvocationName("unrelated", { connectionId: "one", toolName: "search" })).toBeUndefined();
  });
});
