import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import { sandboxerStub } from "./helpers/sandboxer-stub";

const uri = "skill://orchard/triage/SKILL.md";
const exchanges = [
  { method: "resources/list", params: {}, result: { resources: [], nextCursor: "" } },
  { method: "resources/list", params: { cursor: "" }, result: { resources: [], nextCursor: "opaque-page-2" } },
  { method: "resources/list", params: { cursor: "opaque-page-2" }, result: { resources: [{ name: "Triage", uri }] } },
  { method: "resources/templates/list", params: {}, result: { resourceTemplates: [{ name: "Records", uriTemplate: "orchard://{id}" }] } },
  { method: "resources/read", params: { uri }, result: { contents: [{ uri, text: "Orchard fixture" }] } },
  { method: "skills/list", params: {}, result: { skills: [{ uri, frontmatter: { name: "orchard-triage" } }], nextCursor: "opaque-page-2" } },
  { method: "skills/get", params: { uri }, result: { frontmatter: { name: "orchard-triage" }, resources: [{ uri }] } },
  { method: "resources/directory/read", params: { uri: "skill://orchard/triage/" }, result: { entries: [{ name: "SKILL.md", uri }] } },
  { method: "prompts/list", params: {}, result: { prompts: [{ name: "greeting" }] } },
  { method: "prompts/get", params: { name: "greeting", arguments: { fruit: "pomelo" } },
    result: { messages: [{ role: "user", content: { type: "text", text: "Hello, pomelo" } }] } },
] as const;

async function fixture(respond: (message: JSONRPCRequest) => Promise<{ result: Record<string, unknown> } | { error: { code: number; message: string } }>) {
  const directory = await mkdtemp(join(tmpdir(), "pwa-context-"));
  const registry = new McpConnectionRegistry({ configPath: join(directory, "config.toml") });
  const connection = registry.create({
    displayName: "Orchard",
    serverUrl: process.platform === "win32" ? "pipe:///pipe/orchard-fixture#/mcp" : "unix:///tmp/orchard-fixture.sock#/mcp",
  });
  // The health query only describes the fixture. Built-ins can probe the machine.
  Object.assign(registry, { list: () => [connection] });
  let selected = true;
  const broker = new McpConnectionGatewayService({
    registry, leaseManager: null, gatewayEnabled: () => true, sandboxer: sandboxerStub(),
    settings: {} as never,
    readGatewaySelection: async () => selected ? [connection.id] : [],
  });
  Object.assign(broker, { connectUpstreamClient: async () => {
    const [transport, server] = InMemoryTransport.createLinkedPair();
    server.onmessage = (message) => {
      if (!("method" in message && "id" in message)) return;
      const { id, method, params } = message;
      const result = method === "initialize" ? {
        protocolVersion: params?.protocolVersion,
        serverInfo: { name: "Orchard", version: "1" },
        capabilities: { tools: {}, resources: {}, prompts: {}, extensions: { "io.modelcontextprotocol/skills": {} } },
      } : undefined;
      const reply = result ? Promise.resolve({ result }) : respond(message);
      void reply.then((payload) => server.send({ jsonrpc: "2.0", id, ...payload }));
    };
    await server.start();
    const client = new Client({ name: "context-fixture", version: "1" });
    await client.connect(transport);
    return { client, transport };
  } });
  const scopeKey = JSON.stringify(["gateway", "acp:antigravity", "fixture-thread"]);
  const readContext = (contextRequest: { method: string; params: Record<string, unknown> }, scope = scopeKey) =>
    broker.requestGatewayToolOperation({
      connectionId: connection.id, scopeKey: scope, operation: "gateway/context/read",
      // Also exercise malformed requests directly at the broker boundary.
      contextRequest: contextRequest as never, signal: new AbortController().signal,
    });
  return {
    broker, connection, scopeKey, readContext,
    setSelected: (value: boolean) => { selected = value; },
    close: async () => {
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// The upstream wire is the oracle: each admitted read goes to the equivalent
// MCP method with its exact arguments and returns the server's result as data.
// Neither a native bridge token, an unselected connection nor a delegated
// monitor scope can issue this operation, even with a supported method.
it("relays managed context over the owner broker with selection and scope checks", async () => {
  const started = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  const upstream: unknown[] = [];
  let hold = false;
  let oversized = false;
  const { readContext: request, connection, setSelected, close } = await fixture(async ({ method, params }) => {
    upstream.push({ method, params });
    if (hold) {
      started.resolve();
      await respond.promise;
    }
    if (oversized) return { result: { contents: [{ uri, text: "x".repeat(256 * 1024) }] } };
    const exchange = exchanges.find((entry) =>
      entry.method === method && (!("cursor" in entry.params) ? params?.cursor === undefined : entry.params.cursor === params?.cursor));
    return { result: exchange?.result ?? {} };
  });
  try {
    for (const { result, ...exchange } of exchanges) {
      expect(await request(exchange)).toEqual(result);
    }
    expect(upstream).toEqual(exchanges.map(({ method, params }) => ({ method, params })));
    const read = { method: "resources/read", params: { uri } };
    await expect(request(read, "native-thread-id")).rejects.toThrow("not bound to a gateway thread");
    await expect(request(read, JSON.stringify(["gateway", "codex", "fixture-thread"]))).rejects.toThrow("cannot read managed MCP context");
    await expect(request(read, JSON.stringify(["gateway", "acp:antigravity", "monitor", {
      selectionOwner: { backend: "acp:antigravity", threadId: "fixture-thread" }, connectionIds: [connection.id], readOnly: true,
    }]))).rejects.toThrow("cannot read managed MCP context");
    await expect(request({ method: "tools/call", params: { name: "write" } })).rejects.toThrow("supported MCP context method");
    await expect(request({ method: "resources/read", params: { uri, endpoint: "https://invalid.example" } })).rejects.toThrow("Invalid params");
    setSelected(false);
    await expect(request(read)).rejects.toThrow("no longer selected");
    expect(upstream).toHaveLength(exchanges.length);

    setSelected(true);
    oversized = true;
    await expect(request(read)).rejects.toThrow("256 KiB size limit");
    oversized = false;
    hold = true;
    const pending = request(read);
    const rejected = expect(pending).rejects.toThrow("no longer selected");
    await started.promise;
    setSelected(false);
    respond.resolve();
    await rejected;
  } finally {
    respond.resolve();
    await close();
  }
});

it.each(["error", "over budget"] as const)("keeps negotiated context when tools/list is %s", async (failure) => {
  // A failed tool inventory does not revoke capabilities negotiated during initialization.
  const { broker, connection, readContext, close } = await fixture(async ({ method }) => {
    if (method === "tools/list") return failure === "error"
      ? { error: { code: -32603, message: "Fixture tool list failed" } }
      : { result: { tools: [{ name: "huge", description: "x".repeat(2 * 1024 * 1024), inputSchema: { type: "object" } }] } };
    return { result: { prompts: [{ name: "greeting" }] } };
  });
  try {
    const result = await new McpGatewayToolService({
      connections: broker, selectedConnections: async () => [connection.id], contextAllowed: () => true, approve: async () => false,
    }).search({ query: connection.displayName }, { backend: "acp:antigravity", threadId: "fixture-thread", turnId: "turn", transport: "mcp" });
    expect(result.tools).toEqual([]);
    expect(result.unavailable).toEqual([{ connectionId: connection.id, message: expect.stringMatching(failure === "error" ? /tools\/list/u : /size limit/u) }]);
    expect(result.servers).toMatchObject([{ connectionId: connection.id, contextDiscovery: {
      methods: expect.arrayContaining(["resources/list", "prompts/list"]),
    } }]);
    await expect(readContext({ method: "prompts/list", params: {} })).resolves.toEqual({ prompts: [{ name: "greeting" }] });
  } finally {
    await close();
  }
});

it("preserves healthy catalog status when the server rejects a context request", async () => {
  // A request error describes one invalid URI or argument, not the tool inventory.
  const { broker, connection, scopeKey, readContext, close } = await fixture(async ({ method }) => method === "tools/list"
    ? { result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } }
    : { error: { code: -32602, message: "Fixture URI not found" } });
  try {
    await broker.requestGatewayToolOperation({
      connectionId: connection.id, scopeKey, operation: "gateway/tools/list", signal: new AbortController().signal,
    });
    const readHealth = async () => (await broker.listConnections()).find((entry) => entry.id === connection.id)?.discovery;
    const before = await readHealth();
    expect(before?.state).toBe("ready");
    const failure = await readContext({ method: "resources/read", params: { uri } }).catch((error: unknown) => error);
    expect(await readHealth()).toEqual(before);
    expect(failure).toMatchObject({ code: -32602, message: expect.stringContaining("Fixture URI not found") });
  } finally {
    await close();
  }
});
