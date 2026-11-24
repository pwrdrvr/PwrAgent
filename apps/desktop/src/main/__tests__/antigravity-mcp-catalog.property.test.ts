import fc from "fast-check";
import { expect, it } from "vitest";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { agentToolSuccess, type AgentToolDefinition } from "../agent-tools/agent-tool-definition";
import { AgentToolMcpServer } from "../agent-tools/agent-tool-mcp-server";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import type { McpGatewayCatalog } from "../mcp-connections/mcp-gateway-catalog";

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

it("offers context-only connections through the bounded catalog and checks the deferred target", async () => {
  // Every advertised context route must reach just its selected connection,
  // even when the upstream catalog contains no tools and has no native alias.
  const skills = [{ name: "orchard-triage", uri: "skill://orchard/triage/SKILL.md" }];
  const calls: unknown[] = [];
  let selected = true;
  let permitted = true;
  const gateway = new McpGatewayToolService({
    connections: {
      requestGatewayToolOperation: async ({ connectionId, contextRequest, operation, scopeKey }) => {
        if (operation === "gateway/tools/list") return {
          tools: [], serverName: "Orchard", contextMethods: ["resources/read", "prompts/get"],
          serverSkills: { skills, complete: true },
        };
        calls.push({ connectionId, contextRequest, scopeKey });
        return { contents: [{ uri: skills[0].uri, text: "Orchard fixture" }] };
      },
    },
    selectedConnections: async () => selected ? ["orchard"] : [],
    contextAllowed: () => true,
    approve: async () => { throw new Error("Context retrieval must not enter the tools/call approval flow."); },
  });
  const catalogs = resolveAgentToolCatalogs({ mcpGatewayTools: gateway, currentTurnInputSource: () => "unknown" }, {
    taskMonitorRole: "all", antigravityMcpContext: true,
  });
  const server = new AgentToolMcpServer({
    resolveCatalogs: () => catalogs,
    resolveCallContext: () => turn,
    authorizeToolCall: ({ tool, catalogId }) =>
      tool === "read_mcp_context" && catalogId === "mcp_connections" && !permitted ? "test denial" : undefined,
  });
  try {
    const client = await server.registerClient(turn);
    const listing = (await post(client, "tools/list")).result;
    expect(listing.tools.map(({ name }: { name: string }) => name).sort()).toEqual([...directTools, ...discoveryTools].sort());
    expect(Buffer.byteLength(JSON.stringify(listing.tools))).toBeLessThanOrEqual(16 * 1024);
    const call = async (name: string, args: object) =>
      (await post(client, "tools/call", { name, arguments: args })).result.structuredContent;
    const found = await call("search_mcp_tools", { query: "triage", connectionId: "orchard" });
    expect(found.tools).toEqual([]);
    expect(found.servers).toMatchObject([{
      connectionId: "orchard", skills, skillsComplete: true,
      contextDiscovery: { toolName: "read_mcp_context", methods: ["resources/read", "prompts/get"] },
    }]);
    const deferred = await call("tool_search", { query: "read_mcp_context" });
    expect(deferred.tools[0].name).toBe("read_mcp_context");
    const contextRequest = { method: "resources/read", params: { uri: skills[0].uri } };
    const read = () => call("call_pwragent_tool", {
      toolName: "read_mcp_context", arguments: { connectionId: "orchard", ...contextRequest },
    });
    expect((await read()).result.contents[0].text).toBe("Orchard fixture");
    permitted = false;
    expect((await read()).code).toBe("forbidden");
    permitted = true;
    selected = false;
    expect((await read()).code).toBe("mcp_gateway_error");
    expect(calls).toEqual([{ connectionId: "orchard", contextRequest, scopeKey: '["gateway","acp:antigravity","thread"]' }]);
  } finally {
    await server.close();
  }
});

it("keeps exact schemas that fit before adding context routes", async () => {
  // Context is optional metadata. With or without it, the same exact schemas
  // and identity must fit, even at the last byte of the search budget.
  const search = async (size: number, contextAllowed: boolean) => {
    const catalog: McpGatewayCatalog = {
      serverName: "Orchard",
      serverIdentity: { serverInfo: { name: "Orchard", version: "1" } },
      contextMethods: ["resources/list", "resources/read"],
      tools: [{ connectionId: "orchard", serverName: "Orchard", toolName: "lookup", schemaRevision: "fixture",
        definition: { name: "lookup", inputSchema: { type: "object", description: "a".repeat(size) } } }],
    };
    return await new McpGatewayToolService({
      connections: { requestGatewayToolOperation: async () => catalog },
      selectedConnections: async () => ["orchard"],
      contextAllowed: () => contextAllowed,
      approve: async () => false,
    }).search({ query: "lookup", connectionId: "orchard" }, { ...turn, transport: "mcp" });
  };
  const budget = 24_000;
  const room = budget - Buffer.byteLength(JSON.stringify(await search(0, false)));
  await fc.assert(fc.asyncProperty(fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 256 })), async (spare) => {
    const baseline = await search(room - spare, false);
    const result = await search(room - spare, true);
    expect(baseline.tools).toHaveLength(1);
    expect(result.tools).toEqual(baseline.tools);
    expect(result.unavailable).toEqual(baseline.unavailable);
    expect(result.servers?.[0]?.serverInfo).toEqual(baseline.servers?.[0]?.serverInfo);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(budget);
  }));
});

it("returns native media and the complete structured result through the deferred MCP tool", async () => {
  const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" } as const;
  const audio = { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" } as const;
  const uri = "orchard://media";
  const upstream = {
    "resources/read": { contents: [{ uri, mimeType: image.mimeType, blob: image.data }, { uri: "orchard://audio", mimeType: audio.mimeType, blob: audio.data }] },
    "prompts/get": { messages: [{ role: "user", content: image }, { role: "assistant", content: audio }] },
  };
  const gateway = new McpGatewayToolService({
    connections: { requestGatewayToolOperation: async ({ contextRequest }) => contextRequest?.method === "resources/read"
      ? upstream["resources/read"] : upstream["prompts/get"] },
    selectedConnections: async () => ["orchard"],
    contextAllowed: () => true,
    approve: async () => false,
  });
  const catalogs = resolveAgentToolCatalogs({ mcpGatewayTools: gateway }, { antigravityMcpContext: true });
  const server = new AgentToolMcpServer({ resolveCatalogs: () => catalogs, resolveCallContext: () => turn });
  try {
    const client = await server.registerClient(turn);
    for (const [method, params] of [["resources/read", { uri }], ["prompts/get", { name: "media" }]] as const) {
      const { result } = await post(client, "tools/call", {
        name: "call_pwragent_tool",
        arguments: { toolName: "read_mcp_context", arguments: { connectionId: "orchard", method, params } },
      });
      expect(result.structuredContent).toEqual({ connectionId: "orchard", method, result: upstream[method] });
      expect(result.content.slice(1)).toEqual([image, audio]);
      expect(result.content[0].text).not.toContain(image.data);
      expect(result.content[0].text).not.toContain(audio.data);
    }
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
