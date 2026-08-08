import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  AcpBackendId,
  AgentEvent,
  AppServerPendingRequestNotification,
} from "@pwragent/shared";
import {
  AcpBackendAdapter,
  describeInstalledAcpBackend,
  isAcpSessionMissingForProjectError,
  withAcpModelRuntimeSelection,
  type AcpSessionMetadata,
} from "../app-server/acp-backend-adapter";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/acp-transcripts",
);

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

  it("advertises managed review for Kimi but not other ACP providers", () => {
    const kimi = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      backendId: "acp:kimi" as AcpBackendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
    });
    const gemini = describeInstalledAcpBackend(buildInstalledAgent());

    expect(kimi.capabilities.startReview).toBe(true);
    expect(gemini.capabilities.startReview).toBe(false);
  });

  it("advertises Grok 4.5 reasoning efforts in launchpad options", () => {
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      backendId: "acp:grok" as AcpBackendId,
      registryId: "grok",
      name: "Grok",
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        checkedAt: 1000,
        models: {
          currentModelId: "grok-4.5",
          availableModels: [
            {
              id: "grok-4.5",
              label: "Grok 4.5",
            },
          ],
        },
      },
    });

    expect(backend.launchpadOptions).toEqual({
      models: [
        {
          id: "grok-4.5",
          label: "Grok 4.5",
          current: true,
          defaultReasoningEffort: "high",
          reasoningEfforts: ["low", "medium", "high"],
          supportsReasoning: true,
        },
      ],
    });
  });

  it("advertises discovered Kimi 3 thinking levels in launchpad options", () => {
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      backendId: "acp:kimi" as AcpBackendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        checkedAt: 1000,
        models: {
          currentModelId: "kimi-code/kimi-for-coding",
          availableModels: [
            {
              id: "kimi-code/kimi-for-coding",
              label: "K2.7 Coding",
              supportsReasoning: false,
            },
            {
              id: "kimi-code/k3",
              label: "K3",
              defaultReasoningEffort: "high",
              reasoningEfforts: ["low", "high", "max"],
              supportsReasoning: true,
            },
          ],
        },
      },
    });

    expect(backend.launchpadOptions).toEqual({
      models: [
        {
          id: "kimi-code/kimi-for-coding",
          label: "K2.7 Coding",
          current: true,
          defaultReasoningEffort: undefined,
          reasoningEfforts: undefined,
          supportsReasoning: false,
        },
        {
          id: "kimi-code/k3",
          label: "K3",
          current: false,
          defaultReasoningEffort: "high",
          reasoningEfforts: ["low", "high", "max"],
          supportsReasoning: true,
        },
      ],
    });
  });

  it("projects Kimi model reasoning into its thought-level config option", () => {
    expect(
      withAcpModelRuntimeSelection({
        runtime: {
          configValues: {
            model: "kimi-code/kimi-for-coding",
            thinking: "on",
          },
          updatedAt: 500,
        },
        runtimeCapabilities: {
          schemaVersion: 1,
          status: "discovered",
          checkedAt: 1000,
          configOptions: [
            {
              id: "model",
              label: "Model",
              category: "model",
              type: "select",
              currentValue: "kimi-code/kimi-for-coding",
              values: [
                {
                  value: "kimi-code/kimi-for-coding",
                  label: "K2.7 Coding",
                },
                { value: "kimi-code/k3", label: "K3" },
              ],
            },
            {
              id: "thinking",
              label: "Thinking",
              category: "thought_level",
              type: "select",
              currentValue: "on",
              values: [
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
                { value: "max", label: "Max" },
              ],
            },
          ],
          models: {
            currentModelId: "kimi-code/kimi-for-coding",
            availableModels: [
              {
                id: "kimi-code/k3",
                reasoningEfforts: ["low", "high", "max"],
                supportsReasoning: true,
              },
            ],
          },
        },
        model: "kimi-code/k3",
        reasoningEffort: "max",
        now: 1000,
      }),
    ).toEqual({
      configValues: {
        model: "kimi-code/k3",
        thinking: "max",
      },
      reasoningEffort: "max",
      updatedAt: 1000,
    });
  });

  it("suppresses hardcoded execution modes for Kimi once it advertises runtime modes (#658)", () => {
    // Kimi exposes its own Default/Plan/Auto/Yolo runtime modes. Surfacing the
    // hardcoded Default/Full Access modes too produced a second, overlapping
    // dropdown — and the legacy /yolo path they drove is rejected by current
    // kimi. The runtime modes must be the single source.
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      backendId: "acp:kimi" as AcpBackendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        checkedAt: 1000,
        configOptions: [
          {
            id: "approval-mode",
            label: "Permission mode",
            type: "select",
            category: "mode",
            currentValue: "default",
            values: [
              { value: "default", label: "Default" },
              { value: "yolo", label: "Yolo" },
            ],
          },
        ],
      },
    });

    expect(backend.executionModes).toEqual([]);
  });

  it("suppresses hardcoded execution modes when Kimi advertises modes via SessionModeState (#658)", () => {
    // Kimi's real shape: modes arrive as an ACP SessionModeState
    // (runtimeCapabilities.modes.availableModes), NOT as a configOptions entry.
    // The suppression must cover this form too, or the duplicate dropdown
    // survives on actual kimi.
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      backendId: "acp:kimi" as AcpBackendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        checkedAt: 1000,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", label: "Default" },
            { id: "yolo", label: "Yolo" },
          ],
        },
      },
    });

    expect(backend.executionModes).toEqual([]);
  });

  it("keeps execution modes when only a single runtime mode is advertised", () => {
    // Mainline kimi advertises ONLY "default" (a single mode = no real
    // selector), so there's no runtime dropdown to defer to.
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      backendId: "acp:kimi" as AcpBackendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        checkedAt: 1000,
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", label: "Default" }],
        },
      },
    });

    expect(backend.executionModes.map((mode) => mode.mode)).toEqual([
      "default",
      "full-access",
    ]);
  });

  it("falls back to hardcoded execution modes for Kimi with no runtime mode selector", () => {
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      backendId: "acp:kimi" as AcpBackendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
    });

    expect(backend.executionModes.map((mode) => mode.mode)).toEqual([
      "default",
      "full-access",
    ]);
  });

  it("keeps hardcoded execution modes for Grok (no runtime mode selector)", () => {
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      backendId: "acp:grok" as AcpBackendId,
      registryId: "grok",
      name: "Grok CLI",
    });

    expect(backend.executionModes.map((mode) => mode.mode)).toEqual([
      "default",
      "full-access",
    ]);
  });
});

describe("isAcpSessionMissingForProjectError", () => {
  it("treats provider Unknown sessionId errors as rebindable missing sessions", () => {
    expect(
      isAcpSessionMissingForProjectError(
        new Error(
          'json-rpc error (-32602): Invalid params: Unknown sessionId: stable-thread-id: {"sessionId":"stable-thread-id"}',
        ),
      ),
    ).toBe(true);
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
      version: "0.30.0",
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

    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "turn_completed",
      outputText: "Build succeeded",
      usage: {
        inputTokens: 1_200,
        cachedReadTokens: 1_000,
        outputTokens: 50,
        reasoningTokens: 10,
        totalTokens: 1_250,
        modelUsage: {
          "grok-4.5-build": {
            inputTokens: 1_200,
            outputTokens: 50,
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        backend: backendId,
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: session.sessionId,
            turnId: "turn-1",
            model: "grok-4.5-build",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 1_200,
                cached_input_tokens: 1_000,
                output_tokens: 50,
                reasoning_output_tokens: 10,
                total_tokens: 1_250,
              },
            },
          },
        },
      });
    });

    await adapter.close();
  });

  it("emits ACP thought chunks with the same commentary phase used in replay", async () => {
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
    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "The build setup is straightforward." },
    });

    await vi.waitFor(() => {
      expect(
        events
          .filter(
            (event) => event.notification.method === "item/agentMessage/delta",
          )
          .map((event) =>
            event.notification.method === "item/agentMessage/delta"
              ? event.notification.params
              : undefined,
          ),
      ).toEqual([
        {
          threadId: session.sessionId,
          turnId: "turn-1",
          itemId: "assistant:turn-1:0",
          delta: "I should inspect the build setup.",
          phase: "commentary",
        },
        {
          threadId: session.sessionId,
          turnId: "turn-1",
          itemId: "assistant:turn-1:1",
          delta: "The build setup is straightforward.",
          phase: "final",
        },
      ]);
    });
    await expect(
      adapter.readReplay(backendId, session.sessionId),
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          id: "user:turn-1",
          role: "user",
          text: "Inspect this",
        }),
        expect.objectContaining({
          id: "assistant:turn-1:0",
          role: "assistant",
          phase: "commentary",
          text: "I should inspect the build setup.",
        }),
        expect.objectContaining({
          id: "assistant:turn-1:1",
          role: "assistant",
          phase: "final",
          text: "The build setup is straightforward.",
        }),
      ],
    });

    await adapter.close();
  });

  it("does not emit Grok thoughts as live or replayable text", async () => {
    const backendId = "acp:grok" as AcpBackendId;
    const transport = new FakeAcpAgentTransport();
    const events: AgentEvent[] = [];
    const sessions: AcpSessionMetadata[] = [];
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "grok",
      name: "Grok CLI",
      launchDescriptor: {
        backendId,
        registryId: "grok",
        distributionKind: "local",
        command: "grok",
        args: ["agent", "stdio"],
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

    const firstThoughtChunks = [
      "The ",
      "code ",
      "seems ",
      "to ",
      "be ",
      "over ",
      "here",
      ".",
    ];
    for (const [index, text] of firstThoughtChunks.entries()) {
      transport.emitSessionUpdate(session.sessionId, {
        session_update: "agent_thought_chunk",
        content: { type: "text", text },
      });
      if (index === 0) {
        transport.emitSessionUpdate(session.sessionId, {
          session_update: "available_commands_update",
          available_commands: [
            {
              name: "review",
              description: "Review the current changes",
            },
          ],
        });
      }
    }
    const completedToolUpdate = {
      session_update: "tool_call",
      tool_call_id: "tool-1",
      title: "cat package.json",
      status: "completed",
    };
    transport.emitSessionUpdate(session.sessionId, completedToolUpdate);
    for (const [index, text] of [
      "So ",
      "the ",
      "key ",
      "logic is:\n```",
    ].entries()) {
      transport.emitSessionUpdate(session.sessionId, {
        session_update: "agent_thought_chunk",
        content: { type: "text", text },
      });
      if (index === 0) {
        transport.emitSessionUpdate(session.sessionId, completedToolUpdate);
      }
    }
    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "The image flag is disabled." },
    });

    await vi.waitFor(() => {
      expect(
        events
          .filter(
            (event) => event.notification.method === "item/agentMessage/delta",
          )
          .map((event) => event.notification),
      ).toEqual([
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: session.sessionId,
            turnId: "turn-1",
            itemId: "assistant:turn-1:0",
            delta: "The image flag is disabled.",
            phase: "final",
          },
        },
      ]);
    });
    expect(
      events.filter(
        (event) =>
          event.notification.method === "item/transientMessage/updated",
      ),
    ).toEqual([]);
    expect(
      events.filter(
        (event) =>
          event.notification.method === "thread/availableCommands/updated",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.notification.method === "item/completed",
      ),
    ).toHaveLength(1);
    expect(client.readReplay(session.sessionId).messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Inspect this",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "The image flag is disabled.",
      }),
    ]);

    await adapter.close();
  });

  it("does not emit replayed ACP assistant text without a live turn", async () => {
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

    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_thought_chunk",
      content: { type: "text", text: "This is prior turn thinking." },
    });
    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "This is a prior turn answer." },
    });
    await Promise.resolve();

    expect(
      events.filter(
        (event) => event.notification.method === "item/agentMessage/delta",
      ),
    ).toEqual([]);

    await adapter.close();
  });

  it("does not emit Qwen thought chunks as live assistant response text", async () => {
    const backendId = "acp:qwen" as AcpBackendId;
    const transport = new FakeAcpAgentTransport();
    const events: AgentEvent[] = [];
    const sessions: AcpSessionMetadata[] = [];
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "qwen",
      name: "Qwen Code",
      launchDescriptor: {
        backendId,
        registryId: "qwen",
        distributionKind: "local",
        command: "qwen",
        args: ["--experimental-acp"],
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
      executionMode: "full-access",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Does it build?",
      turnId: "turn-1",
    });

    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_thought_chunk",
      content: { type: "text", text: "I should run the build first." },
    });
    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "Yes, it builds." },
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
            delta: "Yes, it builds.",
            phase: "final",
          },
        },
      });
    });
    expect(
      events.filter(
        (event) =>
          event.notification.method === "item/agentMessage/delta" &&
          event.notification.params.delta === "I should run the build first.",
      ),
    ).toEqual([]);

    await adapter.close();
  });

  it("emits cumulative Qwen usage across fixture-backed model calls", async () => {
    const backendId = "acp:qwen" as AcpBackendId;
    const transport = new FakeAcpAgentTransport();
    const events: AgentEvent[] = [];
    const sessions: AcpSessionMetadata[] = [];
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "qwen",
      name: "Qwen Code",
      launchDescriptor: {
        backendId,
        registryId: "qwen",
        distributionKind: "local",
        command: "qwen",
        args: ["--experimental-acp"],
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
      executionMode: "full-access",
      acpRuntime: {
        currentModelId: "qwen3-coder-plus",
      },
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "What is this project?",
      turnId: "turn-usage",
    });
    const updates = JSON.parse(
      readFileSync(path.join(fixtureDir, "qwen-tool-usage.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    for (const update of updates) {
      transport.emitSessionUpdate(session.sessionId, update);
    }

    await vi.waitFor(() => {
      expect(
        events.filter(
          (event) =>
            event.notification.method === "thread/tokenUsage/updated",
        ),
      ).toHaveLength(1);
    });
    const usageEvents = events.filter(
      (event) => event.notification.method === "thread/tokenUsage/updated",
    );
    expect(usageEvents.at(-1)).toEqual({
      backend: backendId,
      notification: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: session.sessionId,
          turnId: "turn-usage",
          model: "qwen3-coder-plus",
          tokenUsage: {
            last_token_usage: {
              input_tokens: 48_851,
              cached_input_tokens: 20_000,
              output_tokens: 322,
              reasoning_output_tokens: 49,
              total_tokens: 49_173,
            },
          },
        },
      },
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
    expect(
      events
        .filter(
          (event) => event.notification.method === "item/agentMessage/delta",
        )
        .map((event) =>
          event.notification.method === "item/agentMessage/delta"
            ? event.notification.params.phase
            : undefined,
        ),
    ).toEqual(["commentary", "commentary"]);

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

  it("does not make a thread newly active when session/load refreshes ACP runtime", async () => {
    const backendId = "acp:grok" as AcpBackendId;
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
      },
      "session/load": {
        models: {
          currentModelId: "grok-4.5",
          availableModels: [{ modelId: "grok-4.5" }],
        },
      },
    });
    const sessions: AcpSessionMetadata[] = [
      {
        backendId,
        sessionId: "session-1",
        title: "Grok session",
        cwd: "/repo",
        createdAt: 900,
        updatedAt: 950,
        executionMode: "default",
        status: "idle",
      },
    ];
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "grok",
      name: "Grok",
      launchDescriptor: {
        backendId,
        registryId: "grok",
        distributionKind: "local",
        command: "grok",
        args: [],
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
        getSession: (_backend, sessionId) =>
          sessions.find((session) => session.sessionId === sessionId),
        upsertSession: (metadata) => {
          const index = sessions.findIndex(
            (session) => session.sessionId === metadata.sessionId,
          );
          sessions[index] = metadata;
        },
      },
      captureStores: [],
      createAcpTransport: () => ({
        request: async (method, params, timeoutMs) => {
          if (method === "session/load") {
            transport.emitSessionUpdate("session-1", {
              kind: "current_mode_update",
              currentModeId: "yolo",
            });
          }
          return await transport.request(method, params, timeoutMs);
        },
        notify: async (method, params) => await transport.notify(method, params),
        close: async () => await transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
        onRequest: (listener) => transport.onRequest(listener),
      }),
      emit: vi.fn(async () => undefined),
      handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
    });

    const client = await adapter.getClient(backendId);
    await client.loadSession(sessions[0]!);
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
    ]);

    await vi.waitFor(() => {
      expect(sessions[0]).toMatchObject({
        acpRuntime: {
          currentModelId: "grok-4.5",
          currentModeId: "yolo",
        },
        updatedAt: 950,
      });
    });
    await adapter.close();
  });

  it("does not emit live tool notifications while replaying session/load history", async () => {
    const backendId = "acp:grok" as AcpBackendId;
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
      },
    });
    const events: AgentEvent[] = [];
    const sessions: AcpSessionMetadata[] = [
      {
        backendId,
        sessionId: "session-1",
        title: "Grok session",
        cwd: "/repo",
        createdAt: 900,
        updatedAt: 950,
        executionMode: "default",
        status: "idle",
        hasConversationHistory: true,
      },
    ];
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "grok",
      name: "Grok",
      launchDescriptor: {
        backendId,
        registryId: "grok",
        distributionKind: "local",
        command: "grok",
        args: [],
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
        getSession: (_backend, sessionId) =>
          sessions.find((session) => session.sessionId === sessionId),
        upsertSession: (metadata) => {
          sessions[0] = metadata;
        },
      },
      captureStores: [],
      createAcpTransport: () => ({
        request: async (method, params, timeoutMs) => {
          if (method === "session/load") {
            transport.emitSessionUpdate("session-1", {
              session_update: "tool_call",
              tool_call_id: "tool-1",
              title: "Read README.md",
              kind: "read",
              status: "in_progress",
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "tool_call_update",
              tool_call_id: "tool-1",
              title: "Read README.md",
              kind: "read",
              status: "completed",
            });
          }
          return await transport.request(method, params, timeoutMs);
        },
        notify: async (method, params) => await transport.notify(method, params),
        close: async () => await transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
        onRequest: (listener) => transport.onRequest(listener),
      }),
      emit: async (event) => {
        events.push(event);
      },
      handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
    });

    const client = await adapter.getClient(backendId);
    const replay = await client.loadSession(sessions[0]!);

    expect(replay.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        id: "tool-1",
        createdAt: expect.any(Number),
        status: "completed",
      }),
    ]);
    expect(
      events.filter((event) =>
        event.notification.method === "item/started"
        || event.notification.method === "item/completed",
      ),
    ).toEqual([]);

    await adapter.close();
  });

  it("retains fallback rollout history until provider replay is verified", async () => {
    for (const registryId of ["grok", "qwen", "kimi"] as const) {
      const backendId = `acp:${registryId}` as AcpBackendId;
      const appendUpdate = vi.fn();
      const transport = new FakeAcpAgentTransport();
      const sessions: AcpSessionMetadata[] = [];
      const agent: AcpInstalledAgentRecord = {
        ...buildInstalledAgent(),
        backendId,
        registryId,
        name: registryId,
        launchDescriptor: {
          backendId,
          registryId,
          distributionKind: "local",
          command: registryId,
          args: [],
          env: {},
        },
      };
      const adapter = new AcpBackendAdapter({
        acpAgentStore: {
          getInstalledAgent: () => agent,
          listInstalledAgents: () => [agent],
          upsertInstalledAgent: vi.fn(),
        },
        acpRolloutStore: {
          appendUpdate,
          readUpdates: vi.fn(() => []),
          readReplay: vi.fn(() => ({
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          })),
        },
        acpSessionStore: {
          listSessions: () => sessions,
          getSession: (_backend, sessionId) =>
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
        discoverLocalAcpAgents: async () => [],
        emit: vi.fn(async () => undefined),
        handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
      });

      const client = await adapter.getClient(backendId);
      const session = await client.startSession({
        cwd: "/repo",
        executionMode: "default",
      });
      client.startPrompt({
        sessionId: session.sessionId,
        prompt: "Tell me about this project",
        turnId: "turn-1",
      });
      await vi.waitFor(() => {
        expect(
          transport.requests.some((request) => request.method === "session/prompt"),
        ).toBe(true);
      });

      expect(appendUpdate).toHaveBeenCalled();
      await adapter.close();
    }
  });

  it("adds Grok billing metadata from an active ACP connection", async () => {
    const backendId = "acp:grok" as AcpBackendId;
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: {
          name: "Grok",
          version: "0.2.113",
        },
      },
      "_x.ai/billing": {
        config: {
          creditUsagePercent: 42.5,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            end: "2026-08-03T00:00:00Z",
          },
        },
        subscription_tier: "SuperGrok Heavy",
      },
    });
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "grok",
      name: "Grok",
      launchDescriptor: {
        backendId,
        registryId: "grok",
        distributionKind: "local",
        command: "grok",
        args: ["agent", "stdio"],
        env: {},
      },
    };
    const emit = vi.fn(async () => undefined);
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
      discoverLocalAcpAgents: async () => [],
      emit,
      handleServerRequest: async () => ({ decision: "accept" }),
      isAcpAgentEnabled: () => true,
    });

    await adapter.getClient(backendId);
    const [initialSummary] = await adapter.describeInstalledBackends();
    expect(initialSummary?.account).toBeUndefined();

    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith({
        backend: backendId,
        notification: {
          method: "backend/providerStatus/updated",
          params: { backend: backendId },
        },
      });
    });
    const [summary] = await adapter.describeInstalledBackends();

    expect(summary).toMatchObject({
      account: {
        type: "provider",
        label: "Grok account",
        planType: "SuperGrok Heavy",
      },
      rateLimits: [
        {
          name: "Weekly limit",
          usedPercent: 42.5,
          resetAt: Date.parse("2026-08-03T00:00:00Z"),
        },
      ],
    });
    expect(transport.requests).toContainEqual({
      method: "_x.ai/billing",
      params: {},
      timeoutMs: 20_000,
    });
    expect(
      transport.requests.filter((request) => request.method === "_x.ai/billing"),
    ).toHaveLength(1);

    await adapter.close();
  });

  it("does not block backend discovery while Grok billing is pending", async () => {
    const backendId = "acp:grok" as AcpBackendId;
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "grok",
      name: "Grok",
    };
    const readProviderStatus = vi.fn(
      async () => await new Promise<never>(() => undefined),
    );
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
      createAcpClient: () =>
        ({
          initialize: vi.fn(async () => undefined),
          readProviderStatus,
          dispose: vi.fn(async () => undefined),
        }) as never,
      discoverLocalAcpAgents: async () => [],
      emit: vi.fn(async () => undefined),
      handleServerRequest: async () => ({ decision: "accept" }),
      isAcpAgentEnabled: () => true,
    });

    await adapter.getClient(backendId);
    const [summary] = await adapter.describeInstalledBackends();
    await adapter.describeInstalledBackends();

    expect(summary?.kind).toBe(backendId);
    expect(summary?.account).toBeUndefined();
    expect(readProviderStatus).toHaveBeenCalledTimes(1);

    await adapter.close();
  });

  it("registers the agent-tool HTTP MCP from initialize capabilities", async () => {
    const backendId = "acp:kimi" as AcpBackendId;
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          mcpCapabilities: {
            http: true,
          },
        },
      },
    });
    const sessions: AcpSessionMetadata[] = [];
    const bindThread = vi.fn();
    const registerClient = vi.fn(async () => ({
      server: {
        name: "pwragent",
        type: "http" as const,
        url: "http://127.0.0.1:43210/mcp",
        headers: [
          {
            name: "Authorization",
            value: "Bearer test-token",
          },
        ],
      },
      bindThread,
    }));
    const closeMcpServer = vi.fn(async () => undefined);
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
          sessions.push(metadata);
        },
      },
      agentToolMcpServer: {
        registerClient,
        close: closeMcpServer,
      },
      captureStores: [],
      createAcpTransport: () => transport,
      emit: vi.fn(async () => undefined),
      handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
    });

    const client = await adapter.getClient(backendId);
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    expect(registerClient).toHaveBeenCalledWith({
      backend: backendId,
      threadId: undefined,
    });
    expect(
      transport.requests.find((request) => request.method === "session/new")
        ?.params,
    ).toEqual({
      cwd: "/repo",
      mcpServers: [
        {
          name: "pwragent",
          type: "http",
          url: "http://127.0.0.1:43210/mcp",
          headers: [
            {
              name: "Authorization",
              value: "Bearer test-token",
            },
          ],
        },
      ],
    });
    expect(bindThread).toHaveBeenCalledWith(session.sessionId);

    await adapter.close();
    expect(closeMcpServer).toHaveBeenCalledOnce();
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

  it("reads Gemini history from rollout, not its session/load <session_context> replay", async () => {
    // Regression: Gemini advertises loadSession=true but does NOT replay the
    // transcript on session/load — it only re-emits its <session_context>
    // boilerplate as a single user message. On a cold reload (no cached
    // client) the adapter used to trust that 1-entry provider replay and show
    // ONLY the session_context, dropping the whole conversation. Because Gemini
    // lacks sessionHistoryReplay, the adapter must prefer our durable rollout
    // (which captured the real turns) over that bogus provider replay. (It
    // still calls session/load to RESUME the agent session for continuation —
    // it just doesn't trust its replay as history.)
    const backendId = "acp:gemini" as AcpBackendId;
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "gemini",
      name: "Gemini CLI",
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        agentCapabilities: {
          // Can resume the session (for continuing the chat) but does not
          // replay history — exactly Gemini's shape.
          loadSession: true,
        },
      },
    };
    const session: AcpSessionMetadata = {
      backendId,
      sessionId: "session-1",
      title: "Gemini thread",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    };
    const rolloutReplay = {
      entries: [
        {
          type: "message" as const,
          id: "user:1",
          role: "user" as const,
          text: "What is this project?",
          createdAt: 1001,
        },
        {
          type: "message" as const,
          id: "assistant:1",
          role: "assistant" as const,
          text: "It is PwrSnap.",
          createdAt: 1002,
        },
      ],
      messages: [
        {
          id: "user:1",
          role: "user" as const,
          text: "What is this project?",
          createdAt: 1001,
        },
        {
          id: "assistant:1",
          role: "assistant" as const,
          text: "It is PwrSnap.",
          createdAt: 1002,
        },
      ],
      lastAssistantMessage: "It is PwrSnap.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle" as const,
    };
    // What Gemini's session/load returns: just the boilerplate context, as a
    // single user message. If the adapter ever trusts this, the test fails.
    const loadSession = vi.fn(async () => ({
      entries: [
        {
          type: "message" as const,
          id: "user:ctx",
          role: "user" as const,
          text: "<session_context>…</session_context>",
          createdAt: 999,
        },
      ],
      messages: [
        {
          id: "user:ctx",
          role: "user" as const,
          text: "<session_context>…</session_context>",
          createdAt: 999,
        },
      ],
      lastAssistantMessage: undefined,
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
        readReplay: vi.fn(() => rolloutReplay),
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

    const result = await adapter.readReplay(backendId, "session-1");
    // The real conversation from the rollout — not the lone session_context.
    expect(result.messages).toHaveLength(2);
    expect(result.lastAssistantMessage).toBe("It is PwrSnap.");
    expect(
      result.messages.some((message) =>
        message.text?.includes("session_context"),
      ),
    ).toBe(false);
    // session/load is still invoked to resume the agent session, but its
    // bogus <session_context> replay is discarded in favor of the rollout.
    expect(loadSession).toHaveBeenCalled();

    await adapter.close();
  });

  it("prefers session/load history observed through ACP notifications", async () => {
    const backendId = "acp:grok" as AcpBackendId;
    const agent: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "grok",
      name: "Grok",
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        agentCapabilities: {
          loadSession: true,
        },
      },
    };
    const session: AcpSessionMetadata = {
      backendId,
      sessionId: "session-1",
      title: "Grok thread",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    };
    const rolloutReplay = {
      entries: [
        {
          type: "message" as const,
          id: "assistant:rollout",
          role: "assistant" as const,
          text: "Stale rollout reply",
          createdAt: 1001,
        },
      ],
      messages: [
        {
          id: "assistant:rollout",
          role: "assistant" as const,
          text: "Stale rollout reply",
          createdAt: 1001,
        },
      ],
      lastAssistantMessage: "Stale rollout reply",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle" as const,
    };
    const providerReplay = {
      entries: [
        {
          type: "message" as const,
          id: "user:provider",
          role: "user" as const,
          text: "Timestamped provider prompt",
          createdAt: 1001,
        },
        {
          type: "message" as const,
          id: "assistant:provider",
          role: "assistant" as const,
          phase: "final" as const,
          text: "Timestamped provider reply",
          createdAt: 1002,
        },
      ],
      messages: [
        {
          id: "user:provider",
          role: "user" as const,
          text: "Timestamped provider prompt",
          createdAt: 1001,
        },
        {
          id: "assistant:provider",
          role: "assistant" as const,
          text: "Timestamped provider reply",
          createdAt: 1002,
        },
      ],
      lastUserMessage: "Timestamped provider prompt",
      lastAssistantMessage: "Timestamped provider reply",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle" as const,
    };
    const loadSession = vi.fn(async () => providerReplay);
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        getInstalledAgent: () => agent,
        listInstalledAgents: () => [agent],
        upsertInstalledAgent: vi.fn(),
      },
      acpRolloutStore: {
        appendUpdate: vi.fn(),
        readUpdates: vi.fn(() => []),
        readReplay: vi.fn(() => rolloutReplay),
      },
      acpSessionStore: {
        listSessions: () => [session],
        getSession: () => session,
        upsertSession: vi.fn(),
      },
      captureStores: [],
      createAcpClient: () =>
        ({
          didSessionLoadReplayHistory: () => true,
          dispose: vi.fn(async () => undefined),
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
          refreshSession: vi.fn(async () => undefined),
        }) as never,
      emit: vi.fn(async () => undefined),
      handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
    });

    const replay = await adapter.readReplay(backendId, "session-1");
    expect(replay).toMatchObject({
      lastAssistantMessage: "Timestamped provider reply",
    });
    expect(replay.entries.map((entry) => entry.turn)).toEqual([
      {
        id: "inferred:user:provider",
        status: "completed",
        startedAt: 1001,
        completedAt: 1002,
        durationMs: 1,
      },
      {
        id: "inferred:user:provider",
        status: "completed",
        startedAt: 1001,
        completedAt: 1002,
        durationMs: 1,
      },
    ]);
    expect(loadSession).toHaveBeenCalledOnce();

    await adapter.close();
  });

  it("falls back to rollout history when Kimi session/load returns no replay", async () => {
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
          // Real Kimi replays history via session/load, so the adapter calls
          // it; this case exercises the empty-replay -> rollout fallback.
          loadSession: true,
          sessionHistoryReplay: true,
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

  it("bounds close while ACP initialization is pending", async () => {
    vi.useFakeTimers();
    try {
      const backendId = "acp:gemini" as AcpBackendId;
      const agent = buildInstalledAgent();
      const initialize = vi.fn(() => new Promise<void>(() => undefined));
      const dispose = vi.fn(async () => undefined);
      const adapter = new AcpBackendAdapter({
        acpAgentStore: {
          getInstalledAgent: () => agent,
          listInstalledAgents: () => [agent],
          upsertInstalledAgent: vi.fn(),
        },
        captureStores: [],
        closeTimeoutMs: 25,
        createAcpClient: () => ({ initialize, dispose }) as never,
        discoverLocalAcpAgents: async () => [],
        emit: vi.fn(async () => undefined),
        handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
      });

      void adapter.getClient(backendId).catch(() => undefined);
      await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
      const close = adapter.close();
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(25);

      await expect(close).resolves.toBeUndefined();
      await expect(adapter.getClient(backendId)).rejects.toThrow(
        "ACP backend adapter is closed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a cached Kimi model catalog with a legacy-CLI diagnostic", async () => {
    const backendId = "acp:kimi" as AcpBackendId;
    const cached: AcpInstalledAgentRecord = {
      ...buildInstalledAgent(),
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      version: "1.46.0",
      activeCommand: "/Users/me/.local/bin/kimi",
      launchDescriptor: {
        backendId,
        registryId: "kimi",
        distributionKind: "local",
        command: "/Users/me/.local/bin/kimi",
        args: ["acp"],
        env: {},
      },
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        models: {
          currentModelId: "kimi-code/kimi-for-coding",
          availableModels: [
            { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding" },
          ],
        },
      },
    };
    const diagnostic: AcpInstalledAgentRecord = {
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      version: "1.46.0",
      distributionKind: "local",
      distributionSource: "/Users/me/.local/bin/kimi (legacy kimi-cli ignored)",
      installStatus: "unavailable",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "local-kimi-cli",
      installedAt: 2000,
      updatedAt: 2000,
      lastError: "Legacy Python kimi-cli was found and ignored.",
      instances: [],
      incompatibleInstances: [
        {
          command: "/Users/me/.local/bin/kimi",
          version: "1.46.0",
          source: "path",
        },
      ],
    };
    const upsertInstalledAgent = vi.fn();
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        getInstalledAgent: () => cached,
        listInstalledAgents: () => [cached],
        upsertInstalledAgent,
      },
      captureStores: [],
      discoverLocalAcpAgents: async () => [diagnostic],
      emit: vi.fn(async () => undefined),
      handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
    });

    await expect(adapter.describeInstalledBackends()).resolves.toEqual([
      expect.objectContaining({
        kind: backendId,
        available: false,
        unavailableReason: diagnostic.lastError,
        acp: expect.objectContaining({
          installStatus: "unavailable",
          runtime: undefined,
        }),
        launchpadOptions: undefined,
      }),
    ]);
    expect(upsertInstalledAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        installStatus: "unavailable",
        incompatibleInstances: diagnostic.incompatibleInstances,
      }),
    );

    await adapter.close();
  });

  it("does not create an ACP client when discovery finishes after close", async () => {
    const backendId = "acp:gemini" as AcpBackendId;
    const agent = buildInstalledAgent();
    let finishDiscovery:
      | ((agents: AcpInstalledAgentRecord[]) => void)
      | undefined;
    const createAcpClient = vi.fn();
    const adapter = new AcpBackendAdapter({
      acpAgentStore: null,
      captureStores: [],
      createAcpClient,
      discoverLocalAcpAgents: () =>
        new Promise((resolve) => {
          finishDiscovery = resolve;
        }),
      emit: vi.fn(async () => undefined),
      handleServerRequest: vi.fn(async () => ({ decision: "accept" })),
    });

    const pendingClient = adapter.getClient(backendId);
    await Promise.resolve();
    await adapter.close();
    finishDiscovery?.([agent]);

    await expect(pendingClient).rejects.toThrow("ACP backend adapter is closed");
    expect(createAcpClient).not.toHaveBeenCalled();
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
