import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import { gatewayToolRevision, type McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";

const antigravity: AgentToolCallContext = { backend: "acp:antigravity", threadId: "thread", turnId: "turn", transport: "mcp" };

function fixture(schemaText: string) {
  const connectionId = "fixture";
  const toolName = "write_record";
  const definition: McpGatewayTool["definition"] = {
    name: toolName,
    inputSchema: {
      type: "object", required: ["content"], additionalProperties: false,
      properties: { content: { type: "string", description: schemaText } },
    },
  };
  const schemaRevision = gatewayToolRevision(connectionId, 1, definition);
  const entry = { connectionId, toolName, schemaRevision, serverName: "Fixture", definition };
  const invoke = vi.fn(async () => { throw new Error("Connection closed after dispatch."); });
  const approve = vi.fn(async () => true);
  const service = new McpGatewayToolService({
    selectedConnections: async () => [connectionId],
    connections: { requestGatewayToolOperation: async ({ operation }) => operation === "gateway/tools/list" ? [entry] : await invoke() },
    approve,
  });
  return { service, entry, approve, invoke };
}

it("delivers only an explicitly requested exact schema within the Antigravity byte budget", async () => {
  const counts = fc.oneof(fc.constantFrom(9_000, 24_000), fc.integer({ min: 8_100, max: 24_000 }));
  await fc.assert(fc.asyncProperty(counts, async (count) => {
    const { service, entry, approve } = fixture("文".repeat(count));
    const lookup = { connectionId: entry.connectionId, query: entry.toolName };
    const standard = await service.search(lookup, antigravity);
    expect(standard.tools).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(standard))).toBeLessThanOrEqual(24_000);

    const exact = await service.search({ ...lookup, includeLargeSchema: true }, antigravity);
    const fullEntry = { ...entry, invocation: { name: "call_mcp_tool", codeModeName: "pwragent__call_mcp_tool" } };
    const fits = Buffer.byteLength(JSON.stringify({ tools: [fullEntry], unavailable: [] })) <= 64_000;
    expect(exact.tools).toEqual(fits ? [fullEntry] : []);
    expect(Buffer.byteLength(JSON.stringify(exact))).toBeLessThanOrEqual(64_000);
    expect(approve).not.toHaveBeenCalled();
  }), { numRuns: 25 });
});

it("keeps the ordinary limits for other backends", async () => {
  const { service, entry, approve, invoke } = fixture("文".repeat(9_000));
  const claude: AgentToolCallContext = { ...antigravity, backend: "claude" };
  const lookup = { query: entry.toolName, connectionId: entry.connectionId };
  expect((await service.search(lookup, claude)).tools).toEqual([]);
  await expect(service.search({ ...lookup, includeLargeSchema: true }, claude)).rejects.toThrow("requires Antigravity");
  await expect(service.call({
    connectionId: entry.connectionId, toolName: entry.toolName, schemaRevision: entry.schemaRevision,
    arguments: { content: "x".repeat(20_000) },
  }, claude)).rejects.toThrow("approval size limit");
  expect(approve).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it("bounds Antigravity writes by serialized bytes and dispatches an attempted write once", async () => {
  const { service, entry, approve, invoke } = fixture("Text to write.");
  const overhead = Buffer.byteLength(JSON.stringify({
    connectionId: entry.connectionId, toolName: entry.toolName, schemaRevision: entry.schemaRevision, arguments: { content: "" },
  }));
  await fc.assert(fc.asyncProperty(
    fc.oneof(fc.constantFrom(20_000, 64_000, 64_001), fc.integer({ min: 16_001, max: 70_000 })),
    async (bytes) => {
      approve.mockClear();
      invoke.mockClear();
      const remaining = bytes - overhead;
      const args = {
        connectionId: entry.connectionId, toolName: entry.toolName, schemaRevision: entry.schemaRevision,
        arguments: { content: "文".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3) },
      };
      const fits = bytes <= 64_000;
      await expect(service.call(args, antigravity)).rejects.toThrow(fits ? "Connection closed after dispatch" : "size limit");
      expect(approve).toHaveBeenCalledTimes(fits ? 1 : 0);
      expect(invoke).toHaveBeenCalledTimes(fits ? 1 : 0);
    },
  ), { numRuns: 25 });
});
