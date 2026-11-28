import { execFile } from "node:child_process";
import { once } from "node:events";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AcpStdioJsonRpcTransport } from "../acp/acp-stdio-transport";
import { MANAGED_ANTIGRAVITY_ENV } from "../acp/antigravity-runtime-retention";
import type { BackendRegistryMcpConnectionService } from "../app-server/backend-registry-types";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { resolveBundledClaudeExecutable } from "../claude/claude-bundled-executable";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import * as desktopSettings from "../settings/desktop-settings-singleton";
import { openInMemoryStateDb } from "./sqlite-test-utils";

vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
  const { stubbedCodexDiscovery } = await import("./helpers/codex-discovery-stub");
  return stubbedCodexDiscovery(await importOriginal());
});

const instructions = "Keep state changes in one transaction. Use the existing checkout test helpers.";
const initialPrompt = "Inspect the sample checkout tests and explain which wait condition is wrong.";
const nextPrompt = "Summarize the proposed fix for the checkout test in one sentence.";
const answer = "Wait for the hydrated rows.";
const replyUsage = { input_tokens: 200, output_tokens: 8 };
const codexModel = "gpt-5.5";
const kimi = "codex:kimi-k3";
const kimiModel = "moonshotai/kimi-k3";
const kimiProvider = "fixture-kimi";
const kimiRoute = "/kimi/v1";
const helperTitle = "Inspect checkout wait condition";
const isTitleHelperRequest = (body: RequestBody) => JSON.stringify(body).includes("# Thread title guidelines");

type CodexToolCall =
  | { type: "tool_search_call"; execution: "client"; call_id: string; arguments: { query: string; limit: number } }
  | { type: "function_call"; name: string; namespace?: string; call_id: string; arguments: string };
type ClaudeToolCall = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function codexResponse(index: number, text: string, call?: CodexToolCall) {
  const item = call ? { id: `fc_fixture_${index}`, status: "completed", ...call } : {
    id: `msg_fixture_${index}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: `resp_fixture_${index}`, object: "response", status: "completed", output: [item],
    usage: { ...replyUsage, total_tokens: 208 },
  };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: call ? { ...item, status: "in_progress" } : { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function claudeResponse(index: number, model: string | undefined, call?: ClaudeToolCall) {
  if (!model) throw new Error("Missing model in Claude fixture request");
  return [
    { type: "message_start", message: {
      id: `msg_fixture_${index}`, type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 200, output_tokens: 0 },
    } },
    { type: "content_block_start", index: 0, content_block: call ? { ...call, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: answer } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const antigravity = "acp:antigravity";
// Keep the expected route explicit so a fallback to eager schemas cannot pass a gateway budget.
const antigravityUsesGateway = false;
const providers = ["codex", "claude", antigravity] as const;
type Provider = typeof providers[number];
const catalogCases = [...providers, kimi] as const;
type BenchmarkCase = typeof catalogCases[number];
type GeminiCall = { id: string; name: string; args: Record<string, unknown> };
type GeminiResult = { id: string; name: string; response: { output?: string; error?: string } };
type RequestBody = {
  model?: string;
  input?: unknown[];
  messages?: unknown[];
  system?: unknown;
  instructions?: unknown;
  tools?: unknown[];
  contents?: Array<{ role?: string; parts?: Array<{
    functionCall?: GeminiCall;
    functionResponse?: GeminiResult;
  }> }>;
  systemInstruction?: unknown;
};
type Sample = { bytes: number; route: string; body: RequestBody };
type TurnMetrics = { bytes: number; calls: number; primaryBytes: number; inputBytes: number; instructionBytes: number; toolBytes: number };
type Metrics = { [K in keyof TurnMetrics as `first${Capitalize<K>}` | `next${Capitalize<K>}`]: number };

const searchId = "fixture_search";
const antigravitySearch = "mcp_pwragent_search_mcp_tools";

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function isToolInventory(item: unknown): item is { tools?: unknown[] } {
  return Boolean(item && typeof item === "object" && "type" in item
    && (item.type === "additional_tools" || item.type === "tool_search_output"));
}

function toolDefinitionBytes(body: RequestBody): number {
  const input = body.input ?? [];
  const inventories = input.filter(isToolInventory).flatMap(({ tools }) => tools ?? []);
  let bytes = jsonBytes([...(body.tools ?? []), ...inventories]);
  // These two scripted searches deliver schemas as encoded tool output.
  // Charge each copy on the wire, excluding the lookup result itself.
  for (const item of input) {
    if (item && typeof item === "object" && "type" in item && item.type === "function_call_output"
      && "call_id" in item && item.call_id === searchId && "output" in item && item.output !== undefined) {
      bytes += jsonBytes(item.output);
    }
  }
  for (const { parts } of body.contents ?? []) {
    for (const { functionResponse } of parts ?? []) {
      if (functionResponse?.name === antigravitySearch && functionResponse.response.output !== undefined) {
        bytes += jsonBytes(functionResponse.response.output);
      }
    }
  }
  return bytes;
}

it("charges every encoded schema-bearing discovery payload to tool definition bytes", () => {
  const installed = [{ type: "function", name: "exec" }];
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 32 }), fc.integer({ min: 1, max: 4 }), (description, copies) => {
    const codexDiscovery = [{ type: "input_text", text: JSON.stringify({ tools: [{ description }] }) }];
    const geminiDiscovery = JSON.stringify({ tools: [{ definition: { description } }] });
    const codex = {
      tools: installed,
      input: [
        ...Array.from({ length: copies }, () => ({ type: "function_call_output", call_id: "fixture_search", output: codexDiscovery })),
        { type: "function_call_output", call_id: "fixture_lookup", output: "tool result" },
      ],
    };
    const gemini = {
      tools: installed,
      contents: [{ parts: [
        ...Array.from({ length: copies }, () => ({
          functionResponse: { id: "search", name: "mcp_pwragent_search_mcp_tools", response: { output: geminiDiscovery } },
        })),
        { functionResponse: { id: "lookup", name: "mcp_pwragent_call_mcp_tool", response: { output: "tool result" } } },
      ] }],
    };
    expect(toolDefinitionBytes(codex) - jsonBytes(installed)).toBe(copies * jsonBytes(codexDiscovery));
    expect(toolDefinitionBytes(gemini) - jsonBytes(installed)).toBe(copies * jsonBytes(geminiDiscovery));
  }), { numRuns: 5, examples: [['A \"quote\" and é', 2]] });
});

function turnMetrics(samples: Sample[], prompt: string, agentInstructions?: string): TurnMetrics {
  const primary = samples.filter(({ body }) => !isTitleHelperRequest(body)
    && JSON.stringify(body).includes(prompt)
    && (agentInstructions === undefined || JSON.stringify(body).includes(agentInstructions)))
    .reduce<Sample | undefined>((largest, sample) =>
      !largest || sample.bytes >= largest.bytes ? sample : largest, undefined);
  expect(primary, "primary model request carries the configured prompt and instructions").toBeDefined();
  const { body, bytes } = primary!;
  // A benchmark started from the contributor checkout must still use only
  // its temporary project, even if the harness also inspects its launch cwd.
  for (const { body: request } of samples) {
    const hasCheckoutRules = /# PwrAgent Repository Guidance|# Desktop App Guidance/.test(JSON.stringify(request));
    expect.soft(hasCheckoutRules, "benchmark includes instructions from the contributor checkout").toBe(false);
  }
  const input = body.input ?? body.messages ?? body.contents ?? [];
  const messageRole = (item: unknown): unknown =>
    item && typeof item === "object" && "role" in item ? item.role : undefined;
  const isInstruction = (item: unknown): boolean => ["developer", "system"].includes(String(messageRole(item)));
  const instructionBlocks = [body.instructions, body.system, body.systemInstruction, ...input.filter(isInstruction)]
    .filter((value) => value !== undefined);
  expect.soft(JSON.stringify(input).split(prompt)).toHaveLength(2);
  if (agentInstructions !== undefined) expect.soft(JSON.stringify(body).split(agentInstructions)).toHaveLength(2);
  return {
    bytes: samples.reduce((total, sample) => total + sample.bytes, 0),
    calls: samples.length,
    primaryBytes: bytes,
    inputBytes: jsonBytes(input.filter((item) => !isInstruction(item) && !isToolInventory(item))),
    instructionBytes: jsonBytes(instructionBlocks),
    toolBytes: toolDefinitionBytes(body),
  };
}

type GeminiPart = { text: string } | { functionCall: { name: string; args: Record<string, unknown> } };

function antigravityResponse(part: GeminiPart) {
  return `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 8, totalTokenCount: 208 },
  })}\n\n`;
}

type ModelReply = { codex?: CodexToolCall; claude?: ClaudeToolCall; gemini?: GeminiPart };

async function startModelEndpoint(provider: BenchmarkCase) {
  const requests: Sample[] = [];
  const paths: string[] = [];
  const scriptedRequests: Sample[] = [];
  let modelReply: ((body: RequestBody) => ModelReply | undefined) | undefined;
  let scriptError: unknown;
  const responsesApi = provider === "codex" || provider === kimi;
  const server = createServer(async (request, response) => {
    const route = request.url?.split("?")[0] ?? "";
    paths.push(route);
    const isModelRequest = responsesApi ? route === "/v1/responses" || (provider === kimi && route === kimiRoute + "/responses")
      : provider === "claude" ? route === "/v1/messages"
        : /^\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(route);
    if (request.method !== "POST" || !isModelRequest) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
      const sample = { bytes, route, body };
      requests.push(sample);
      const title = isTitleHelperRequest(body);
      const text = title ? JSON.stringify({ title: helperTitle }) : answer;
      let scripted: ModelReply | undefined;
      if (!title && modelReply) {
        try {
          scripted = modelReply(body);
          if (scripted) scriptedRequests.push(sample);
        } catch (error) {
          scriptError ??= error;
        }
      }
      const reply = responsesApi ? codexResponse(requests.length, text, scripted?.codex)
        : provider === "claude" ? claudeResponse(requests.length, body.model, scripted?.claude)
          : antigravityResponse(scripted?.gemini ?? { text });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(reply);
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fake model endpoint address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests, paths, scriptedRequests,
    setReply(reply: typeof modelReply) { modelReply = reply; },
    assertScript() { if (scriptError) throw scriptError; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

type Comparison = { cwd: string; mode: "desktop" | "cli" };
type Capture = { metrics: TurnMetrics; requests: Sample[]; toolRequests?: Sample[] };
type BenchmarkOptions = { projectInstructionsCwd?: string; comparison?: Comparison; largeMcpCatalog?: "measure" | "exercise" };

const selectedTool = "fixture_reviews_lookup_79";
const toolPrompt = "Find the selected review lookup tool and use it.";
const approvedArguments = { field_0: "approved" };
const resultText = "Fixture lookup completed. field_0=approved";
const catalogMarker = "full-model-request-mcp-catalog-fixture";
const toolsPerConnection = 80;
const mcpServerPath = fileURLToPath(new URL("./fixtures/model-request-mcp-server.cjs", import.meta.url));

async function createLargeMcpCatalog(home: string) {
  const catalogs = await Promise.all(["inventory", "reviews", "support"].map(async (id) => {
    const tools = Array.from({ length: toolsPerConnection }, (_, index) => ({
      name: `fixture_${id}_lookup_${index}`,
      description: `Look up synthetic ${id} records of type ${index}.`,
      inputSchema: {
        type: "object" as const,
        properties: Object.fromEntries(Array.from({ length: 16 }, (_, field) => [`field_${field}`, {
          type: "string", description: `${catalogMarker}: field ${field} for ${id} lookup ${index}`,
        }])),
        additionalProperties: false,
      },
    }));
    const catalogPath = path.join(home, `${id}.json`);
    const listingLog = path.join(home, `${id}.listed`);
    await writeFile(catalogPath, JSON.stringify(tools));
    return { id, tools, listingLog, server: { name: id, command: process.execPath, args: [mcpServerPath, catalogPath, listingLog], env: {} } };
  }));

  const catalogFor = (id: string) => {
    const catalog = catalogs.find((candidate) => candidate.id === id);
    if (!catalog) throw new Error(`Unexpected benchmark MCP connection ${id}`);
    return catalog;
  };
  const service: BackendRegistryMcpConnectionService = {
    listConnections: async () => catalogs.map(({ id }) => ({
      id, displayName: id, serverUrl: `https://${id}.example.test/mcp`, kind: "remote",
      authMode: "oauth", enabled: true, configured: true, state: "ready", selectForNewThreads: false,
      createdAt: 0, updatedAt: 0,
    })),
    registerBridge: async (id) => ({
      server: catalogFor(id).server, bindThread: () => {}, revoke: () => {},
    }),
    requestGatewayToolOperation: async ({ connectionId, operation, invocation, signal }) => {
      const client = new Client({ name: "benchmark-gateway", version: "1" });
      try {
        await client.connect(new StdioClientTransport(catalogFor(connectionId).server));
        if (operation === "gateway/tools/call" && invocation) {
          return await client.callTool({ name: invocation.toolName, arguments: invocation.arguments }, undefined, { signal });
        }
        if (operation !== "gateway/tools/list") throw new Error(`Unexpected benchmark MCP operation ${operation}`);
        const { tools } = await client.listTools({}, { signal });
        return tools.map((definition) => ({
          connectionId, serverName: connectionId, toolName: definition.name, schemaRevision: "fixture", definition,
        }));
      } finally {
        await client.close();
      }
    },
  };
  return { catalogs, connectionIds: catalogs.map(({ id }) => id), service };
}

async function expectFixtureCall(mcp: Awaited<ReturnType<typeof createLargeMcpCatalog>>, tool = selectedTool) {
  for (const { id, listingLog } of mcp.catalogs) {
    const calls = await readFile(listingLog + ".calls", "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    expect(calls.split("\n").filter(Boolean).map((line) => JSON.parse(line)), `calls received by ${id}`)
      .toEqual(id === "reviews" ? [{ name: tool, arguments: approvedArguments }] : []);
  }
}

// The fake model reads its invocation identity from the search reply on the wire.
// The invalid, declined and approved calls all run inside one ACP session/prompt.
async function exerciseAntigravityGatewayTools(
  registry: ReturnType<typeof createDesktopBackendRegistry>,
  threadId: string,
  endpoint: Awaited<ReturnType<typeof startModelEndpoint>>,
  mcp: Awaited<ReturnType<typeof createLargeMcpCatalog>>,
  runTurn: () => Promise<Capture>,
) {
  const search = antigravitySearch;
  const call = "mcp_pwragent_call_mcp_tool";
  const query = selectedTool;
  const approvals: unknown[] = [];
  const stop = registry.onEvent(async ({ backend, notification }) => {
    if (backend !== antigravity || notification.method !== "mcpServer/elicitation/request"
      || notification.params.threadId !== threadId) return;
    const { requestId, turnId } = notification.params;
    approvals.push(notification.params);
    await registry.submitServerRequest({
      backend, threadId, turnId: String(turnId), requestId: String(requestId),
      response: { action: approvals.length === 1 ? "decline" : "accept", content: null, _meta: null },
    });
  });
  let responses: GeminiResult[] = [];
  let found: { toolName: string; connectionId: string; schemaRevision: string; definition: unknown } | undefined;
  const values = [7, "denied", "approved"];
  endpoint.setReply((body) => {
    // Native and PwrAgent title requests can run alongside the conversation.
    if (!JSON.stringify(body.tools ?? []).includes(`"name":"${search}"`)) return undefined;
    responses = (body.contents ?? []).flatMap(({ parts }) => (parts ?? []).flatMap(({ functionResponse }) => functionResponse ?? []));
    if (!responses.length) {
      expect(JSON.stringify(body)).not.toContain(catalogMarker);
      return { gemini: { functionCall: { name: search, args: {
        query, limit: 1, toolSummary: "Find the review lookup tool",
      } } } };
    }
    if (responses.length === 1) {
      const listing = responses[0]?.response.output?.split("\n").find((line) => line.startsWith('{"tools":'));
      found = listing ? JSON.parse(listing).tools[0] : undefined;
    }
    if (!found || responses.length > values.length) return {};
    const { connectionId, toolName, schemaRevision } = found;
    return { gemini: { functionCall: { name: call, args: {
      connectionId, toolName, schemaRevision, arguments: { field_0: values[responses.length - 1] }, toolSummary: "Look up the review",
    } } } };
  });
  try {
    const capture = await runTurn();
    endpoint.assertScript();
    expect(found).toMatchObject({
      connectionId: "reviews", toolName: query,
      definition: mcp.catalogs.find(({ id }) => id === "reviews")!.tools.find(({ name }) => name === query),
    });
    expect(responses).toMatchObject([
      { name: search },
      { name: call, response: { error: expect.stringContaining("data/field_0 must be string") } },
      { name: call, response: { error: expect.stringContaining("was not approved") } },
      { name: call, response: { output: expect.stringContaining(resultText) } },
    ]);
    expect(approvals).toMatchObject(["denied", "approved"].map((value) => ({
      threadId, serverName: "reviews", _meta: { tool_params_display: [{ name: "field_0", value }] },
    })));
    const conversation = endpoint.scriptedRequests.at(-1)!.body;
    const calls = (conversation.contents ?? []).flatMap(({ parts }) => (parts ?? [])
      .flatMap(({ functionCall }) => functionCall ?? []));
    expect(new Set(calls.map(({ id }) => id)).size).toBe(4);
    expect(responses.map(({ id }) => id)).toEqual(calls.map(({ id }) => id));
    expect(calls.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: search, args: { query, limit: 1, toolSummary: "Find the review lookup tool" } },
      ...values.map((value) => ({ name: call, args: {
        connectionId: "reviews", toolName: selectedTool, schemaRevision: found!.schemaRevision,
        arguments: { field_0: value }, toolSummary: "Look up the review",
      } })),
    ]);
    await expectFixtureCall(mcp);
    return { ...capture, toolRequests: endpoint.scriptedRequests };
  } finally { stop(); }
}

// Native stdio exposes a bounded subset of declarations. Use a fixture in that subset.
async function exerciseAntigravityNativeTools(
  registry: ReturnType<typeof createDesktopBackendRegistry>,
  threadId: string,
  endpoint: Awaited<ReturnType<typeof startModelEndpoint>>,
  mcp: Awaited<ReturnType<typeof createLargeMcpCatalog>>,
  runTurn: () => Promise<Capture>,
) {
  const tool = "fixture_reviews_lookup_0";
  const name = `mcp_reviews_${tool}`;
  const args = { ...approvedArguments, toolSummary: "Look up the review" };
  const approvals: unknown[] = [];
  const stop = registry.onEvent(async ({ backend, notification }) => {
    if (backend !== antigravity || notification.method !== "item/commandExecution/requestApproval"
      || notification.params.threadId !== threadId) return;
    const params = notification.params;
    expect(params).toMatchObject({
      acpMcpToolName: `reviews / ${tool}`,
      acpMcpToolDetail: JSON.stringify(approvedArguments, null, 2),
      acpMethod: "session/request_permission",
    });
    approvals.push(params);
    await registry.submitServerRequest({
      backend, threadId, turnId: String(params.turnId), requestId: String(params.requestId),
      response: { decision: "accept" },
    });
  });
  let step = 0;
  endpoint.setReply((body) => {
    if (!JSON.stringify(body).includes(toolPrompt) || !body.tools?.length) return undefined;
    const parts = (body.contents ?? []).flatMap((content) => content.parts ?? []);
    if (step++ === 0) {
      const definitions = (body.tools ?? []).flatMap((group) => array(object(group).functionDeclarations ?? []));
      expect(definitions).toContainEqual(expect.objectContaining({
        name,
        parametersJsonSchema: expect.objectContaining({
          properties: expect.objectContaining({ field_0: expect.objectContaining({ type: "string" }) }),
        }),
      }));
      return { gemini: { functionCall: { name, args } } };
    }
    expect(step).toBe(2);
    const calls = parts.flatMap(({ functionCall }) => functionCall ?? []);
    expect(calls).toEqual([expect.objectContaining({ id: expect.any(String), name, args })]);
    const results = parts.flatMap(({ functionResponse }) => functionResponse ?? []);
    expect(results).toEqual([expect.objectContaining({ id: calls[0]!.id, name })]);
    expect(JSON.stringify(results[0]!.response)).toContain(resultText);
    return {};
  });
  try {
    const capture = await runTurn();
    endpoint.assertScript();
    expect(step).toBe(2);
    expect(approvals).toHaveLength(1);
    await expectFixtureCall(mcp, tool);
    return { ...capture, toolRequests: endpoint.scriptedRequests };
  } finally { stop(); }
}

const callId = "fixture_lookup";
type WireObject = Record<string, unknown>;
function object(value: unknown): WireObject {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as WireObject;
}
function array(value: unknown): WireObject[] {
  expect(Array.isArray(value)).toBe(true);
  return value as WireObject[];
}

function advertisedToolName(body: RequestBody): string {
  const named = JSON.stringify(body).match(new RegExp(`mcp__[A-Za-z0-9_-]+__${selectedTool}\\b`, "u"))?.[0];
  expect(named, "Claude advertises the selected fixture by name before loading its schema").toBeDefined();
  return named!;
}

function nativeCodexReply(body: RequestBody, step: number): ModelReply {
  const input = array(body.input);
  const search = { type: "tool_search_call", execution: "client", call_id: searchId, arguments: { query: selectedTool, limit: 1 } } as const;
  if (step === 0) {
    expect(body.tools).toContainEqual(expect.objectContaining({ type: "tool_search", execution: "client" }));
    expect(JSON.stringify(body)).not.toContain(catalogMarker);
    return { codex: search };
  }
  expect(input).toContainEqual(expect.objectContaining(search));
  const output = input.find(({ type, call_id }) => type === "tool_search_output" && call_id === searchId);
  expect(output).toMatchObject({ execution: "client", tools: [expect.any(Object)] });
  const [namespace] = array(output?.tools);
  expect(namespace).toMatchObject({ type: "namespace", name: expect.stringMatching(/^mcp__pwragent_reviews_/) });
  expect(namespace?.tools).toContainEqual(expect.objectContaining({
    type: "function", name: selectedTool,
    parameters: expect.objectContaining({ properties: expect.objectContaining({ field_0: expect.objectContaining({ type: "string" }) }) }),
  }));
  const call = { type: "function_call", name: selectedTool, namespace: String(namespace?.name),
    call_id: callId, arguments: JSON.stringify(approvedArguments) } as const;
  if (step === 1) return { codex: call };
  expect(input).toContainEqual(expect.objectContaining(call));
  expect(input).toContainEqual(expect.objectContaining({
    type: "function_call_output", call_id: callId,
    output: expect.anything(),
  }));
  expect(JSON.stringify(input.find(({ call_id, type }) => call_id === callId && type === "function_call_output")))
    .toContain(resultText);
  return {};
}

function claudeMcpReply(body: RequestBody, step: number, name: string): ModelReply {
  const query = { query: `select:${name}` };
  const search = { type: "tool_use", id: searchId, name: "ToolSearch", input: query } as const;
  const call = { type: "tool_use", id: callId, name, input: approvedArguments } as const;
  if (step === 0) {
    expect(body.tools).toContainEqual(expect.objectContaining({ name: "ToolSearch" }));
    expect(JSON.stringify(body)).not.toContain(catalogMarker);
    return { claude: search };
  }
  const blocks = array(body.messages).flatMap(({ content }) => Array.isArray(content) ? array(content) : []);
  expect(blocks).toContainEqual(expect.objectContaining(search));
  expect(blocks).toContainEqual(expect.objectContaining({
    type: "tool_result", tool_use_id: searchId, content: expect.arrayContaining([{ type: "tool_reference", tool_name: name }]),
  }));
  if (step === 1) {
    expect(body.tools).toContainEqual(expect.objectContaining({
      name, input_schema: expect.objectContaining({
        properties: expect.objectContaining({ field_0: expect.objectContaining({ type: "string" }) }),
      }),
    }));
    return { claude: call };
  }
  expect(blocks).toContainEqual(expect.objectContaining(call));
  expect(JSON.stringify(blocks.find(({ type, tool_use_id }) => type === "tool_result" && tool_use_id === callId)))
    .toContain(resultText);
  return {};
}

function kimiExecTool(body: RequestBody): string {
  const tools = array(body.tools);
  const expectedParameters = [
    ["code"], ["cell_id", "max_tokens", "terminate", "yield_time_ms"], ["questions"],
  ];
  expect(tools.map((tool) => Object.keys(object(object(tool.parameters).properties)).sort())).toEqual(expectedParameters);
  for (const tool of tools) {
    expect(tool).toMatchObject({ type: "function", name: expect.stringMatching(/^codex_[0-9a-f]{48}$/) });
    expect(tool).not.toHaveProperty("defer_loading");
  }
  expect(tools[0]?.parameters).toEqual({
    type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false,
  });
  return String(tools[0]!.name);
}

function kimiMcpReply(body: RequestBody, step: number): ModelReply {
  const name = kimiExecTool(body);
  const input = array(body.input);
  const searchCode = `text(await tools.tool_search({query: "${selectedTool}", limit: 1}));`;
  const exec = (call_id: string, code: string) =>
    ({ type: "function_call", name, call_id, arguments: JSON.stringify({ code }) }) as const;
  if (step === 0) {
    expect(JSON.stringify(body)).not.toContain(catalogMarker);
    return { codex: exec(searchId, searchCode) };
  }
  expect(input).toContainEqual(expect.objectContaining(exec(searchId, searchCode)));
  const discovery = input.find(({ call_id, type }) => call_id === searchId && type === "function_call_output");
  const toolName = JSON.stringify(discovery).match(new RegExp(`mcp__[A-Za-z0-9_]+__${selectedTool}\\b`, "u"))?.[0];
  expect(toolName).toMatch(/^mcp__pwragent_reviews_/u);
  expect(JSON.stringify(discovery)).toContain("field_0?: string");
  const callCode = `text(await tools[${JSON.stringify(toolName)}](${JSON.stringify(approvedArguments)}));`;
  if (step === 1) return { codex: exec(callId, callCode) };
  expect(input).toContainEqual(expect.objectContaining(exec(callId, callCode)));
  const result = input.find(({ call_id, type }) => call_id === callId && type === "function_call_output");
  expect(JSON.stringify(result)).toContain(resultText);
  return {};
}

async function exerciseCodexAndClaudeTools(
  scenario: Exclude<BenchmarkCase, typeof antigravity>,
  registry: ReturnType<typeof createDesktopBackendRegistry>,
  threadId: string,
  endpoint: Awaited<ReturnType<typeof startModelEndpoint>>,
  mcp: Awaited<ReturnType<typeof createLargeMcpCatalog>>,
  runTurn: () => Promise<Capture>,
) {
  const provider = scenario === kimi ? "codex" : scenario;
  const approvals: unknown[] = [];
  const stop = registry.onEvent(async ({ backend, notification }) => {
    if (backend !== provider || !("threadId" in notification.params) || notification.params.threadId !== threadId) return;
    if (notification.method !== "mcpServer/elicitation/request"
      && notification.method !== "item/commandExecution/requestApproval") return;
    const { params } = notification;
    if (notification.method === "mcpServer/elicitation/request") {
      expect(params).toMatchObject({
        serverName: expect.stringMatching(/^pwragent_reviews_/u),
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: selectedTool, tool_params: approvedArguments },
      });
    } else {
      expect(params).toMatchObject({
        toolName: expect.stringMatching(new RegExp(`^mcp__pwragent_reviews_.+__${selectedTool}$`, "u")),
        arguments: approvedArguments,
      });
    }
    approvals.push(params);
    await registry.submitServerRequest({
      backend, threadId, turnId: String(params.turnId), requestId: String(params.requestId),
      response: notification.method === "mcpServer/elicitation/request"
        ? { action: "accept", content: null, _meta: null }
        : { decision: "accept" },
    });
  });
  let step = 0;
  let claudeName: string | undefined;
  endpoint.setReply((body) => {
    if (!JSON.stringify(body).includes(toolPrompt)) return undefined;
    expect(step).toBeLessThan(3);
    const index = step++;
    if (scenario === kimi) return kimiMcpReply(body, index);
    if (scenario === "codex") return nativeCodexReply(body, index);
    claudeName ??= advertisedToolName(body);
    return claudeMcpReply(body, index, claudeName);
  });
  try {
    const capture = await runTurn();
    endpoint.assertScript();
    expect(step, `${scenario} search, dispatch, and result requests`).toBe(3);
    expect(approvals).toHaveLength(1);
    await expectFixtureCall(mcp);
    return { ...capture, toolRequests: endpoint.scriptedRequests };
  } finally { stop(); }
}

async function captureModelRequests(
  scenario: BenchmarkCase,
  codexExecutable: string,
  antigravityExecutable: string,
  { comparison, largeMcpCatalog, projectInstructionsCwd }: BenchmarkOptions = {},
): Promise<Capture[]> {
  const provider = scenario === kimi ? "codex" : scenario;
  const home = await mkdtemp(path.join(os.tmpdir(), "pwragent-model-request-"));
  const cwd = projectInstructionsCwd ?? comparison?.cwd ?? home;
  const codexPolicy = comparison && provider === "codex"
    ? { approvalPolicy: "never", sandbox: "workspace-write" }
    : {};
  const endpoint = await startModelEndpoint(scenario);
  const db = openInMemoryStateDb();
  // Use empty credential/config directories and route HTTP clients only to loopback.
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "claude-home"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_STATE_HOME: path.join(home, "state"),
    NO_PROXY: "127.0.0.1", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ANTHROPIC_BASE_URL: endpoint.origin, DISABLE_NONESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    GEMINI_API_KEY: "fixture-key", GOOGLE_GEMINI_BASE_URL: endpoint.origin,
    ...MANAGED_ANTIGRAVITY_ENV,
  };
  let registry: ReturnType<typeof createDesktopBackendRegistry> | undefined;
  let settings: DesktopSettingsService | undefined;
  let restoreSettings: (() => void) | undefined;
  try {
    await writeFile(path.join(home, "config.toml"), [
      `model = "${codexModel}"`, 'model_provider = "fixture"', 'web_search = "disabled"',
      `approval_policy = "${codexPolicy.approvalPolicy ?? "never"}"`,
      `sandbox_mode = "${codexPolicy.sandbox ?? "read-only"}"`,
      "[features]", "apps = false", "plugins = false",
      "[model_providers.fixture]", 'name = "Synthetic model endpoint"', `base_url = "${endpoint.origin}/v1"`,
      'wire_api = "responses"', "requires_openai_auth = false",
    ].join("\n"));
    const claude = path.join(home, "claude");
    if (provider === "claude") {
      const bundled = await resolveBundledClaudeExecutable();
      if (!bundled) throw new Error("The benchmark requires the pinned Claude SDK binary");
      await copyFile(bundled, claude);
      await chmod(claude, 0o755);
    }
    if (provider === antigravity) {
      const settingsDirectory = path.join(home, ".gemini", "antigravity-cli");
      await mkdir(settingsDirectory, { recursive: true });
      await writeFile(path.join(settingsDirectory, "settings.json"), JSON.stringify({ modelProvider: "gemini", autoUpdate: false }));
    }
    if (comparison?.mode === "cli") {
      const cli = {
        codex: { executable: codexExecutable, args: ["exec", "--skip-git-repo-check", "--json", initialPrompt] },
        claude: { executable: claude, args: ["--print", "--output-format", "json", "--model", "sonnet", initialPrompt] },
        [antigravity]: { executable: antigravityExecutable, args: ["--output-format", "json", `--print=${initialPrompt}`] },
      }[provider];
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(cli.executable, cli.args, {
          cwd, env: { ...env, ANTHROPIC_API_KEY: "fixture-key" },
          timeout: 25_000, maxBuffer: 256 * 1024,
        }, (error, output) => error ? reject(error) : resolve(output));
        child.stdin?.end();
      });
      expect(stdout).toContain(answer);
      return [{ metrics: turnMetrics(endpoint.requests, initialPrompt), requests: endpoint.requests }];
    }

    const acpAgentStore = new AcpAgentStore(db);
    if (provider === antigravity) {
      acpAgentStore.upsertInstalledAgent({
        backendId: antigravity, registryId: "antigravity", name: "Antigravity",
        distributionKind: "local", distributionSource: "agy", installStatus: "installed", authStatus: "not-required",
        verificationStatus: "not-applicable", allowlistRuleId: "local-antigravity-cli", installedAt: 1, updatedAt: 1,
        launchDescriptor: {
          backendId: antigravity, registryId: "antigravity", distributionKind: "local",
          command: antigravityExecutable, args: ["acp", "--disable-telemetry", "--cloud_code_endpoint", endpoint.origin],
          cwd, env: {},
        },
      });
    }
    const codexClient = new CodexAppServerClient({
      command: codexExecutable, env, directoryResolver: async () => [],
      resolveCommand: async () => ({ command: codexExecutable, source: "config" }),
    });
    const mcp = largeMcpCatalog ? await createLargeMcpCatalog(home) : undefined;
    if (scenario === kimi) {
      const configPath = path.join(home, "pwragent.toml");
      await writeFile(configPath, [
        "[[models.codex.providers]]",
        `id = "${kimiProvider}"`, 'name = "Kimi fixture"', `base_url = "${endpoint.origin}${kimiRoute}"`,
        `models = ["${kimiModel}"]`, "discover_models = false", 'tool_discovery = "portable"',
        "[[models.codex.provider_model_metadata]]",
        `provider = "${kimiProvider}"`, `base_url = "${endpoint.origin}${kimiRoute}"`,
        `model = "${kimiModel}"`, "context_window = 262144", "supports_portable_discovery = true",
      ].join("\n"));
      settings = new DesktopSettingsService({
        env, codexHome: home, configPath, secretStore: new MemoryDesktopSecretStore(),
      });
      vi.spyOn(settings, "resolveCodexCommandPreference").mockReturnValue(codexExecutable);
      vi.spyOn(settings, "resolveCodexCommand").mockResolvedValue({ command: codexExecutable, source: "config" });
      vi.spyOn(settings, "resolveCodexSpawnEnv").mockReturnValue(env);
      vi.spyOn(settings, "resolveCodexSpawnEnvAsync").mockResolvedValue(env);
      const settingsSpy = vi.spyOn(desktopSettings, "getDesktopSettingsService").mockReturnValue(settings);
      restoreSettings = () => settingsSpy.mockRestore();
      expect(settings.resolveCodexModelProviders()).toEqual([expect.objectContaining({
        id: kimiProvider, models: [kimiModel], toolDiscovery: "portable",
        modelMetadata: [expect.objectContaining({ id: kimiModel, contextWindow: 262144 })],
      })]);
    }
    registry = createDesktopBackendRegistry({
      ...(scenario === kimi ? {} : { codexClient }), overlayStore: new SqliteOverlayStore(db), messagingStore: null,
      mcpConnectionService: mcp?.service ?? null,
      discoverLocalAcpAgents: async () => [],
      acpAgentStore, acpSessionStore: new AcpSessionStore(db),
      createAcpTransport: (agent) => {
        if (!agent.launchDescriptor) throw new Error("Missing benchmark ACP launch descriptor.");
        return new AcpStdioJsonRpcTransport({ launchDescriptor: agent.launchDescriptor, baseEnv: env });
      },
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(home, "claude-store")),
        inspectInstallation: async () => ({ executable: claude, authStatus: "signed-in" }),
        discoverModels: async () => [],
        resolveEnv: async () => env,
        // Production strips inherited API keys. Inject this dummy only at the
        // SDK boundary so the real CLI can authenticate to the local endpoint.
        query: (args) => query({ ...args, options: {
          ...args.options, env: { ...args.options?.env, ANTHROPIC_API_KEY: "fixture-key" },
        } }),
      },
    });
    const { threadId } = await registry.startThread({
      backend: provider, cwd, ...codexPolicy,
      ...(mcp ? { mcpConnectionIds: mcp.connectionIds } : {}),
      ...(provider === "codex" ? { model: scenario === kimi ? `@${kimiProvider}/${kimiModel}` : codexModel } : provider === "claude" ? { model: "sonnet" } : {}),
      ...(comparison ? {} : { agent: { name: "Checkout test fixture", instructions } }),
    });
    const terminal: Array<{ method: string; params: unknown }> = [];
    registry.onEvent(({ backend, notification }) => {
      if (backend === provider && (notification.method === "turn/completed" || notification.method === "turn/failed")
        && notification.params.threadId === threadId) {
        terminal.push(notification);
      }
    });
    async function measureTurn(index: number, text: string): Promise<Capture> {
      const start = endpoint.requests.length;
      await registry!.startTurn({ backend: provider, threadId, ...codexPolicy, input: [{ type: "text", text }] });
      await vi.waitFor(() => expect(terminal[index]).toBeDefined(), { timeout: 15_000 });
      expect(terminal[index]!.method, JSON.stringify({ terminal: terminal[index], paths: endpoint.paths })).toBe("turn/completed");
      await registry!.whenThreadTitleGenerationSettledForTests();
      const requests = endpoint.requests.slice(start);
      if (scenario === kimi) {
        const conversation = requests.filter(({ body }) => !isTitleHelperRequest(body));
        expect(conversation.length).toBeGreaterThan(0);
        for (const { route, body } of conversation) {
          expect(route).toBe(kimiRoute + "/responses");
          expect(body).toMatchObject({ model: kimiModel, stream: true });
          kimiExecTool(body);
          expect(JSON.stringify(body.input)).not.toContain('"type":"additional_tools"');
        }
      }
      return { metrics: turnMetrics(requests, text, comparison ? undefined : instructions), requests };
    }
    if (mcp && scenario === antigravity) {
      const report = await registry.describeThreadMcpConnections({ backend: provider, threadId });
      expect(Boolean(report.managedConnectionsViaGateway)).toBe(antigravityUsesGateway);
      expect(report.connections.map(({ connectionId }) => connectionId)).toEqual(mcp.connectionIds);
    }
    if (largeMcpCatalog === "exercise" && mcp) {
      const runTurn = () => measureTurn(0, toolPrompt);
      if (scenario === antigravity) {
        const exercise = antigravityUsesGateway ? exerciseAntigravityGatewayTools : exerciseAntigravityNativeTools;
        return [await exercise(registry, threadId, endpoint, mcp, runTurn)];
      }
      return [await exerciseCodexAndClaudeTools(scenario, registry, threadId, endpoint, mcp, runTurn)];
    }
    const first = await measureTurn(0, initialPrompt);
    if (projectInstructionsCwd) return [first];
    const next = await measureTurn(1, nextPrompt);
    // Antigravity also makes its native title request for the helper session.
    const expectedHelperCalls = provider === antigravity ? 2 : provider === "codex" ? 1 : 0;
    expect.soft(first.requests.filter(({ body }) => isTitleHelperRequest(body)).length,
      `${provider} first-turn PwrAgent title helper traffic`).toBe(expectedHelperCalls);
    expect.soft(next.requests.filter(({ body }) => isTitleHelperRequest(body)).length,
      `${provider} follow-up PwrAgent title helper traffic`).toBe(0);
    if (mcp) {
      if (provider === antigravity && antigravityUsesGateway) {
        for (const capture of [first, next]) {
          const primary = capture.requests.find(({ bytes }) => bytes === capture.metrics.primaryBytes)!;
          const definitions = JSON.stringify(primary.body.tools);
          for (const name of ["search_mcp_tools", "call_mcp_tool"]) {
            expect.soft(definitions).toContain(`"name":"mcp_pwragent_${name}"`);
          }
          expect.soft(definitions).not.toMatch(/fixture_(inventory|reviews|support)_lookup_/);
        }
      } else {
        for (const { id, listingLog } of mcp.catalogs) {
          const listings = await readFile(listingLog, "utf8").catch(() => "");
          expect(listings.trim().split("\n"), `${provider} lists the ${id} fixture over MCP`).toContain(String(toolsPerConnection));
        }
      }
    }
    return [first, next];
  } finally {
    try {
      await registry?.close();
    } finally {
      restoreSettings?.();
      await settings?.closeCommandDiscovery();
      db.close();
      await endpoint.close();
      // The SDK closes its stream before the CLI finishes its last cache writes.
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

// Byte ceilings leave headroom for native runtime and OS metadata. Call
// ceilings include native and PwrAgent title-generation traffic.
const ceilings: Record<Provider, Metrics> = {
  codex: {
    firstBytes: 84_000, firstCalls: 2, nextBytes: 59_000, nextCalls: 1,
    firstPrimaryBytes: 58_000, firstInputBytes: 2_600, firstInstructionBytes: 38_000, firstToolBytes: 16_500,
    nextPrimaryBytes: 59_000, nextInputBytes: 3_500, nextInstructionBytes: 38_000, nextToolBytes: 16_500,
  },
  claude: {
    firstBytes: 74_000, firstCalls: 1, nextBytes: 75_000, nextCalls: 1,
    firstPrimaryBytes: 74_000, firstInputBytes: 1_250, firstInstructionBytes: 28_000, firstToolBytes: 44_000,
    nextPrimaryBytes: 75_000, nextInputBytes: 1_600, nextInstructionBytes: 29_000, nextToolBytes: 44_000,
  },
  [antigravity]: {
    firstBytes: 106_000, firstCalls: 4, nextBytes: 57_000, nextCalls: 1,
    firstPrimaryBytes: 55_000, firstInputBytes: 1_650, firstInstructionBytes: 21_000, firstToolBytes: 32_000,
    nextPrimaryBytes: 56_000, nextInputBytes: 2_500, nextInstructionBytes: 21_000, nextToolBytes: 32_000,
  },
};

type CatalogMetrics = Pick<Metrics, "firstBytes" | "nextBytes" | "firstToolBytes" | "nextToolBytes" | "firstCalls" | "nextCalls">;
const mcpCeilings: Record<BenchmarkCase, CatalogMetrics> = {
  codex: { firstBytes: 81_000, nextBytes: 55_000, firstToolBytes: 16_000, nextToolBytes: 16_000, firstCalls: 2, nextCalls: 1 },
  claude: { firstBytes: 88_000, nextBytes: 90_000, firstToolBytes: 40_000, nextToolBytes: 40_000, firstCalls: 1, nextCalls: 1 },
  [antigravity]: antigravityUsesGateway
    ? { firstBytes: 106_000, nextBytes: 56_000, firstToolBytes: 33_000, nextToolBytes: 33_000, firstCalls: 4, nextCalls: 1 }
    : { firstBytes: 173_000, nextBytes: 124_000, firstToolBytes: 100_000, nextToolBytes: 100_000, firstCalls: 4, nextCalls: 1 },
  [kimi]: { firstBytes: 55_000, nextBytes: 39_000, firstToolBytes: 23_000, nextToolBytes: 23_000, firstCalls: 2, nextCalls: 1 },
};

type ToolUseMetrics = { bytes: number; primaryBytes: number; toolBytes: number; continuationBytes: number; calls: number; roundTripCalls: number };
const toolUseCeilings: Record<BenchmarkCase, ToolUseMetrics> = {
  codex: { bytes: 193_000, primaryBytes: 57_000, toolBytes: 18_500, continuationBytes: 115_000, calls: 4, roundTripCalls: 2 },
  claude: { bytes: 270_000, primaryBytes: 91_000, toolBytes: 40_000, continuationBytes: 181_000, calls: 3, roundTripCalls: 2 },
  [antigravity]: antigravityUsesGateway
    ? { bytes: 347_000, primaryBytes: 62_000, toolBytes: 35_500, continuationBytes: 239_000, calls: 8, roundTripCalls: 4 }
    : { bytes: 289_000, primaryBytes: 120_000, toolBytes: 100_000, continuationBytes: 120_000, calls: 5, roundTripCalls: 1 },
  [kimi]: { bytes: 136_000, primaryBytes: 42_000, toolBytes: 25_500, continuationBytes: 81_000, calls: 4, roundTripCalls: 2 },
};

function budget<T extends Record<string, number>>(description: string, observed: T, limits: T) {
  for (const key of Object.keys(limits) as Array<keyof T>) {
    expect.soft(observed[key], `${description} ${String(key)}`).toBeLessThanOrEqual(limits[key]);
  }
}

function hasFullMcpSchemas({ requests }: Capture): boolean {
  return requests.some(({ body }) => JSON.stringify(body).includes(catalogMarker));
}

const codexExecutable = process.env.PWRAGENT_MODEL_BENCH_CODEX;
const antigravityExecutable = process.env.PWRAGENT_MODEL_BENCH_AGY;
const artifactPath = process.env.PWRAGENT_MODEL_BENCH_RESULT;
const mcpArtifactPath = process.env.PWRAGENT_MODEL_BENCH_MCP_RESULT;
it.runIf(Boolean(artifactPath || (codexExecutable && antigravityExecutable)))(
  "keeps outbound model requests bounded on first turns and follow-ups",
  async () => {
    if (!codexExecutable || !antigravityExecutable) throw new Error("Set both pinned agent executable paths.");
    const results = [];
    for (const provider of providers) {
      const [firstCapture, nextCapture] = await captureModelRequests(provider, codexExecutable, antigravityExecutable);
      const first = firstCapture!.metrics;
      const next = nextCapture!.metrics;
      const observed = {
        firstBytes: first.bytes, firstCalls: first.calls, firstPrimaryBytes: first.primaryBytes,
        firstInputBytes: first.inputBytes, firstInstructionBytes: first.instructionBytes, firstToolBytes: first.toolBytes,
        nextBytes: next.bytes, nextCalls: next.calls, nextPrimaryBytes: next.primaryBytes,
        nextInputBytes: next.inputBytes, nextInstructionBytes: next.instructionBytes, nextToolBytes: next.toolBytes,
      };
      results.push({ provider, observed, ceilings: ceilings[provider] });
    }
    if (artifactPath) {
      const baseSha = process.env.PWRAGENT_MODEL_BENCH_BASE_SHA ?? null;
      await writeFile(artifactPath, JSON.stringify({ version: 2, baseSha, results }) + "\n");
    }
    for (const { provider, observed, ceilings: limits } of results) {
      for (const key of Object.keys(limits) as Array<keyof Metrics>) {
        expect.soft(observed[key], `${provider} ${key}`).toBeLessThanOrEqual(limits[key]);
      }
    }
  },
  80_000,
);

describe.runIf(Boolean(mcpArtifactPath || artifactPath || (codexExecutable && antigravityExecutable)))("240 configured MCP tools", () => {
  type CatalogRow = {
    provider: BenchmarkCase; first: TurnMetrics; next: TurnMetrics;
    ceilings: CatalogMetrics; fullSchemasAdvertised: boolean[];
  };
  const catalogs = new Map<BenchmarkCase, CatalogRow>();
  const toolUse = new Map<BenchmarkCase, { provider: BenchmarkCase; observed: ToolUseMetrics; ceilings: ToolUseMetrics }>();

  afterAll(async () => {
    const results = providers.flatMap((provider) => catalogs.get(provider) ?? []);
    if (mcpArtifactPath && (catalogs.size || toolUse.size)) {
      const baseSha = process.env.PWRAGENT_MODEL_BENCH_BASE_SHA ?? null;
      await writeFile(mcpArtifactPath, JSON.stringify({
        version: 4, baseSha, antigravityNative: !antigravityUsesGateway,
        results, thirdParty: catalogs.get(kimi) ?? null, toolUse: [...toolUse.values()],
      }) + "\n");
    }
  });

  it.each(catalogCases)("%s budgets the catalog on the first turn and follow-up", async (provider) => {
    if (!codexExecutable || !antigravityExecutable) throw new Error("Set both pinned agent executable paths.");
    const captures = await captureModelRequests(provider, codexExecutable, antigravityExecutable, { largeMcpCatalog: "measure" });
    const [first, next] = captures.map(({ metrics }) => metrics);
    const limits = mcpCeilings[provider];
    const fullSchemasAdvertised = captures.map(hasFullMcpSchemas);
    const observed = {
      firstBytes: first!.bytes, firstToolBytes: first!.toolBytes, firstCalls: first!.calls,
      nextBytes: next!.bytes, nextToolBytes: next!.toolBytes, nextCalls: next!.calls,
    };
    catalogs.set(provider, { provider, first: first!, next: next!, ceilings: limits, fullSchemasAdvertised });
    budget(`${provider} large MCP catalog`, observed, limits);
    for (const [index, advertised] of fullSchemasAdvertised.entries()) {
      const expected = provider === antigravity && !antigravityUsesGateway;
      expect.soft(advertised, `${provider} fixture schema exposure on turn ${index + 1}`).toBe(expected);
    }
  }, 30_000);

  it.each(catalogCases)("%s discovers, invokes, and returns a selected MCP result", async (provider) => {
    if (!codexExecutable || !antigravityExecutable) throw new Error("Set both pinned agent executable paths.");
    const [capture] = await captureModelRequests(provider, codexExecutable, antigravityExecutable, { largeMcpCatalog: "exercise" });
    const requests = capture!.toolRequests!;
    const continuations = requests.slice(1);
    const observed = {
      bytes: capture!.metrics.bytes,
      primaryBytes: Math.max(...requests.map(({ bytes }) => bytes)),
      toolBytes: Math.max(...requests.map(({ body }) => toolDefinitionBytes(body))),
      continuationBytes: continuations.reduce((total, { bytes }) => total + bytes, 0),
      calls: capture!.metrics.calls,
      roundTripCalls: continuations.length,
    };
    const limits = toolUseCeilings[provider];
    toolUse.set(provider, { provider, observed, ceilings: limits });
    expect(observed.roundTripCalls, `${provider} tool results reaching the model`).toBe(limits.roundTripCalls);
    budget(`${provider} scripted tool use`, observed, limits);
  }, 30_000);
});

const comparisonPath = process.env.PWRAGENT_MODEL_BENCH_COMPARISON;
it.runIf(Boolean(comparisonPath))("compares Desktop first turns and follow-ups with fresh CLI turns", async () => {
  if (!codexExecutable || !antigravityExecutable) throw new Error("Set both pinned agent executable paths.");
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-model-workspace-")));
  try {
    await writeFile(path.join(cwd, "checkout.test.ts"), "// Synthetic checkout test for the model request comparison.\n");
    const results = [];
    for (const provider of providers) {
      const [desktop, desktopFollowUp] = await captureModelRequests(provider, codexExecutable, antigravityExecutable, { comparison: { cwd, mode: "desktop" } });
      const [cli] = await captureModelRequests(provider, codexExecutable, antigravityExecutable, { comparison: { cwd, mode: "cli" } });
      const modelFor = (capture: Capture) => {
        const mainRequest = capture.requests.find(({ bytes }) => bytes === capture.metrics.primaryBytes)!;
        return mainRequest.body.model ?? mainRequest.route;
      };
      const model = modelFor(desktop!);
      expect(modelFor(desktopFollowUp!)).toBe(model);
      expect(modelFor(cli!)).toBe(model);
      results.push({ provider, model, desktop, desktopFollowUp, cli });
    }
    // This local opt-in contains synthetic request bodies. CI uploads only sizes.
    await writeFile(comparisonPath!, JSON.stringify({
      version: 1, prompt: initialPrompt, followUpPrompt: nextPrompt, results,
    }) + "\n", { mode: 0o600, flag: "wx" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

// The byte at the 32 KiB chain cutoff starts a new, uniquely numbered rule.
// Keep it non-whitespace so a harness-added newline cannot mimic another byte.
const projectRuleBytes = 256;
function projectInstructionFile(scope: "root" | "child") {
  const prose = "Keep this example record in its assigned project directory. ";
  return Array.from({ length: 80 }, (_, index) => {
    const label = `Fixture ${scope} rule ${String(index).padStart(3, "0")}. `;
    return (label + prose.repeat(5)).slice(0, projectRuleBytes - 2) + (index === 79 ? ".." : ".\n");
  }).join("");
}

// Read the text payloads of Responses, Messages, and Gemini in block order.
// Block metadata and tool declarations do not contribute instruction bytes.
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).join("");
  if (value && typeof value === "object") {
    if ("text" in value) return contentText(value.text);
    if ("content" in value) return contentText(value.content);
    if ("parts" in value) return contentText(value.parts);
  }
  return "";
}

function firstProjectRequest(requests: Sample[]) {
  const first = requests.find(({ body }) => {
    const messages = body.input ?? body.messages ?? body.contents ?? [];
    // Antigravity also sends the original prompt to its native title model.
    if (isTitleHelperRequest(body) || contentText(body.systemInstruction).startsWith("You are a conversation title generator.")) return false;
    return messages.some((message) =>
      message && typeof message === "object" && "role" in message && message.role === "user"
      && contentText(message).includes(initialPrompt));
  });
  expect(first, "first conversation request carrying the fixture prompt").toBeDefined();
  return first!.body;
}

function deliveredProjectRules(body: RequestBody, files: { root: string; child: string }) {
  const content = contentText([body.instructions, body.system, body.systemInstruction,
    body.input, body.messages, body.contents]);
  const delivered = { root: "", child: "" };
  for (const match of content.matchAll(/Fixture (root|child) rule (\d{3})\./g)) {
    const scope = match[1] as keyof typeof files;
    const offset = Number(match[2]) * projectRuleBytes;
    const rule = files[scope].slice(offset, offset + projectRuleBytes);
    expect(rule.startsWith(match[0]), `unexpected fixture label: ${match[0]}`).toBe(true);
    let length = match[0].length;
    while (length < rule.length && content[match.index + length] === rule[length]) length++;
    delivered[scope] += rule.slice(0, length);
  }
  return delivered;
}

it("measures the first conversation even when only a larger continuation carries the rules", () => {
  const messages = [{ role: "user", content: initialPrompt }];
  const first = { messages };
  const later = { messages, system: projectInstructionFile("root") };
  const bodies = [
    { messages, system: "# Thread title guidelines" },
    { messages, systemInstruction: { parts: [{ text: "You are a conversation title generator." }] } },
    first, later,
  ];
  const samples = bodies.map((body) => ({ body, route: "/v1/messages", bytes: jsonBytes(body) }));
  expect(firstProjectRequest(samples) === first).toBe(true);
});

it("counts project rules split across content blocks", () => {
  const root = projectInstructionFile("root");
  const half = root.length / 2;
  const body = { system: [{ text: root.slice(0, half) }, { text: "Other context." }, { text: root.slice(half) }] };
  const files = { root, child: projectInstructionFile("child") };
  expect(deliveredProjectRules(body, files).root === root).toBe(true);
  // A split inside a label is packaging too. A duplicate or a truncated
  // final rule, on the other hand, must remain visible in the measurement.
  const split = half + 5;
  const partial = root.slice(half, half + 100);
  const duplicate = { system: [{ text: root.slice(0, split) }, { text: root.slice(split) }, { text: partial }] };
  expect(deliveredProjectRules(duplicate, files).root === root + partial).toBe(true);
});

it.runIf(Boolean(artifactPath || (codexExecutable && antigravityExecutable)))(
  "measures nested project instructions in the first model request", async () => {
    if (!codexExecutable || !antigravityExecutable) throw new Error("Set both pinned agent executable paths.");
    const project = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-rule-fixture-")));
    const cwd = path.join(project, "child");
    const root = projectInstructionFile("root");
    const child = projectInstructionFile("child");
    expect(Buffer.byteLength(root)).toBe(20 * 1024);
    expect(Buffer.byteLength(child)).toBe(20 * 1024);
    const rows = [
      "### Nested project instructions on the first model request", "",
      "| Backend | Project files | Root bytes | Child bytes |", "| --- | --- | ---: | ---: |",
    ];
    try {
      await mkdir(cwd);
      await promisify(execFile)("git", ["init", "--quiet", project]);
      await writeFile(path.join(project, "AGENTS.md"), root);
      await writeFile(path.join(cwd, "AGENTS.md"), child);
      const cases = [
        ...catalogCases.map((provider) => ({ provider, claudeAliases: false })),
        { provider: "claude" as const, claudeAliases: true },
      ];
      for (const { provider, claudeAliases } of cases) {
        if (claudeAliases) {
          for (const dir of [project, cwd]) await symlink("AGENTS.md", path.join(dir, "CLAUDE.md"));
        }
        const [capture] = await captureModelRequests(provider, codexExecutable, antigravityExecutable, { projectInstructionsCwd: cwd });
        const first = firstProjectRequest(capture!.requests);
        const delivered = deliveredProjectRules(first, { root, child });
        const files = claudeAliases ? "AGENTS.md + CLAUDE.md symlinks" : "AGENTS.md";
        rows.push(`| ${provider} | ${files} | ${Buffer.byteLength(delivered.root)} | ${Buffer.byteLength(delivered.child)} |`);
        const childLimit = provider === "codex" || provider === kimi ? 12 * 1024 : 20 * 1024;
        // Compare content as well as size to catch missing, repeated or reordered rules.
        expect.soft(delivered.root === root, `${provider} ${files} root rules`).toBe(true);
        expect.soft(delivered.child === child.slice(0, childLimit), `${provider} ${files} child rules`).toBe(true);
      }
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, rows.join("\n") + "\n");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 90_000,
);
