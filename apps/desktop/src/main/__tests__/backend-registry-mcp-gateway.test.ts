import { SandboxerConnection } from "../mcp-connections/sandboxer-connection";
import { sandboxerStub } from "./helpers/sandboxer-stub";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerMcpElicitationRequestNotification, AppServerPendingRequestNotification, AgentEvent, ThreadExecutionMode } from "@pwragent/shared";
import type { CodexAppServerClient } from "../codex-app-server/client";
import { DesktopBackendRegistry, buildCodexConnectionMcpServerName } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";
import { attachSqliteWriteMetrics, isSqliteWriteMetricsEnabled, measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import type { AcpBackendAdapter } from "../app-server/acp-backend-adapter";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { McpGatewayInvocation, McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import type { McpGatewayApproval } from "../mcp-connections/mcp-gateway-tool-service";
import { buildMcpElicitationResponse, createMcpElicitationState, readMcpApprovalPersistence } from "../../renderer/src/features/thread-detail/mcp-elicitation";
import { nativeCodexMcpApprovalFixture } from "./fixtures/native-codex-mcp-approval";

type McpApprovalEvent = Pick<AgentEvent, "backend"> & { notification: AppServerMcpElicitationRequestNotification };

describe("backend MCP gateway dispatch", () => {
  let directory: string;
  let db: StateDb;
  let store: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  let operation: ReturnType<typeof vi.fn<McpConnectionGatewayService["requestGatewayToolOperation"]>>;
  let startTurn: ReturnType<typeof vi.fn<() => Promise<{ threadId: string; turnId: string }>>>;
  let registerBridge: ReturnType<typeof vi.fn<McpConnectionGatewayService["registerBridge"]>>;
  let review: ReturnType<typeof vi.fn<CodexAppServerClient["generateStructuredObject"]>>;
  let readReviewTurn: ReturnType<typeof vi.fn<CodexAppServerClient["readMcpApprovalUserMessages"]>>;
  const brokers: McpConnectionGatewayService[] = [];
  let internals: {
    activeTurnKeys: Set<string>;
    activeCodexTurnModes: Map<string, ThreadExecutionMode>;
    acpBackend: AcpBackendAdapter;
    approveGatewayInvocation(invocation: McpGatewayInvocation, context: AgentToolCallContext, signal: AbortSignal, annotations?: McpGatewayTool["definition"]["annotations"], catalogRevision?: string, definition?: McpGatewayTool["definition"]): Promise<McpGatewayApproval>;
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
    const fixture = createTempStateDb("pwragent-gateway-dispatch-");
    directory = fixture.tempDir;
    db = StateDb.open(fixture.dbPath);
    store = new SqliteOverlayStore(db);
    await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: ["one"] });
    operation = vi.fn(async (params) => params.operation === "gateway/tools/list"
      ? [{ connectionId: "one", serverName: "Fixture", toolName: "lookup", schemaRevision: "r1", definition: {
          name: "lookup", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        } }]
      : { content: [{ type: "text", text: "fixture result" }] });
    review = vi.fn<CodexAppServerClient["generateStructuredObject"]>().mockResolvedValue({ status: "failed", reason: "fixture unavailable" });
    readReviewTurn = vi.fn<CodexAppServerClient["readMcpApprovalUserMessages"]>().mockResolvedValue(["Look up fixture on Fixture."]);
    startTurn = vi.fn(async () => ({ threadId: "headless-1", turnId: "turn-1" }));
    registerBridge = vi.fn<McpConnectionGatewayService["registerBridge"]>(async () => ({
      server: { name: "one", command: "fixture", args: [], env: {} },
      bindThread: vi.fn(), revoke: vi.fn(),
    }));
    createRegistry();
  });

  function buildRegistry(overlayStore = store, service?: McpConnectionGatewayService) {
    return new DesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }), listThreads: async () => [],
        onNotification: () => () => {}, onPendingRequest: () => () => {},
        readConfiguredMcpServerNames: async () => [], startThread: async () => ({ threadId: "headless-1" }),
        startTurn, generateStructuredObject: review, readMcpApprovalUserMessages: readReviewTurn,
      } as never,
      overlayStore, isBootstrapMode: () => false,
      mcpConnectionService: service ?? { registerBridge, requestGatewayToolOperation: operation },
    });
  }

  function createRegistry(service?: McpConnectionGatewayService) {
    registry = buildRegistry(store, service);
    internals = registry as unknown as typeof internals;
    internals.activeTurnKeys.add("codex:thread-1:turn-1");
  }

  afterEach(async () => {
    await registry.close();
    await Promise.all(brokers.splice(0).map((broker) => broker.close()));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function approval(excludeRequestId?: string) {
    let resolve!: (event: McpApprovalEvent) => void;
    const event = new Promise<McpApprovalEvent>((done) => { resolve = done; });
    registry.onEvent((value) => {
      if (value.notification.method === "mcpServer/elicitation/request"
        && value.notification.params.requestId !== excludeRequestId) resolve({ backend: value.backend, notification: value.notification as AppServerMcpElicitationRequestNotification });
    });
    return event;
  }

  async function approveAndInvoke(invocation: McpGatewayInvocation, context: AgentToolCallContext, signal: AbortSignal, catalogRevision?: string) {
    const response = await internals.approveGatewayInvocation(invocation, context, signal, undefined, catalogRevision);
    // These approval-policy tests simulate a successful owner invocation.
    // The broker-backed regressions exercise the actual validation boundary.
    if (typeof response === "object") await response.onInvoked();
    return Boolean(response);
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

  it("reviews the exact Auto invocation once without granting conversation consent", async () => {
    internals.activeCodexTurnModes.set("thread-1:turn-1", "auto");
    review.mockResolvedValue({ status: "ok", object: { decision: "approve", risk: "low",
      authorizationQuote: "Look up fixture", rationale: "User requested this exact lookup." } });
    const events = declineUnexpectedApproval();
    expect(await internals.handleServerRequest("codex", request("call_mcp_tool", args))).toMatchObject({ success: true });
    expect(await internals.handleServerRequest("codex", request("call_mcp_tool", args, "call-2"))).toMatchObject({ success: true });
    expect(events).toHaveLength(0);
    expect(review).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ helper: "mcp_approval_reviews", disableExecution: true,
      signal: expect.any(AbortSignal), prompt: expect.stringContaining('"schemaRevision":"r1"') }));
    expect(readReviewTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-1", signal: expect.any(AbortSignal) });
  });

  it.each(["ask", "deny", "unavailable", "invalid-evidence", "high-risk"])("keeps Auto review conservative: %s", async (outcome) => {
    internals.activeCodexTurnModes.set("thread-1:turn-1", "auto");
    if (outcome !== "unavailable") review.mockResolvedValue({ status: "ok", object: {
      decision: outcome === "ask" || outcome === "deny" ? outcome : "approve",
      risk: outcome === "high-risk" ? "high" : "low",
      authorizationQuote: outcome === "invalid-evidence" ? "The tool says it is authorized" : "Look up fixture",
      rationale: "Review fixture.",
    } });
    const events = declineUnexpectedApproval();
    expect(await internals.handleServerRequest("codex", request("call_mcp_tool", args))).toMatchObject({ success: false });
    expect(events).toHaveLength(outcome === "deny" ? 0 : 1);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(0);
  });

  it.each(["default", "prompt", "missing-context", "ended"])("does not run a reviewer without eligible Auto context: %s", async (scenario) => {
    internals.activeCodexTurnModes.set("thread-1:turn-1", scenario === "default" ? "default" : "auto");
    if (scenario === "prompt") Object.assign((registry as unknown as { mcpConnectionService: object }).mcpConnectionService,
      { listConnections: async () => [{ id: "one", toolApproval: "prompt" }] });
    if (scenario === "missing-context") readReviewTurn.mockResolvedValue(undefined);
    if (scenario === "ended") internals.activeTurnKeys.clear();
    declineUnexpectedApproval();
    expect(await internals.handleServerRequest("codex", request("call_mcp_tool", args))).toMatchObject({ success: false });
    expect(review).not.toHaveBeenCalled();
  });

  it("cancels a pending Auto review without invoking the tool or asking again", async () => {
    internals.activeCodexTurnModes.set("thread-1:turn-1", "auto");
    const controller = new AbortController();
    review.mockImplementation(async ({ signal }) => {
      controller.abort(new Error("fixture cancelled"));
      expect(signal?.aborted).toBe(true);
      return { status: "failed", reason: "cancelled" };
    });
    declineUnexpectedApproval();
    await expect(internals.approveGatewayInvocation({ ...args, serverName: "Fixture" }, {
      backend: "codex", threadId: "thread-1", turnId: "turn-1", transport: "codex_dynamic_tool",
    }, controller.signal, undefined, "catalog-1", { name: "lookup", inputSchema: { type: "object" } })).rejects.toThrow("fixture cancelled");
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it("releases parallel approvals only after the owner's successful conversation grant", async () => {
    const events: McpApprovalEvent[] = [];
    const resolved: unknown[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "mcpServer/elicitation/request") events.push(event as McpApprovalEvent);
      if (event.notification.method === "serverRequest/resolved") resolved.push(event);
    });
    const context: AgentToolCallContext = { backend: "codex", threadId: "thread-1", turnId: "turn-1", transport: "codex_dynamic_tool" };
    const invocation = { ...args, serverName: "Fixture" };
    const first = internals.approveGatewayInvocation(invocation, context, new AbortController().signal, undefined, "catalog-1");
    const second = internals.approveGatewayInvocation({ ...invocation, toolName: "write" }, context, new AbortController().signal, undefined, "catalog-1");
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await registry.submitServerRequest({ ...context, requestId: String(events[0]!.notification.params.requestId),
      response: { action: "accept", content: {}, _meta: { persist: "server-session" } } });
    const grant = await first;
    expect(internals.pendingServerRequests.size).toBe(1);
    expect(typeof grant).toBe("object");
    if (typeof grant === "object") await grant.onInvoked();
    expect(await second).toBe(true);
    expect(internals.pendingServerRequests.size).toBe(0);
    expect(resolved.length).toBeGreaterThanOrEqual(1);
  });

  it.each(["once", "tool-only", "other-thread", "other-connection", "changed-catalog", "revoked-selection"])(
    "keeps a parallel approval pending outside a validated grant: %s", async (scenario) => {
      const events: McpApprovalEvent[] = [];
      registry.onEvent((event) => {
        if (event.notification.method === "mcpServer/elicitation/request") events.push(event as McpApprovalEvent);
      });
      const context: AgentToolCallContext = { backend: "codex", threadId: "thread-1", turnId: "turn-1", transport: "codex_dynamic_tool" };
      const invocation = { ...args, serverName: "Fixture" };
      const controller = new AbortController();
      const first = internals.approveGatewayInvocation(invocation, context, new AbortController().signal, undefined, "catalog-1");
      const second = internals.approveGatewayInvocation({ ...invocation, toolName: "write",
        ...(scenario === "other-connection" ? { connectionId: "two" } : {}),
      }, { ...context, ...(scenario === "other-thread" ? { threadId: "thread-2" } : {}) },
      controller.signal, undefined, scenario === "changed-catalog" ? "catalog-2" : "catalog-1");
      await vi.waitFor(() => expect(events).toHaveLength(2));
      const persist = scenario === "once" ? null : scenario === "tool-only" ? "session" : "server-session";
      await registry.submitServerRequest({ ...context, requestId: String(events[0]!.notification.params.requestId),
        response: { action: "accept", content: {}, _meta: persist ? { persist } : null } });
      const grant = await first;
      if (scenario === "revoked-selection") await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
      if (typeof grant === "object") await grant.onInvoked();
      expect(internals.pendingServerRequests.size).toBe(1);
      const cancelled = expect(second).rejects.toThrow("fixture cleanup");
      controller.abort(new Error("fixture cleanup"));
      await cancelled;
    },
  );

  it.each(["disabled", "cold", "expired"] as const)(
    "keeps unrelated new-thread defaults when Sandboxer status is slow (%s)",
    async (cache) => {
      await registry.close();
      const connections = new McpConnectionRegistry({ configPath: path.join(directory, "config.toml") });
      connections.setSandboxerTransport("local_cli");
      const remote = connections.create({ displayName: "Remote", serverUrl: "https://fixture.example/mcp" });
      for (const id of ["pwrsnap", "pwrgit", remote.id, "builtin:sandboxer"]) {
        connections.setSelectForNewThreads(id, true);
      }
      connections.setEnabled("builtin:sandboxer", cache !== "disabled");
      let finishProbe!: (output: string) => void;
      const probe = vi.fn(() => new Promise<string>((resolve) => { finishProbe = resolve; }));
      const sandboxer = new SandboxerConnection(probe);
      if (cache === "expired") {
        probe.mockResolvedValueOnce('{"signedIn":true}');
        await sandboxer.readStatus();
      }
      const credentials = JSON.stringify({ version: 1, credentials: Object.fromEntries(
        connections.list().filter((connection) => connection.authMode === "oauth").map((connection) => [connection.id, {
          resourceUrl: connection.serverUrl, tokens: { access_token: "fixture", token_type: "bearer" },
        }]),
      ) });
      const broker = new McpConnectionGatewayService({
        registry: connections, sandboxer, leaseManager: null,
        settings: {
          resolveMcpConnectionCredentials: async () => credentials,
          resolvePwrSnapMcpCredential: async () => undefined,
          resolvePwrGitMcpCredential: async () => undefined,
          clearMcpConnectionCredentials: async () => {}, clearPwrSnapMcpCredential: async () => {},
          clearPwrGitMcpCredential: async () => {}, saveMcpConnectionCredentials: async () => {},
          savePwrSnapMcpCredential: async () => {},
        },
      });
      brokers.push(broker);
      await broker.start();
      createRegistry(broker);
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 16_000);
        const defaults = (registry as unknown as {
          resolveNewThreadMcpConnectionIds: () => Promise<string[] | undefined>;
        }).resolveNewThreadMcpConnectionIds();
        await vi.advanceTimersByTimeAsync(2_001);
        expect(await defaults).toEqual(cache === "expired"
          ? ["pwrsnap", "pwrgit", "builtin:sandboxer", remote.id]
          : ["pwrsnap", "pwrgit", remote.id]);
        expect(probe).toHaveBeenCalledTimes(cache === "disabled" ? 0 : cache === "expired" ? 2 : 1);
      } finally {
        if (finishProbe) {
          finishProbe('{"signedIn":false}');
          await sandboxer.readStatus();
        }
        vi.useRealTimers();
      }
    },
  );

  it("keeps legacy sandboxer credentials and existing thread selection on the remote connection", async () => {
    await registry.close();
    const configPath = path.join(directory, "config.toml");
    writeFileSync(configPath, `[[mcp_connections.connections]]
id = "sandboxer"
display_name = "Sandboxer"
server_url = "https://legacy.example/mcp"
select_for_new_threads = true
`);
    const connections = new McpConnectionRegistry({ configPath });
    await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: ["sandboxer"] });
    const sandboxer = sandboxerStub();
    const probe = vi.spyOn(sandboxer, "readStatus");
    const credentialRead = vi.fn(async () => JSON.stringify({ version: 1, credentials: {
      sandboxer: { resourceUrl: "https://legacy.example/mcp", tokens: { access_token: "legacy-token", token_type: "bearer" } },
    } }));
    const broker = new McpConnectionGatewayService({
      registry: connections, sandboxer, leaseManager: null,
      settings: {
        resolveMcpConnectionCredentials: credentialRead,
        resolvePwrSnapMcpCredential: async () => undefined, resolvePwrGitMcpCredential: async () => undefined,
        clearMcpConnectionCredentials: async () => {}, clearPwrSnapMcpCredential: async () => {},
        clearPwrGitMcpCredential: async () => {}, saveMcpConnectionCredentials: async () => {},
        savePwrSnapMcpCredential: async () => {},
      },
    });
    brokers.push(broker);
    createRegistry(broker);
    expect((await broker.listConnections({ cachedLocalStatus: true })).find((connection) => connection.id === "sandboxer"))
      .toMatchObject({ kind: "remote", configured: true, serverUrl: "https://legacy.example/mcp" });
    expect(await (registry as unknown as {
      resolveNewThreadMcpConnectionIds: () => Promise<string[] | undefined>;
    }).resolveNewThreadMcpConnectionIds()).toEqual(["sandboxer"]);
    const selection = (await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))!.mcpConnectionIds!;
    expect(selection).toEqual(["sandboxer"]);
    const bridge = await broker.registerBridge(selection[0]!, "thread-1");
    expect(bridge.server.env.PWRAGENT_MCP_CONNECTION_NAME).toBe("sandboxer");
    expect(probe).not.toHaveBeenCalled();
    expect(credentialRead).toHaveBeenCalled();
    bridge.revoke();
  });

  async function brokerFixture() {
    await registry.close();
    await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: ["pwrsnap"] });
    let credentials: string | undefined;
    const broker = new McpConnectionGatewayService({
      sandboxer: sandboxerStub(),
      registry: new McpConnectionRegistry({ configPath: path.join(directory, "config.toml") }),
      leaseManager: null,
      readGatewaySelection: async (context) => (await store.getThreadOverlayState(context))?.mcpConnectionIds ?? [],
      settings: {
        resolvePwrSnapMcpCredential: async () => JSON.stringify({
          clientInformation: { client_id: "fixture" },
          tokens: { access_token: "fixture", token_type: "bearer" },
        }),
        resolveMcpConnectionCredentials: async () => credentials,
        saveMcpConnectionCredentials: async (value: string) => { credentials = value; },
        clearMcpConnectionCredentials: async () => { credentials = undefined; },
        clearPwrSnapMcpCredential: async () => {},
        resolvePwrGitMcpCredential: async () => undefined,
      } as never,
    });
    brokers.push(broker);
    let idType = "string";
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "fixture result" }] }));
    Object.assign(broker, { connectUpstreamClient: async () => ({
      client: { listTools: async () => ({ tools: [{ name: "lookup", inputSchema: {
        type: "object", properties: { id: { type: idType } }, required: ["id"],
      } }] }), callTool, close: async () => {} },
      transport: { close: async () => {} },
    }) });
    createRegistry(broker);
    const readArgs = async () => {
      const [tool] = await broker.requestGatewayToolOperation({
        connectionId: "pwrsnap", scopeKey: JSON.stringify(["gateway", "codex", "thread-1"]),
        operation: "gateway/tools/list", signal: new AbortController().signal,
      }) as McpGatewayTool[];
      return { connectionId: tool.connectionId, toolName: tool.toolName, schemaRevision: tool.schemaRevision,
        arguments: { id: idType === "string" ? "fixture" : 1 } };
    };
    return { broker, readArgs, callTool, changeSchema: (type: string) => { idType = type; } };
  }

  function acceptFirstConversationApproval(persist = "session") {
    const events: AgentEvent[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      await registry.submitServerRequest({
        backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId),
        response: { action: events.length === 1 ? "accept" : "decline", content: {}, _meta: { persist } },
      });
    });
    return events;
  }

  it.each(["session", "server-session"])("revokes a broker-backed %s grant after another profile instance deselects and reselects", async (persist) => {
    const f = await brokerFixture();
    const events = acceptFirstConversationApproval(persist);
    const first = await f.readArgs();
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", first))).success).toBe(true);
    const peerDb = StateDb.open(path.join(directory, "state.db"));
    const peer = buildRegistry(new SqliteOverlayStore(peerDb), f.broker);
    try {
      await peer.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds: [] });
      await peer.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds: ["pwrsnap"] });
      expect((await f.readArgs()).schemaRevision).toBe(first.schemaRevision);
      expect((await internals.handleServerRequest("codex", request("call_mcp_tool", first, "call-2"))).success).toBe(false);
      expect(events).toHaveLength(2);
      expect(f.callTool).toHaveBeenCalledOnce();
    } finally {
      await peer.close();
      peerDb.close();
    }
  });

  it("stores shared MCP selection revocation in the existing selection write", async () => {
    const before = (await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.mcpSelectionRevision;
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    const { writes } = await measureSqliteWrites(async () => {
      await registry.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds: [] });
    });
    const after = (await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.mcpSelectionRevision;
    expect(after).toEqual(expect.any(String));
    expect(after).not.toBe(before);
    expectSqliteWriteBudget({ scenario: "mcp-selection-revocation", note: "Selection revocation shares the existing operator selection commit. No per-call or grant writes are added.", writes });
  });

  it.each(["full-access", "automation"])("invalidates a changed broker revision during %s before returning to Default", async (mode) => {
    const f = await brokerFixture();
    const events = acceptFirstConversationApproval();
    const first = await f.readArgs();
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", first))).success).toBe(true);
    f.changeSchema("number");
    if (mode === "full-access") {
      internals.activeCodexTurnModes.set("thread-1:turn-1", "full-access");
    } else {
      internals.headlessAutomationTurns.set("codex:thread-1:turn-1", {
        agentThreadId: "thread-1", backend: "codex", automationRunId: "run-1", executionMode: "default",
        executionThreadId: "thread-1", queueEntryId: "queue-1", startedAt: 1,
        mcpConnectionIds: ["pwrsnap"], toolAllowlist: ["lookup"],
      });
    }
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", await f.readArgs(), "call-2"))).success).toBe(true);
    f.changeSchema("string");
    internals.headlessAutomationTurns.delete("codex:thread-1:turn-1");
    internals.activeCodexTurnModes.set("thread-1:turn-1", "default");
    expect((await f.readArgs()).schemaRevision).toBe(first.schemaRevision);
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", first, "call-3"))).success).toBe(false);
    expect(events).toHaveLength(2);
    expect(f.callTool).toHaveBeenCalledTimes(2);
  });

  it.each([
    { newerPrompt: false, restoreBeforeResponse: false },
    { newerPrompt: true, restoreBeforeResponse: false },
    { newerPrompt: true, restoreBeforeResponse: true },
  ].flatMap((scenario) => ["session", "server-session"].map((persist) => ({ ...scenario, persist }))))("does not remember obsolete broker $persist consent (newer prompt: $newerPrompt, restored before response: $restoreBeforeResponse)", async ({ newerPrompt, restoreBeforeResponse, persist }) => {
    const f = await brokerFixture();
    const first = await f.readArgs();
    const pending = approval();
    const oldCall = internals.handleServerRequest("codex", request("call_mcp_tool", first));
    const oldEvent = await pending;
    f.changeSchema("number");
    if (newerPrompt) {
      // A listener added during emit's fan-out may still see the older event.
      const newerPending = approval(String(oldEvent.notification.params.requestId));
      const newerCall = internals.handleServerRequest("codex", request("call_mcp_tool", await f.readArgs(), "call-2"));
      const newerEvent = await Promise.race([newerPending, newerCall.then((result) => {
        throw new Error(`Newer invocation ended before approval: ${JSON.stringify(result)}`);
      })]);
      await registry.submitServerRequest({
        backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(newerEvent.notification.params.requestId),
        response: { action: "decline", content: null, _meta: null },
      });
      expect((await newerCall).success).toBe(false);
    }
    if (restoreBeforeResponse) f.changeSchema("string");
    await registry.submitServerRequest({
      backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(oldEvent.notification.params.requestId),
      response: { action: "accept", content: {}, _meta: { persist } },
    });
    expect((await oldCall).success).toBe(restoreBeforeResponse);
    f.changeSchema("string");
    expect((await f.readArgs()).schemaRevision).toBe(first.schemaRevision);
    const unexpected = declineUnexpectedApproval();
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", first, "call-3"))).success).toBe(false);
    expect(unexpected).toHaveLength(1);
    expect(f.callTool).toHaveBeenCalledTimes(restoreBeforeResponse ? 1 : 0);
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

  const gatewayConnection = (enabled: boolean) => ({
    id: "one", displayName: "Datadog", serverUrl: "https://mcp.example.com/one", authMode: "oauth" as const,
    kind: "remote" as const, enabled, createdAt: 1, updatedAt: 1, state: "ready" as const, configured: true,
  });

  it.each(["one", "Datadog"])("grants an allowlisted gateway connection the Agent has not selected (%s)", async (allowed) => {
    await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
    createRegistry({
      registerBridge, requestGatewayToolOperation: operation, listConnections: async () => [gatewayConnection(true)],
    } as unknown as McpConnectionGatewayService);
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: [allowed], input: [{ type: "text", text: "Look up the fixture." }],
    });
    expect(registerBridge).toHaveBeenCalledWith("one", undefined);
    internals.activeTurnKeys.add("codex:headless-1:turn-1");
    const call = request("call_mcp_tool", args);
    expect((await internals.handleServerRequest("codex", { ...call, params: { ...call.params, threadId: "headless-1" } })).success).toBe(true);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(1);
  });

  it("does not grant a gateway connection by a name the Agent's own Codex server answers to", async () => {
    await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
    createRegistry({
      registerBridge, requestGatewayToolOperation: operation, listConnections: async () => [gatewayConnection(true)],
    } as unknown as McpConnectionGatewayService);
    const nativeRegistry = registry as unknown as { readConfiguredCodexMcpServerNames(cwd?: string): Promise<string[]> };
    vi.spyOn(nativeRegistry, "readConfiguredCodexMcpServerNames").mockResolvedValue(["datadog"]);
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: ["datadog"], input: [{ type: "text", text: "Look up the fixture." }],
    });
    expect(registerBridge).not.toHaveBeenCalled();
  });

  it("does not grant a gateway connection that is not offered to threads", async () => {
    await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
    createRegistry({
      registerBridge, requestGatewayToolOperation: operation, listConnections: async () => [gatewayConnection(false)],
    } as unknown as McpConnectionGatewayService);
    await expect(registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: ["one"], input: [{ type: "text", text: "Look up the fixture." }],
    })).rejects.toThrow("not configured for the Agent: one");
    expect(registerBridge).not.toHaveBeenCalled();
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

  function nativeConsent(): AppServerPendingRequestNotification {
    const wire = nativeCodexMcpApprovalFixture();
    return { method: wire.method, params: {
      ...wire.params, threadId: "headless-1", turnId: "turn-1", serverName: "one", requestId: String(wire.id),
    } };
  }

  async function startApprovedAutomation(toolAllowlist = ["lookup"]) {
    await registry.startAutomationHeadlessTurn({
      backend: "codex", agentThreadId: "thread-1", automationRunId: "run-1", cwd: directory,
      mcpAllowlist: ["one"], toolAllowlist, input: [{ type: "text", text: "Look up the fixture." }],
    });
  }

  it.each(["lookup", "mcp__one__lookup", "mcp__Fixture__lookup"])("cancels native consent without exact identity for allowlisted %s", async (tool) => {
    await startApprovedAutomation([tool]);
    const events = declineUnexpectedApproval();
    expect(await internals.handleServerRequest("codex", nativeConsent())).toEqual({ action: "cancel", content: null, _meta: null });
    expect(events).toEqual([]);
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it.each(["allowed", "unknown-server", "revoked-server", "ended-run", "permanent-only"])("checks server-wide native consent when the grant is %s", async (scenario) => {
    await startApprovedAutomation([]);
    const consent = nativeConsent();
    if (scenario === "unknown-server") consent.params.serverName = "other";
    if (scenario === "revoked-server") {
      await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
    }
    if (scenario === "ended-run") {
      const readSelection = registry.readThreadMcpConnections.bind(registry);
      vi.spyOn(registry, "readThreadMcpConnections").mockImplementationOnce(async (request) => {
        const selected = await readSelection(request);
        internals.headlessAutomationTurns.clear();
        return selected;
      });
    }
    if (scenario === "permanent-only") {
      consent.params._meta = { ...consent.params._meta as Record<string, unknown>, persist: "always" };
    }
    const events = declineUnexpectedApproval();
    const accepted = scenario === "allowed" || scenario === "permanent-only";
    expect(await internals.handleServerRequest("codex", consent)).toEqual(accepted
      ? { action: "accept", content: {}, _meta: scenario === "allowed" ? { persist: "session" } : null }
      : { action: "cancel", content: null, _meta: null });
    expect(events).toEqual([]);
    expect(internals.pendingServerRequests.size).toBe(0);
  });

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

  it.each([
    { persist: "session", meta: { persist: "session" } },
    { persist: ["session", "session", "always"], meta: { persist: "session" } },
    { persist: ["always", "always", "always"], meta: null },
  ])("accepts valid advertised automation scopes without rejecting duplicates: $persist", async ({ persist, meta }) => {
    await startApprovedAutomation();
    expect(await internals.handleServerRequest("codex", appConsent({ persist }))).toEqual({
      action: "accept", content: {}, _meta: meta,
    });
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
    expect(await approveAndInvoke(
      { ...args, serverName: "Fixture" },
      { backend, threadId: "thread-1", turnId: "turn-1", transport: "mcp" },
      new AbortController().signal,
    )).toBe(approved);
    expect(events).toHaveLength(approved ? 0 : 1);
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it.each([
    { label: "read-only", annotations: { readOnlyHint: true }, prompts: 0 },
    { label: "read-only but destructive", annotations: { readOnlyHint: true, destructiveHint: true }, prompts: 1 },
  ])("follows Codex's annotation rule for a $label tool", async ({ annotations, prompts }) => {
    operation.mockImplementation(async (params) => params.operation === "gateway/tools/list"
      ? [{ connectionId: "one", serverName: "Fixture", toolName: "lookup", schemaRevision: "r1", definition: {
          name: "lookup", annotations, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        } }]
      : { content: [{ type: "text", text: "fixture result" }] });
    const events: AgentEvent[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: null } });
    });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(true);
    expect(events).toHaveLength(prompts);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(1);
  });

  it.each([
    { toolApproval: "approve", annotations: { destructiveHint: true }, prompts: 0, lookupFails: false },
    { toolApproval: "prompt", annotations: { readOnlyHint: true }, prompts: 1, lookupFails: false },
    { toolApproval: "auto", annotations: { readOnlyHint: true }, prompts: 0, lookupFails: false },
    // A failed lookup reads as the default, never as Allow all tools.
    { toolApproval: "approve", annotations: { destructiveHint: true }, prompts: 1, lookupFails: true },
  ] as const)("follows the connection's $toolApproval tool approval (lookup fails: $lookupFails)", async ({ toolApproval, annotations, prompts, lookupFails }) => {
    operation.mockImplementation(async (params) => params.operation === "gateway/tools/list"
      ? [{ connectionId: "one", serverName: "Fixture", toolName: "lookup", schemaRevision: "r1", definition: {
          name: "lookup", annotations, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        } }]
      : { content: [{ type: "text", text: "fixture result" }] });
    await registry.close();
    createRegistry({
      registerBridge, requestGatewayToolOperation: operation,
      listConnections: async () => {
        if (lookupFails) throw new Error("owner unavailable");
        return [{ id: "one", toolApproval }];
      },
    } as never);
    const events: AgentEvent[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: null } });
    });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(true);
    expect(events).toHaveLength(prompts);
  });

  it.each(["default", "auto"] as const)("runs the opted-in Sandboxer's full workflow without approval in %s", async (executionMode) => {
    await registry.close();
    const connections = new McpConnectionRegistry({ configPath: path.join(directory, "config.toml") });
    connections.setEnabled("builtin:sandboxer", true);
    const names = ["list_sandboxes", "create_sandbox", "write_file", "exec", "stop_sandbox", "resume_sandbox"];
    operation.mockImplementation(async (params) => params.operation === "gateway/tools/list"
      ? names.map((name) => ({
          connectionId: "builtin:sandboxer", serverName: "Sandboxer", toolName: name, schemaRevision: name,
          definition: { name, inputSchema: { type: "object" }, annotations: { readOnlyHint: name === "list_sandboxes", destructiveHint: ["exec", "write_file"].includes(name), openWorldHint: true } },
        }))
      : { content: [{ type: "text", text: "sandbox result" }] });
    await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: ["builtin:sandboxer"] });
    createRegistry({ registerBridge, requestGatewayToolOperation: operation, listConnections: async () => connections.list() } as never);
    internals.activeCodexTurnModes.set("thread-1:turn-1", executionMode);
    const unexpected = declineUnexpectedApproval();
    for (const toolName of names) {
      expect((await internals.handleServerRequest("codex", request("call_mcp_tool", {
        connectionId: "builtin:sandboxer", toolName, schemaRevision: toolName, arguments: {},
      }, `sandbox-${toolName}`))).success).toBe(true);
    }
    expect(unexpected).toEqual([]);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(names.length);
  });

  it.each(["approve", "auto", "prompt"] as const)(
    "applies %s to native Codex tool approval for an exact selected bridge",
    async (toolApproval) => {
      await registry.close();
      const server = { name: "one", command: "fixture", args: [], env: { FIXTURE_BRIDGE: "one" } };
      const service = {
        registerBridge,
        peekThreadBridge: (id: string, threadId: string) => id === "one" && threadId === "thread-1" ? server : undefined,
        listConnections: async () => [{ id: "one", enabled: true, configured: true, toolApproval }],
      };
      createRegistry(service as never);
      const emitted = declineUnexpectedApproval();
      const result = await internals.handleServerRequest("codex", {
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1", turnId: "turn-1", requestId: "native-approval",
          serverName: buildCodexConnectionMcpServerName(server), mode: "form", message: "Allow create_sandbox?",
          requestedSchema: { type: "object", properties: {} },
          _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_title: "Create sandbox" },
        },
      });
      expect(result).toEqual({ action: toolApproval === "approve" ? "accept" : "decline", content: toolApproval === "approve" ? {} : null, _meta: null });
      expect(emitted).toHaveLength(toolApproval === "approve" ? 0 : 1);
    },
  );

  it.each(["lookalike", "deselected", "disabled", "signed-out", "ended", "input", "url", "upstream", "policy-error"] as const)(
    "keeps native approval interactive for %s requests",
    async (scenario) => {
      await registry.close();
      const server = { name: "one", command: "fixture", args: [], env: { FIXTURE_BRIDGE: "one" } };
      const service = {
        registerBridge,
        peekThreadBridge: (id: string, threadId: string) => id === "one" && threadId === "thread-1" ? server : undefined,
        listConnections: async () => {
          if (scenario === "policy-error") throw new Error("Fixture unavailable");
          if (scenario === "deselected") await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
          if (scenario === "ended") internals.activeTurnKeys.delete("codex:thread-1:turn-1");
          return [{ id: "one", enabled: scenario !== "disabled", configured: scenario !== "signed-out", toolApproval: "approve" }];
        },
      };
      createRegistry(service as never);
      const emitted = declineUnexpectedApproval();
      const notification: AppServerPendingRequestNotification = {
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1", turnId: "turn-1", requestId: "native-boundary",
          serverName: buildCodexConnectionMcpServerName(server) + (scenario === "lookalike" ? "_other" : ""),
          mode: scenario === "url" ? "url" : "form", message: "Allow an operation?",
          requestedSchema: { type: "object", properties: scenario === "input" ? { answer: { type: "string" } } : {} },
          _meta: scenario === "upstream" ? {} : { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
          ...(scenario === "url" ? { url: "https://example.test/authorize" } : {}),
        },
      };
      expect(await internals.handleServerRequest("codex", notification)).toMatchObject({ action: "decline" });
      expect(emitted).toHaveLength(1);
    },
  );

  it("rechecks the configured policy for every native approval without a remembered grant", async () => {
    await registry.close();
    const server = { name: "one", command: "fixture", args: [], env: {} };
    let toolApproval = "approve";
    createRegistry({
      registerBridge,
      peekThreadBridge: () => server,
      listConnections: async () => [{ id: "one", enabled: true, configured: true, toolApproval }],
    } as never);
    const emitted = declineUnexpectedApproval();
    const notification: AppServerPendingRequestNotification = {
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", requestId: "native-first", mode: "form",
        serverName: buildCodexConnectionMcpServerName(server), message: "Allow create?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
      },
    };
    expect(await internals.handleServerRequest("codex", notification)).toEqual({ action: "accept", content: {}, _meta: null });
    toolApproval = "prompt";
    expect(await internals.handleServerRequest("codex", {
      ...notification, params: { ...notification.params, requestId: "native-second" },
    })).toMatchObject({ action: "decline" });
    expect(emitted).toHaveLength(1);
  });

  it("requires source-specific approval and deduplicates the same dynamic call", async () => {
    const pending = approval();
    const call = internals.handleServerRequest("codex", request("call_mcp_tool", args));
    const duplicate = internals.handleServerRequest("codex", request("call_mcp_tool", args));
    const event = await pending;
    if (event.notification.method !== "mcpServer/elicitation/request") throw new Error("Expected MCP approval");
    // The card draws the message as its title and the arguments as rows.
    expect(event.notification.params).toMatchObject({
      serverName: "Fixture", mode: "form",
      message: "Allow the agent to call \"lookup\" on Fixture?",
      _meta: { tool_params_display: [{ name: "id", value: "fixture" }] },
    });
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(0);
    await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: null } });
    expect((await call).success).toBe(true);
    expect(await duplicate).toEqual(await call);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(1);
    expect(internals.pendingServerRequests.size).toBe(0);
  });

  it("offers conversation approval through the gateway's actual request and renderer response", async () => {
    const pending = approval();
    const call = internals.handleServerRequest("codex", request("call_mcp_tool", args));
    const event = await pending;
    if (event.notification.method !== "mcpServer/elicitation/request") throw new Error("Expected MCP approval");
    const state = createMcpElicitationState(event.notification as AppServerMcpElicitationRequestNotification)!;
    // Resolve even when the assertion fails, so the pending call is owned by
    // this test rather than left for registry shutdown.
    const modes = readMcpApprovalPersistence(state);
    await registry.submitServerRequest({
      backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: state.requestId,
      response: buildMcpElicitationResponse(state, "accept", modes.includes("session") ? "session" : undefined),
    });
    expect((await call).success).toBe(true);
    expect(modes).toEqual(["session", "server-session"]);

    const unexpected = declineUnexpectedApproval();
    internals.activeTurnKeys.add("codex:thread-1:turn-2");
    const next = request("call_mcp_tool", { ...args, arguments: { id: "another record" } }, "call-2");
    expect((await internals.handleServerRequest("codex", { ...next, params: { ...next.params, turnId: "turn-2" } })).success).toBe(true);
    expect(unexpected).toEqual([]);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(2);
  });

  it("uses a server conversation grant for a different tool with different arguments", async () => {
    const tools = ["lookup", "write_file"].map((name) => ({
      connectionId: "one", serverName: "Fixture", toolName: name, schemaRevision: name,
      definition: { name, inputSchema: { type: "object" as const }, annotations: { destructiveHint: true } },
    }));
    operation.mockImplementation(async (params) => params.operation === "gateway/tools/list" ? tools : { content: [] });
    const events: AgentEvent[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      const state = createMcpElicitationState(event.notification as AppServerMcpElicitationRequestNotification)!;
      await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: state.requestId,
        response: buildMcpElicitationResponse(state, "accept", "server-session") });
    });
    for (const tool of tools) {
      expect((await internals.handleServerRequest("codex", request("call_mcp_tool", {
        connectionId: tool.connectionId, toolName: tool.toolName, schemaRevision: tool.schemaRevision,
        arguments: { path: "/tmp/fixture", content: tool.toolName },
      }, `server-${tool.toolName}`))).success).toBe(true);
    }
    expect(events).toHaveLength(1);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(2);
  });

  it.each(["other-tool", "other-connection", "other-thread", "other-backend", "changed-catalog", "changed-selection"])(
    "scopes server consent by conversation, connection and catalog: %s",
    async (scenario) => {
      const events: AgentEvent[] = [];
      registry.onEvent(async (event) => {
        if (event.notification.method !== "mcpServer/elicitation/request") return;
        events.push(event);
        await registry.submitServerRequest({ backend: event.backend, threadId: event.notification.params.threadId,
          turnId: event.notification.params.turnId ?? undefined, requestId: String(event.notification.params.requestId),
          response: { action: "accept", content: {}, _meta: { persist: "server-session" } } });
      });
      const context: AgentToolCallContext = { backend: "codex", threadId: "thread-1", turnId: "turn-1", transport: "codex_dynamic_tool" };
      const invocation = { ...args, serverName: "Fixture" };
      expect(await approveAndInvoke(invocation, context, new AbortController().signal, "catalog-1")).toBe(true);
      if (scenario === "changed-selection") {
        await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: [] });
        await store.setThreadMcpConnectionIds({ backend: "codex", threadId: "thread-1", connectionIds: ["one"] });
      }
      expect(await approveAndInvoke({ ...invocation, toolName: "write_file",
        ...(scenario === "other-connection" ? { connectionId: "two" } : {}),
      }, { ...context,
        ...(scenario === "other-thread" ? { threadId: "thread-2" } : {}),
        ...(scenario === "other-backend" ? { backend: "acp:fixture" as const } : {}),
      }, new AbortController().signal, scenario === "changed-catalog" ? "catalog-2" : "catalog-1")).toBe(true);
      expect(events).toHaveLength(scenario === "other-tool" ? 1 : 2);
    },
  );

  it.each(["same-tool", "other-tool", "other-connection", "other-thread", "other-backend", "changed-schema"])(
    "scopes conversation approval to its backend, thread, connection, tool and revision: %s",
    async (scenario) => {
      const events: AgentEvent[] = [];
      registry.onEvent(async (event) => {
        if (event.notification.method !== "mcpServer/elicitation/request") return;
        events.push(event);
        await registry.submitServerRequest({
          backend: event.backend, threadId: event.notification.params.threadId,
          turnId: event.notification.params.turnId ?? undefined, requestId: String(event.notification.params.requestId),
          response: { action: "accept", content: {}, _meta: { persist: "session" } },
        });
      });
      const context: AgentToolCallContext = { backend: "codex", threadId: "thread-1", turnId: "turn-1", transport: "codex_dynamic_tool" };
      const invocation = { ...args, serverName: "Fixture" };
      expect(await approveAndInvoke(invocation, context, new AbortController().signal)).toBe(true);
      const nextInvocation = {
        ...invocation, arguments: { id: "another record" },
        ...(scenario === "other-tool" ? { toolName: "write" } : {}),
        ...(scenario === "other-connection" ? { connectionId: "two" } : {}),
        ...(scenario === "changed-schema" ? { schemaRevision: "r2" } : {}),
      };
      const nextContext = {
        ...context, turnId: "turn-2",
        ...(scenario === "other-thread" ? { threadId: "thread-2" } : {}),
        ...(scenario === "other-backend" ? { backend: "acp:fixture" as const } : {}),
      };
      expect(await approveAndInvoke(nextInvocation, nextContext, new AbortController().signal)).toBe(true);
      expect(events).toHaveLength(scenario === "same-tool" ? 1 : 2);
    },
  );

  it.each([
    { action: "accept" as const, persist: undefined },
    { action: "accept" as const, persist: "always" },
    { action: "decline" as const, persist: "session" },
    { action: "cancel" as const, persist: "session" },
  ])("does not remember a $action response with persistence $persist", async ({ action, persist }) => {
    const events: AgentEvent[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      await registry.submitServerRequest({
        backend: event.backend, threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId),
        response: { action, content: {}, _meta: persist ? { persist } : null },
      });
    });
    const context: AgentToolCallContext = { backend: "codex", threadId: "thread-1", turnId: "turn-1", transport: "codex_dynamic_tool" };
    for (let i = 0; i < 2; i++) {
      expect(await approveAndInvoke({ ...args, serverName: "Fixture" }, context, new AbortController().signal)).toBe(action === "accept");
    }
    expect(events).toHaveLength(2);
  });

  it("revokes conversation approval when MCP selection changes", async () => {
    const events: AgentEvent[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: { persist: "session" } } });
    });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(true);
    await registry.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds: [] });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args, "call-2"))).success).toBe(false);
    await registry.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds: ["one"] });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args, "call-3"))).success).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("stops a thread's sessions for the connections it turned off, and only those", async () => {
    await registry.close();
    const closeThreadSessions = vi.fn(async () => undefined);
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }), listThreads: async () => [],
        onNotification: () => () => {}, onPendingRequest: () => () => {},
        readConfiguredMcpServerNames: async () => [], startThread: async () => ({ threadId: "headless-1" }),
        startTurn,
      } as never,
      overlayStore: store, isBootstrapMode: () => false,
      mcpConnectionService: { registerBridge, requestGatewayToolOperation: operation, closeThreadSessions },
    });

    await registry.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds: ["one", "two"] });
    expect(closeThreadSessions).not.toHaveBeenCalled();
    await registry.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds: ["two"] });
    expect(closeThreadSessions).toHaveBeenCalledExactlyOnceWith("thread-1", ["one"]);

    // A failed release is logged; the operator's selection still lands.
    closeThreadSessions.mockRejectedValueOnce(new Error("owner went away"));
    await expect(registry.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds: [] }))
      .resolves.toBeDefined();
    expect(closeThreadSessions).toHaveBeenLastCalledWith("thread-1", ["two"]);
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.mcpConnectionIds ?? []).toEqual([]);
  });

  it.each([
    { change: "toggling the backend's own servers", connectionIds: ["one"], providerServersEnabled: false },
    { change: "re-saving the same connections", connectionIds: ["one", " one "], providerServersEnabled: undefined },
  ])("keeps conversation approval when $change", async ({ connectionIds, providerServersEnabled }) => {
    const events: AgentEvent[] = [];
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      events.push(event);
      await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: { persist: "session" } } });
    });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(true);
    const before = (await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.mcpSelectionRevision;
    await registry.setThreadMcpConnections({ backend: "codex", threadId: "thread-1", connectionIds, providerServersEnabled });
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.mcpSelectionRevision).toBe(before);
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args, "call-2"))).success).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("expires conversation approval when PwrAgent closes and reopens the same profile", async () => {
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: { persist: "session" } } });
    });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(true);
    await registry.close();
    createRegistry();
    const events = declineUnexpectedApproval();
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(false);
    expect(events).toHaveLength(1);
    expect(operation.mock.calls.filter(([entry]) => entry.operation === "gateway/tools/call")).toHaveLength(1);
  });

  it("still enforces active-turn and actor permissions after conversation approval", async () => {
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: { persist: "session" } } });
    });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args))).success).toBe(true);
    operation.mockClear();
    internals.activeTurnKeys.clear();
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args, "call-2"))).success).toBe(false);
    internals.activeTurnKeys.add("codex:thread-1:turn-1");
    Object.assign(registry, { messagingAgentToolService: { checkDynamicToolPermission: vi.fn(() => ({ allowed: false, permission: "tools.instance_management" })) } });
    expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args, "call-3"))).success).toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not resurrect an old grant after a changed schema is declined", async () => {
    let prompts = 0;
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      prompts += 1;
      await registry.submitServerRequest({
        backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId),
        response: { action: prompts === 1 ? "accept" : "decline", content: {}, _meta: { persist: "session" } },
      });
    });
    const context: AgentToolCallContext = { backend: "codex", threadId: "thread-1", turnId: "turn-1", transport: "codex_dynamic_tool" };
    const invocation = { ...args, serverName: "Fixture" };
    expect(await approveAndInvoke(invocation, context, new AbortController().signal)).toBe(true);
    expect(await approveAndInvoke({ ...invocation, schemaRevision: "r2" }, context, new AbortController().signal)).toBe(false);
    expect(await approveAndInvoke(invocation, context, new AbortController().signal)).toBe(false);
    expect(prompts).toBe(3);
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

  it.each([
    { executionMode: "default" as const, persist: null },
    { executionMode: "full-access" as const, persist: null },
    { executionMode: "default" as const, persist: "session" },
    { executionMode: "default" as const, persist: "server-session" },
  ])("adds no SQLite writes for discovery and repeated invocation in $executionMode with $persist approval", async ({ executionMode, persist }) => {
    await store.setThreadExecutionMode({ backend: "codex", threadId: "thread-1", executionMode });
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    registry.onEvent(async (event) => {
      if (event.notification.method !== "mcpServer/elicitation/request") return;
      await registry.submitServerRequest({ backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(event.notification.params.requestId), response: { action: "accept", content: {}, _meta: persist ? { persist } : null } });
    });
    const { writes } = await measureSqliteWrites(async () => {
      expect((await internals.handleServerRequest("codex", request("search_mcp_tools", { query: "lookup" }))).success).toBe(true);
      expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args, "call-2"))).success).toBe(true);
      expect((await internals.handleServerRequest("codex", request("call_mcp_tool", args, "call-3"))).success).toBe(true);
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
