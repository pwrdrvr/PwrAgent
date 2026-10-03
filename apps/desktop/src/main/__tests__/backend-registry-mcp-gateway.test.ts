import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_AUTO_APPROVAL_SETTINGS, type DesktopMcpAutoApprovalSettings, type AppServerPendingRequestNotification, type AppServerTurnInputItem, type AgentEvent, type ThreadExecutionMode } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { attachSqliteWriteMetrics, isSqliteWriteMetricsEnabled, measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import type { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import type { AcpBackendAdapter } from "../app-server/acp-backend-adapter";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { McpGatewayInvocation } from "../mcp-connections/mcp-gateway-catalog";

describe("backend MCP gateway dispatch", () => {
  let directory: string;
  let db: StateDb;
  let store: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  let operation: ReturnType<typeof vi.fn<McpConnectionGatewayService["requestGatewayToolOperation"]>>;
  let startTurn: ReturnType<typeof vi.fn<() => Promise<{ threadId: string; turnId: string }>>>;
  let startThread: ReturnType<typeof vi.fn<() => Promise<{ threadId: string }>>>;
  let readConfiguredMcpServerNames: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
  let reviewerSettings: DesktopMcpAutoApprovalSettings;
  const reviewModel = vi.fn(async (_request: unknown) => ({ status: "ok", object: { action: "decline", content: null as Record<string, unknown> | null, reason: "Unauthorized." } }));
  let registerBridge: ReturnType<typeof vi.fn<McpConnectionGatewayService["registerBridge"]>>;
  let internals: {
    activeTurnKeys: Set<string>;
    activeCodexTurnModes: Map<string, ThreadExecutionMode>;
    activeMcpReviewTasks: Map<string, string>;
    rememberMcpReviewSteering(backend: "codex", threadId: string, turnId: string, input: readonly AppServerTurnInputItem[]): void;
    acpBackend: AcpBackendAdapter;
    codexClient: { readConfiguredMcpServerNames?: () => Promise<string[]> };
    approveGatewayInvocation(invocation: McpGatewayInvocation, context: AgentToolCallContext, signal: AbortSignal): Promise<boolean>;
    headlessAutomationTurns: Map<string, {
      agentThreadId: string;
      backend: "codex";
      automationRunId: string;
      executionMode: ThreadExecutionMode;
      executionThreadId: string;
      queueEntryId: string;
      startedAt: number;
      mcpConnectionIds?: string[];
      toolAllowlist?: string[];
    }>;
    handleServerRequest(backend: "codex", request: AppServerPendingRequestNotification): Promise<{ success: boolean; contentItems: unknown[] }>;
    pendingServerRequests: Map<string, unknown>;
  };
  const args = { connectionId: "one", toolName: "lookup", schemaRevision: "r1", arguments: { id: "fixture" } };
  const request = (tool: string, arguments_: Record<string, unknown>, callId = "call-1"): AppServerPendingRequestNotification => ({
    method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", requestId: callId, callId, namespace: "pwragent", tool, arguments: arguments_ },
  });

  beforeEach(async () => {
    reviewerSettings = { ...DEFAULT_MCP_AUTO_APPROVAL_SETTINGS };
    reviewModel.mockReset();
    reviewModel.mockResolvedValue({ status: "ok", object: { action: "decline", content: null, reason: "Unauthorized." } });
    directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-gateway-dispatch-"));
    db = StateDb.open(path.join(directory, "state.db"));
    store = new SqliteOverlayStore(db);
    await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: ["one"] });
    operation = vi.fn(async (params) => params.operation === "gateway/tools/list"
      ? [{ connectionId: "one", serverName: "Fixture", toolName: "lookup", schemaRevision: "r1", definition: {
          name: "lookup", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        } }]
      : { content: [{ type: "text", text: "fixture result" }] });
    startTurn = vi.fn(async () => ({ threadId: "headless-1", turnId: "turn-1" }));
    startThread = vi.fn(async () => ({ threadId: "headless-1" }));
    readConfiguredMcpServerNames = vi.fn(async () => []);
    registerBridge = vi.fn<McpConnectionGatewayService["registerBridge"]>(async () => ({
      server: { name: "one", command: "fixture", args: [], env: {} },
      bindThread: vi.fn(), revoke: vi.fn(),
    }));
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }), listThreads: async () => [],
        onNotification: () => () => {}, onPendingRequest: () => () => {},
        readConfiguredMcpServerNames, startThread,
        startTurn, generateStructuredObject: reviewModel,
      } as never,
      overlayStore: store, isBootstrapMode: () => false,
      resolveMcpAutoApprovalSettings: () => reviewerSettings,
      mcpConnectionService: { registerBridge, requestGatewayToolOperation: operation },
    });
    internals = registry as unknown as typeof internals;
    internals.activeTurnKeys.add("codex:thread-1:turn-1");
  });

  afterEach(async () => {
    await registry.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function approval() {
    let resolve!: (event: AgentEvent) => void;
    const event = new Promise<AgentEvent>((done) => { resolve = done; });
    registry.onEvent((value) => { if (value.notification.method === "mcpServer/elicitation/request") resolve(value); });
    return event;
  }

  function declineUnexpectedApproval() {
    const events: AgentEvent[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      await registry.submitServerRequest({
        backend: "codex", threadId: "thread-1", turnId: "turn-1",
        requestId: String(event.notification.params.requestId),
        response: { action: "decline", content: null, _meta: null },
      });
    });
    return events;
  }

  it("uses the reviewer for automation tool calls and honors rejection before invocation", async () => {
    reviewerSettings.enabled = true;
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "auto-review", input: [{ type: "text", text: "Read fixture health." }], mcpAllowlist: ["one"], mcpApproval: { tools: "auto" } });
    internals.activeTurnKeys.add("codex:headless-1:turn-1");
    await internals.handleServerRequest("codex", { ...request("search_mcp_tools", {}, "review-search"), params: { ...request("search_mcp_tools", {}, "review-search").params, threadId: "headless-1" } });
    const result = await internals.handleServerRequest("codex", { ...request("call_mcp_tool", args), params: { ...request("call_mcp_tool", args).params, threadId: "headless-1" } });
    expect(result.success).toBe(false);
    expect(reviewModel, JSON.stringify(result)).toHaveBeenCalledOnce();
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(0);
    // An empty Codex model follows Settings → Helper model.
    expect(reviewModel.mock.calls[0][0]).toMatchObject({ helper: "mcp_auto_review", model: undefined, disableExecution: true, prompt: expect.stringContaining("Read fixture health.") });
    expect(JSON.stringify(result)).toContain("The approval reviewer declined this MCP tool call: Unauthorized.");
  });

  it("answers an allowed automation MCP question using the configured reviewer", async () => {
    reviewerSettings.enabled = true;
    reviewModel.mockResolvedValue({ status: "ok", object: { action: "accept", content: { region: "us" }, reason: "Task specifies US." } });
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "question-review", input: [{ type: "text", text: "Investigate US health." }], mcpAllowlist: ["one"], mcpApproval: { questions: "auto" } });
    const result = await internals.handleServerRequest("codex", {
      method: "mcpServer/elicitation/request",
      params: { threadId: "headless-1", turnId: "turn-1", requestId: "review-question", serverName: "one", mode: "form", message: "Choose region", requestedSchema: { type: "object", properties: { region: { type: "string", enum: ["us", "eu"] } }, required: ["region"] }, _meta: null },
    });
    expect(result).toEqual({ action: "accept", content: { region: "us" }, _meta: null });
    expect(reviewModel).toHaveBeenCalledOnce();
  });

  it("uses the escalation prompt for Default Access command approvals", async () => {
    reviewerSettings = { ...reviewerSettings, enabled: true, reviewEscalations: true, prompt: "Monitoring policy", escalationPrompt: "Check exact shell and file effects" };
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "escalation", executionMode: "default", input: [{ type: "text", text: "Inspect fixture files." }] });
    expect(await internals.handleServerRequest("codex", { method: "item/commandExecution/requestApproval", params: { threadId: "headless-1", turnId: "turn-1", requestId: "cmd-review", command: "rm fixture.txt" } })).toEqual({ decision: "decline" });
    expect(reviewModel.mock.calls[0][0]).toMatchObject({ system: expect.stringContaining("Check exact shell and file effects") });
    expect(JSON.stringify(reviewModel.mock.calls[0][0])).not.toContain("Monitoring policy");
  });

  it("leaves an interactive Default Access escalation to its operator", async () => {
    reviewerSettings = { ...reviewerSettings, enabled: true, reviewEscalations: true };
    internals.activeCodexTurnModes.set("thread-1:turn-1", "default");
    internals.activeTurnKeys.add("codex:thread-1:turn-1");
    const pending = new Promise<AgentEvent>((resolve) => {
      registry.onEvent((event) => { if (event.notification.method === "item/commandExecution/requestApproval") resolve(event); });
    });
    void internals.handleServerRequest("codex", { method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", requestId: "interactive-escalation", command: "cat fixture.txt" } });
    expect((await pending).notification.params).toMatchObject({ requestId: "interactive-escalation" });
    expect(reviewModel).not.toHaveBeenCalled();
  });

  it("keeps a run in its sandbox when escalation review is chosen but the reviewer is off", async () => {
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "escalation-off", executionMode: "default", mcpApproval: { escalations: "auto" }, input: [{ type: "text", text: "Inspect fixture files." }] });
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ approvalPolicy: "never" }));
  });

  it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"] as const)("returns the protocol acceptance value for %s", async (method) => {
    reviewerSettings = { ...reviewerSettings, enabled: true, reviewEscalations: true };
    reviewModel.mockResolvedValue({ status: "ok", object: { action: "accept", content: null, reason: "Authorized." } });
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "accepted-escalation", executionMode: "default", input: [{ type: "text", text: "Inspect fixture files." }] });
    expect(await internals.handleServerRequest("codex", { method, params: { threadId: "headless-1", turnId: "turn-1", requestId: "accepted-escalation", command: "cat fixture.txt" } })).toEqual({ decision: "accept" });
  });

  it.each(["invocation", "question", "escalation"] as const)("uses current automation intent for subsequent %s reviews after steering", async (kind) => {
    reviewerSettings = { ...reviewerSettings, enabled: true, reviewEscalations: true };
    const task = "Read fixture health.";
    const steering = "Do not read fixture health.";
    reviewModel.mockImplementation(async (request) => {
      const input = JSON.parse((request as { prompt: string }).prompt) as { task?: string };
      return { status: "ok", object: { action: input.task?.includes(steering) ? "decline" : "accept", content: kind === "question" ? {} : null, reason: "Current task policy." } };
    });
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "updated-intent", executionMode: "default", mcpReviewTask: task, mcpAllowlist: ["one"], mcpApproval: { tools: "auto", questions: "auto" }, input: [{ type: "text", text: "Incoming monitoring alert." }] });
    expect(internals.activeMcpReviewTasks.get("codex:headless-1")).toBe(task);
    internals.rememberMcpReviewSteering("codex", "headless-1", "turn-1", [{ type: "text", text: steering }]);
    if (kind === "invocation") {
      await expect(internals.approveGatewayInvocation({ ...args, serverName: "Fixture" }, { backend: "codex", threadId: "headless-1", turnId: "turn-1", transport: "codex_dynamic_tool" }, new AbortController().signal)).rejects.toThrow("The approval reviewer declined this MCP tool call: Current task policy.");
    } else if (kind === "question") {
      expect(await internals.handleServerRequest("codex", { method: "mcpServer/elicitation/request", params: { threadId: "headless-1", turnId: "turn-1", requestId: "updated-intent", serverName: "one", mode: "form", message: "Read health?", requestedSchema: { type: "object", properties: {} }, _meta: null } })).toEqual({ action: "decline", content: null, _meta: null });
    } else {
      expect(await internals.handleServerRequest("codex", { method: "item/commandExecution/requestApproval", params: { threadId: "headless-1", turnId: "turn-1", requestId: "updated-intent", command: "cat fixture.txt" } })).toEqual({ decision: "decline" });
    }
    expect(reviewModel).toHaveBeenCalledOnce();
    const input = JSON.parse((reviewModel.mock.calls[0][0] as { prompt: string }).prompt) as { task: string };
    expect(input.task).toContain(task);
    expect(input.task).toContain(steering);
    expect(input.task).not.toContain("Incoming monitoring alert.");
  });

  it.each([
    ["deny", "failed"], ["auto", "failed"], ["backend", "failed"],
    ["deny", "unavailable"], ["auto", "unavailable"], ["backend", "unavailable"],
  ] as const)("rejects %s policy startup when inherited server inventory is %s", async (tools, availability) => {
    if (availability === "failed") readConfiguredMcpServerNames.mockRejectedValue(new Error("Inventory failed."));
    else delete internals.codexClient.readConfiguredMcpServerNames;
    await expect(registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "inventory-failed", mcpApproval: { tools }, input: [{ type: "text", text: "Inspect fixture health." }] })).rejects.toThrow("cannot report configured MCP servers");
    expect(startThread).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect((await registerBridge.mock.results[0].value)?.revoke).toHaveBeenCalledOnce();
  });

  it("retains unrestricted legacy startup when inherited inventory is unavailable", async () => {
    delete internals.codexClient.readConfiguredMcpServerNames;
    await expect(registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "legacy-inventory", input: [{ type: "text", text: "Inspect fixture health." }] })).resolves.toMatchObject({ headlessThreadId: "headless-1" });
    expect(startTurn).toHaveBeenCalledOnce();
  });

  it("rejects a helper answer produced by a model other than the selected reviewer", async () => {
    reviewerSettings = { ...reviewerSettings, enabled: true, reviewEscalations: true, model: "gpt-6-luna" };
    reviewModel.mockResolvedValue({ status: "ok", object: { action: "accept", content: null, reason: "Authorized." }, model: "another-model" } as never);
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "model-mismatch", executionMode: "default", input: [{ type: "text", text: "Inspect fixture files." }] });
    expect(await internals.handleServerRequest("codex", { method: "item/commandExecution/requestApproval", params: { threadId: "headless-1", turnId: "turn-1", requestId: "model-mismatch", command: "cat fixture.txt" } })).toEqual({ decision: "decline" });
  });

  it("cancels an in-flight approval when steering changes the task", async () => {
    reviewerSettings = { ...reviewerSettings, enabled: true, reviewEscalations: true };
    let finish!: (answer: Awaited<ReturnType<typeof reviewModel>>) => void;
    let started!: () => void;
    const reviewing = new Promise<void>((resolve) => { started = resolve; });
    reviewModel.mockImplementation(() => {
      started();
      return new Promise((resolve) => { finish = resolve; });
    });
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "steering", executionMode: "default", input: [{ type: "text", text: "Inspect fixture files." }] });
    const response = internals.handleServerRequest("codex", { method: "item/commandExecution/requestApproval", params: { threadId: "headless-1", turnId: "turn-1", requestId: "steering", command: "cat fixture.txt" } });
    await reviewing;
    internals.rememberMcpReviewSteering("codex", "headless-1", "turn-1", [{ type: "text", text: "Stop inspecting files." }]);
    expect(await response).toEqual({ decision: "cancel" });
    finish({ status: "ok", object: { action: "accept", content: null, reason: "Old task." } });
    expect(internals.activeMcpReviewTasks.get("codex:headless-1")).toContain("Stop inspecting files.");
  });

  it("does not review a question from a server outside the automation allowlist", async () => {
    reviewerSettings.enabled = true;
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "scope", input: [{ type: "text", text: "Inspect fixture health." }], mcpAllowlist: ["one"] });
    expect(await internals.handleServerRequest("codex", { method: "mcpServer/elicitation/request", params: { threadId: "headless-1", turnId: "turn-1", requestId: "out-of-scope", serverName: "other", mode: "form", message: "Approve this unrelated action?", requestedSchema: { type: "object", properties: {} }, _meta: null } })).toMatchObject({ action: "cancel" });
    expect(reviewModel).not.toHaveBeenCalled();
  });

  it("discards an accepted answer when the selected connection is removed during review", async () => {
    reviewerSettings.enabled = true;
    reviewModel.mockImplementation(async () => {
      await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
      return { status: "ok", object: { action: "accept", content: {}, reason: "OK" } };
    });
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "revoke", input: [{ type: "text", text: "Inspect fixture health." }], mcpAllowlist: ["one"] });
    expect(await internals.handleServerRequest("codex", { method: "mcpServer/elicitation/request", params: { threadId: "headless-1", turnId: "turn-1", requestId: "revoked", serverName: "one", mode: "form", message: "Continue?", requestedSchema: { type: "object", properties: {} }, _meta: null } })).toMatchObject({ action: "cancel" });
    expect(reviewModel).toHaveBeenCalledOnce();
  });

  it("honors an automation's reject tool policy even in Full Access", async () => {
    reviewerSettings.enabled = true;
    await registry.startAutomationHeadlessTurn({ backend: "codex", agentThreadId: "thread-1", automationRunId: "deny", executionMode: "full-access", input: [{ type: "text", text: "Inspect fixture health." }], mcpAllowlist: ["one"], mcpApproval: { tools: "deny" } });
    expect(await internals.approveGatewayInvocation({ connectionId: "one", serverName: "Fixture", toolName: "lookup", schemaRevision: "r1", arguments: {} }, { backend: "codex", threadId: "headless-1", turnId: "turn-1", transport: "codex_dynamic_tool" }, new AbortController().signal)).toBe(false);
    expect(reviewModel).not.toHaveBeenCalled();
  });

  it("reviews ordinary Auto gateway calls and adds no SQLite writes", async () => {
    reviewerSettings.enabled = true;
    reviewModel.mockResolvedValue({ status: "ok", object: { action: "accept", content: null, reason: "Authorized read." } });
    await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "auto" });
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    const { writes } = await measureSqliteWrites(async () => {
      await internals.handleServerRequest("codex", request("search_mcp_tools", {}, "auto-discover"));
      expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args, "auto-call"))).success).toBe(true);
    });
    expect(reviewModel).toHaveBeenCalledOnce();
    expectSqliteWriteBudget({ scenario: "mcp-gateway-discovery-and-invocation", note: "MCP review uses an isolated model adapter and in-memory pending decisions without additional SQLite commits.", writes });
  });

  it("invokes a selected MCP tool without a prompt in Full Access", async () => {
    await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "full-access" });
    const events = declineUnexpectedApproval();
    const result = await internals.handleServerRequest("codex", request("call_mcp_tool", args));
    expect(result.success).toBe(true);
    expect(events).toEqual([]);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(1);
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it("uses the active turn's Full Access when the saved mode differs", async () => {
    internals.activeCodexTurnModes.set("thread-1:turn-1", "full-access");
    const events = declineUnexpectedApproval();
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(true);
    expect(events).toEqual([]);
  });

  it.each(["default", "auto"] as const)("keeps gateway confirmation for an active %s turn even with a saved Full Access mode", async (mode) => {
    await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "full-access" });
    internals.activeCodexTurnModes.set("thread-1:turn-1", mode);
    const events = declineUnexpectedApproval();
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(false);
    expect(events).toHaveLength(1);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(0);
  });

  it.each(["full-access", "default", "auto"] as const)("honors %s for a headless automation's gateway call", async (mode) => {
    internals.headlessAutomationTurns.set("codex:thread-1:turn-1", {
      agentThreadId: "automation-1", backend: "codex", automationRunId: "run-1",
      executionMode: mode, executionThreadId: "thread-1", queueEntryId: "queue-1", startedAt: 1,
    });
    const events = declineUnexpectedApproval();
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(mode === "full-access");
    expect(events).toEqual([]);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(mode === "full-access" ? 1 : 0);
  });

  it.each(["default", "auto"] as const)("pre-approves selected automation tools during turn startup in %s", async (executionMode) => {
    const events = declineUnexpectedApproval();
    startTurn.mockImplementation(async () => {
      internals.activeTurnKeys.add("codex:headless-1:turn-1");
      const call = request("call_mcp_tool", args);
      const result = await internals.handleServerRequest("codex", { ...call, params: { ...call.params, threadId: "headless-1" } });
      expect(result.success).toBe(true);
      return { threadId: "headless-1", turnId: "turn-1" };
    });
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      executionMode, mcpAllowlist: ["one"], toolAllowlist: ["lookup"], input: [{ type: "text", text: "Look up the fixture." }],
    });
    expect(events).toEqual([]);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(1);
    expect(internals.pendingServerRequests.size).toBe(0);
    const bridge = await registerBridge.mock.results[0].value;
    expect(bridge.bindThread).toHaveBeenCalledWith("headless-1");
    await registry.close();
    expect(bridge.revoke).toHaveBeenCalled();
  });

  it("rejects an automation tool outside its allowlist even in Full Access", async () => {
    internals.headlessAutomationTurns.set("codex:thread-1:turn-1", {
      agentThreadId: "thread-1", backend: "codex", automationRunId: "run-1", executionMode: "full-access",
      executionThreadId: "thread-1", queueEntryId: "queue-1", startedAt: 1, mcpConnectionIds: ["one"], toolAllowlist: ["other_tool"],
    });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(false);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(0);
  });

  it("rechecks the Agent's selection before an automation invocation", async () => {
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: ["one"], input: [{ type: "text", text: "Look up the fixture." }],
    });
    await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
    internals.activeTurnKeys.add("codex:headless-1:turn-1");
    const call = request("call_mcp_tool", args);
    expect((await internals.handleServerRequest("codex", { ...call, params: { ...call.params, threadId: "headless-1" } })).success).toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });

  it("revokes automation bridge grants if turn startup fails", async () => {
    startTurn.mockRejectedValue(new Error("fixture start failure"));
    await expect(registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: ["one"], input: [{ type: "text", text: "Look up the fixture." }],
    })).rejects.toThrow("fixture start failure");
    const bridge = await registerBridge.mock.results[0].value;
    expect(bridge.revoke).toHaveBeenCalledOnce();
    expect(internals.headlessAutomationTurns.size).toBe(0);
    expect(internals.activeMcpReviewTasks.has("codex:headless-1")).toBe(false);
  });

  it("cancels upstream MCP questions even when the automation pre-approves that server", async () => {
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: ["one"], input: [{ type: "text", text: "Look up the fixture." }],
    });
    expect(await internals.handleServerRequest("codex", {
      method: "mcpServer/elicitation/request",
      params: { threadId: "headless-1", turnId: "turn-1", requestId: "question-1", serverName: "Fixture", mode: "form", message: "Enter a verification code", requestedSchema: { type: "object", properties: { code: { type: "string" } } }, _meta: null },
    })).toEqual({ action: "cancel", content: null, _meta: null });
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it.each([
    { mode: "form" as const, requestedSchema: { type: "object" as const, properties: {} } },
    { mode: "form" as const, requestedSchema: { type: "object" as const, properties: { region: { type: "string" } }, required: ["region"] } },
    { mode: "url" as const, url: "https://example.com/authorize", elicitationId: "auth-1" },
  ])("leaves upstream MCP $mode elicitation interactive in Full Access", async (shape) => {
    await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode: "full-access" });
    const pending = approval();
    const response = internals.handleServerRequest("codex", {
      method: "mcpServer/elicitation/request",
      params: { threadId: "thread-1", turnId: "turn-1", requestId: "upstream-1", serverName: "Fixture", message: "Please confirm or answer", _meta: null, ...shape },
    });
    await pending;
    expect(internals.pendingServerRequests.size).toBe(1);
    await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: "upstream-1", response: { action: "cancel", content: null, _meta: null } });
    expect(await response).toEqual({ action: "cancel", content: null, _meta: null });
  });

  it.each([
    { executionMode: "full-access" as const, currentModeId: undefined, approved: true },
    { executionMode: "default" as const, currentModeId: "yolo", approved: true },
    { executionMode: "full-access" as const, currentModeId: "default", approved: false },
  ])("uses the applied ACP runtime policy for gateway approval: $executionMode / $currentModeId", async ({ executionMode, currentModeId, approved }) => {
    const backend = "acp:fixture" as const;
    vi.spyOn(internals.acpBackend, "getSession").mockReturnValue({
      backendId: backend, sessionId: "thread-1", title: "Fixture", cwd: directory,
      createdAt: 1, updatedAt: 1, status: "active", executionMode,
      ...(currentModeId ? { acpRuntime: { currentModeId, updatedAt: 1 } } : {}),
    });
    vi.spyOn(internals.acpBackend, "getInstalledAgent").mockReturnValue(undefined);
    const events: AgentEvent[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      await registry.submitServerRequest({ backend, threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "decline", content: null, _meta: null } });
    });
    expect(await internals.approveGatewayInvocation(
      { ...args, serverName: "Fixture" },
      { backend, threadId: "thread-1", turnId: "turn-1", transport: "mcp" },
      new AbortController().signal,
    )).toBe(approved);
    expect(events).toHaveLength(approved ? 0 : 1);
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it("keeps the approval card for an ACP harness without native Auto", async () => {
    reviewerSettings.enabled = true;
    reviewModel.mockResolvedValue({ status: "ok", object: { action: "accept", content: null, reason: "Authorized read." } });
    const events: AgentEvent[] = [];
    const backend = "acp:fixture" as const;
    vi.spyOn(internals.acpBackend, "getSession").mockReturnValue({
      backendId: backend, sessionId: "thread-1", title: "Fixture", cwd: directory,
      createdAt: 1, updatedAt: 1, status: "active", executionMode: "default",
    });
    vi.spyOn(internals.acpBackend, "getInstalledAgent").mockReturnValue(undefined);
    vi.spyOn(registry, "listBackends").mockResolvedValue({ backends: [{ kind: backend, executionModes: [] }] } as never);
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      await registry.submitServerRequest({ backend, threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: null } });
    });
    // Default Access keeps asking its operator, even where the provider has
    // no Auto mode for the reviewer to stand in for.
    expect(await internals.approveGatewayInvocation(
      { ...args, serverName: "Fixture" },
      { backend, threadId: "thread-1", turnId: "turn-1", transport: "mcp" },
      new AbortController().signal,
    )).toBe(true);
    expect(events).toHaveLength(1);
    expect(reviewModel).not.toHaveBeenCalled();
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it("requires source-specific approval and deduplicates the same dynamic call", async () => {
    const pending = approval();
    const call = internals.handleServerRequest("codex", request("call_mcp_tool", args));
    const duplicate = internals.handleServerRequest("codex", request("call_mcp_tool", args));
    const event = await pending;
    if (event.notification.method !== "mcpServer/elicitation/request") throw new Error("Expected MCP approval");
    expect(event.notification.params).toMatchObject({ serverName: "Fixture", mode: "form", message: expect.stringContaining("lookup") });
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(0);
    await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: null } });
    expect((await call).success).toBe(true);
    expect(await duplicate).toEqual(await call);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(1);
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it("cancels pending approval when the operator deselects a connection", async () => {
    const pending = approval();
    const call = internals.handleServerRequest("codex", request("call_mcp_tool", args));
    await pending;
    await registry.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds: [] });
    expect((await call).success).toBe(false);
    expect(internals.pendingServerRequests.size).toBe(0);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(0);
  });

  it.each(["default", "full-access"] as const)("rejects idle-thread and messaging-policy violations in %s before reading tools", async (executionMode) => {
    await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode });
    internals.activeTurnKeys.clear();
    expect((await internals.handleServerRequest("codex", request("search_mcp_tools", { query: "lookup" }))).success).toBe(false);
    internals.activeTurnKeys.add("codex:thread-1:turn-1");
    Object.assign(registry, { messagingAgentToolService: { checkDynamicToolPermission: vi.fn(() => ({ allowed: false, permission: "tools.instance_management" })) } });
    expect((await internals.handleServerRequest("codex", request("search_mcp_tools", { query: "lookup" }, "call-2"))).success).toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(["default", "full-access"] as const)("adds no SQLite writes for discovery, approval and invocation in %s", async (executionMode) => {
    await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode });
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: null } });
    });
    const { writes } = await measureSqliteWrites(async () => {
      expect((await internals.handleServerRequest("codex", request("search_mcp_tools", { query: "lookup" }))).success).toBe(true);
      expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args, "call-2"))).success).toBe(true);
    });
    expectSqliteWriteBudget({ scenario: "mcp-gateway-discovery-and-invocation", note: "Fixed MCP gateway discovery and one scoped approved call use in-memory catalogs and the existing event flow, with no additional SQLite commits.", writes });
  });

  it("adds no SQLite writes for an automation's pre-approved gateway flow", async () => {
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: ["one"], input: [{ type: "text", text: "Look up the fixture." }],
    });
    internals.activeTurnKeys.add("codex:headless-1:turn-1");
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    const { writes } = await measureSqliteWrites(async () => {
      for (const call of [request("search_mcp_tools", { query: "lookup" }), request("call_mcp_tool", args, "call-2")]) {
        expect((await internals.handleServerRequest("codex", { ...call, params: { ...call.params, threadId: "headless-1" } })).success).toBe(true);
      }
    });
    expectSqliteWriteBudget({ scenario: "mcp-gateway-discovery-and-invocation", note: "Fixed MCP gateway discovery and one scoped approved call use in-memory catalogs and the existing event flow, with no additional SQLite commits.", writes });
  });
});
