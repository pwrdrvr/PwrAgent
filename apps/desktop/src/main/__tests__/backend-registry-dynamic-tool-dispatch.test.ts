import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { MessagingDynamicToolCategory } from "@pwragent/shared/contracts/rbac";
import type { TaskMonitorResponse } from "@pwragent/shared/contracts/task-monitor-tools";
import type { DynamicToolCallResponse, DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { buildTurnUserMessageOriginId } from "../app-server/thread-transcript-helpers";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { PWRAGENT_TOOL_GUIDE } from "../agent-tools/pwragent-tool-guide";
import { RbacPolicyService } from "../messaging/rbac-policy-service";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import type { TokenMiserService } from "../token-miser/token-miser-service";
import { createTempStateDb } from "./sqlite-test-utils";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { DurableConfigSnapshotStore } from "../storage/durable-config-snapshot-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { messagingAccessHarness } from "./fixtures/messaging-access-harness";

describe("Codex catalog dynamic tool dispatch", () => {
  let directory: string;
  let db: StateDb;
  let overlay: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  let internals: {
    tokenMiserStore?: TokenMiserStore;
    tokenMiserService?: TokenMiserService;
    buildCodexParentDynamicTools(tokenMiserEnabled: boolean, discoveryEnabled: boolean): Promise<DynamicToolSpec[]>;
    performServerRequest(backend: "codex", request: AppServerPendingRequestNotification, signal?: AbortSignal): Promise<DynamicToolCallResponse>;
    isTokenMiserDynamicToolCallEnabled(): Promise<boolean>;
    dynamicToolPermissionDenied(): string | null;
  };
  const request = (namespace: string, tool: string, args = {}): AppServerPendingRequestNotification => ({
    method: "item/tool/call",
    params: {
      threadId: "thread-1", turnId: "turn-1", callId: `call-${tool}`, requestId: `call-${tool}`,
      namespace, tool, arguments: args,
    },
  });

  beforeEach(() => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const fixture = createTempStateDb("pwragent-catalog-dispatch-");
    directory = fixture.tempDir;
    db = StateDb.open(fixture.dbPath);
    overlay = new SqliteOverlayStore(db);
    registry = createDesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }), listThreads: async () => [],
        onNotification: () => () => {}, onPendingRequest: () => () => {}, readConfiguredMcpServerNames: async () => [],
      } as never,
      overlayStore: overlay, isBootstrapMode: () => false,
    });
    internals = registry as unknown as typeof internals;
    registryModules(registry).turnState.registerTurn("codex:thread-1:turn-1");
    // Only build contracts; no retrieval or inference runs in dispatch coverage.
    internals.tokenMiserStore = { flushAll: async () => {} } as TokenMiserStore;
    internals.tokenMiserService = { focused: { isEnabled: () => true } } as TokenMiserService;
    vi.spyOn(internals, "isTokenMiserDynamicToolCallEnabled").mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    internals.tokenMiserService = undefined;
    await registry.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    { tokenMiser: false, discovery: false },
    { tokenMiser: true, discovery: false },
    { tokenMiser: false, discovery: true },
    { tokenMiser: true, discovery: true },
  ])("routes every advertised definition: %j", async ({ tokenMiser, discovery }) => {
    // Stop at the router boundary so arbitrary tools cannot create threads,
    // change settings, or invoke external services during this inventory test.
    const dispatch = vi.spyOn(AgentToolRouter.prototype, "handleDynamicToolCall").mockResolvedValue({
      success: true, contentItems: [],
    });
    const specs = await internals.buildCodexParentDynamicTools(tokenMiser, discovery);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec.type).toBe("namespace");
      if (spec.type !== "namespace") throw new Error(`Unexpected tool spec: ${spec.type}`);
      for (const tool of spec.tools) {
        dispatch.mockClear();
        const response = await internals.performServerRequest("codex", request(spec.name, tool.name));
        expect(response.success, `${spec.name}.${tool.name} has no dispatch route`).toBe(true);
        expect(dispatch, `${spec.name}.${tool.name} must reach its router`).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
          backend: "codex", call: expect.objectContaining({ namespace: spec.name, tool: tool.name }),
        }));
      }
    }
  });

  it("checks the active turn for every advertised tool before dispatch", async () => {
    registryModules(registry).turnState.registeredTurnKeys().forEach(key => registryModules(registry).turnState.unregisterTurn(key));
    const dispatch = vi.spyOn(AgentToolRouter.prototype, "handleDynamicToolCall");
    for (const spec of await internals.buildCodexParentDynamicTools(true, true)) {
      if (spec.type !== "namespace") throw new Error(`Unexpected tool spec: ${spec.type}`);
      for (const tool of spec.tools) {
        const response = await internals.performServerRequest("codex", request(spec.name, tool.name));
        expect(response.success, tool.name).toBe(false);
        expect(JSON.parse((response.contentItems[0] as { text: string }).text).code, tool.name).toBe("forbidden");
      }
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("allows the static guide without lifecycle authority while requiring a live turn", async () => {
    const checkDynamicToolPermission = vi.fn(() => ({ allowed: false, permission: "tools.instance_management" }));
    registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(), checkDynamicToolPermission });

    const guide = await internals.performServerRequest("codex", request("pwragent", "read_tool_guide"));
    expect(guide.success).toBe(true);
    expect(JSON.parse((guide.contentItems[0] as { text: string }).text)).toEqual({ guide: PWRAGENT_TOOL_GUIDE });
    expect(checkDynamicToolPermission).not.toHaveBeenCalled();

    const management = await internals.performServerRequest("codex", request("pwragent", "manage_pwragent"));
    expect(management.success).toBe(false);
    expect(JSON.stringify(management)).toContain("persisted Agent designation");
    expect(checkDynamicToolPermission).not.toHaveBeenCalled();

    checkDynamicToolPermission.mockClear();
    registryModules(registry).turnState.registeredTurnKeys().forEach(key => registryModules(registry).turnState.unregisterTurn(key));
    const inactiveGuide = await internals.performServerRequest("codex", request("pwragent", "read_tool_guide"));
    expect(inactiveGuide.success).toBe(false);
    expect(JSON.parse((inactiveGuide.contentItems[0] as { text: string }).text).code).toBe("forbidden");
    expect(checkDynamicToolPermission).not.toHaveBeenCalled();
  });

  it("reports unknown when the current provider turn has no admitted input source", async () => {
    const result = await internals.performServerRequest("codex", request("pwragent", "get_current_turn_input_source"));
    expect(result.success).toBe(true);
    expect(JSON.parse((result.contentItems[0] as { text: string }).text)).toEqual({ source: "unknown" });
    const spoofed = await internals.performServerRequest("codex", request("pwragent", "get_current_turn_input_source", { source: "desktop" }));
    expect(spoofed.success).toBe(false);
    expect(JSON.parse((spoofed.contentItems[0] as { text: string }).text)).toMatchObject({ code: "invalid_arguments" });
  });

  it("reads the provisional source only for the provider turn announced at ingress", async () => {
    const turnState = registryModules(registry).turnState;
    turnState.unregisterTurn("codex:thread-1:turn-1");
    const origin = { backend: "codex" as const, threadId: "thread-1", turnInputSource: "desktop" as const };
    turnState.addStartingOrigin(origin);
    const ingress = turnState.beginStartDelivery("thread-1", "turn-1");
    try {
      const toolCall = request("pwragent", "get_current_turn_input_source");
      const result = await internals.performServerRequest("codex", toolCall);
      expect(JSON.parse((result.contentItems[0] as { text: string }).text)).toEqual({ source: "desktop" });
      turnState.observeTurnTerminal("thread-1", "turn-1");
      expect((await internals.performServerRequest("codex", toolCall)).success).toBe(false);
    } finally {
      turnState.endStartDelivery(ingress);
      turnState.removeStartingOrigin(origin);
    }
  });

  it.each(["get_messaging_working_updates_default", "set_messaging_working_updates_default"])(
    "fails closed when %s comes from a live turn without a verified origin",
    async (tool) => {
      const response = await internals.performServerRequest("codex", request(
        "pwragent", tool, tool.startsWith("set") ? { mode: "show_none" } : {},
      ));
      expect(response.success).toBe(false);
      expect(JSON.parse((response.contentItems[0] as { text: string }).text)).toMatchObject({ code: "forbidden" });
    },
  );

  it("saves only the verified profile default, returns a no-op on retry and reopens with the same value", async () => {
    const configPath = path.join(directory, "config.toml");
    const initialConfig = '[messaging]\nmanager_tool_update_mode = "show_more"\n# Keep this comment\n';
    writeFileSync(configPath, initialConfig);
    const config = new DesktopConfigStore({ configPath, storage: new DurableConfigSnapshotStore(db) });
    const secretStore = new MemoryDesktopSecretStore();
    await secretStore.setSecret("telegramBotToken", "synthetic-private-token");
    const settings = new DesktopSettingsService({ configPath, configStore: config, env: {}, secretStore });
    registry.setMessagingWorkingUpdatesSettings(settings);
    const get = (args = {}) => internals.performServerRequest("codex", request("pwragent", "get_messaging_working_updates_default", args));
    const set = (args: Record<string, unknown>) => internals.performServerRequest("codex", request("pwragent", "set_messaging_working_updates_default", args));
    const data = (response: DynamicToolCallResponse) => JSON.parse((response.contentItems[0] as { text: string }).text);
    const source = { requestId: "requested-by-actor", ownerId: "fixture-profile", instanceId: "local-owner" };
    const context = { backend: "codex" as const, threadId: "thread-1" };
    const authorizeRetainedTool = vi.fn(async () => ({ allowed: true }));
    registry.setMessagingAgentToolService({ authorizeRetainedTool,
      handlePwrAgentMessagingRequest: vi.fn(), checkDynamicToolPermission: vi.fn(() => ({ allowed: true })) });
    await overlay.upsertThreadMessageOrigin({ ...context, messageId: "user:turn-1",
      origin: { kind: "messaging", causalMessagingSource: source } });
    try {
      const scope = { scope: "local_profile", bindingTargetKind: "thread" };
      expect(data(await get())).toEqual({ ...scope, value: "show_some", source: "default" });
      authorizeRetainedTool.mockResolvedValueOnce({ allowed: false });
      expect(data(await set({ mode: "show_none" })).code).toBe("forbidden");
      expect(readFileSync(configPath, "utf8")).toBe(initialConfig);

      const { result, writes } = await measureSqliteWrites(() => set({ mode: "show_none" }));
      expect(result.success).toBe(true);
      expect(data(result)).toEqual({ ...scope, value: "show_none", source: "config", changed: true });
      expectSqliteWriteBudget({ scenario: "agent-working-updates-default-change", writes,
        note: "One existing config snapshot commit per changed Working Updates default. No per-turn, idle or streaming writes." });

      const unchanged = await measureSqliteWrites(async () => {
        expect(data(await get())).toEqual({ ...scope, value: "show_none", source: "config" });
        expect(data(await set({ mode: "show_none" }))).toEqual({ ...scope, value: "show_none", source: "config", changed: false });
        for (const extra of [{ key: "telegramBotToken" }, { profile: "other" }, { instanceId: "peer" }, { includeRemote: true }]) {
          expect(data(await get(extra)).code).toBe("invalid_arguments");
          expect(data(await set({ mode: "show_all", ...extra })).code).toBe("invalid_arguments");
        }
        expect(data(await set({ mode: "quiet" })).code).toBe("invalid_arguments");
      });
      expectSqliteWriteBudget({ scenario: "agent-working-updates-default-read-noop-invalid", writes: unchanged.writes,
        note: "Profile Working Updates read, identical update and invalid attempts commit nothing." });
      // A peer process can save the same profile before this owner's watcher runs.
      writeFileSync(configPath, readFileSync(configPath, "utf8").replace('tool_update_mode = "show_none"', 'tool_update_mode = "show_all"'));
      expect(config.read("messaging").toolUpdateMode).toBe("show_none");
      expect(data(await set({ mode: "show_none" }))).toEqual({ ...scope, value: "show_none", source: "config", changed: true });
      expect(readFileSync(configPath, "utf8")).toContain('tool_update_mode = "show_none"');
      expect(authorizeRetainedTool).toHaveBeenCalledWith(
        { ...context, turnId: "turn-1", causalMessagingSource: source },
        { ...context, turnId: "turn-1", category: "messaging_context", tool: "set_messaging_working_updates_default" },
      );
      expect(await secretStore.getSecret("telegramBotToken")).toBe("synthetic-private-token");
      expect(readFileSync(configPath, "utf8")).toContain("# Keep this comment");
      const reopened = new DesktopSettingsService({ configPath, env: {}, secretStore });
      expect(reopened.readMessagingSettings()).toMatchObject({
        toolUpdateMode: { value: "show_none", source: "config" },
        managerToolUpdateMode: { value: "show_more", source: "config" },
      });
      authorizeRetainedTool.mockImplementationOnce(async () => {
        await overlay.upsertThreadMessageOrigin({ ...context, messageId: "turn-causal:turn-1",
          origin: { kind: "messaging", causalMessagingAmbiguous: true } });
        return { allowed: true };
      });
      expect(data(await set({ mode: "show_all" })).code).toBe("forbidden");
      expect(reopened.readMessagingSettings().toolUpdateMode.value).toBe("show_none");
    } finally {
      config.dispose();
    }
  });

  it.each<[MessagingDynamicToolCategory, string]>([
    ["automation_inspection", "list_automations"],
    ["app_management", "manage_pwragent"],
    ["thread_inspection", "get_thread_status"],
    ["forge", "list_ci_runs"],
    ["thread_orchestration", "handoff_task"],
    ["messaging_context", "get_current_messaging_surface"],
    ["star_map", "read_star_map_view"],
  ])("preserves messaging RBAC for the %s catalog", async (category, tool) => {
    const denied = vi.spyOn(internals, "dynamicToolPermissionDenied").mockReturnValue("fixture.permission");
    const dispatch = vi.spyOn(AgentToolRouter.prototype, "handleDynamicToolCall");
    const response = await internals.performServerRequest("codex", request("pwragent", tool));
    expect(denied).toHaveBeenCalledWith("codex", category, expect.objectContaining({ tool }));
    expect(response.success).toBe(false);
    expect(JSON.stringify(response)).toContain("fixture.permission");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["pwragent_automations", "list_automations"],
    ["pwragent_threads", "get_thread_status"],
    ["pwragent_messaging", "get_current_messaging_surface"],
  ])("keeps persisted %s definitions dispatchable", async (namespace, tool) => {
    const dispatch = vi.spyOn(AgentToolRouter.prototype, "handleDynamicToolCall").mockResolvedValue({ success: true, contentItems: [] });
    expect((await internals.performServerRequest("codex", request(namespace, tool))).success).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ backend: "codex", call: expect.objectContaining({ namespace: "pwragent", tool }) });
  });

  it("reports the lifecycle gate that actually denied an admitted Telegram request", async () => {
    const fixture = await messagingAccessHarness("telegram", true);
    try {
      const policy = new RbacPolicyService({ env: { PWRAGENT_HOME: directory } }, () => {});
      fixture.controllerOptions.rbacPolicy = policy.providerFor("telegram");
      fixture.controllerOptions.adapter.retainedSourceConnectionId = () => "fixture-connection";
      const context = { backend: "codex" as const, threadId: "fixture-thread", turnId: "fixture-turn" };
      const subject = { kind: "actor" as const, platform: "telegram" as const, actorId: "fixture-actor" };
      registryModules(registry).turnState.registerTurn("codex:fixture-thread:fixture-turn");
      registry.setMessagingAgentToolService({
        handlePwrAgentMessagingRequest: vi.fn(),
        checkDynamicToolPermission: vi.fn(),
        authorizeRetainedTool: async (caller, check) => fixture.controller.authorizeRetainedTool(caller, check),
      });
      const dispatch = vi.spyOn(AgentToolRouter.prototype, "handleDynamicToolCall")
        .mockResolvedValue({ success: true, contentItems: [] });
      const cases = [
        { scenario: "legacy", denial: "requires messaging RBAC enforcement" },
        { scenario: "admin", denial: null },
        { scenario: "power_user_tools", denial: "tools.instance_lifecycle" },
        { scenario: "custom", denial: null },
        { scenario: "ordinary-thread", denial: "persisted Agent designation" },
        { scenario: "missing-origin", denial: "no retained messaging actor" },
        { scenario: "ambiguous-origin", denial: "messaging actor for this turn is ambiguous" },
        { scenario: "revoked-provider", denial: "could not verify current messaging access" },
        { scenario: "actor-changed", denial: "messaging actor changed during app management authorization" },
      ] as const;
      policy.upsertRole({ id: "fixture-role", name: "Fixture role", builtIn: false,
        permissions: ["message.reply", "tools.instance_management", "tools.instance_lifecycle"] });
      await fc.assert(fc.asyncProperty(fc.constantFrom(...cases), fc.constantFrom("pwragent", "pwragent_app"), async ({ scenario, denial }, namespace) => {
        dispatch.mockClear();
        policy.setEnforced(scenario !== "legacy");
        policy.upsertAttachment({ subject, roleIds: [scenario === "custom" ? "fixture-role"
          : scenario === "power_user_tools" ? scenario : "admin"] });
        fixture.controllerOptions.adapter.authorizeRetainedSource = async () => {
          if (scenario === "actor-changed") {
            await overlay.upsertThreadMessageOrigin({
              ...context,
              messageId: buildTurnUserMessageOriginId(context.turnId),
              origin: { kind: "messaging", causalMessagingSource: { ...fixture.source.ref, requestId: "replacement-request" } },
            });
          }
          return scenario !== "revoked-provider";
        };
        await overlay.setThreadAgent({ ...context, agent: scenario === "ordinary-thread" ? null : { name: "Fixture Agent" } });
        await overlay.upsertThreadMessageOrigin({
          ...context,
          messageId: buildTurnUserMessageOriginId(context.turnId),
          origin: scenario === "missing-origin" ? { kind: "agent" } : {
            kind: "messaging", causalMessagingSource: fixture.source.ref,
            causalMessagingAmbiguous: scenario === "ambiguous-origin",
          },
        });
        const response = await internals.performServerRequest("codex", {
          method: "item/tool/call",
          params: {
            ...context, namespace, tool: "manage_pwragent", arguments: { action: "status" },
            callId: "fixture-call", requestId: "fixture-call",
          },
        });
        expect(response.success).toBe(denial === null);
        expect(dispatch).toHaveBeenCalledTimes(denial === null ? 1 : 0);
        if (denial) {
          const error = JSON.parse((response.contentItems[0] as { text: string }).text);
          expect(error.code).toBe("forbidden");
          expect(error.message).toContain(denial);
        }
      }), { examples: cases.flatMap(testCase => [[testCase, "pwragent"], [testCase, "pwragent_app"]]), numRuns: 24 });
    } finally {
      await fixture.close();
    }
  });

  it.each(["inject_progress", "complete_monitoring"])("routes the monitor role's %s definition", async (tool) => {
    const dispatch = vi.spyOn(AgentToolRouter.prototype, "handleDynamicToolCall").mockResolvedValue({ success: true, contentItems: [] });
    const signal = new AbortController().signal;
    expect((await internals.performServerRequest("codex", request("pwragent", tool), signal)).success).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ backend: "codex", call: expect.objectContaining({ tool }), signal });
  });

  it.each(["create_monitor_delegation", "inject_progress", "complete_monitoring"])("retains the frozen legacy task-monitor operation %s", async (tool) => {
    const handler = vi.spyOn(registryModules(registry).subAgentMonitorService, "handleAgentTaskMonitorRequest")
      .mockResolvedValue({ ok: true } as TaskMonitorResponse);
    expect((await internals.performServerRequest("codex", request("pwragent_task_monitors", tool))).success).toBe(true);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ operation: tool }));
  });

  it("does not add cancellation to the frozen legacy task-monitor namespace", async () => {
    const handler = vi.spyOn(registryModules(registry).subAgentMonitorService, "handleAgentTaskMonitorRequest");
    const response = await internals.performServerRequest("codex", request("pwragent_task_monitors", "cancel_monitor_delegation"));
    expect(response.success).toBe(false);
    expect(JSON.stringify(response)).toContain("Unsupported legacy");
    expect(handler).not.toHaveBeenCalled();
  });
});
