import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Query, SDKMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PWRAGENT_TOOL_NAMESPACE, type AgentEvent, type FederationPeerRole } from "@pwragent/shared";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
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
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
};

type AgentSideSession = { client: Client; tools: string[] };

/**
 * An ACP agent that connects to the session's PwrAgent MCP server when
 * session/new or session/load starts it, lists its tools once, and keeps
 * that list until session/close, as Grok does.
 */
class ListingAgentTransport extends FakeAcpAgentTransport {
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
    const client = new AcpAgentClient({
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
        client.startPrompt({ sessionId: sessionIds[next.session]!, prompt: "next" });
        await vi.waitFor(() => {
          expect(client.hasActiveTurns()).toBe(false);
          expect(transport.promptTools).toHaveLength(prompts + 1);
        });
        expect(transport.promptTools.at(-1)).toEqual(expectedTools(current));
      }
    }
    await client.dispose();
  }), { numRuns: 25 });
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
      inspectInstallation: vi.fn(async () => ({ executable: "/fixture/claude", authStatus: "signed-in" as const })),
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
  }), { numRuns: 15 });
}, 60_000);
