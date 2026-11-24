import fc from "fast-check";
import { expect, it } from "vitest";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { agentToolSuccess, type AgentToolDefinition } from "../agent-tools/agent-tool-definition";
import { AgentToolMcpServer } from "../agent-tools/agent-tool-mcp-server";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";

const turn = { backend: "acp:antigravity", threadId: "thread", turnId: "turn" } as const;
const directTools = ["agent_memory", "call_mcp_tool", "create_monitor_delegation",
  "get_current_turn_input_source", "handoff_task", "read_tool_guide", "search_mcp_tools"];
const discoveryTools = ["call_pwragent_tool", "tool_search"];

function definition(name: string): AgentToolDefinition {
  return {
    name,
    namespace: "pwragent",
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: { marker: { type: "string" } } },
    dispatch: (args, context) => agentToolSuccess({ name, args, ...context }),
  };
}

it("keeps the production Antigravity MCP bootstrap under 16 KiB of tool declarations", async () => {
  const catalogs = resolveAgentToolCatalogs({
    appManagementAllowed: true,
    currentTurnInputSource: () => "unknown",
  }, { taskMonitorRole: "all" });
  const server = new AgentToolMcpServer({ resolveCatalogs: () => catalogs, resolveCallContext: () => turn });
  try {
    const client = await server.registerClient(turn);
    const listing = (await post(client, "tools/list")).result;
    expect(Buffer.byteLength(JSON.stringify(listing.tools))).toBeLessThanOrEqual(16 * 1024);
    expect(listing.tools.map(({ name }: { name: string }) => name).sort()).toEqual([...directTools, ...discoveryTools].sort());
    const search = await post(client, "tools/call", {
      name: "tool_search",
      arguments: { query: "create_instance_thread handoff_instance_thread add_todo", limit: 1 },
    });
    expect(search.result.structuredContent.tools.map(({ name }: { name: string }) => name))
      .toEqual(["create_instance_thread", "handoff_instance_thread", "add_todo"]);
  } finally {
    await server.close();
  }
});

it("keeps the Antigravity MCP catalog bounded as tools are added and resolves exact deferred schemas", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 70, max: 150 }), async (size) => {
    const original = [...directTools, ...Array.from({ length: size }, (_, i) => `probe_tool_${i}`)];
    const router = new AgentToolRouter(original.map(definition));
    const server = new AgentToolMcpServer({
      resolveCatalogs: () => [{ id: "thread_orchestration", router }],
      resolveCallContext: () => turn,
    });
    try {
      const acp = await server.registerClient(turn);
      const claude = await server.registerClient({ backend: "claude", threadId: "claude-thread" });
      const tools = (await post(acp, "tools/list")).result.tools;
      expect(tools.map(({ name }: { name: string }) => name).sort()).toEqual([...directTools, ...discoveryTools].sort());
      expect((await post(claude, "tools/list")).result.tools).toHaveLength(original.length);
      const name = `probe_tool_${size - 1}`;
      const search = await post(acp, "tools/call", { name: "tool_search", arguments: { query: name } });
      expect(search.result.structuredContent.tools[0]).toMatchObject({
        name,
        inputSchema: definition(name).inputSchema,
      });
    } finally {
      await server.close();
    }
  }), { numRuns: 10 });
});

it("uses the live catalog and enforces the target tool's permission and session requirement", async () => {
  let visible = true;
  let permitted = true;
  const router = new AgentToolRouter([definition("handoff_task"), definition("probe_deferred")]);
  const server = new AgentToolMcpServer({
    resolveCatalogs: () => [{ id: "thread_orchestration", router }],
    resolveCallContext: () => turn,
    isToolAdvertised: (name) => name !== "probe_deferred" || visible,
    authorizeToolCall: ({ tool, catalogId }) =>
      tool === "probe_deferred" && catalogId === "thread_orchestration" && !permitted ? "test denial" : undefined,
  });
  try {
    const client = await server.registerClient(turn);
    const call = (toolName: string, sessionId?: string) => post(client, "tools/call", {
      name: "call_pwragent_tool",
      arguments: { toolName, arguments: { marker: "test" } },
    }, sessionId);
    expect((await call("handoff_task")).result.structuredContent.code).toBe("forbidden");
    const initialization = await send(client, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" },
    });
    const sessionId = initialization.headers.get("Mcp-Session-Id") ?? undefined;
    expect(sessionId).toBeDefined();
    await initialization.text();
    const result = (await call("handoff_task", sessionId)).result.structuredContent;
    expect(result).toMatchObject({ ...turn, name: "handoff_task", args: { marker: "test" } });
    expect((await call("handoff_task", sessionId)).result.structuredContent.callId).toBe(result.callId);
    permitted = false;
    expect((await call("probe_deferred", sessionId)).result.structuredContent.code).toBe("forbidden");
    visible = false;
    expect((await call("probe_deferred", sessionId)).result.structuredContent.code).toBe("unsupported_operation");
  } finally {
    await server.close();
  }
});

type Registration = Awaited<ReturnType<AgentToolMcpServer["registerClient"]>>;

function send({ server }: Registration, method: string, params?: object, sessionId?: string) {
  return fetch(server.url, {
    method: "POST",
    headers: {
      ...Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Connection: "close",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function post(client: Registration, method: string, params?: object, sessionId?: string) {
  const response = await send(client, method, params, sessionId);
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const data = body.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(data?.slice("data:".length) ?? body);
}
