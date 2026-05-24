import { describe, expect, it, vi } from "vitest";
import type {
  AcpBackendId,
  AgentEvent,
  AppServerPendingRequestNotification,
} from "@pwragent/shared";
import {
  AcpBackendAdapter,
  describeInstalledAcpBackend,
  type AcpSessionMetadata,
} from "../app-server/acp-backend-adapter";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";

describe("describeInstalledAcpBackend", () => {
  it("does not advertise session/load when the agent reports it is unsupported", () => {
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        agentCapabilities: {
          loadSession: false,
        },
        checkedAt: 1000,
      },
    });

    expect(backend.methods).toEqual([
      "session/new",
      "session/prompt",
      "session/cancel",
    ]);
  });

  it("keeps session/load advertised for agents without explicit load capability data", () => {
    const backend = describeInstalledAcpBackend(buildInstalledAgent());

    expect(backend.methods).toContain("session/load");
  });

  it("advertises session/load for Kimi unless the agent reports it is unsupported", () => {
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      backendId: "acp:kimi" as AcpBackendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
    });

    expect(backend.methods).toContain("session/load");
  });
});

describe("AcpBackendAdapter", () => {
  it("passes the installed agent name to ACP approval prompts", async () => {
    const backendId = "acp:kimi" as AcpBackendId;
    const transport = new FakeAcpAgentTransport();
    const events: AgentEvent[] = [];
    const sessions: AcpSessionMetadata[] = [];
    const requests: AppServerPendingRequestNotification[] = [];
    const agent: AcpInstalledAgentRecord = {
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      version: "1.44.0",
      distributionKind: "local",
      distributionSource: "kimi acp",
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "local-kimi-cli",
      installedAt: 1000,
      updatedAt: 1000,
      launchDescriptor: {
        backendId,
        registryId: "kimi",
        distributionKind: "local",
        command: "kimi",
        args: ["acp"],
        env: {},
      },
    };
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        getInstalledAgent: () => agent,
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: vi.fn(),
      },
      acpSessionStore: {
        listSessions: () => sessions,
        getSession: (_backendId, sessionId) =>
          sessions.find((session) => session.sessionId === sessionId),
        upsertSession: (metadata) => {
          const index = sessions.findIndex(
            (session) => session.sessionId === metadata.sessionId,
          );
          if (index >= 0) {
            sessions[index] = metadata;
          } else {
            sessions.push(metadata);
          }
        },
      },
      captureStores: [],
      createAcpTransport: () => transport,
      emit: async (event) => {
        events.push(event);
      },
      handleServerRequest: async (_requestBackend, request) => {
        requests.push(request);
        return { decision: "accept" };
      },
    });

    const client = await adapter.getClient(backendId);
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Run npm view openclaw",
      turnId: "turn-1",
    });

    await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "run_shell_command_1",
          kind: "execute",
          title: "npm view openclaw",
        },
        options: [{ optionId: "proceed_once", kind: "allow_once" }],
      },
      0,
    );

    expect(requests[0]?.params.prompt).toBe(
      "Kimi Code CLI wants to run execute: npm view openclaw",
    );
    expect(requests[0]?.params.reason).toBe(
      "Kimi Code CLI wants to run execute: npm view openclaw",
    );

    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "You only live once! All actions will be auto-approved.",
      },
    });
    await vi.waitFor(() => {
      expect(sessions[0]?.executionMode).toBe("full-access");
    });
    expect(events).toContainEqual({
      backend: backendId,
      notification: {
        method: "thread/executionMode/updated",
        params: {
          threadId: session.sessionId,
          executionMode: "full-access",
        },
      },
    });

    await adapter.close();
  });

  it("coalesces unchanged ACP live tool notifications", async () => {
    const backendId = "acp:kimi" as AcpBackendId;
    const transport = new FakeAcpAgentTransport();
    const events: AgentEvent[] = [];
    const sessions: AcpSessionMetadata[] = [];
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      launchDescriptor: {
        backendId,
        registryId: "kimi",
        distributionKind: "local",
        command: "kimi",
        args: ["acp"],
        env: {},
      },
    };
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        getInstalledAgent: () => agent,
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: vi.fn(),
      },
      acpSessionStore: {
        listSessions: () => sessions,
        getSession: (_backendId, sessionId) =>
          sessions.find((session) => session.sessionId === sessionId),
        upsertSession: (metadata) => {
          const index = sessions.findIndex(
            (session) => session.sessionId === metadata.sessionId,
          );
          if (index >= 0) {
            sessions[index] = metadata;
          } else {
            sessions.push(metadata);
          }
        },
      },
      captureStores: [],
      createAcpTransport: () => transport,
      emit: async (event) => {
        events.push(event);
      },
      handleServerRequest: async () => ({ decision: "accept" }),
    });

    const client = await adapter.getClient(backendId);
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Build",
      turnId: "turn-1",
    });

    for (let index = 0; index < 5; index += 1) {
      transport.emitSessionUpdate(session.sessionId, {
        session_update: "tool_call_update",
        tool_call_id: "turn-1:tool-1",
        title: "pnpm build",
        status: "in_progress",
      });
    }

    const itemStartedEvents = events.filter(
      (event) => event.notification.method === "item/started",
    );
    expect(itemStartedEvents).toHaveLength(1);
    expect(itemStartedEvents[0]?.notification.params).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          id: "turn-1:tool-1",
          status: "in_progress",
        }),
      }),
    );

    transport.emitSessionUpdate(session.sessionId, {
      session_update: "tool_call_update",
      tool_call_id: "turn-1:tool-1",
      title: "pnpm build",
      status: "completed",
      content: { type: "text", text: "Build succeeded" },
    });

    expect(
      events.filter((event) => event.notification.method === "item/completed"),
    ).toHaveLength(1);

    await adapter.close();
  });

  it("emits ACP thought chunks as live assistant response text", async () => {
    const backendId = "acp:kimi" as AcpBackendId;
    const transport = new FakeAcpAgentTransport();
    const events: AgentEvent[] = [];
    const sessions: AcpSessionMetadata[] = [];
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      launchDescriptor: {
        backendId,
        registryId: "kimi",
        distributionKind: "local",
        command: "kimi",
        args: ["acp"],
        env: {},
      },
    };
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        getInstalledAgent: () => agent,
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: vi.fn(),
      },
      acpSessionStore: {
        listSessions: () => sessions,
        getSession: (_backendId, sessionId) =>
          sessions.find((session) => session.sessionId === sessionId),
        upsertSession: (metadata) => {
          const index = sessions.findIndex(
            (session) => session.sessionId === metadata.sessionId,
          );
          if (index >= 0) {
            sessions[index] = metadata;
          } else {
            sessions.push(metadata);
          }
        },
      },
      captureStores: [],
      createAcpTransport: () => transport,
      emit: async (event) => {
        events.push(event);
      },
      handleServerRequest: async () => ({ decision: "accept" }),
    });

    const client = await adapter.getClient(backendId);
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Inspect this",
      turnId: "turn-1",
    });

    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_thought_chunk",
      content: { type: "text", text: "I should inspect the build setup." },
    });

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        backend: backendId,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: session.sessionId,
            turnId: "turn-1",
            itemId: "assistant:turn-1:0",
            delta: "I should inspect the build setup.",
          },
        },
      });
    });

    await adapter.close();
  });

  it("uses separate live assistant item ids for ACP text separated by tools", async () => {
    const backendId = "acp:kimi" as AcpBackendId;
    const transport = new FakeAcpAgentTransport();
    const events: AgentEvent[] = [];
    const sessions: AcpSessionMetadata[] = [];
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      launchDescriptor: {
        backendId,
        registryId: "kimi",
        distributionKind: "local",
        command: "kimi",
        args: ["acp"],
        env: {},
      },
    };
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        getInstalledAgent: () => agent,
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: vi.fn(),
      },
      acpSessionStore: {
        listSessions: () => sessions,
        getSession: (_backendId, sessionId) =>
          sessions.find((session) => session.sessionId === sessionId),
        upsertSession: (metadata) => {
          const index = sessions.findIndex(
            (session) => session.sessionId === metadata.sessionId,
          );
          if (index >= 0) {
            sessions[index] = metadata;
          } else {
            sessions.push(metadata);
          }
        },
      },
      captureStores: [],
      createAcpTransport: () => transport,
      emit: async (event) => {
        events.push(event);
      },
      handleServerRequest: async () => ({ decision: "accept" }),
    });

    const client = await adapter.getClient(backendId);
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "does it build?",
      turnId: "turn-1",
    });

    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_thought_chunk",
      content: { type: "text", text: "I will inspect the scripts." },
    });
    transport.emitSessionUpdate(session.sessionId, {
      session_update: "tool_call",
      tool_call_id: "tool-1",
      title: "cat package.json",
      status: "completed",
    });
    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_thought_chunk",
      content: { type: "text", text: "Now I will run the build." },
    });

    await vi.waitFor(() => {
      expect(
        events
          .filter(
            (event) => event.notification.method === "item/agentMessage/delta",
          )
          .map((event) =>
            event.notification.method === "item/agentMessage/delta"
              ? event.notification.params.itemId
              : undefined,
          ),
      ).toEqual(["assistant:turn-1:0", "assistant:turn-1:1"]);
    });

    await adapter.close();
  });

  it("emits a backend update when ACP runtime capabilities are discovered", async () => {
    const backendId = "acp:kimi" as AcpBackendId;
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
        models: {
          currentModelId: "kimi-code/kimi-for-coding,thinking",
          availableModels: [
            {
              modelId: "kimi-code/kimi-for-coding,thinking",
              name: "kimi-for-coding (thinking)",
            },
          ],
        },
      },
    });
    const events: AgentEvent[] = [];
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      launchDescriptor: {
        backendId,
        registryId: "kimi",
        distributionKind: "local",
        command: "kimi",
        args: ["acp"],
        env: {},
      },
    };
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        getInstalledAgent: () => agent,
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: vi.fn(),
      },
      acpSessionStore: {
        listSessions: () => [],
        getSession: () => undefined,
        upsertSession: vi.fn(),
      },
      captureStores: [],
      createAcpTransport: () => transport,
      emit: async (event) => {
        events.push(event);
      },
      handleServerRequest: async () => ({ decision: "accept" }),
    });

    await adapter.getClient(backendId);

    expect(events).toContainEqual({
      backend: backendId,
      notification: {
        method: "backend/acpRuntimeCapabilities/updated",
        params: {
          backend: backendId,
        },
      },
    });

    await adapter.close();
  });

  it("reads Kimi replay from local rollout history instead of session/load", async () => {
    const backendId = "acp:kimi" as AcpBackendId;
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        agentCapabilities: {
          loadSession: false,
        },
      },
    };
    const session: AcpSessionMetadata = {
      backendId,
      sessionId: "session-1",
      title: "Kimi thread",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    };
    const replay = {
      entries: [
        {
          type: "message" as const,
          id: "assistant:1",
          role: "assistant" as const,
          text: "Restored from rollout",
          createdAt: 1001,
        },
      ],
      messages: [
        {
          id: "assistant:1",
          role: "assistant" as const,
          text: "Restored from rollout",
          createdAt: 1001,
        },
      ],
      lastAssistantMessage: "Restored from rollout",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle" as const,
    };
    const loadSession = vi.fn();
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        getInstalledAgent: () => agent,
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: vi.fn(),
      },
      acpRolloutStore: {
        appendUpdate: vi.fn(),
        readUpdates: vi.fn(() => []),
        readReplay: vi.fn(() => replay),
      },
      acpSessionStore: {
        listSessions: () => [session],
        getSession: () => session,
        upsertSession: vi.fn(),
      },
      captureStores: [],
      createAcpClient: () =>
        ({
          initialize: vi.fn(async () => undefined),
          loadSession,
          readReplay: vi.fn(() => ({
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
            threadStatus: "idle",
          })),
        }) as never,
      emit: vi.fn(async () => undefined),
      handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
    });

    await expect(adapter.readReplay(backendId, "session-1")).resolves.toMatchObject({
      lastAssistantMessage: "Restored from rollout",
    });
    expect(loadSession).not.toHaveBeenCalled();

    await adapter.close();
  });

  it("falls back to rollout history when Kimi session/load returns no replay", async () => {
    const backendId = "acp:kimi" as AcpBackendId;
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
    };
    const session: AcpSessionMetadata = {
      backendId,
      sessionId: "session-1",
      title: "Kimi thread",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    };
    const replay = {
      entries: [
        {
          type: "message" as const,
          id: "assistant:1",
          role: "assistant" as const,
          text: "Restored from rollout",
          createdAt: 1001,
        },
      ],
      messages: [
        {
          id: "assistant:1",
          role: "assistant" as const,
          text: "Restored from rollout",
          createdAt: 1001,
        },
      ],
      lastAssistantMessage: "Restored from rollout",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle" as const,
    };
    const loadSession = vi.fn(async () => ({
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle" as const,
    }));
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        getInstalledAgent: () => agent,
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: vi.fn(),
      },
      acpRolloutStore: {
        appendUpdate: vi.fn(),
        readUpdates: vi.fn(() => []),
        readReplay: vi.fn(() => replay),
      },
      acpSessionStore: {
        listSessions: () => [session],
        getSession: () => session,
        upsertSession: vi.fn(),
      },
      captureStores: [],
      createAcpClient: () =>
        ({
          initialize: vi.fn(async () => undefined),
          loadSession,
          readReplay: vi.fn(() => ({
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
            threadStatus: "idle",
          })),
          dispose: vi.fn(async () => undefined),
          refreshSession: vi.fn(async () => undefined),
        }) as never,
      emit: vi.fn(async () => undefined),
      handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
    });

    await expect(adapter.readReplay(backendId, "session-1")).resolves.toMatchObject({
      lastAssistantMessage: "Restored from rollout",
    });
    expect(loadSession).toHaveBeenCalled();

    await adapter.close();
  });
});

function buildInstalledAgent(): AcpInstalledAgentRecord {
  return {
    backendId: "acp:gemini" as AcpBackendId,
    registryId: "gemini",
    name: "Gemini CLI",
    distributionKind: "local",
    distributionSource: "gemini",
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    allowlistRuleId: "local-gemini-cli",
    installedAt: 1000,
    updatedAt: 1000,
  };
}
