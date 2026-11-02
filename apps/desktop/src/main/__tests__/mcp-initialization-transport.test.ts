import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { McpInitializationTransport } from "../mcp-connections/mcp-initialization-transport";

it.each(["2024-11-05", "2025-11-25"])("keeps initialize metadata out of a later call reusing its id (%s)", async (protocolVersion) => {
  const [host, upstream] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "desktop", version: "2" }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [], _meta: request.params?._meta }));
  const metadata = { interface: { owner: "desktop", desktopVersion: "2", relayVersion: "1" } };
  const messages: JSONRPCMessage[] = [];
  host.onmessage = (message) => messages.push(message);
  await server.connect(new McpInitializationTransport(upstream, metadata));
  await host.start();
  try {
    await host.send({ jsonrpc: "2.0", id: 7, method: "initialize", params: {
      protocolVersion, capabilities: {}, clientInfo: { name: "fixture", version: "1" },
    } });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ result: { protocolVersion, _meta: metadata } });
    await host.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const approval = { "fixture/approval": { singleUse: "exact-operation" } };
    await host.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "write", arguments: {}, _meta: approval } });
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({ result: { _meta: approval } });
  } finally {
    await host.close();
    await server.close();
  }
});
