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
    expect(store.getSession("acp:codex-acp", "session-1")?.transcriptUpdates)
      .toEqual([
        {
          receivedAt: 1000,
          update: {
            kind: "pwragent_user_prompt",
            prompt: "hello",
            turnId: "pending:session-1:1000",
          },
        },
        {
          receivedAt: 1000,
          update: {
            kind: "turn_finished",
            outputText: "",
            turnId: "pending:session-1:1000",
          },
        },
        {
          receivedAt: 1000,
          update: {
            kind: "agent_message_chunk",
            content: "Done",
          },
        },
      ]);
    expect(sessionUpdates).toEqual(["session-1"]);
  });

  it("surfaces ACP permission requests and returns the selected option", async () => {
    const transport = new FakeAcpAgentTransport();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onRequest: (request) => {
        requests.push(request);
        return { decision: "approve" };
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Run npm view openclaw",
      turnId: "turn-1",
    });

    const response = await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "run_shell_command_1",
          kind: "execute",
          title: "npm view openclaw",
          status: "pending",
        },
        options: [
          {
            optionId: "proceed_always",
            name: "Allow for this session",
            kind: "allow_always",
          },
          {
            optionId: "proceed_once",
            name: "Allow",
            kind: "allow_once",
          },
          {
            optionId: "cancel",
            name: "Reject",
            kind: "reject_once",
          },
        ],
      },
      0,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "session-1",
        turnId: "turn-1",
        requestId: "0",
        command: "npm view openclaw",
        acpMethod: "session/request_permission",
        acpToolCallId: "run_shell_command_1",
        acpToolKind: "execute",
      },
    });
    expect(response).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "proceed_once",
      },
    });
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
    const activeReplay = client.readReplay(session.sessionId);
    const persistedSession = store.getSession("acp:codex-acp", session.sessionId);
    await client.cancelSession(session.sessionId);

    expect(prompt).toEqual({
      sessionId: "session-1",
      turnId: "pending:session-1:1000",
    });
    expect(activeReplay).toMatchObject({
      lastUserMessage: "keep going",
      threadStatus: "active",
    });
    expect(persistedSession?.transcriptUpdates).toEqual([
      {
        receivedAt: 1000,
        update: {
          kind: "pwragent_user_prompt",
          prompt: "keep going",
          turnId: "pending:session-1:1000",
        },
      },
    ]);
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

  it("can keep a stable app session id while rebinding the ACP protocol session", async () => {
    const transport = new FakeAcpAgentTransport();
    const updateSessionIds: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ sessionId }) => {
        updateSessionIds.push(sessionId);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      sessionId: "app-session-1",
      cwd: "/repo/worktree",
      executionMode: "default",
      title: "Stable thread",
    });
    client.startPrompt({
      sessionId: "app-session-1",
      prompt: "hello",
      turnId: "pending:app-session-1",
    });
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello from rebound session." },
    });
    await client.cancelSession("app-session-1");

    expect(session).toMatchObject({
      sessionId: "app-session-1",
      agentSessionId: "session-1",
      cwd: "/repo/worktree",
    });
    expect(transport.requests[2]?.params).toEqual({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(updateSessionIds[0]).toBe("app-session-1");
    expect(client.readReplay("app-session-1").lastAssistantMessage).toBe(
      "Hello from rebound session.",
    );
    expect(transport.notifications).toEqual([
      {
        method: "session/cancel",
        params: { sessionId: "session-1" },
      },
    ]);
  });

  it("reports fire-and-forget prompt chunks and completion with turn context", async () => {
    const transport = new FakeAcpAgentTransport();
    let resolvePrompt: ((value: unknown) => void) | undefined;
    const updates: Array<{
      outputText?: string;
      text?: string;
      turnId?: string;
      updateKind?: string;
    }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport: {
        request: async (method, params) => {
          if (method === "session/prompt") {
            transport.requests.push({ method, params });
            return await new Promise((resolve) => {
              resolvePrompt = resolve;
            });
          }
          return await transport.request(method, params);
        },
        notify: (method, params) => transport.notify(method, params),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 1000,
      onSessionUpdate: ({ replay, turnId, update }) => {
        const content = update.content as { text?: string } | undefined;
        updates.push({
          ...(typeof update.outputText === "string"
            ? { outputText: update.outputText }
            : {}),
          ...(typeof content?.text === "string" ? { text: content.text } : {}),
          turnId,
          updateKind:
            typeof update.kind === "string"
              ? update.kind
              : typeof update.sessionUpdate === "string"
                ? update.sessionUpdate
                : undefined,
        });
        expect(replay.threadStatus).toBeDefined();
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "hello",
      turnId: "pending:session-1",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello " },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
    });
    resolvePrompt?.({});

    await vi.waitFor(() => {
      expect(updates.map((update) => update.updateKind)).toEqual([
        "agent_message_chunk",
        "agent_message_chunk",
        "turn_finished",
      ]);
    });
    expect(updates).toEqual([
      {
        text: "Hello ",
        turnId: "pending:session-1",
        updateKind: "agent_message_chunk",
      },
      {
        text: "world",
        turnId: "pending:session-1",
        updateKind: "agent_message_chunk",
      },
      {
        outputText: "Hello world",
        turnId: "pending:session-1",
        updateKind: "turn_finished",
      },
    ]);
  });

  it("persists ACP topic updates as session titles", async () => {
    const transport = new FakeAcpAgentTransport();
    const titleUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ title }) => {
        if (title) {
          titleUpdates.push(title);
        }
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "update_topic_1",
      kind: "think",
      title: 'Update topic to: "Exploring PwrSnap Project"',
      status: "in_progress",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "update_topic_1",
      kind: "think",
      title: 'Update topic to: "Exploring PwrSnap Project"',
      status: "completed",
    });

    expect(store.getSession("acp:gemini", session.sessionId)?.title).toBe(
      "Exploring PwrSnap Project",
    );
    expect(client.readReplay(session.sessionId).entries).toEqual([]);
    expect(titleUpdates).toEqual(["Exploring PwrSnap Project"]);
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

  it("reloads stored sessions at a changed cwd before prompting", async () => {
    const transport = new FakeAcpAgentTransport();
    const updateEvents: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ update }) => {
        updateEvents.push(String(update.sessionUpdate ?? update.kind));
      },
    });

    await client.initialize();
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "ACP session",
      cwd: "/repo/worktree",
      createdAt: 900,
      updatedAt: 950,
      executionMode: "default",
      status: "idle",
      transcriptUpdates: [
        {
          receivedAt: 950,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Previous answer." },
          },
        },
      ],
    });
    const ensurePromise = client.ensureSession(
      store.getSession("acp:gemini", "session-1")!,
    );
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Replayed from load." },
    });
    await ensurePromise;
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Late replay from load." },
    });
    client.startPrompt({
      sessionId: "session-1",
      prompt: "What is the CWD?",
      turnId: "pending:session-1:1000",
    });

    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
      "session/prompt",
    ]);
    expect(transport.requests[1]?.params).toEqual({
      cwd: "/repo/worktree",
      mcpServers: [],
      sessionId: "session-1",
    });
    expect(updateEvents).toEqual([]);
    expect(client.readReplay("session-1").lastAssistantMessage).toBeUndefined();
  });
});
