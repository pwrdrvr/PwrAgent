import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { sandboxerStub } from "./helpers/sandboxer-stub";

const uri = "skill://orchard/triage/SKILL.md";
const exchanges = [
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

// The upstream wire is the oracle: each admitted read goes to the equivalent
// MCP method with its exact arguments and returns the server's result as data.
// Neither a native bridge token, an unselected connection nor a delegated
// monitor scope can issue this operation, even with a supported method.
it("relays managed context over the owner broker with selection and scope checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pwa-context-"));
  const registry = new McpConnectionRegistry({ configPath: join(directory, "config.toml") });
  const connection = registry.create({
    displayName: "Orchard",
    serverUrl: process.platform === "win32" ? "pipe:///pipe/orchard-fixture#/mcp" : "unix:///tmp/orchard-fixture.sock#/mcp",
  });
  let selected = true;
  const upstream: unknown[] = [];
  const broker = new McpConnectionGatewayService({
    registry, leaseManager: null, gatewayEnabled: () => true, sandboxer: sandboxerStub(),
    settings: {} as never,
    readGatewaySelection: async () => selected ? [connection.id] : [],
  });
  const started = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  let hold = false;
  let oversized = false;
  Object.assign(broker, { connectUpstreamClient: async () => {
    const [transport, server] = InMemoryTransport.createLinkedPair();
    server.onmessage = (message) => {
      if (!("method" in message && "id" in message)) return;
      const { id, method, params } = message;
      const result = method === "initialize" ? {
        protocolVersion: params?.protocolVersion,
        serverInfo: { name: "Orchard", version: "1" },
        capabilities: { resources: {}, prompts: {}, extensions: { "io.modelcontextprotocol/skills": {} } },
      } : oversized && method === "resources/read"
        ? { contents: [{ uri, text: "x".repeat(256 * 1024) }] }
        : exchanges.find((entry) => entry.method === method)?.result;
      if (method !== "initialize") upstream.push({ method, params });
      const send = () => server.send({ jsonrpc: "2.0", id, result: result ?? {} });
      if (hold) {
        started.resolve();
        void respond.promise.then(send);
      } else {
        void send();
      }
    };
    await server.start();
    const client = new Client({ name: "context-fixture", version: "1" });
    await client.connect(transport);
    return { client, transport };
  } });
  const scopeKey = JSON.stringify(["gateway", "acp:antigravity", "fixture-thread"]);
  const request = (contextRequest: { method: string; params: Record<string, unknown> }, scope = scopeKey) =>
    broker.requestGatewayToolOperation({
      connectionId: connection.id, scopeKey: scope, operation: "gateway/context/read",
      // Also exercise malformed requests directly at the broker boundary.
      contextRequest: contextRequest as never, signal: new AbortController().signal,
    });
  try {
    for (const { result, ...exchange } of exchanges) {
      expect(await request(exchange)).toEqual(result);
    }
    expect(upstream).toEqual(exchanges.map(({ method, params }) => ({ method, params })));
    const { method, params } = exchanges[2];
    const read = { method, params };
    await expect(request(read, "native-thread-id")).rejects.toThrow("not bound to a gateway thread");
    await expect(request(read, JSON.stringify(["gateway", "codex", "fixture-thread"]))).rejects.toThrow("cannot read managed MCP context");
    await expect(request(read, JSON.stringify(["gateway", "acp:antigravity", "monitor", {
      selectionOwner: { backend: "acp:antigravity", threadId: "fixture-thread" }, connectionIds: [connection.id], readOnly: true,
    }]))).rejects.toThrow("cannot read managed MCP context");
    await expect(request({ method: "tools/call", params: { name: "write" } })).rejects.toThrow("supported MCP context method");
    await expect(request({ method: "resources/read", params: { uri, endpoint: "https://invalid.example" } })).rejects.toThrow("Invalid params");
    selected = false;
    await expect(request(read)).rejects.toThrow("no longer selected");
    expect(upstream).toHaveLength(exchanges.length);

    selected = true;
    oversized = true;
    await expect(request(read)).rejects.toThrow("256 KiB size limit");
    oversized = false;
    hold = true;
    const pending = request(read);
    const rejected = expect(pending).rejects.toThrow("no longer selected");
    await started.promise;
    selected = false;
    respond.resolve();
    await rejected;
  } finally {
    respond.resolve();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
