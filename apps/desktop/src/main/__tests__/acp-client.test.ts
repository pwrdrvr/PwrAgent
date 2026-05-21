import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { AcpSessionStore } from "../acp/acp-session-store";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { StateDb } from "../state/state-db";

let tempDir: string;
let stateDb: StateDb;
let store: AcpSessionStore;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-acp-client-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new AcpSessionStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AcpAgentClient", () => {
  it("initializes, starts sessions, sends prompts, and normalizes updates", async () => {
    const transport = new FakeAcpAgentTransport();
    const sessionUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ sessionId }) => {
        sessionUpdates.push(sessionId);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      title: "Test ACP",
    });
    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: "hello",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "agent_message_chunk",
      content: "Done",
    });

    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    expect(transport.requests[0]?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        auth: {
          terminal: false,
        },
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
      clientInfo: {
        name: "pwragent",
        title: "PwrAgent",
        version: "0.0.0",
      },
    });
    expect(transport.requests[1]?.params).toEqual({
      cwd: "/repo",
      mcpServers: [],
    });
    expect(transport.requests[2]?.params).toEqual({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(prompt).toEqual({ sessionId: "session-1", turnId: "turn-1" });
    expect(store.getSession("acp:codex-acp", "session-1")).toMatchObject({
      title: "Test ACP",
      cwd: "/repo",
      executionMode: "default",
    });
    expect(client.readReplay("session-1").lastAssistantMessage).toBe("Done");
    expect(sessionUpdates).toEqual(["session-1"]);
  });

  it("can start prompts without waiting for completion and cancel sessions", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const prompt = client.startPrompt({
      sessionId: session.sessionId,
      prompt: "keep going",
    });
    await client.cancelSession(session.sessionId);

    expect(prompt).toEqual({
      sessionId: "session-1",
      turnId: "pending:session-1:1000",
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    expect(transport.requests[2]?.params).toEqual({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "keep going" }],
    });
    expect(transport.notifications).toEqual([
      {
        method: "session/cancel",
        params: { sessionId: "session-1" },
      },
    ]);
  });

  it("reports fire-and-forget prompt failures", async () => {
    const transport = new FakeAcpAgentTransport();
    const errors: Array<{ sessionId: string; turnId: string; error: unknown }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport: {
        request: async (method, params) => {
          if (method === "session/prompt") {
            throw new Error("agent exited");
          }
          return transport.request(method, params);
        },
        notify: (method, params) => transport.notify(method, params),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 1000,
      onPromptError: (event) => {
        errors.push(event);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const prompt = client.startPrompt({
      sessionId: session.sessionId,
      prompt: "keep going",
      turnId: "pending:session-1",
    });

    expect(prompt).toEqual({
      sessionId: "session-1",
      turnId: "pending:session-1",
    });
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errors[0]).toMatchObject({
      sessionId: "session-1",
      turnId: "pending:session-1",
    });
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect((errors[0]?.error as Error).message).toBe("agent exited");
  });

  it("loads stored sessions through the ACP agent and closes transports", async () => {
    const transport = new FakeAcpAgentTransport();
    const loadRequests: Array<Record<string, unknown> | undefined> = [];
    const client = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport: {
        request: async (method, params) => {
          if (method === "session/load") {
            loadRequests.push(params);
            return {
              updates: [
                {
                  kind: "agent_message_chunk",
                  content: "Restored transcript",
                },
              ],
            };
          }
          return await transport.request(method, params);
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 1000,
    });

    await client.initialize();
    const replay = await client.loadSession({
      backendId: "acp:codex-acp",
      sessionId: "session-1",
      title: "Stored ACP session",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 950,
      executionMode: "full-access",
      status: "idle",
    });
    await client.dispose();

    expect(replay.lastAssistantMessage).toBe("Restored transcript");
    expect(store.getSession("acp:codex-acp", "session-1")).toMatchObject({
      title: "Stored ACP session",
      cwd: "/repo",
      executionMode: "full-access",
    });
    expect(loadRequests).toEqual([
      {
        cwd: "/repo",
        mcpServers: [],
        sessionId: "session-1",
      },
    ]);
    expect(transport.closeCount).toBe(1);
  });
});
