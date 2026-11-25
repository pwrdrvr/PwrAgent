import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Query, SDKMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import { type FederationPeerRole } from "@pwragent/shared/contracts/federation";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { agentToolSuccess } from "../agent-tools/agent-tool-definition";
import { AgentToolMcpServer, type AgentToolHttpMcpServerConfig } from "../agent-tools/agent-tool-mcp-server";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import {
  agentToolAllowlistForRole,
  clearGatewayAssignedMemberRole,
  isAgentToolAdvertisedLocally,
  localAgentToolRefusal,
  localMemberRole,
  recordGatewayAssignedMemberRole,
} from "../member-containment";
import type { StateDb } from "../state/state-db";
import { AcpSessionStore } from "../storage/acp-session-store";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { createAcpPromptSettlement } from "./fixtures/acp-prompt-settlement";
import { createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Rule: when this member's containment changes while a session is open, the
// session's next turn lists exactly the agent tools of the new role, and
// until that turn a call outside the role's allowlist is refused. An ACP agent
// lists a session's MCP tools once, when session/new or session/load starts
// its servers, and Claude Code lists them when its process connects, so only
// a reload or a relaunch can change what the model is shown. (Codex replaces
// its dynamic tools before each turn on a runtime that supports it.)

// One tool the contained allowlist grants and one it does not.
const ALLOWED = "read_tool_guide";
const REFUSED = "list_todos";

function expectedTools(role: FederationPeerRole): string[] {
  const allowlist = agentToolAllowlistForRole(role);
  return [ALLOWED, REFUSED]
    .filter((tool) => !allowlist || allowlist.includes(`${PWRAGENT_TOOL_NAMESPACE}/${tool}`))
    .sort();
}

const GROK_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true },
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
};

it.each([
  { role: "full", gatewayAvailable: true, useDefaults: true },
  { role: "full", gatewayAvailable: true, useDefaults: false },
  { role: "contained", gatewayAvailable: true, useDefaults: true },
  { role: "full", gatewayAvailable: false, useDefaults: false },
] as const)("routes Antigravity connections on a $role member with gateway=$gatewayAvailable and defaults=$useDefaults", async ({ role, gatewayAvailable, useDefaults }) => {
  const backend = "acp:antigravity";
  const agentStore = new AcpAgentStore(stateDb);
  const sessionStore = new AcpSessionStore(stateDb);
  const overlayStore = createOverlayStoreMock();
  agentStore.upsertInstalledAgent({
    backendId: backend, registryId: "antigravity", name: "Antigravity", version: "1.5.15",
    distributionKind: "local", distributionSource: "antigravity",
    installStatus: "installed", authStatus: "not-required", verificationStatus: "not-applicable",
    allowlistRuleId: "fixture-antigravity", installedAt: 1, updatedAt: 1,
    launchDescriptor: { backendId: backend, registryId: "antigravity", distributionKind: "local",
      command: "/fixture/agy", args: ["acp"], env: {} },
  });
  setRole(role);
  const transport = new ListingAgentTransport({ initialize: GROK_INITIALIZE });
  const registerBridge = vi.fn(async (name: string) => ({
    server: { name, command: "/fixture/mcp", args: [], env: {} },
    bindThread: vi.fn(),
    revoke: vi.fn(),
  }));
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({}),
    acpAgentStore: agentStore,
    acpSessionStore: sessionStore,
    createAcpTransport: () => transport,
    overlayStore,
    mcpConnectionService: {
      registerBridge,
      listConnections: async () => [{
        id: "fixture-linear", displayName: "Fixture Linear", serverUrl: "https://linear.example.test/mcp",
        kind: "remote", authMode: "oauth", enabled: true, configured: true, state: "ready",
        selectForNewThreads: true, createdAt: 0, updatedAt: 0,
      }],
      ...(gatewayAvailable ? { requestGatewayToolOperation: async () => [] } : {}),
    },
    createScratchProjectDirectory: async () => "/tmp/pwragent-antigravity-mcp",
    threadTitleGenerationService: null,
  });
  try {
    const { threadId } = await registry.startThread({ backend, ...(!useDefaults ? { mcpConnectionIds: ["fixture-linear"] } : {}) });
    const viaGateway = role === "full" && gatewayAvailable;
    const expectedNative = viaGateway ? [] : ["fixture-linear"];
    const expectedServers = ["pwragent", ...expectedNative];
    const serverNames = () => transport.requests
      .filter(({ method }) => method === "session/new" || method === "session/load")
      .map(({ params }) => ((params?.mcpServers ?? []) as { name: string }[]).map(({ name }) => name));
    expect(serverNames()).toEqual([expectedServers]);
    expect(registerBridge.mock.calls.map(([name]) => name)).toEqual(expectedNative);
    const selection = await overlayStore.getThreadOverlayState({ backend, threadId });
    expect(selection?.mcpConnectionIds).toEqual(["fixture-linear"]);

    const client = await registry.constructionPorts().acpBackend.getClient(backend);
    await client.closeSessionForTransfer?.(threadId);
    await client.loadSession(sessionStore.getSession(backend, threadId)!);
    expect(serverNames()).toEqual([expectedServers, expectedServers]);
    expect(registerBridge.mock.calls.map(([name]) => name)).toEqual([...expectedNative, ...expectedNative]);
    const report = await registry.describeThreadMcpConnections({ backend, threadId });
    expect(report.managedConnectionsViaGateway === true).toBe(viaGateway);

    const listed = [...transport.sessions.values()].at(-1)!;
    expect(listed.tools.includes("search_mcp_tools")).toBe(role === "full");
    expect(listed.tools.includes("call_pwragent_tool")).toBe(role === "full");
    if (role === "contained") {
      registryModules(registry).turnState.registerTurn({ backend, threadId, turnId: "fixture-turn" });
      await expect(listed.client.callTool({
        name: "call_pwragent_tool", arguments: { toolName: ALLOWED, arguments: {} },
      })).resolves.toMatchObject({ isError: true, structuredContent: { code: "forbidden" } });
    }
  } finally {
    await transport.closeAll();
    await registry.close();
  }
});

it("refuses a cached Antigravity dispatcher once the owner contains the member", async () => {
  const server = agentToolServer([]);
  try {
    setRole("full");
    const { server: config } = await server.registerClient({ backend: "acp:antigravity", threadId: "fixture-thread" });
    const agent = await connectAndList(config.url, Object.fromEntries(config.headers.map(({ name, value }) => [name, value])));
    try {
      expect(agent.tools).toContain("call_pwragent_tool");
      setRole("contained");
      const catalog = await agent.client.listTools();
      expect(catalog.tools.map(({ name }) => name)).toEqual([ALLOWED, "tool_search"]);
      await expect(agent.client.callTool({ name: "call_pwragent_tool", arguments: { toolName: ALLOWED, arguments: {} } }))
        .resolves.toMatchObject({ isError: true, structuredContent: { code: "forbidden" } });
    } finally {
      await agent.client.close();
    }
  } finally {
    await server.close();
  }
});

it("uses the ACP owner's saved catalog and denies cached monitor calls through the shared dispatch gate", async () => {
  const backend = "acp:grok";
  const agentStore = new AcpAgentStore(stateDb);
  const overlayStore = new SqliteOverlayStore(stateDb);
  agentStore.upsertInstalledAgent({
    backendId: backend, registryId: "grok", name: "Grok", version: "1.0.77",
    distributionKind: "local", distributionSource: "grok",
    installStatus: "installed", authStatus: "not-required", verificationStatus: "not-applicable",
    allowlistRuleId: "fixture-grok", installedAt: 1, updatedAt: 1,
    launchDescriptor: { backendId: backend, registryId: "grok", distributionKind: "local",
      command: "/fixture/grok", args: [], env: {} },
  });
  const transport = new ListingAgentTransport({ initialize: GROK_INITIALIZE });
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({}),
    acpAgentStore: agentStore,
    acpSessionStore: new AcpSessionStore(stateDb),
    createAcpTransport: () => transport,
    overlayStore: {
      ...createOverlayStoreMock(),
      getThreadOverlayState: identity => overlayStore.getThreadOverlayState(identity),
      setThreadJobMonitorCreation: request => overlayStore.setThreadJobMonitorCreation(request),
    },
  });
  try {
    const adapter = registry.constructionPorts().acpBackend;
    const client = await adapter.getClient(backend);
    const { sessionId: threadId } = await client.startSession({ cwd: "/repo", executionMode: "default" });
    const turnState = registryModules(registry).turnState;
    const turn = { backend, threadId, turnId: "running-turn" } as const;
    turnState.registerTurn(turn);
    const original = transport.sessions.get(threadId)!;
    expect(original.tools).toContain("create_monitor_delegation");
    const toggle = (enabled: boolean) => registry.setThreadJobMonitorCreation({ backend, threadId, enabled });
    const staleCall = () => original.client.callTool({
      name: "create_monitor_delegation", arguments: { task: "Watch the fixture build." },
    });
    await toggle(false);
    await expect(staleCall()).resolves.toMatchObject({ isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("Job Monitors are off") })] });
    await toggle(true);
    await expect(staleCall()).resolves.toMatchObject({ isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("next turn") })] });
    turnState.unregisterTurn(turn);
    await toggle(false);
    expect((await overlayStore.getThreadOverlayState({ backend, threadId }))?.jobMonitorCreationEnabled).toBe(false);
    const send = (text: string) => registry.startTurn({ backend, threadId, input: [{ type: "text", text }] });
    transport.failClose = true;
    await expect(send("unsent prompt")).rejects.toThrow("couldn't refresh its Job Monitor tools");
    expect(transport.promptTools).toHaveLength(0);
    expect(client.readReplay(threadId).messages).not.toContainEqual(expect.objectContaining({ text: "unsent prompt" }));
    transport.failClose = false;
    await send("next prompt");
    await vi.waitFor(() => expect(transport.promptTools).toHaveLength(1));
    expect(transport.promptTools[0]).not.toContain("create_monitor_delegation");
    expect(adapter.sessionToThreadSummary(adapter.getSession(backend, threadId)!)).toMatchObject({
      jobMonitorCreationControl: true,
    });
    await expect(registry.setThreadJobMonitorCreation({ backend, threadId: "unknown", enabled: false }))
      .rejects.toThrow("doesn't support");
  } finally {
    await transport.closeAll();
    await registry.close();
  }
});

it("lets an ACP owner clear an old opt-out without closing an unverified session", async () => {
  const backend = "acp:grok";
  const threadId = "after-upgrade";
  const identity = { backend, threadId } as const;
  const sessions = new AcpSessionStore(stateDb);
  const overlay = new SqliteOverlayStore(stateDb);
  sessions.upsertSession({ backendId: backend, sessionId: threadId, title: "Fixture",
    cwd: "/repo", createdAt: 1, updatedAt: 1, executionMode: "default", status: "idle" });
  overlay.setThreadJobMonitorCreation({ ...identity, enabled: false });
  const createAcpTransport = vi.fn(() => new FakeAcpAgentTransport());
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({}), acpSessionStore: sessions, createAcpTransport,
    overlayStore: {
      ...createOverlayStoreMock(),
      getThreadOverlayState: request => overlay.getThreadOverlayState(request),
      setThreadJobMonitorCreation: request => overlay.setThreadJobMonitorCreation(request),
    },
  });
  try {
    await expect(registry.setThreadJobMonitorCreation({ ...identity, enabled: true }))
      .resolves.toEqual({ threadId, enabled: true });
    expect((await overlay.getThreadOverlayState(identity))?.jobMonitorCreationEnabled).toBeUndefined();
    await expect(registry.setThreadJobMonitorCreation({ ...identity, enabled: false })).rejects.toThrow("doesn't support");
    expect(createAcpTransport).not.toHaveBeenCalled();
  } finally {
    await registry.close();
  }
});

type AgentSideSession = { client: Client; tools: string[] };

/**
 * An ACP agent that connects to the session's PwrAgent MCP server when
 * session/new or session/load starts it, lists its tools once, and keeps
 * that list until session/close, as Grok does.
 */
class ListingAgentTransport extends FakeAcpAgentTransport {
  failClose = false;
  readonly sessions = new Map<string, AgentSideSession>();
  /** The tools each prompt's session had listed, in order. */
  readonly promptTools: string[][] = [];
  private nextSession = 0;

  override async request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (method === "session/new") {
      this.requests.push({ method, params });
      const sessionId = `grok-session-${++this.nextSession}`;
      this.sessions.set(sessionId, await this.listTools(params));
      return { sessionId };
    }
    if (method === "session/load") {
      this.sessions.set(String(params?.sessionId), await this.listTools(params));
    }
    if (method === "session/close") {
      if (this.failClose) throw new Error("Fixture refused session close");
      const session = this.sessions.get(String(params?.sessionId));
      this.sessions.delete(String(params?.sessionId));
      await session?.client.close();
    }
    if (method === "session/prompt") {
      const sessionId = String(params?.sessionId);
      this.promptTools.push([...this.sessions.get(sessionId)?.tools ?? ["<closed>"]]);
      this.emitSessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      });
      this.requests.push({ method, params });
      return { stopReason: "end_turn" };
    }
    return await super.request(method, params, timeoutMs);
  }

  private async listTools(params: Record<string, unknown> | undefined): Promise<AgentSideSession> {
    const servers = (params?.mcpServers ?? []) as AgentToolHttpMcpServerConfig[];
    const server = servers.find((candidate) => candidate.type === "http");
    if (!server) throw new Error("The session has no PwrAgent MCP server.");
    return await connectAndList(server.url, Object.fromEntries(server.headers.map(({ name, value }) => [name, value])));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.client.close()));
    this.sessions.clear();
  }
}

/** Connect to an MCP server and list its tools once, as an agent does when it starts the server. */
async function connectAndList(url: string, headers: Record<string, string>): Promise<AgentSideSession> {
  const client = new Client({ name: "listing-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  const { tools } = await client.listTools();
  return { client, tools: tools.map((tool) => tool.name).sort() };
}

/** A PwrAgent MCP server gated the way backend-registry-wiring.ts gates the real ones. */
function agentToolServer(dispatched: string[]): AgentToolMcpServer {
  const tool = (name: string) => ({
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name,
    description: name,
    inputSchema: { type: "object" },
    dispatch: async () => {
      dispatched.push(name);
      return agentToolSuccess({ ok: true });
    },
  });
  return new AgentToolMcpServer({
    resolveCatalogs: () => [{ id: "thread_inspection", router: new AgentToolRouter([tool(ALLOWED), tool(REFUSED)]) }],
    resolveCallContext: (context) => context.threadId
      ? { backend: context.backend, threadId: context.threadId, turnId: "turn" }
      : undefined,
    authorizeToolCall: (params) => localAgentToolRefusal(params.tool),
    isToolAdvertised: isAgentToolAdvertisedLocally,
  });
}

function setRole(role: FederationPeerRole): void {
  // This member's own setting is full, so the gateway's assignment decides.
  recordGatewayAssignedMemberRole("gateway-fixture", role);
  expect(localMemberRole()).toBe(role);
}

let stateDb: StateDb;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  clearGatewayAssignedMemberRole();
}, 60_000);

afterEach(() => {
  clearGatewayAssignedMemberRole();
  stateDb.close();
}, 60_000);

type Step =
  | { kind: "role"; role: FederationPeerRole }
  | { kind: "call"; session: number }
  | { kind: "prompt"; session: number };

const role = fc.constantFrom<FederationPeerRole>("full", "contained");
const step: fc.Arbitrary<Step> = fc.oneof(
  role.map((value) => ({ kind: "role" as const, role: value })),
  fc.integer({ min: 0, max: 1 }).map((session) => ({ kind: "call" as const, session })),
  fc.integer({ min: 0, max: 1 }).map((session) => ({ kind: "prompt" as const, session })),
);

it("gives an open ACP session the new role's tools at its next turn, and refuses unlisted calls until then", async () => {
  await fc.assert(fc.asyncProperty(role, fc.array(step, { minLength: 1, maxLength: 14 }), async (initial, steps) => {
    clearGatewayAssignedMemberRole();
    setRole(initial);
    const dispatched: string[] = [];
    const server = agentToolServer(dispatched);
    const transport = new ListingAgentTransport({ initialize: GROK_INITIALIZE });
    onTestFinished(async () => {
      await transport.closeAll();
      await server.close();
    });
    const settlement = createAcpPromptSettlement();
    const client = new AcpAgentClient({
      ...settlement.callbacks,
      backendId: "acp:grok",
      store: new AcpSessionStore(stateDb),
      transport,
      agentToolCatalogKey: localMemberRole,
      mcpServers: async ({ backendId, sessionId }) => {
        const registration = await server.registerClient({ backend: backendId, ...(sessionId ? { threadId: sessionId } : {}) });
        return { servers: [registration.server], bindThread: registration.bindThread };
      },
    });
    await client.initialize();
    const sessionIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      sessionIds.push((await client.startSession({ cwd: "/repo", executionMode: "default" })).sessionId);
    }
    let current = initial;

    for (const next of steps) {
      if (next.kind === "role") {
        setRole(next.role);
        current = next.role;
      } else if (next.kind === "call") {
        // The model calls what it was shown, which may be the old role's list.
        const session = transport.sessions.get(sessionIds[next.session]!)!;
        const before = dispatched.length;
        const result = await session.client.callTool({ name: REFUSED, arguments: {} });
        const allowed = expectedTools(current).includes(REFUSED);
        expect(result.isError === true).toBe(!allowed);
        expect(dispatched.length - before).toBe(allowed ? 1 : 0);
      } else {
        const prompts = transport.promptTools.length;
        await settlement.finish(client, { sessionId: sessionIds[next.session]!, prompt: "next" });
        expect(client.hasActiveTurns()).toBe(false);
        expect(transport.promptTools).toHaveLength(prompts + 1);
        expect(transport.promptTools.at(-1)).toEqual(expectedTools(current));
      }
    }
    await client.dispose();
  }), { numRuns: 8 });
}, 60_000);

const CLAUDE_SESSION_ID = "5a85c1ad-85c1-4930-ae19-50f721ad13dd";

/**
 * A Claude Code process that lists PwrAgent's MCP tools when it starts and
 * keeps the list. Each turn runs a background task that finishes after the
 * result, so the process stays open for the next turn, as one does inside
 * the task follow-up grace.
 */
function listingClaudeQuery(launches: AgentSideSession[], turnTools: string[][]) {
  let tasks = 0;
  return vi.fn((args: Parameters<typeof query>[0]) => {
    const options = args.options!;
    const prompt = args.prompt as AsyncIterable<SDKUserMessage>;
    async function* run(): AsyncGenerator<SDKMessage> {
      const server = options.mcpServers?.pwragent as { url: string; headers?: Record<string, string> } | undefined;
      if (!server) throw new Error("The turn has no PwrAgent MCP server.");
      const launch = await connectAndList(server.url, server.headers ?? {});
      launches.push(launch);
      try {
        yield { type: "system", subtype: "init", session_id: CLAUDE_SESSION_ID } as SDKMessage;
        for await (const message of prompt) {
          turnTools.push([...launch.tools]);
          const taskId = `task-${++tasks}`;
          yield { type: "system", subtype: "task_started", task_id: taskId, description: "sleep", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
          yield { type: "assistant", parent_tool_use_id: null, message: { id: `answer-${tasks}`, content: [{ type: "text", text: "OK" }] } } as SDKMessage;
          yield { type: "result", subtype: "success", is_error: false, result: "OK",
            ...(message.uuid ? { user_message_uuids: [message.uuid] } : {}) } as unknown as SDKMessage;
          yield { type: "system", subtype: "task_notification", task_id: taskId, status: "completed", output_file: "", summary: "done" } as SDKMessage;
        }
      } finally {
        await launch.client.close();
      }
    }
    return Object.assign(run(), {
      close: vi.fn(),
      initializationResult: async () => ({ mcp_servers_applied: true }),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      setMcpServers: vi.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
    }) as unknown as Query;
  });
}

it("gives a live Claude session the new role's tools at its next turn, and refuses unlisted calls until then", async () => {
  await fc.assert(fc.asyncProperty(role, fc.array(step, { minLength: 1, maxLength: 10 }), async (initial, steps) => {
    clearGatewayAssignedMemberRole();
    setRole(initial);
    const dispatched: string[] = [];
    const server = agentToolServer(dispatched);
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-catalog-"));
    const launches: AgentSideSession[] = [];
    const turnTools: string[][] = [];
    let completedTurns = 0;
    const backend = new ClaudeBackend({
      store: new ClaudeSessionStore(root),
      query: listingClaudeQuery(launches, turnTools),
      getSessionInfo: vi.fn().mockResolvedValue(undefined),
      discoverModels: vi.fn().mockResolvedValue([]),
      inspectInstallation: vi.fn(async () => ({ executable: "/fixture/claude", version: "2.1.330", authStatus: "signed-in" as const })),
      resolveEnv: async () => ({ PATH: "/fixture" }),
      emit: async (event: AgentEvent) => {
        if (event.notification.method === "turn/completed") completedTurns += 1;
      },
      request: async () => ({ decision: "accept" }),
      cancelRequest: async () => {},
      taskFollowUpGraceMs: 60_000,
    });
    onTestFinished(async () => {
      await backend.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    });
    const { threadId } = await backend.startThread({ cwd: root, executionMode: "default" });
    const registration = await server.registerClient({ backend: "claude", threadId });
    const mcpServers = { pwragent: {
      type: "http" as const,
      url: registration.server.url,
      headers: Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])),
    } };
    let current = initial;

    // What the registry sends with each turn (backend-registry.ts).
    const turn = async () => {
      const before = completedTurns;
      await backend.startTurn({ threadId, input: [{ type: "text", text: "next" }], mcpServers, agentToolCatalogKey: localMemberRole() });
      await vi.waitFor(() => expect(completedTurns).toBe(before + 1));
      expect(turnTools.at(-1)).toEqual(expectedTools(current));
    };
    await turn();
    for (const next of steps) {
      if (next.kind === "role") {
        setRole(next.role);
        current = next.role;
      } else if (next.kind === "call") {
        const before = dispatched.length;
        const result = await launches.at(-1)!.client.callTool({ name: REFUSED, arguments: {} });
        const allowed = expectedTools(current).includes(REFUSED);
        expect(result.isError === true).toBe(!allowed);
        expect(dispatched.length - before).toBe(allowed ? 1 : 0);
      } else {
        await turn();
      }
    }
  }), { numRuns: 8 });
}, 60_000);
