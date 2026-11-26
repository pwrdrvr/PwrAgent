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
import { expect, it, vi } from "vitest";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import type { AgentToolMcpRegistration } from "../agent-tools/agent-tool-mcp-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";

const threadId = "shared-provider-session-id";

function createAcpMcpFixture() {
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
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({ threads: [] }),
    overlayStore: createOverlayStoreMock(),
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

it("admits ACP MCP calls during their own prompt and rejects them after completion", async () => {
  const fixture = createAcpMcpFixture();
  const { registry, providers: [antigravity, grok] } = fixture;
  const resolutionWarnings = () => mainLoggerMock.warn.mock.calls.filter(([message]) => message === "MCP active turn resolution failed");
  const callRejections = () => mainLoggerMock.warn.mock.calls.filter(([message]) => message === "MCP tool rejected: no unique active turn");

  try {
    for (const provider of fixture.providers) {
      await fixture.connect(provider);
      expect((await provider.mcp.listTools()).tools).toContainEqual(expect.objectContaining({ name: "get_current_turn_input_source" }));
      expect(resolutionWarnings()).toContainEqual([
        "MCP active turn resolution failed", expect.objectContaining({ backend: provider.backend, threadId, matchingTurnCount: 0 }),
      ]);
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
