import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerPendingRequestNotification,
  MessagingDynamicToolCategory,
  TaskMonitorRequest,
  TaskMonitorResponse,
} from "@pwragent/shared";
import type { DynamicToolCallResponse, DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import type { TokenMiserService } from "../token-miser/token-miser-service";
import { createTempStateDb } from "./sqlite-test-utils";

describe("Codex catalog dynamic tool dispatch", () => {
  let directory: string;
  let db: StateDb;
  let registry: DesktopBackendRegistry;
  let internals: {
    activeTurnKeys: Set<string>;
    tokenMiserStore?: TokenMiserStore;
    tokenMiserService?: TokenMiserService;
    buildCodexParentDynamicTools(tokenMiserEnabled: boolean, discoveryEnabled: boolean): DynamicToolSpec[];
    performServerRequest(backend: "codex", request: AppServerPendingRequestNotification, signal?: AbortSignal): Promise<DynamicToolCallResponse>;
    isTokenMiserDynamicToolCallEnabled(): Promise<boolean>;
    dynamicToolPermissionDenied(): string | null;
    handleAgentTaskMonitorRequest(request: TaskMonitorRequest): Promise<TaskMonitorResponse>;
  };
  const request = (namespace: string, tool: string): AppServerPendingRequestNotification => ({
    method: "item/tool/call",
    params: {
      threadId: "thread-1", turnId: "turn-1", callId: `call-${tool}`, requestId: `call-${tool}`,
      namespace, tool, arguments: {},
    },
  });

  beforeEach(() => {
    const fixture = createTempStateDb("pwragent-catalog-dispatch-");
    directory = fixture.tempDir;
    db = StateDb.open(fixture.dbPath);
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }), listThreads: async () => [],
        onNotification: () => () => {}, onPendingRequest: () => () => {}, readConfiguredMcpServerNames: async () => [],
      } as never,
      overlayStore: new SqliteOverlayStore(db), isBootstrapMode: () => false,
    });
    internals = registry as unknown as typeof internals;
    internals.activeTurnKeys.add("codex:thread-1:turn-1");
    // Only build contracts; no retrieval or inference runs in dispatch coverage.
    internals.tokenMiserStore = { flushAll: async () => {} } as TokenMiserStore;
    internals.tokenMiserService = { focused: { isEnabled: () => true } } as TokenMiserService;
    vi.spyOn(internals, "isTokenMiserDynamicToolCallEnabled").mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    const specs = internals.buildCodexParentDynamicTools(tokenMiser, discovery);
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
    internals.activeTurnKeys.clear();
    const dispatch = vi.spyOn(AgentToolRouter.prototype, "handleDynamicToolCall");
    for (const spec of internals.buildCodexParentDynamicTools(true, true)) {
      if (spec.type !== "namespace") throw new Error(`Unexpected tool spec: ${spec.type}`);
      for (const tool of spec.tools) {
        const response = await internals.performServerRequest("codex", request(spec.name, tool.name));
        expect(response.success, tool.name).toBe(false);
        expect(JSON.parse((response.contentItems[0] as { text: string }).text).code, tool.name).toBe("forbidden");
      }
    }
    expect(dispatch).not.toHaveBeenCalled();
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
    ["pwragent_app", "manage_pwragent"],
    ["pwragent_messaging", "get_current_messaging_surface"],
  ])("keeps persisted %s definitions dispatchable", async (namespace, tool) => {
    const dispatch = vi.spyOn(AgentToolRouter.prototype, "handleDynamicToolCall").mockResolvedValue({ success: true, contentItems: [] });
    expect((await internals.performServerRequest("codex", request(namespace, tool))).success).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ backend: "codex", call: expect.objectContaining({ namespace: "pwragent", tool }) });
  });

  it.each(["inject_progress", "complete_monitoring"])("routes the monitor role's %s definition", async (tool) => {
    const dispatch = vi.spyOn(AgentToolRouter.prototype, "handleDynamicToolCall").mockResolvedValue({ success: true, contentItems: [] });
    const signal = new AbortController().signal;
    expect((await internals.performServerRequest("codex", request("pwragent", tool), signal)).success).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ backend: "codex", call: expect.objectContaining({ tool }), signal });
  });

  it.each(["create_monitor_delegation", "inject_progress", "complete_monitoring"])("retains the frozen legacy task-monitor operation %s", async (tool) => {
    const handler = vi.spyOn(internals, "handleAgentTaskMonitorRequest").mockResolvedValue({ ok: true } as TaskMonitorResponse);
    expect((await internals.performServerRequest("codex", request("pwragent_task_monitors", tool))).success).toBe(true);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ operation: tool }));
  });

  it("does not add cancellation to the frozen legacy task-monitor namespace", async () => {
    const handler = vi.spyOn(internals, "handleAgentTaskMonitorRequest");
    const response = await internals.performServerRequest("codex", request("pwragent_task_monitors", "cancel_monitor_delegation"));
    expect(response.success).toBe(false);
    expect(JSON.stringify(response)).toContain("Unsupported legacy");
    expect(handler).not.toHaveBeenCalled();
  });
});
