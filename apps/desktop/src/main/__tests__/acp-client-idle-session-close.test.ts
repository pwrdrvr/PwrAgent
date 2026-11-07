import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { AcpSessionStore } from "../storage/acp-session-store";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const IDLE_MS = 10 * 60_000;

// Grok advertises close under agentCapabilities.sessionCapabilities.
const GROK_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
};

/**
 * Answers each prompt with one assistant chunk, and replays the session's
 * history during session/load, as Grok does.
 */
class GrokLikeTransport extends FakeAcpAgentTransport {
  closeGate?: Promise<void>;

  override async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (method === "session/close" && this.closeGate) {
      this.requests.push({ method, params });
      await this.closeGate;
      return {};
    }
    if (method === "session/load") {
      this.emitSessionUpdate(String(params?.sessionId), {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "earlier prompt" },
      });
    }
    if (method === "session/prompt") {
      this.emitSessionUpdate(String(params?.sessionId), {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      });
    }
    return await super.request(method, params, timeoutMs);
  }

  methods(): string[] {
    return this.requests.map((request) => request.method);
  }
}

let stateDb: StateDb;
let store: AcpSessionStore;
let clock: number;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new AcpSessionStore(stateDb);
  clock = 1_000_000;
});

afterEach(() => {
  vi.useRealTimers();
  stateDb.close();
});

async function createClient(options: {
  transport?: GrokLikeTransport;
  onRequest?: ConstructorParameters<typeof AcpAgentClient>[0]["onRequest"];
  onPromptError?: ConstructorParameters<typeof AcpAgentClient>[0]["onPromptError"];
} = {}) {
  const transport = options.transport ?? new GrokLikeTransport({
    initialize: GROK_INITIALIZE,
    "session/new": { sessionId: "grok-session" },
  });
  const mcpServers = vi.fn(() => [{
    name: "pwragent",
    command: "node",
    args: ["bridge.js"],
    env: {},
  }]);
  const client = new AcpAgentClient({
    backendId: "acp:grok",
    store,
    transport,
    now: () => clock,
    mcpServers,
    ...(options.onRequest ? { onRequest: options.onRequest } : {}),
    ...(options.onPromptError ? { onPromptError: options.onPromptError } : {}),
  });
  await client.initialize();
  return { client, mcpServers, transport };
}

async function finishPrompt(client: AcpAgentClient, sessionId: string, prompt: string) {
  client.startPrompt({ sessionId, prompt });
  await vi.waitFor(() => {
    expect(client.hasActiveTurns()).toBe(false);
  });
}

describe("AcpAgentClient idle session close", () => {
  it("closes a session idle past the grace period, once", async () => {
    const { client, transport } = await createClient();
    await client.startSession({ cwd: "/repo", executionMode: "default" });

    clock += IDLE_MS - 1;
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([]);

    clock += 1;
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([
      "grok-session",
    ]);
    expect(transport.requests.filter((request) => request.method === "session/close"))
      .toEqual([{
        method: "session/close",
        params: { sessionId: "grok-session" },
        timeoutMs: 20_000,
      }]);
    // The session still routes here; only the agent-side session closed.
    expect(client.ownsSession("grok-session")).toBe(true);

    clock += IDLE_MS;
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([]);
    expect(transport.methods().filter((method) => method === "session/close")).toHaveLength(1);
  });

  it("starts the idle clock when a turn ends", async () => {
    const { client } = await createClient();
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    clock += IDLE_MS;
    await finishPrompt(client, "grok-session", "hello");

    clock += IDLE_MS - 1;
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([]);
  });

  it("keeps a session with a running turn open", async () => {
    let releasePrompt!: () => void;
    const transport = new GrokLikeTransport({
      initialize: GROK_INITIALIZE,
      "session/new": { sessionId: "grok-session" },
    });
    const request = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
      return await request(method, params, timeoutMs);
    };
    const { client } = await createClient({ transport });
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    client.startPrompt({ sessionId: "grok-session", prompt: "long task" });

    clock += IDLE_MS * 3;
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([]);
    expect(transport.methods()).not.toContain("session/close");

    await vi.waitFor(() => expect(releasePrompt).toBeTypeOf("function"));
    releasePrompt();
    await vi.waitFor(() => expect(client.hasActiveTurns()).toBe(false));
  });

  it("keeps a session waiting on a permission request open", async () => {
    let answer!: (value: unknown) => void;
    const { client, transport } = await createClient({
      onRequest: async () => await new Promise((resolve) => {
        answer = resolve;
      }),
    });
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    const permission = transport.emitRequest("session/request_permission", {
      sessionId: "grok-session",
      toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    }, 7);
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));

    clock += IDLE_MS * 3;
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([]);

    answer({ decision: "accept" });
    await permission;
    // Answering the request is activity; the clock restarts from there.
    clock += IDLE_MS - 1;
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([]);
    clock += 1;
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([
      "grok-session",
    ]);
  });

  it("keeps a session the owner reports busy, such as one with queued input", async () => {
    const { client } = await createClient();
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    clock += IDLE_MS;

    const isSessionBusy = vi.fn((sessionId: string) => sessionId === "grok-session");
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS, isSessionBusy }))
      .resolves.toEqual([]);
    expect(isSessionBusy).toHaveBeenCalledWith("grok-session");
  });

  it("keeps helper sessions that session/load cannot rebuild", async () => {
    const { client } = await createClient();
    await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      hidden: true,
      mcpServers: "none",
      sessionMeta: { agentProfile: { name: "helper" } },
    });
    clock += IDLE_MS;

    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([]);
  });

  it("closes nothing when the agent cannot both close and reload a session", async () => {
    for (const agentCapabilities of [
      { loadSession: true },
      { loadSession: false, sessionCapabilities: { close: {} } },
    ]) {
      const transport = new GrokLikeTransport({
        initialize: { protocolVersion: 1, agentCapabilities },
        "session/new": { sessionId: "grok-session" },
      });
      const { client } = await createClient({ transport });
      await client.startSession({ cwd: "/repo", executionMode: "default" });
      clock += IDLE_MS;

      await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([]);
      expect(transport.methods()).not.toContain("session/close");
    }
  });

  it("reloads a closed session with session/load before the next prompt", async () => {
    const { client, mcpServers, transport } = await createClient();
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    await finishPrompt(client, "grok-session", "first prompt");
    const entriesBeforeClose = client.readReplay("grok-session").entries.length;
    clock += IDLE_MS;
    await client.closeIdleSessions({ idleMs: IDLE_MS });
    mcpServers.mockClear();

    // The registry's turn path: ensureSession, then startPrompt.
    await client.ensureSession(store.getSession("acp:grok", "grok-session")!);
    await finishPrompt(client, "grok-session", "second prompt");

    expect(transport.methods().slice(-3)).toEqual([
      "session/close",
      "session/load",
      "session/prompt",
    ]);
    const load = transport.requests.find((request) => request.method === "session/load");
    expect(load?.params).toMatchObject({
      sessionId: "grok-session",
      cwd: "/repo",
      mcpServers: [{ name: "pwragent", command: "node", args: ["bridge.js"] }],
    });
    expect(mcpServers).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "grok-session",
    }));
    // The replay session/load sent did not repeat the transcript in memory.
    const replay = client.readReplay("grok-session");
    expect(replay.entries.length).toBeGreaterThan(entriesBeforeClose);
    expect(replay.entries.filter((entry) =>
      entry.type === "message" && entry.role === "user" && entry.text === "earlier prompt"))
      .toHaveLength(0);

    // Loaded again, so it can idle out again.
    clock += IDLE_MS;
    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([
      "grok-session",
    ]);
  });

  it("reloads a closed session when a prompt arrives without ensureSession", async () => {
    const { client, transport } = await createClient();
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    clock += IDLE_MS;
    await client.closeIdleSessions({ idleMs: IDLE_MS });

    await finishPrompt(client, "grok-session", "queued prompt");

    expect(transport.methods().slice(-2)).toEqual(["session/load", "session/prompt"]);
  });

  it("ignores turn ends that session/load replays while a prompt reloads", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let releasePrompt: (() => void) | undefined;
    const transport = new GrokLikeTransport({
      initialize: GROK_INITIALIZE,
      "session/new": { sessionId: "grok-session" },
    });
    const request = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      sent.push(method);
      if (method === "session/load") {
        transport.emitSessionUpdate(String(params?.sessionId), {
          sessionUpdate: "turn_finished",
          text: "earlier answer",
        });
      }
      if (method === "session/prompt") {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
      return await request(method, params, timeoutMs);
    };
    const onPromptError = vi.fn();
    const { client } = await createClient({ transport, onPromptError });
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    clock += IDLE_MS;
    await client.closeIdleSessions({ idleMs: IDLE_MS });

    client.startPrompt({ sessionId: "grok-session", prompt: "a long task" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.slice(-2)).toEqual(["session/load", "session/prompt"]);

    // Past the 5 s grace a live turn end would start.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onPromptError).not.toHaveBeenCalled();
    expect(client.hasActiveTurns()).toBe(true);
    expect(transport.notifications.map((notification) => notification.method))
      .not.toContain("session/cancel");

    releasePrompt?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.hasActiveTurns()).toBe(false);
    expect(onPromptError).not.toHaveBeenCalled();
  });

  it("reloads a closed session before other session requests", async () => {
    const { client, transport } = await createClient();
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    clock += IDLE_MS;
    await client.closeIdleSessions({ idleMs: IDLE_MS });

    await client.setRuntimeOption({
      sessionId: "grok-session",
      source: "configOption",
      optionId: "permission_mode",
      value: "default",
    });

    expect(transport.methods().slice(-2)).toEqual([
      "session/load",
      "session/set_config_option",
    ]);
  });

  it("serves an open thread's transcript from memory without reloading", async () => {
    const { client, transport } = await createClient();
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    await finishPrompt(client, "grok-session", "first prompt");
    clock += IDLE_MS;
    await client.closeIdleSessions({ idleMs: IDLE_MS });

    const replay = await client.loadSession(store.getSession("acp:grok", "grok-session")!);

    expect(replay.lastAssistantMessage).toBe("done");
    expect(transport.methods()).not.toContain("session/load");
  });

  it("waits for a close in flight before reloading the session", async () => {
    const { client, transport } = await createClient();
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    clock += IDLE_MS;
    let releaseClose!: () => void;
    transport.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const sweep = client.closeIdleSessions({ idleMs: IDLE_MS });
    await vi.waitFor(() => expect(transport.methods()).toContain("session/close"));

    const ensure = client.ensureSession(store.getSession("acp:grok", "grok-session")!);
    await Promise.resolve();
    expect(transport.methods()).not.toContain("session/load");

    releaseClose();
    await expect(sweep).resolves.toEqual(["grok-session"]);
    await ensure;
    expect(transport.methods().slice(-2)).toEqual(["session/close", "session/load"]);
  });

  it("keeps a session loaded when its close fails", async () => {
    const transport = new GrokLikeTransport({
      initialize: GROK_INITIALIZE,
      "session/new": { sessionId: "grok-session" },
    });
    const request = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/close") throw new Error("agent busy");
      return await request(method, params, timeoutMs);
    };
    const { client } = await createClient({ transport });
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    clock += IDLE_MS;

    await expect(client.closeIdleSessions({ idleMs: IDLE_MS })).resolves.toEqual([]);
    await finishPrompt(client, "grok-session", "still loaded");

    expect(transport.methods()).not.toContain("session/load");
  });

  it("does not close an idle-closed session again when its worktree is archived", async () => {
    const { client, transport } = await createClient();
    await client.startSession({ cwd: "/repo", executionMode: "default" });
    clock += IDLE_MS;
    await client.closeIdleSessions({ idleMs: IDLE_MS });

    await expect(client.closeSessionForArchive("grok-session")).resolves.toBe(true);

    expect(transport.methods().filter((method) => method === "session/close")).toHaveLength(1);
    expect(client.ownsSession("grok-session")).toBe(false);
  });
});
