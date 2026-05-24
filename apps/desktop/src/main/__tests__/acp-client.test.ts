import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { AcpRolloutStore } from "../acp/acp-rollout-store";
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
  vi.useRealTimers();
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function readRawAcpSessionPayload(
  backendId: string,
  sessionId: string,
): Record<string, unknown> | undefined {
  const row = stateDb.raw
    .prepare(
      `SELECT payload FROM acp_sessions WHERE backend_id = ? AND session_id = ?`,
    )
    .get(backendId, sessionId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

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
    expect(transport.requests[2]?.timeoutMs).toBe(60 * 60_000);
    expect(prompt).toEqual({ sessionId: "session-1", turnId: "turn-1" });
    expect(store.getSession("acp:codex-acp", "session-1")).toMatchObject({
      title: "Test ACP",
      cwd: "/repo",
      executionMode: "default",
      hasConversationHistory: true,
    });
    expect(client.readReplay("session-1").lastAssistantMessage).toBe("Done");
    expect(
      readRawAcpSessionPayload("acp:codex-acp", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
    expect(sessionUpdates).toEqual(["session-1"]);
  });

  it("records Kimi snake_case assistant chunks as active turn text", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const sessionUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ update }) => {
        sessionUpdates.push(String(update.session_update ?? update.kind));
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
      turnId: "turn-1",
    });
    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "Kimi says hi." },
    });
    promptResponse.resolve({});
    await vi.waitFor(() => {
      expect(client.readReplay(session.sessionId).lastAssistantMessage).toBe(
        "Kimi says hi.",
      );
    });

    expect(sessionUpdates).toContain("agent_message_chunk");
    expect(transport.requests[2]?.timeoutMs).toBe(60 * 60_000);
  });

  it("sends control prompts without recording transcript updates", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const sessionUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
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
      title: "Kimi ACP",
    });
    const controlPrompt = client.sendControlPrompt({
      sessionId: session.sessionId,
      prompt: "/yolo",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "You only live once! All actions will be auto-approved.",
      },
    });
    promptResponse.resolve({ stopReason: "end_turn" });
    await expect(controlPrompt).resolves.toEqual({
      text: "You only live once! All actions will be auto-approved.",
    });

    expect(transport.requests.at(-1)).toEqual({
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "/yolo" }],
      },
      timeoutMs: 60 * 60_000,
    });
    expect(client.readReplay("session-1").messages).toEqual([]);
    expect(store.getSession("acp:kimi", "session-1")).not.toHaveProperty(
      "hasConversationHistory",
    );
    expect(
      readRawAcpSessionPayload("acp:kimi", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
    expect(sessionUpdates).toEqual([]);
  });

  it("passes configured MCP servers when an ACP session id is known", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      mcpServers: ({ backendId, cwd, sessionId }) =>
        sessionId
          ? [
              {
                name: "pwragent_automations",
                command: "pwragent-automation-tools",
                args: [backendId, cwd, sessionId],
              },
            ]
          : [],
    });

    await client.initialize();
    await client.startSession({
      sessionId: "app-session-1",
      cwd: "/repo",
      executionMode: "default",
    });
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "loaded-session-1",
      title: "Loaded ACP session",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 950,
      executionMode: "default",
      status: "idle",
    });
    await client.refreshSession(
      store.getSession("acp:gemini", "loaded-session-1")!,
    );

    expect(transport.requests[1]?.params).toEqual({
      cwd: "/repo",
      mcpServers: [
        {
          name: "pwragent_automations",
          command: "pwragent-automation-tools",
          args: ["acp:gemini", "/repo", "app-session-1"],
        },
      ],
    });
    expect(transport.requests[2]?.params).toEqual({
      cwd: "/repo",
      mcpServers: [
        {
          name: "pwragent_automations",
          command: "pwragent-automation-tools",
          args: ["acp:gemini", "/repo", "loaded-session-1"],
        },
      ],
      sessionId: "loaded-session-1",
    });
  });

  it("sends pasted images as ACP image content and keeps structured parts in live replay", async () => {
    const transport = new FakeAcpAgentTransport();
    const imageUrl = "data:image/png;base64,aGVsbG8=";
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "What's in this image?",
      promptContent: [
        { type: "text", text: "What's in this image?" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
      parts: [
        { type: "text", text: "What's in this image?" },
        { type: "image", url: imageUrl },
      ],
      turnId: "turn-1",
    });

    expect(transport.requests[2]?.params).toEqual({
      sessionId: "session-1",
      prompt: [
        { type: "text", text: "What's in this image?" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    });
    expect(client.readReplay("session-1").messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "What's in this image?",
        parts: [
          { type: "text", text: "What's in this image?" },
          { type: "image", url: imageUrl },
        ],
      }),
    ]);
    expect(store.getSession("acp:gemini", "session-1")).toMatchObject({
      hasConversationHistory: true,
    });
    expect(
      readRawAcpSessionPayload("acp:gemini", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
  });

  it("surfaces ACP permission requests and returns the selected option", async () => {
    const transport = new FakeAcpAgentTransport();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      agentDisplayName: "Kimi Code CLI",
      store,
      transport,
      now: () => 1000,
      onRequest: (request) => {
        requests.push(request);
        return { decision: "accept" };
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
        prompt: "Kimi Code CLI wants to run execute: npm view openclaw",
        reason: "Kimi Code CLI wants to run execute: npm view openclaw",
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

  it("captures ACP runtime modes and models from session setup", async () => {
    const runtimeEvents: unknown[] = [];
    const transport = new FakeAcpAgentTransport({
      "session/new": {
        sessionId: "gemini-session",
        modes: {
          currentModeId: "default",
          availableModes: [
            {
              id: "default",
              name: "Default",
              description: "Prompts for approval",
            },
            {
              id: "yolo",
              name: "YOLO",
              description: "Auto-approves all tools",
            },
          ],
        },
        models: {
          currentModelId: "gemini-3-flash-preview",
          availableModels: [
            {
              modelId: "gemini-3-flash-preview",
              name: "gemini-3-flash-preview",
            },
          ],
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onRuntimeCapabilities: (event) => {
        runtimeEvents.push(event);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    expect(session).toMatchObject({
      sessionId: "gemini-session",
      acpRuntime: {
        currentModeId: "default",
        currentModelId: "gemini-3-flash-preview",
      },
    });
    expect(store.getSession("acp:gemini", "gemini-session")).toMatchObject({
      acpRuntime: {
        currentModeId: "default",
        currentModelId: "gemini-3-flash-preview",
      },
    });
    expect(runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "gemini-session",
          runtimeCapabilities: expect.objectContaining({
            status: "discovered",
            source: "session-new",
            modes: expect.objectContaining({
              currentModeId: "default",
              availableModes: expect.arrayContaining([
                expect.objectContaining({ id: "default", label: "Default" }),
                expect.objectContaining({ id: "yolo", label: "YOLO" }),
              ]),
            }),
            models: expect.objectContaining({
              currentModelId: "gemini-3-flash-preview",
              availableModels: expect.arrayContaining([
                expect.objectContaining({
                  id: "gemini-3-flash-preview",
                  label: "gemini-3-flash-preview",
                }),
              ]),
            }),
          }),
        }),
      ]),
    );
  });

  it("updates ACP runtime state without rendering config notifications", async () => {
    const runtimeUpdates: unknown[] = [];
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionRuntimeStateChange: (event) => {
        runtimeUpdates.push(event);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "current_mode_update",
      currentModeId: "yolo",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "config_option_update",
      configOption: {
        id: "approval-mode",
        currentValue: "yolo",
      },
    });

    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      acpRuntime: {
        currentModeId: "yolo",
        configValues: {
          "approval-mode": "yolo",
        },
      },
    });
    expect(client.readReplay(session.sessionId).entries).toEqual([]);
    expect(runtimeUpdates).toHaveLength(2);
  });

  it("keeps requested ACP mode when set_mode returns no fresh runtime state", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": {
        sessionId: "gemini-session",
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "yolo", name: "YOLO" },
          ],
        },
      },
      "session/set_mode": {},
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "mode",
        optionId: "mode",
        value: "yolo",
      }),
    ).resolves.toMatchObject({
      currentModeId: "yolo",
    });
    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      acpRuntime: {
        currentModeId: "yolo",
      },
    });
  });

  it("keeps requested ACP model when set_model returns no fresh runtime state", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": {
        sessionId: "gemini-session",
        models: {
          currentModelId: "gemini-3-flash-preview",
          availableModels: [
            { modelId: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
            { modelId: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
          ],
        },
      },
      "session/set_model": {},
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "model",
        optionId: "model",
        value: "gemini-3-pro-preview",
      }),
    ).resolves.toMatchObject({
      currentModelId: "gemini-3-pro-preview",
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session/set_model",
      params: {
        sessionId: "gemini-session",
        modelId: "gemini-3-pro-preview",
      },
    });
    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      acpRuntime: {
        currentModelId: "gemini-3-pro-preview",
      },
    });
  });

  it("rejects a second active prompt for the same ACP session", async () => {
    const pendingPrompt = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": pendingPrompt.promise,
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "first",
    });

    expect(() =>
      client.startPrompt({
        sessionId: session.sessionId,
        prompt: "second",
      }),
    ).toThrow("A turn is already active for this ACP session.");

    pendingPrompt.resolve({ turnId: "turn-1" });
  });

  it("treats Gemini mode marker chunks as runtime updates instead of assistant text", async () => {
    const runtimeUpdates: unknown[] = [];
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionRuntimeStateChange: (event) => {
        runtimeUpdates.push(event);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "agent_message_chunk",
      content: "[MODE_UPDATE] yolo",
    });

    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      acpRuntime: {
        currentModeId: "yolo",
      },
    });
    expect(client.readReplay(session.sessionId).entries).toEqual([]);
    expect(runtimeUpdates).toEqual([
      {
        sessionId: session.sessionId,
        runtimeState: {
          currentModeId: "yolo",
          updatedAt: 1000,
        },
      },
    ]);
  });

  it("loads ACP transcript replay from provider session/load without storing it in the DB", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport: {
        request: async (method, params) => {
          const result = await transport.request(method, params);
          if (method === "session/load") {
            transport.emitSessionUpdate("session-1", {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "first" },
            });
            transport.emitSessionUpdate("session-1", {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "reply" },
            });
          }
          return result;
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "ACP session",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    const firstReplay = await client.loadSession(store.getSession("acp:gemini", "session-1")!);
    const secondReplay = await client.loadSession(store.getSession("acp:gemini", "session-1")!);

    expect(firstReplay.messages.map((message) => message.text)).toEqual([
      "first",
      "reply",
    ]);
    expect(secondReplay.messages.map((message) => message.text)).toEqual([
      "first",
      "reply",
    ]);
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
    ]);
    expect(
      readRawAcpSessionPayload("acp:gemini", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
  });

  it("returns empty replay when no provider session/load support is advertised", async () => {
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "ACP session",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    const replay = await client.loadSession(
      store.getSession("acp:gemini", "session-1")!,
    );

    expect(replay.messages).toEqual([]);
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
    ]);
  });

  it("restores ACP replay from local rollout history when session/load is unsupported", async () => {
    const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts"));
    const firstTransport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      },
    });
    const firstClient = new AcpAgentClient({
      backendId: "acp:kimi",
      rolloutStore,
      store,
      transport: firstTransport,
      now: () => 1000,
    });

    await firstClient.initialize();
    const session = await firstClient.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    firstClient.startPrompt({
      sessionId: session.sessionId,
      prompt: "hello",
      turnId: "turn-1",
    });
    firstTransport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "Kimi says hi." },
    });

    const secondTransport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      },
    });
    const secondClient = new AcpAgentClient({
      backendId: "acp:kimi",
      rolloutStore,
      store,
      transport: secondTransport,
      now: () => 2000,
    });

    await secondClient.initialize();
    const replay = await secondClient.loadSession(
      store.getSession("acp:kimi", session.sessionId)!,
    );

    expect(replay.messages.map((message) => message.text)).toEqual([
      "hello",
      "Kimi says hi.",
    ]);
    expect(secondTransport.requests.map((request) => request.method)).toEqual([
      "initialize",
    ]);
    expect(
      readRawAcpSessionPayload("acp:kimi", session.sessionId)?.transcriptUpdates,
    ).toBeUndefined();
  });

  it("does not write local rollout history when the ACP agent advertises session replay", async () => {
    const rolloutStore = {
      appendUpdate: vi.fn(),
      readUpdates: vi.fn(() => []),
      flushAll: vi.fn(),
    };
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
        sessionCapabilities: {
          _meta: {
            kimi: {
              sessionHistoryReplay: true,
            },
          },
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      rolloutStore,
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "hello",
      turnId: "turn-1",
    });
    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "Kimi says hi." },
    });

    await vi.waitFor(() => {
      expect(client.readReplay(session.sessionId).lastAssistantMessage).toBe(
        "Kimi says hi.",
      );
    });
    await vi.waitFor(() => {
      expect(client.readReplay(session.sessionId).threadStatus).toBe("idle");
    });

    expect(rolloutStore.appendUpdate).not.toHaveBeenCalled();
  });

  it("does not call session/load when the ACP agent says loading is unsupported", async () => {
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "ACP session",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
    });

    await client.initialize();
    await client.ensureSession(store.getSession("acp:gemini", "session-1")!);
    await client.refreshSession(store.getSession("acp:gemini", "session-1")!);

    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
    ]);
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
    expect(persistedSession).toMatchObject({
      hasConversationHistory: true,
    });
    expect(
      readRawAcpSessionPayload("acp:codex-acp", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
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

  it("does not overwrite an explicit ACP session title with topic updates", async () => {
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
      title: "Manual thread name",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "update_topic_1",
      kind: "think",
      title: 'Update topic to: "Agent Suggested Name"',
      status: "completed",
    });

    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      title: "Manual thread name",
      titleSource: "explicit",
    });
    expect(titleUpdates).toEqual([]);
  });

  it("keeps the first ACP topic title instead of treating later topics as renames", async () => {
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
      sessionUpdate: "tool_call_update",
      toolCallId: "update_topic_1",
      kind: "think",
      title: 'Update topic to: "Cleaning up formatting"',
      status: "completed",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "update_topic_2",
      kind: "think",
      title: 'Update topic to: "Running npm audit"',
      status: "completed",
    });

    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      title: "Cleaning up formatting",
      titleSource: "derived",
    });
    expect(titleUpdates).toEqual(["Cleaning up formatting"]);
  });

  it("reports fire-and-forget prompt failures", async () => {
    const transport = new FakeAcpAgentTransport();
    const quotaError =
      "json-rpc error (500): You have exhausted your capacity on this model. Your quota will reset after 22h38m3s.";
    const errors: Array<{ sessionId: string; turnId: string; error: unknown }> = [];
    const sessionUpdateKinds: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport: {
        request: async (method, params) => {
          if (method === "session/prompt") {
            throw new Error(quotaError);
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
      onSessionUpdate: ({ update }) => {
        const record =
          update && typeof update === "object" && !Array.isArray(update)
            ? (update as Record<string, unknown>)
            : undefined;
        if (typeof record?.kind === "string") {
          sessionUpdateKinds.push(record.kind);
        }
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
    expect((errors[0]?.error as Error).message).toBe(quotaError);
    expect(sessionUpdateKinds).not.toContain("turn_finished");
    expect(store.getSession("acp:codex-acp", "session-1")).toMatchObject({
      hasConversationHistory: true,
      lastError: quotaError,
      status: "idle",
    });
    expect(
      readRawAcpSessionPayload("acp:codex-acp", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
    const expectedEntries = [
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "keep going",
      }),
      expect.objectContaining({
        type: "activity",
        summary: "Turn failed",
        tone: "warning",
        status: "failed",
        details: [
          expect.objectContaining({
            label: quotaError,
            status: "failed",
          }),
        ],
      }),
    ];
    expect(client.readReplay("session-1").entries).toEqual(expectedEntries);

    const reloadedClient = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport,
      now: () => 1000,
    });
    expect(reloadedClient.readReplay("session-1").entries).toEqual([]);
  });

  it("refreshes stored session metadata without ingesting returned session/load payloads", async () => {
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
    await client.refreshSession(
      store.getSession("acp:codex-acp", "session-1")!,
    );
    await client.dispose();

    expect(replay.lastAssistantMessage).toBeUndefined();
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

  it("applies ACP updates replayed during provider session/load refresh", async () => {
    let notificationListener:
      | ((method: string, params: Record<string, unknown>) => void)
      | undefined;
    const titleUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport: {
        request: async (method) => {
          if (method === "initialize") {
            return { protocolVersion: 1 };
          }
          if (method === "session/load") {
            notificationListener?.("session/update", {
              sessionId: "session-1",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "update_topic_1",
                kind: "think",
                title: 'Update topic to: "Loaded Project Research"',
                status: "completed",
              },
            });
            notificationListener?.("session/update", {
              sessionId: "session-1",
              update: {
                kind: "agent_message_chunk",
                content: "Loaded replay response",
              },
            });
            return {};
          }
          return {};
        },
        notify: async () => undefined,
        close: async () => undefined,
        onNotification: (listener) => {
          notificationListener = listener;
          return () => {
            if (notificationListener === listener) {
              notificationListener = undefined;
            }
          };
        },
      },
      now: () => 1000,
      onSessionUpdate: ({ title }) => {
        if (title) {
          titleUpdates.push(title);
        }
      },
    });

    await client.initialize();
    const replay = await client.loadSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "ACP session",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 950,
      executionMode: "default",
      status: "idle",
    });
    await client.refreshSession(store.getSession("acp:gemini", "session-1")!);

    expect(replay.lastAssistantMessage).toBe("Loaded replay response");
    expect(store.getSession("acp:gemini", "session-1")?.title).toBe(
      "Loaded Project Research",
    );
    expect(store.getSession("acp:gemini", "session-1")).toMatchObject({
      hasConversationHistory: true,
    });
    expect(
      readRawAcpSessionPayload("acp:gemini", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
    expect(titleUpdates).toEqual(["Loaded Project Research"]);
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
      hasConversationHistory: true,
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
    expect(updateEvents).toEqual([
      "agent_message_chunk",
      "agent_message_chunk",
    ]);
    expect(client.readReplay("session-1").lastAssistantMessage).toBe(
      "Replayed from load.Late replay from load.",
    );
  });

  it("does not write streaming transcript updates into ACP session metadata", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const upsertSession = vi.spyOn(store, "upsertSession");
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const upsertCountAfterStart = upsertSession.mock.calls.length;
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "hello",
      turnId: "turn-1",
    });
    const upsertCountAfterPrompt = upsertSession.mock.calls.length;

    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hel" },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "lo" },
    });

    expect(upsertSession.mock.calls.length).toBe(upsertCountAfterPrompt);
    expect(store.getSession("acp:kimi", session.sessionId)).toMatchObject({
      hasConversationHistory: true,
    });
    expect(
      readRawAcpSessionPayload("acp:kimi", session.sessionId)?.transcriptUpdates,
    ).toBeUndefined();
    expect(client.readReplay(session.sessionId).lastAssistantMessage).toBe("Hello");
    expect(upsertCountAfterStart).toBeGreaterThan(0);

    promptResponse.resolve({ turnId: "turn-1" });
    await Promise.resolve();
    await client.dispose();
  });

  it("strips legacy transcript updates when upserting stored sessions", () => {
    store.upsertSession({
      backendId: "acp:kimi",
      sessionId: "session-1",
      title: "ACP session",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      transcriptUpdates: [
        {
          receivedAt: 950,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Thinking " },
          },
        },
        {
          receivedAt: 975,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "hard." },
          },
        },
        {
          receivedAt: 1000,
          update: {
            sessionUpdate: "turn_finished",
          },
        },
      ],
    } as Parameters<AcpSessionStore["upsertSession"]>[0] & {
      transcriptUpdates: unknown[];
    });

    expect(store.getSession("acp:kimi", "session-1")).not.toHaveProperty(
      "transcriptUpdates",
    );
    expect(
      readRawAcpSessionPayload("acp:kimi", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
  });

  it("derives conversation metadata while stripping legacy transcript updates", () => {
    store.upsertSession({
      backendId: "acp:kimi",
      sessionId: "session-1",
      title: "ACP session",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      transcriptUpdates: [
        {
          receivedAt: 950,
          update: {
            kind: "pwragent_user_prompt",
            prompt: "hello",
          },
        },
      ],
    } as Parameters<AcpSessionStore["upsertSession"]>[0] & {
      transcriptUpdates: unknown[];
    });

    expect(store.getSession("acp:kimi", "session-1")).toMatchObject({
      hasConversationHistory: true,
    });
    expect(
      readRawAcpSessionPayload("acp:kimi", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
  });
});
