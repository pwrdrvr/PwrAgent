import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import { gatewayToolRevision, type McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";

const antigravity: AgentToolCallContext = { backend: "acp:antigravity", threadId: "thread", turnId: "turn", transport: "mcp" };

function fixture(schemaText: string, metadata?: Pick<McpGatewayTool, "serverIdentity" | "serverInstructions">) {
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
    connections: { requestGatewayToolOperation: async ({ operation }) => operation === "gateway/tools/list" ? [{ ...entry, ...metadata }] : await invoke() },
    approve,
  });
  return { service, entry, approve, invoke };
}

function resultTool(entry: McpGatewayTool) {
  return { ...entry, invocation: { name: "call_mcp_tool", codeModeName: "pwragent__call_mcp_tool" } };
}

function resultBytes(entry: McpGatewayTool): number {
  return Buffer.byteLength(JSON.stringify({ tools: [resultTool(entry)], unavailable: [] }));
}

function fixtureText(bytes: number): string {
  return "文".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
}

it("delivers only an explicitly requested exact schema within the Antigravity byte budget", async () => {
  const sizes = fc.integer({ min: 24_001, max: 72_000 });
  const overhead = resultBytes(fixture("").entry);
  await fc.assert(fc.asyncProperty(sizes, async (bytes) => {
    const { service, entry, approve } = fixture(fixtureText(bytes - overhead));
    const lookup = { connectionId: entry.connectionId, query: entry.toolName };
    const standard = await service.search(lookup, antigravity);
    expect(standard.tools).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(standard))).toBeLessThanOrEqual(24_000);

    const exact = await service.search({ ...lookup, includeLargeSchema: true }, antigravity);
    expect(exact.tools).toEqual(bytes <= 64_000 ? [resultTool(entry)] : []);
    expect(Buffer.byteLength(JSON.stringify(exact))).toBeLessThanOrEqual(64_000);
    expect(approve).not.toHaveBeenCalled();
  }), { numRuns: 25 });
});

it.each([64_000, 64_001])("enforces the exact-schema byte cap at a %i-byte result", async (bytes) => {
  const { service, entry } = fixture(fixtureText(bytes - resultBytes(fixture("").entry)));
  expect(resultBytes(entry)).toBe(bytes);
  const exact = await service.search({ connectionId: entry.connectionId, query: entry.toolName, includeLargeSchema: true }, antigravity);
  expect(exact.tools).toEqual(bytes === 64_000 ? [resultTool(entry)] : []);
  expect(Buffer.byteLength(JSON.stringify(exact))).toBeLessThanOrEqual(64_000);
});

it("delivers an exact schema before optional server metadata", async () => {
  const metadata = { serverIdentity: { metadata: { fixture: "x".repeat(3_000) } }, serverInstructions: "Source guidance." };
  const overhead = resultBytes(fixture("").entry);
  for (const bytes of [60_000, 62_000, 64_000]) {
    const { service, entry } = fixture(fixtureText(bytes - overhead), metadata);
    const exact = await service.search({ connectionId: entry.connectionId, query: entry.toolName, includeLargeSchema: true }, antigravity);
    expect(exact.tools).toEqual([resultTool(entry)]);
    expect(exact.servers?.[0]?.metadata).toEqual(bytes === 60_000 ? metadata.serverIdentity.metadata : undefined);
    expect(exact.serverInstructions?.[0]?.instructions).toBe(bytes === 64_000 ? undefined : metadata.serverInstructions);
    expect(Buffer.byteLength(JSON.stringify(exact))).toBeLessThanOrEqual(64_000);
  }
});

it("returns complete exact retry names within the ordinary response budget", async () => {
  const { entry } = fixture(fixtureText(27_000));
  const connectionId = "a".repeat(64);
  const failed = Array.from({ length: 59 }, (_, index) => `f${String(index).padStart(63, "0")}`);
  const tools = Array.from({ length: 5 }, (_, index) => {
    const toolName = `write_${index}${"\u0001".repeat(493)}`;
    return { ...entry, connectionId, toolName, definition: { ...entry.definition, name: toolName } };
  });
  const service = new McpGatewayToolService({
    selectedConnections: async () => [connectionId, ...failed],
    connections: { requestGatewayToolOperation: async ({ connectionId: id }) => {
      if (id !== connectionId) throw new Error("\u0001".repeat(180));
      return tools;
    } },
    approve: async () => false,
  });
  const standard = await service.search({ query: "write", limit: 5 }, antigravity);
  expect(standard.tools).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(standard))).toBeLessThanOrEqual(24_000);
  expect(standard.unavailable.slice(0, failed.length).map((item) => item.connectionId)).toEqual(failed);
  const retries = standard.unavailable.slice(failed.length);
  expect(retries.map((item) => item.toolName)).toEqual(tools.map((tool) => tool.toolName));
  for (const [index, { toolName }] of retries.entries()) {
    const exact = await service.search({ connectionId, query: toolName!, includeLargeSchema: true }, antigravity);
    expect(exact.tools).toEqual([resultTool(tools[index])]);
  }
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
      const args = {
        connectionId: entry.connectionId, toolName: entry.toolName, schemaRevision: entry.schemaRevision,
        arguments: { content: fixtureText(bytes - overhead) },
      };
      const fits = bytes <= 64_000;
      await expect(service.call(args, antigravity)).rejects.toThrow(fits ? "Connection closed after dispatch" : "size limit");
      expect(approve).toHaveBeenCalledTimes(fits ? 1 : 0);
      expect(invoke).toHaveBeenCalledTimes(fits ? 1 : 0);
    },
  ), { numRuns: 25 });
});
