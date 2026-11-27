import {
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAgentRecord,
  createOverlayStoreMock,
  mainLoggerMock,
  MockBackendClient,
  nextTurnEnd,
  nonRepositoryCwd,
} from "./helpers/backend-registry-fixture";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { attachSqliteWriteMetrics, isSqliteWriteMetricsEnabled, measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { expect, it, vi } from "vitest";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import type { AgentToolMcpRegistration } from "../agent-tools/agent-tool-mcp-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";

const threadId = "shared-provider-session-id";

function createAcpMcpFixture(tokenMiser = false, store?: SqliteOverlayStore) {
  const agentCapabilities = { loadSession: true, mcp: { http: true } };
  const providers = (["antigravity", "grok"] as const).map((name) => {
    const backend = `acp:${name}` as const;
    const transport = new FakeAcpAgentTransport({
      initialize: { protocolVersion: 1, agentCapabilities },
      "session/new": { sessionId: threadId },
    });
    const prompts: Array<PromiseWithResolvers<Record<string, unknown>>> = [];
    const request = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation((method, params) => {
      if (method !== "session/prompt") return request(method, params);
      const response = Promise.withResolvers<Record<string, unknown>>();
      prompts.push(response);
      return response.promise;
    });
    const agent = {
      ...createKimiAgentRecord(backend, {
        schemaVersion: 1, status: "discovered", agentCapabilities, checkedAt: 1000,
      }),
      registryId: name,
      name,
    };
    return { agent, backend, transport, prompts, mcp: new McpClient({ name, version: "1.0.0" }) };
  });
  const overlayStore = store ?? createOverlayStoreMock();
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({ threads: [] }),
    overlayStore,
    resolveTokenMiserEnabled: () => false,
    resolveTokenMiserBoundedCommands: () => tokenMiser,
    acpAgentStore: createAcpAgentStoreMock(providers.map(({ agent }) => agent)),
    acpSessionStore: createAcpSessionStoreMock([]),
    createAcpTransport: (agent) => providers.find(({ backend }) => backend === agent.backendId)!.transport,
    threadTitleGenerationService: null,
  });
  return {
    providers,
    registry,
    async connect({ backend, transport, mcp }: (typeof providers)[number]) {
      await registry.startThread({ backend, cwd: nonRepositoryCwd, executionMode: "default" });
      const sessionNew = transport.requests.find(({ method }) => method === "session/new");
      const servers = sessionNew?.params?.mcpServers as AgentToolMcpRegistration["server"][] | undefined;
      const server = servers?.find(({ name }) => name === "pwragent");
      if (!server) throw new Error("The ACP session did not receive the PwrAgent MCP server.");
      await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) },
      }));
    },
    async close() {
      for (const { prompts, mcp } of providers) {
        for (const prompt of prompts) prompt.resolve({ stopReason: "cancelled" });
        await mcp.close();
      }
      await registry.close();
    },
  };
}

function readSource(mcp: McpClient) {
  return mcp.callTool({ name: "get_current_turn_input_source", arguments: {} });
}

function expectInactive(result: Awaited<ReturnType<typeof readSource>>) {
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {
      code: "forbidden",
      message: "PwrAgent MCP tools are callable only during an active turn on the registered thread.",
    },
  });
}

it.skipIf(process.platform === "win32")("requires a fresh owner decision before issuing each native capture command", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "capture-approval-"));
  const db = StateDb.open(path.join(dir, "state.db"));
  const store = new SqliteOverlayStore(db);
  const fixture = createAcpMcpFixture(true, store);
  const { registry, providers: [provider] } = fixture;
  const target = { backend: provider.backend, threadId };
  try {
    await fixture.connect(provider);
    await store.setThreadTokenMiser({ ...target, enabled: true });
    const turn = await registry.startTurn({ ...target, input: [{ type: "text", text: "Inspect the diff." }] }, "desktop");
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    const decide = async (action: "decline" | "accept" | "cancel") => {
      const call = provider.mcp.callTool({ name: "call_pwragent_tool", arguments: {
        toolName: "capture_token_miser_command", arguments: { command: "git diff" },
      } });
      const request = await vi.waitFor(() => {
        const pending = registry.getPendingRequestForThread(target);
        expect(pending?.params.message).toContain("git diff");
        return pending!;
      });
      expect(request.params.turnId).toBe(turn.turnId);
      expect(request.method).toBe("mcpServer/elicitation/request");
      await registry.submitServerRequest({ ...turn, requestId: request.params.requestId, response: { action, content: null, _meta: null } });
      const result = await call;
      expect(JSON.stringify(result.content)).toContain(action === "accept" ? "objectId" : "declined");
      return result.structuredContent;
    };
    await decide("decline");
    const { result: prepared, writes } = await measureSqliteWrites(() => decide("accept"));
    expectSqliteWriteBudget({ scenario: "bounded-command-retention-approval", writes,
      note: "One owner-approved ACP command capture, from MCP preparation through receipt of the native command." });
    await decide("cancel");
    if (!prepared || typeof prepared !== "object" || !("command" in prepared) || typeof prepared.command !== "string"
      || !("objectId" in prepared) || typeof prepared.objectId !== "string") throw new Error("Missing command or capture ID.");
    const { command: native, objectId } = prepared;
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await writeFile(path.join(dir, "headers.css"), "thead { position: sticky }\n");
    execFileSync("git", ["add", "headers.css"], { cwd: dir });
    await writeFile(path.join(dir, "headers.css"), "thead { position: static }\n");
    const call = { toolCallId: "native", name: "run_command", kind: "execute", rawInput: { CommandLine: native } };
    provider.transport.emitSessionUpdate(threadId, { ...call, sessionUpdate: "tool_call", status: "in_progress" });
    const receipt = execFileSync("/bin/sh", ["-c", native], { cwd: dir, encoding: "utf8" });
    provider.transport.emitSessionUpdate(threadId, { ...call, sessionUpdate: "tool_call_update", status: "completed",
      content: [{ type: "content", content: { type: "text", text: receipt } }] });
    await vi.waitFor(async () => {
      const summary = await provider.mcp.callTool({ name: "call_pwragent_tool", arguments: {
        toolName: "capture_token_miser_command", arguments: { objectId },
      } });
      expect(JSON.stringify(summary.content)).toContain("+thead { position: static }");
    });
  } finally {
    await fixture.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("admits ACP MCP calls during their own prompt and rejects them after completion", async () => {
  const fixture = createAcpMcpFixture();
  const { registry, providers: [antigravity, grok] } = fixture;
  const resolutionWarnings = () => mainLoggerMock.warn.mock.calls.filter(([message]) => message === "MCP active turn resolution failed");
  const callRejections = () => mainLoggerMock.warn.mock.calls.filter(([message]) => message === "MCP tool rejected: no unique active turn");

  try {
    for (const provider of fixture.providers) {
      await fixture.connect(provider);
      expect((await provider.mcp.listTools()).tools).toContainEqual(expect.objectContaining({ name: "get_current_turn_input_source" }));
      expect(resolutionWarnings()).toEqual([]);
    }
    expect(callRejections()).toEqual([]);
    const idleWarningCount = resolutionWarnings().length;

    for (const [provider, source] of [[antigravity, "desktop"], [grok, "automation"]] as const) {
      const turn = await registry.startTurn({
        backend: provider.backend, threadId, input: [{ type: "text", text: "Check attribution." }],
      }, source);
      expect(provider.prompts).toHaveLength(1);
      expect(registry.getActiveTurnForThread({ backend: provider.backend, threadId })).toEqual(turn);
      expect(await readSource(provider.mcp)).toMatchObject({ structuredContent: { source } });
    }
    expect(await readSource(antigravity.mcp)).toMatchObject({ structuredContent: { source: "desktop" } });
    expect(resolutionWarnings()).toHaveLength(idleWarningCount);

    for (const provider of fixture.providers) {
      const ended = nextTurnEnd(registry);
      provider.transport.emitSessionUpdate(threadId, {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." },
      });
      provider.prompts[0].resolve({ stopReason: "end_turn" });
      expect(await ended).toBe("turn/completed");
      expectInactive(await readSource(provider.mcp));
      expect(resolutionWarnings()).toContainEqual([
        "MCP active turn resolution failed", expect.objectContaining({ backend: provider.backend, threadId, matchingTurnCount: 0 }),
      ]);
      expect(callRejections()).toContainEqual([
        "MCP tool rejected: no unique active turn", expect.objectContaining({ backend: provider.backend, threadId }),
      ]);
      if (provider === antigravity) {
        expect(await readSource(grok.mcp)).toMatchObject({ structuredContent: { source: "automation" } });
      }
    }
  } finally {
    await fixture.close();
  }
});

it.each(["acp:antigravity", "acp:grok"] as const)(
  "keeps the replacement %s prompt callable when the stopped prompt reports its terminal late",
  async (backend) => {
    const fixture = createAcpMcpFixture();
    const { registry } = fixture;
    const provider = fixture.providers.find((candidate) => candidate.backend === backend)!;
    const start = (source: "desktop" | "automation") => registry.startTurn({
      backend, threadId, input: [{ type: "text", text: "Check attribution." }],
    }, source);
    const usageEntered = Promise.withResolvers<void>();
    const releaseUsage = Promise.withResolvers<void>();
    const oldTerminal = Promise.withResolvers<void>();
    let unsubscribe: (() => void) | undefined;
    try {
      await fixture.connect(provider);
      const stopped = await start("desktop");
      await registry.interruptTurn(stopped);
      expectInactive(await readSource(provider.mcp));

      // The provider settles the old prompt, then PwrAgent publishes its usage
      // before delivering the prompt's terminal. Hold that delivery across the
      // next prompt's dispatch.
      unsubscribe = registry.onEvent(async (event) => {
        const { method, params } = event.notification;
        if (event.backend !== backend || !("turnId" in params) || params.turnId !== stopped.turnId) return;
        if (method === "thread/tokenUsage/updated") {
          usageEntered.resolve();
          await releaseUsage.promise;
        } else if (method === "turn/cancelled") {
          oldTerminal.resolve();
        }
      });
      const usage = { inputTokens: 100, outputTokens: 5, totalTokens: 105 };
      if (backend === "acp:grok") {
        provider.transport.emitSessionUpdate(threadId, { sessionUpdate: "turn_completed", usage });
      }
      provider.prompts[0].resolve({ stopReason: "cancelled", usage });
      await usageEntered.promise;

      const next = await start("automation");
      expect(provider.prompts).toHaveLength(2);
      expect(await readSource(provider.mcp)).toMatchObject({ structuredContent: { source: "automation" } });
      releaseUsage.resolve();
      await oldTerminal.promise;
      expect(await readSource(provider.mcp)).toMatchObject({ structuredContent: { source: "automation" } });
      expect(registry.getActiveTurnForThread({ backend, threadId })).toEqual(next);

      const ended = nextTurnEnd(registry);
      provider.prompts[1].resolve({ stopReason: "cancelled" });
      expect(await ended).toBe("turn/cancelled");
      expectInactive(await readSource(provider.mcp));
    } finally {
      releaseUsage.resolve();
      unsubscribe?.();
      await fixture.close();
    }
  },
);
