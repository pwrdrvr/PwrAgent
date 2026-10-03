import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerPendingRequestNotification, AgentEvent, ThreadExecutionMode } from "@pwragent/shared";
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
  let registerBridge: ReturnType<typeof vi.fn<McpConnectionGatewayService["registerBridge"]>>;
  let internals: {
    activeTurnKeys: Set<string>;
    activeCodexTurnModes: Map<string, ThreadExecutionMode>;
    acpBackend: AcpBackendAdapter;
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
    registerBridge = vi.fn<McpConnectionGatewayService["registerBridge"]>(async () => ({
      server: { name: "one", command: "fixture", args: [], env: {} },
      bindThread: vi.fn(), revoke: vi.fn(),
    }));
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }), listThreads: async () => [],
        onNotification: () => () => {}, onPendingRequest: () => () => {},
        readConfiguredMcpServerNames: async () => [], startThread: async () => ({ threadId: "headless-1" }),
        startTurn,
      } as never,
      overlayStore: store, isBootstrapMode: () => false,
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
  });

  const appConsent = (meta: Record<string, unknown> = {}): AppServerPendingRequestNotification => ({
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "headless-1", turnId: "turn-1", requestId: "app-consent", serverName: "one",
      mode: "form", message: "Allow Computer Use to use Electron?",
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "lookup", persist: ["session", "always"], ...meta },
    },
  });

  async function startApprovedAutomation(toolAllowlist = ["lookup"]) {
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: ["one"], toolAllowlist, input: [{ type: "text", text: "Look up the fixture." }],
    });
  }

  it("answers an automation's preauthorized native consent with the advertised run scope", async () => {
    await startApprovedAutomation();
    const events = declineUnexpectedApproval();
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    const { writes } = await measureSqliteWrites(async () => {
      expect(await internals.handleServerRequest("codex", appConsent())).toEqual({
        action: "accept", content: {}, _meta: { persist: "session" },
      });
    });
    expectSqliteWriteBudget({ scenario: "mcp-automation-native-consent", note: "Native automation MCP consent checks the in-memory run grant and reads the Agent selection without adding SQLite commits.", writes });
    expect(events).toEqual([]);
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it.each(["allowed", "outside-allowlist", "provider-disabled"])("checks inherited native servers when consent is %s", async (scenario) => {
    const nativeRegistry = registry as unknown as { readConfiguredCodexMcpServerNames(cwd?: string): Promise<string[]> };
    vi.spyOn(nativeRegistry, "readConfiguredCodexMcpServerNames").mockResolvedValue(["native-fixture", "other-native"]);
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: ["native-fixture"], toolAllowlist: ["lookup"], input: [{ type: "text", text: "Look up the fixture." }],
    });
    if (scenario === "provider-disabled") {
      await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: ["one"], providerServersEnabled: false });
    }
    const consent = appConsent();
    consent.params.serverName = scenario === "outside-allowlist" ? "other-native" : "native-fixture";
    expect(await internals.handleServerRequest("codex", consent)).toEqual(scenario === "allowed"
      ? { action: "accept", content: {}, _meta: { persist: "session" } }
      : { action: "cancel", content: null, _meta: null });
  });

  it("honors native automation consent before turn startup returns", async () => {
    startTurn.mockImplementation(async () => {
      expect(await internals.handleServerRequest("codex", appConsent())).toEqual({
        action: "accept", content: {}, _meta: { persist: "session" },
      });
      return { threadId: "headless-1", turnId: "turn-1" };
    });
    await startApprovedAutomation();
  });

  it("does not answer native consent after the automation ends during the selection check", async () => {
    await startApprovedAutomation();
    const readSelection = registry.readThreadMcpConnections.bind(registry);
    vi.spyOn(registry, "readThreadMcpConnections").mockImplementationOnce(async (request) => {
      const selected = await readSelection(request);
      internals.headlessAutomationTurns.clear();
      return selected;
    });
    expect(await internals.handleServerRequest("codex", appConsent())).toEqual({ action: "cancel", content: null, _meta: null });
  });

  it.each(["default", "auto"] as const)("presents native MCP consent to the user in interactive %s threads", async (executionMode) => {
    await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode });
    const pending = approval();
    const consent = appConsent();
    consent.params.threadId = "thread-1";
    const response = internals.handleServerRequest("codex", consent);
    await pending;
    expect(internals.pendingServerRequests.size).toBe(1);
    await registry.submitServerRequest({
      backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: "app-consent",
      response: { action: "accept", content: {}, _meta: { persist: "session" } },
    });
    expect(await response).toEqual({ action: "accept", content: {}, _meta: { persist: "session" } });
  });

  it("never creates a permanent native grant for an automation", async () => {
    await startApprovedAutomation();
    expect(await internals.handleServerRequest("codex", appConsent({ persist: ["always"] }))).toEqual({
      action: "accept", content: {}, _meta: null,
    });
  });

  it.each(["different-tool", "missing-tool", "revoked-server"])("rejects native consent when the automation grant is %s", async (scenario) => {
    await startApprovedAutomation();
    if (scenario === "revoked-server") {
      await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
    }
    const meta = scenario === "different-tool" ? { tool_name: "write" }
      : scenario === "missing-tool" ? { tool_name: undefined } : {};
    expect(await internals.handleServerRequest("codex", appConsent(meta))).toEqual({ action: "cancel", content: null, _meta: null });
  });

  it.each(["question", "required-field", "url", "unknown-server", "unknown-scope"])("does not use an automation grant for native %s", async (scenario) => {
    await startApprovedAutomation();
    const consent = appConsent(scenario === "unknown-scope" ? { persist: ["forever"] } : {});
    if (scenario === "question") consent.params.requestedSchema = { type: "object", properties: { account: { type: "string" } } };
    if (scenario === "required-field") consent.params.requestedSchema = { type: "object", properties: {}, required: ["account"] };
    if (scenario === "url") consent.params.mode = "url";
    if (scenario === "unknown-server") consent.params.serverName = "other";
    expect(await internals.handleServerRequest("codex", consent)).toEqual({ action: "cancel", content: null, _meta: null });
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
