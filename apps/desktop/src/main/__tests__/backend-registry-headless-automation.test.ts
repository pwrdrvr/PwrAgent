import {
  createAgentOverlay,
  createOverlayStoreMock,
  MockBackendClient,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AgentEvent, AppServerPendingRequestNotification } from "@pwragent/shared";

describe("DesktopBackendRegistry", () => {
  it("refuses invalid automation models before creating a headless thread", async () => {
    const codexClient = new MockBackendClient({ models: [{ id: "gpt-6.1-terra" }] });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    try {
      await expect(registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "fixture", automationRunId: "fixture-run",
        model: "opus", input: [{ type: "text", text: "Inspect" }] }))
        .rejects.toThrow('model="opus" is not available');
      expect(codexClient.lastStartThreadParams).toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it("routes headless automation retry and failure notices to the visible Agent thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });
    await registry.startAutomationHeadlessTurn({
      backend: "codex",
      agentThreadId: "agent-thread-1",
      automationName: "Check email",
      automationRunId: "run-1",
      input: [{ type: "text", text: "Run the scheduled task." }],
    });

    await codexClient.emit({
      method: "error",
      params: {
        threadId: "thread-1", turnId: "turn-1", willRetry: true,
        error: { message: "Reconnecting" },
      },
    });
    await codexClient.emit({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "systemError" } },
    });
    await codexClient.emit({
      method: "turn/failed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "failed", error: { message: "Spend cap" } },
      },
    });

    expect(events.filter((event) =>
      event.notification.method === "error"
      || event.notification.method === "thread/status/changed"
      || event.notification.method === "turn/failed"
    )).toEqual([
      expect.objectContaining({ errorNoticeContext: {
        backend: "codex", threadId: "agent-thread-1", title: "Check email",
        automationName: "Check email",
      } }),
      expect.objectContaining({ errorNoticeContext: {
        backend: "codex", threadId: "agent-thread-1", title: "Check email",
        automationName: "Check email",
      } }),
      expect.objectContaining({ errorNoticeContext: {
        backend: "codex", threadId: "agent-thread-1", title: "Check email",
        automationName: "Check email",
      } }),
    ]);
    unsubscribe();
    await registry.close();
  });

  it("mirrors headless automation turn lifecycle onto the Agent thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    const started = await registry.startAutomationHeadlessTurn({
      backend: "codex",
      agentThreadId: "agent-thread-1",
      automationName: "Check email",
      automationRunId: "run-1",
      input: [{ type: "text", text: "Run the scheduled task." }],
    });

    expect(started).toEqual({
      backend: "codex",
      headlessThreadId: "thread-1",
      queueEntryId: "headless:run-1",
      threadId: "agent-thread-1",
      turnId: "turn-1",
    });
    expect(codexClient.lastStartThreadParams).toMatchObject({
      approvalPolicy: "never",
      ephemeral: true,
      sandbox: "workspace-write",
    });
    expect(codexClient.lastStartThreadParams?.threadSource).toBeUndefined();
    expect(codexClient.lastStartTurnParams).toMatchObject({
      approvalPolicy: "never",
      sandbox: "workspace-write",
      threadId: "thread-1",
    });
    expect(codexClient.lastStartTurnParams?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Access mode: Default Access (default)."),
      },
      { type: "text", text: "Run the scheduled task." },
    ]);
    expect(events).toEqual([
      {
        backend: "codex",
        notification: {
          method: "thread/turnQueue/updated",
          params: {
            threadId: "agent-thread-1",
            queueEntryId: "headless:run-1",
            origin: "automation",
            automationRunId: "run-1",
            automationName: "Check email",
            status: "started",
            backendThreadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
    ]);
    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 1,
      threadIds: [],
      automationRuns: [
        {
          agentThreadId: "agent-thread-1",
          automationName: "Check email",
          automationRunId: "run-1",
          backend: "codex",
          startedAt: expect.any(Number),
        },
      ],
    });

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [{ type: "text", text: "Automation finished." }],
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        notification: expect.objectContaining({
          method: "thread/turnQueue/updated",
          params: expect.objectContaining({ status: "started" }),
        }),
      }),
      {
        backend: "codex",
        notification: {
          method: "thread/turnQueue/updated",
          params: {
            threadId: "agent-thread-1",
            queueEntryId: "headless:run-1",
            origin: "automation",
            automationRunId: "run-1",
            automationName: "Check email",
            status: "terminal",
            turnId: "turn-1",
            finalText: "Automation finished.",
            terminalStatus: "turn/completed",
          },
        },
      },
      {
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Automation finished." }],
            },
          },
        },
        errorNoticeContext: {
          backend: "codex", threadId: "agent-thread-1", title: "Check email", automationName: "Check email",
        },
      },
    ]);
    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 0,
      threadIds: [],
    });

    unsubscribe();
    await registry.close();
  });

  it("reports only a headless automation turn's last message as its final text", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });
    await registry.startAutomationHeadlessTurn({
      backend: "codex",
      agentThreadId: "agent-thread-1",
      automationName: "Check email",
      automationRunId: "run-1",
      input: [{ type: "text", text: "Run the scheduled task." }],
    });

    // Claude's shape: every assistant message of the turn is its own part.
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [
            { type: "text", text: "Now checking the inbox." },
            { type: "text", text: "Two new messages. Reading them." },
            { type: "text", text: "No email needs a reply." },
            { type: "text", text: "  " },
          ],
        },
      },
    });

    expect(events).toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/turnQueue/updated",
        params: expect.objectContaining({
          status: "terminal",
          finalText: "No email needs a reply.",
        }),
      },
    });

    unsubscribe();
    await registry.close();
  });

  it("reports duplicate executions of one automation run as one quit blocker", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      startTurnResults: [
        { threadId: "ephemeral-1", turnId: "turn-1" },
        { threadId: "ephemeral-2", turnId: "turn-2" },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await Promise.all([
      registry.startAutomationHeadlessTurn({
        backend: "codex",
        agentThreadId: "agent-thread-1",
        automationName: "Search Bots",
        automationRunId: "run-1",
        input: [{ type: "text", text: "Run the task." }],
      }),
      registry.startAutomationHeadlessTurn({
        backend: "codex",
        agentThreadId: "agent-thread-1",
        automationName: "Search Bots",
        automationRunId: "run-1",
        input: [{ type: "text", text: "Run the task." }],
      }),
    ]);

    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 1,
      threadIds: [],
      automationRuns: [
        {
          agentThreadId: "agent-thread-1",
          automationName: "Search Bots",
          automationRunId: "run-1",
          backend: "codex",
          startedAt: expect.any(Number),
        },
      ],
    });

    await registry.close();
  });

  it("runs headless automations with the Agent thread's full access settings", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread-1": {
            backend: "codex",
            threadId: "agent-thread-1",
            executionMode: "full-access",
            extraLinkedDirectories: [
              {
                id: "/tmp/full-access-project",
                label: "Full Access Project",
                path: "/tmp/full-access-project",
                kind: "local",
              },
            ],
          },
        },
      }),
    });

    await registry.startAutomationHeadlessTurn({
      backend: "codex",
      agentThreadId: "agent-thread-1",
      automationName: "Check weather",
      automationRunId: "run-1",
      input: [{ type: "text", text: "Check whether it will rain." }],
    });

    expect(codexClient.lastStartThreadParams).toMatchObject({
      approvalPolicy: "never",
      cwd: "/tmp/full-access-project",
      ephemeral: true,
      sandbox: "danger-full-access",
    });
    expect(codexClient.lastStartThreadParams?.threadSource).toBeUndefined();
    expect(codexClient.lastStartTurnParams).toMatchObject({
      approvalPolicy: "never",
      cwd: "/tmp/full-access-project",
      sandbox: "danger-full-access",
      threadId: "thread-1",
    });
    expect(codexClient.lastStartTurnParams?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Access mode: Full Access (full-access)."),
      },
      { type: "text", text: "Check whether it will rain." },
    ]);

    await registry.close();
  });

  it("applies explicit headless automation profile overrides without changing approval policy", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          supportsFast: true,
          supportsReasoning: true,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread-1": {
            backend: "codex",
            threadId: "agent-thread-1",
            executionMode: "default",
            extraLinkedDirectories: [
              {
                id: "/tmp/default-project",
                label: "Default Project",
                path: "/tmp/default-project",
                kind: "local",
              },
            ],
          },
        },
      }),
    });

    await registry.startAutomationHeadlessTurn({
      backend: "codex",
      agentThreadId: "agent-thread-1",
      automationName: "Incident triage",
      automationRunId: "run-1",
      cwd: "/tmp/incident-bot",
      executionMode: "full-access",
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "priority",
      fastMode: true,
      input: [{ type: "text", text: "Investigate alert." }],
    });

    expect(codexClient.lastStartThreadParams).toMatchObject({
      approvalPolicy: "never",
      cwd: "/tmp/incident-bot",
      ephemeral: true,
      model: "gpt-5.4",
      reasoningEffort: "high",
      sandbox: "danger-full-access",
      serviceTier: "priority",
      fastMode: true,
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      approvalPolicy: "never",
      cwd: "/tmp/incident-bot",
      model: "gpt-5.4",
      reasoningEffort: "high",
      sandbox: "danger-full-access",
      serviceTier: "priority",
      fastMode: true,
      threadId: "thread-1",
    });
    expect(codexClient.lastStartTurnParams?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Access mode: Full Access (full-access)."),
      },
      { type: "text", text: "Investigate alert." },
    ]);

    await registry.close();
  });

  it("pre-approves an automation's allowed MCP server in Default Access", async () => {
    const codexClient = new MockBackendClient({});
    Object.assign(codexClient, {
      readConfiguredMcpServerNames: vi.fn(async () => ["datadog", "other"]),
      listMcpServers: vi.fn(async () => [
        { name: "datadog", authStatus: "oAuth", tools: ["get_metrics", "write_monitor"] },
        { name: "other", authStatus: "oAuth", tools: ["search"] },
      ]),
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "agent-thread-1", automationRunId: "run-1",
      executionMode: "default", mcpAllowlist: ["datadog"], toolAllowlist: ["get_metrics"],
      input: [{ type: "text", text: "Check Datadog." }],
    });
    expect(codexClient.lastStartThreadParams).toMatchObject({
      sandbox: "workspace-write", approvalPolicy: "never",
      config: { mcp_servers: {
        datadog: { enabled: true, required: true, enabled_tools: ["get_metrics"], default_tools_approval_mode: "approve", tools: { get_metrics: { approval_mode: "approve" } } },
        other: { enabled: false },
      } },
    });
    await registry.close();
  });

  it("publishes headless automation start before an early terminal notification", async () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const statuses: unknown[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "thread/turnQueue/updated") statuses.push(event.notification.params.status);
    });
    vi.spyOn(codexClient, "startTurn").mockImplementation(async ({ threadId }) => {
      await codexClient.emit({ method: "turn/completed", params: { threadId, turnId: "turn-1", turn: { id: "turn-1", status: "completed", output: [] } } });
      return { threadId, turnId: "turn-1" };
    });
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "agent-thread-1", automationRunId: "run-1",
      input: [{ type: "text", text: "Check Datadog." }],
    });
    expect(statuses).toEqual(["started", "terminal"]);
    await registry.close();
  });

  it("auto-cancels approval requests from headless automations", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await registry.startAutomationHeadlessTurn({
      backend: "codex",
      agentThreadId: "agent-thread-1",
      automationName: "Check weather",
      automationRunId: "run-1",
      input: [{ type: "text", text: "Check whether it will rain." }],
    });

    const response = await codexClient.emitRequest({
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "call-1",
        requestId: "approval-1",
        command: "curl https://example.com",
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({ decision: "cancel" });
    expect(events.map((event) => event.notification.method)).toEqual([
      "thread/turnQueue/updated",
    ]);

    unsubscribe();
    await registry.close();
  });

  it("handles namespace-less legacy automation calls without surfacing pending requests", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": createAgentOverlay("thread-1"),
        },
      }),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });
    registry.setAutomationInspectionHandler((request) => {
      expect(request).toEqual({
        operation: "list_automations",
        context: {
          backend: "codex",
          threadId: "thread-1",
        },
        args: {
          limit: 2,
        },
      });
      return {
        ok: true,
        operation: "list_automations",
        data: {
          automations: [],
        },
      };
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    events.length = 0;
    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: null,
        tool: "list_automations",
        arguments: {
          limit: 2,
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ automations: [] }, null, 2),
        },
      ],
    });
    expect(events).toEqual([]);

    unsubscribe();
    await registry.close();
  });

  it("rejects automation inspection dynamic tool calls that do not match an active turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const handler = vi.fn();
    registry.setAutomationInspectionHandler(handler);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread-2",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_automations",
        tool: "list_automations",
        arguments: {},
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "forbidden",
              message:
                "Automation inspection tool calls must originate from an active turn on the same thread.",
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(handler).not.toHaveBeenCalled();

    await registry.close();
  });

  it("returns a tool error for unknown PwrAgent automation dynamic tools", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": createAgentOverlay("thread-1"),
        },
      }),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    events.length = 0;

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_automations",
        tool: "unknown_tool",
        arguments: {},
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "unsupported_operation",
              message: "Unsupported PwrAgent automation tool.",
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(events).toEqual([]);

    unsubscribe();
    await registry.close();
  });
});
