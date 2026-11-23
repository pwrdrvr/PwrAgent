import {
  configuredMemberRole,
  pwragentDynamicTools,
  expectPwragentDynamicTools,
  createAgentOverlay,
  nonRepositoryCwd,
  waitForCondition,
  createOverlayStoreMock,
  MockBackendClient,
  createMessagingArchiveCleanupStoreMock,
  createKimiAcpRegistry,
  callRegistryMcpTool,
  emitCompletedTurn,
  discoverCodexBackendForTest,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { getOwnerHostServices, installOwnerHostServices } from "../owner-host";
import { createOutpostRuntimePolicy } from "../owner-runtime-policy";
import fc from "fast-check";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { snapshotThreadAgentTrustPolicy } from "@pwragent/shared/contracts/navigation";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { threadLockRefusalMessage } from "@pwragent/shared/thread-lock";
import {
  THREAD_EXECUTION_MODES_BY_ACCESS,
  threadExecutionModeForRawPermissions,
  threadExecutionModeRank,
} from "@pwragent/shared/thread-execution-mode";
import { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type {
  AcpBackendId,
  AppServerPendingRequestNotification,
  AppServerThreadSummary,
  ArchiveThreadCleanupResult,
  ArchiveThreadRequest,
  HandoffThreadWorkspaceResponse,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  MarkThreadSeenRequest,
  SetThreadParentRequest,
  SetThreadPinRequest,
} from "@pwragent/shared/contracts/navigation";
import type { PwrAgentMessagingResponse } from "@pwragent/shared/contracts/messaging-tools";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
import { GitWorkingStateService } from "../app-server/git-working-state-service";
import { type MockOverlayState } from "./helpers/mock-sub-agent-store";
import { TestTokenMiserStore as TokenMiserStore } from "./token-miser-test-store";
import type { AgentToolMcpServerLike } from "../agent-tools/agent-tool-mcp-server";
import { PwrAgentFederatedThreadMessageError, type PwrAgentFederatedThreadMessageRequest } from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import { MESSAGING_EAGER_TOOLS, VOICE_MANAGER_EAGER_TOOLS } from "../agent-tools/pwragent-tool-search";
import { THREAD_MAINTENANCE_TOOL_WAIT_MS } from "../agent-tools/thread-maintenance-tool-scans";

describe("DesktopBackendRegistry", () => {
  describe("existing Codex Agent designation", () => {
    const agent = { name: "Fixture manager", instructions: "Manage requested messaging attachments." };
    const capabilities = { codeModeOutputReducer: { protocolVersion: 1 as const, dynamicToolsResumeField: "dynamicTools" as const } };
    const identity = { backend: "codex" as const, threadId: "existing-agent" };

    it("checks trust after a preceding policy save settles and before removing a Codex Agent", async () => {
      await fc.assert(fc.asyncProperty(fc.boolean(), async (occupied) => {
        const overlayStore = createOverlayStoreMock();
        const codexClient = new MockBackendClient({ threads: [], serverCapabilities: capabilities });
        const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
        const entered = Promise.withResolvers<void>();
        const releaseSave = Promise.withResolvers<void>();
        try {
          await registry.setThreadAgent({ ...identity, agent });
          codexClient.refreshThreadTools.mockClear();
          if (occupied) {
            await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: {
              threadId: identity.threadId, turnId: "fixture-active", turn: { id: "fixture-active" },
            } } });
          }
          const originalSave = overlayStore.setThreadAgentTrustPolicy;
          vi.spyOn(overlayStore, "setThreadAgentTrustPolicy").mockImplementationOnce(async (request) => {
            entered.resolve();
            await releaseSave.promise;
            return await originalSave(request);
          });
          const restriction = { version: 1, denialResponse: "silent", rules: [] } as const;
          const save = registry.setThreadAgentTrustPolicy({
            ...identity, expectedRevision: snapshotThreadAgentTrustPolicy(undefined).revision, policy: restriction,
          });
          await Promise.race([entered.promise, save.then(() => expect.fail("Policy save must reach the store"))]);
          const removal = registry.setThreadAgent({ ...identity, agent: null });
          const result = Promise.allSettled([save, removal]);
          await waitForImmediate();
          releaseSave.resolve();

          expect(await result).toMatchObject([
            { status: "fulfilled", value: { trustPolicy: restriction } },
            { status: "rejected", reason: { message: expect.stringContaining("Clear the Agent") } },
          ]);
          expect(codexClient.refreshThreadTools).not.toHaveBeenCalled();
          expect(await overlayStore.getThreadOverlayState(identity)).toMatchObject({ agent: { trustPolicy: restriction }, queuedAgentChange: undefined });
        } finally {
          releaseSave.resolve();
          await registry.close();
        }
      }), { numRuns: 10, examples: [[false], [true]] });
    });

    it.each([false, true])("refreshes, persists and authorizes promotion independently of discovery (%s)", async (discovery) => {
      const overlayStore = createOverlayStoreMock();
      const codexClient = new MockBackendClient({ threads: [], serverCapabilities: capabilities });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore, resolveCodexToolDiscovery: () => discovery });
      const dispatch = vi.fn(async () => ({ ok: true, data: {} }) as PwrAgentMessagingResponse);
      registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: dispatch, checkDynamicToolPermission: () => ({ allowed: true }) });
      const call = {
        method: "item/tool/call",
        params: { threadId: identity.threadId, turnId: "turn-attach", callId: "attach-1", requestId: "attach-1", namespace: "pwragent", tool: "attach_thread_here", arguments: { backend: "codex", threadId: "fixture-target" } },
      } as AppServerPendingRequestNotification;
      const start = async () => registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId: identity.threadId, turnId: "turn-attach", turn: { id: "turn-attach" } } } });
      try {
        await start();
        expect(await codexClient.emitRequest(call)).toMatchObject({ success: false });
        expect(dispatch).not.toHaveBeenCalled();
        await registry.setThreadAgent({ ...identity, agent });
        expect(await codexClient.emitRequest(call)).toMatchObject({ success: false });
        expect(dispatch).not.toHaveBeenCalled();
        expect(codexClient.refreshThreadTools).not.toHaveBeenCalled();
        await emitCompletedTurn(registry, "codex", identity.threadId, "turn-attach");
        await vi.waitFor(async () => expect(await registry.getThreadAgentMetadata(identity)).toEqual(agent));
        const tools = pwragentDynamicTools(codexClient.refreshThreadTools.mock.calls[0][0].dynamicTools);
        expect(tools.some((tool) => tool.name === "attach_thread_here")).toBe(true);
        expect(tools.some((tool) => tool.name === "tool_search")).toBe(discovery);
        await registry.startThread({ backend: "codex", cwd: nonRepositoryCwd, agent });
        expect(codexClient.refreshThreadTools.mock.calls[0][0].dynamicTools).toEqual(codexClient.lastStartThreadParams?.dynamicTools);
        await start();
        expect(await codexClient.emitRequest(call)).toMatchObject({ success: true });
        expect(dispatch).toHaveBeenCalledOnce();
        expect(await registry.setThreadAgent({ ...identity, agent: null })).toMatchObject({ agent, queuedAgentChange: { agent: null } });
        expect(await registry.getThreadAgentMetadata(identity)).toEqual(agent);
        await emitCompletedTurn(registry, "codex", identity.threadId, "turn-attach");
        await vi.waitFor(async () => expect(await registry.getThreadAgentMetadata(identity)).toBeUndefined());
        await start();
        expect(await codexClient.emitRequest(call)).toMatchObject({ success: false });
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        await registry.close();
      }
      // A new registry reads the durable designation; no process-local grant.
      const reloaded = createDesktopBackendRegistry({ codexClient: new MockBackendClient({ threads: [] }), overlayStore });
      try {
        expect(await reloaded.getThreadAgentMetadata(identity)).toBeUndefined();
      } finally {
        await reloaded.close();
      }
    });

    it("queues promotion without granting authority, deduplicates, and allows cancellation", async () => {
      const overlayStore = createOverlayStoreMock();
      const codexClient = new MockBackendClient({ threads: [], serverCapabilities: capabilities });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      const save = vi.spyOn(overlayStore, "setQueuedThreadAgentChange");
      try {
        await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId: identity.threadId, turnId: "turn-active", turn: { id: "turn-active" } } } });
        expect(await registry.setThreadAgent({ ...identity, agent })).toMatchObject({ queuedAgentChange: { agent } });
        expect(await registry.getThreadAgentMetadata(identity)).toBeUndefined();
        expect(codexClient.refreshThreadTools).not.toHaveBeenCalled();
        await registry.setThreadAgent({ ...identity, agent });
        expect(save).toHaveBeenCalledOnce();
        await registry.setThreadAgent({ ...identity, agent: null });
        expect((await overlayStore.getThreadOverlayState(identity))?.queuedAgentChange).toBeUndefined();
        await emitCompletedTurn(registry, "codex", identity.threadId, "turn-active");
        expect(codexClient.refreshThreadTools).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledTimes(2);
      } finally { await registry.close(); }
    });

    it("restores a queued promotion and applies it before the next turn", async () => {
      const overlayStore = createOverlayStoreMock();
      const original = createDesktopBackendRegistry({ codexClient: new MockBackendClient({ threads: [], serverCapabilities: capabilities }), overlayStore });
      await original.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId: identity.threadId, turnId: "turn-active", turn: { id: "turn-active" } } } });
      await original.setThreadAgent({ ...identity, agent });
      await original.close();
      const codexClient = new MockBackendClient({ threads: [], serverCapabilities: capabilities });
      const reloaded = createDesktopBackendRegistry({ codexClient, overlayStore });
      try {
        await reloaded.startTurn({ ...identity, input: [{ type: "text", text: "Fixture" }] });
        expect(codexClient.refreshThreadTools).toHaveBeenCalledOnce();
        expect(await reloaded.getThreadAgentMetadata(identity)).toEqual(agent);
        expect((await overlayStore.getThreadOverlayState(identity))?.queuedAgentChange).toBeUndefined();
        expect(codexClient.startTurnCalls).toHaveLength(1);
      } finally { await reloaded.close(); }
    });

    it("keeps failed queued changes visible without automatic retries and accepts an explicit retry", async () => {
      const overlayStore = createOverlayStoreMock();
      const codexClient = new MockBackendClient({ threads: [], serverCapabilities: capabilities });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      try {
        await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId: identity.threadId, turnId: "turn-active", turn: { id: "turn-active" } } } });
        await registry.setThreadAgent({ ...identity, agent });
        codexClient.refreshThreadTools.mockRejectedValueOnce(new Error("fixture refresh failed"));
        await emitCompletedTurn(registry, "codex", identity.threadId, "turn-active");
        await vi.waitFor(async () => expect((await overlayStore.getThreadOverlayState(identity))?.queuedAgentChange?.error).toBe("fixture refresh failed"));
        expect(await registry.getThreadAgentMetadata(identity)).toBeUndefined();
        await registry.startTurn({ ...identity, input: [{ type: "text", text: "Fixture" }] });
        expect(codexClient.refreshThreadTools).toHaveBeenCalledOnce();
        await emitCompletedTurn(registry, "codex", identity.threadId);
        await registry.setThreadAgent({ ...identity, agent });
        expect(await registry.getThreadAgentMetadata(identity)).toEqual(agent);
        expect((await overlayStore.getThreadOverlayState(identity))?.queuedAgentChange).toBeUndefined();
      } finally { await registry.close(); }
    });

    it("rejects unsupported runtimes without saving", async () => {
      const codexClient = new MockBackendClient({ threads: [], serverCapabilities: {} });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      try {
        await expect(registry.setThreadAgent({ ...identity, agent })).rejects.toThrow("Update to a supported");
        expect(await registry.getThreadAgentMetadata(identity)).toBeUndefined();
        expect(codexClient.refreshThreadTools).not.toHaveBeenCalled();
        await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId: identity.threadId, turnId: "turn-active", turn: { id: "turn-active" } } } });
        await expect(registry.setThreadAgent({ ...identity, agent })).rejects.toThrow("Update to a supported");
      } finally { await registry.close(); }
    });

    it("keeps the previous designation on failed refresh and releases the reservation", async () => {
      const codexClient = new MockBackendClient({ threads: [], serverCapabilities: capabilities });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      try {
        codexClient.refreshThreadTools.mockRejectedValueOnce(new Error("refresh refused"));
        await expect(registry.setThreadAgent({ ...identity, agent })).rejects.toThrow("refresh refused");
        expect(await registry.getThreadAgentMetadata(identity)).toBeUndefined();
        await registry.setThreadAgent({ ...identity, agent });
        codexClient.refreshThreadTools.mockRejectedValueOnce(new Error("refresh refused"));
        await expect(registry.setThreadAgent({ ...identity, agent: null })).rejects.toThrow("refresh refused");
        expect(await registry.getThreadAgentMetadata(identity)).toEqual(agent);
        await registry.setThreadAgent({ ...identity, agent: null });
      } finally { await registry.close(); }
    });

    it("blocks concurrent starts until the runtime transition completes", async () => {
      const codexClient = new MockBackendClient({ threads: [], serverCapabilities: capabilities });
      let release!: () => void;
      codexClient.refreshThreadTools.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      try {
        const promotion = registry.setThreadAgent({ ...identity, agent });
        await vi.waitFor(() => expect(codexClient.refreshThreadTools).toHaveBeenCalledOnce());
        expect(await registry.getThreadAgentMetadata(identity)).toBeUndefined();
        await expect(registry.startTurn({ ...identity, input: [{ type: "text", text: "Fixture" }] })).rejects.toThrow("already active");
        expect(await registry.submitTurn({ ...identity, input: [{ type: "text", text: "Queued fixture" }] })).toMatchObject({ status: "queued" });
        release();
        await promotion;
        await vi.waitFor(() => expect(codexClient.startTurnCalls).toHaveLength(1));
        expect(codexClient.lastStartTurnParams?.input).toEqual([{ type: "text", text: "Queued fixture" }]);
        expect(await registry.getThreadAgentMetadata(identity)).toEqual(agent);
      } finally { release?.(); await registry.close(); }
    });

    it("does not demote while an attachment dispatched by the previous turn is still in flight", async () => {
      const codexClient = new MockBackendClient({ threads: [], serverCapabilities: capabilities });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      let release!: () => void;
      const dispatch = vi.fn(async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { ok: true, data: {} } as PwrAgentMessagingResponse;
      });
      registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: dispatch, checkDynamicToolPermission: () => ({ allowed: true }) });
      try {
        await registry.setThreadAgent({ ...identity, agent });
        await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId: identity.threadId, turnId: "turn-attach", turn: { id: "turn-attach" } } } });
        const attachment = codexClient.emitRequest({ method: "item/tool/call", params: {
          threadId: identity.threadId, turnId: "turn-attach", requestId: "fixture-attach", callId: "fixture-attach", namespace: "pwragent", tool: "attach_thread_here", arguments: { backend: "codex", threadId: "fixture-target" },
        } } as AppServerPendingRequestNotification);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        await emitCompletedTurn(registry, "codex", identity.threadId, "turn-attach");
        expect(await registry.setThreadAgent({ ...identity, agent: null })).toMatchObject({ agent, queuedAgentChange: { agent: null } });
        expect(await registry.getThreadAgentMetadata(identity)).toEqual(agent);
        release();
        await attachment;
        await vi.waitFor(async () => expect(await registry.getThreadAgentMetadata(identity)).toBeUndefined());
      } finally { release?.(); await registry.close(); }
    });

    it("preserves non-Codex designation without a Codex runtime", async () => {
      const codexClient = new MockBackendClient({ threads: [] });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      try {
        await registry.setThreadAgent({ backend: "acp:gemini", threadId: "fixture", agent });
        expect(await registry.getThreadAgentMetadata({ backend: "acp:gemini", threadId: "fixture" })).toEqual(agent);
        expect(codexClient.refreshThreadTools).not.toHaveBeenCalled();
      } finally { await registry.close(); }
    });
  });

  it.each([
    { version: "0.152.0", expected: "default" },
    { version: "0.153.0", expected: "auto" },
  ])("starts an Auto launchpad thread on $expected under Codex $version", async ({
    version,
    expected,
  }) => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-auto-start-"));
    const configStore = new DesktopConfigStore({
      configPath: path.join(tempRoot, "config.toml"),
    });
    const command = "/opt/homebrew/bin/codex";
    configStore.recordProviderDiscovery("codex", {
      candidates: [{ command, source: "path", version }],
      selectedCommand: command,
      selectedVersion: version,
    });
    const codexClient = new MockBackendClient({
      threads: [],
      initializeResult: { userAgent: `pwragent/${version} (Mac OS 26.6.2; arm64) unknown` },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, configStore, overlayStore });
    try {
      await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
      await registry.startThread({
        backend: "codex",
        cwd: nonRepositoryCwd,
        executionMode: "auto",
      });
      expect(
        (await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))
          ?.executionMode,
      ).toBe(expected);
      expect(
        (codexClient.lastStartThreadParams as { approvalsReviewer?: string } | undefined)
          ?.approvalsReviewer,
      ).toBe(expected === "auto" ? "auto_review" : "user");
    } finally {
      await registry.close();
      configStore.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("dispatches the advertised tool guide only from a live owning turn", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    try {
      await registry.startThread({ backend: "codex", cwd: nonRepositoryCwd });
      expect(pwragentDynamicTools(codexClient.lastStartThreadParams?.dynamicTools).map((tool) => tool.name)).toContain("read_tool_guide");
      const call = {
        method: "item/tool/call",
        params: { threadId: "thread-1", turnId: "guide-turn", callId: "guide-1", requestId: "guide-1", namespace: "pwragent", tool: "read_tool_guide", arguments: {} },
      } as AppServerPendingRequestNotification;
      expect(await codexClient.emitRequest(call)).toMatchObject({ success: false });
      await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId: "thread-1", turnId: "guide-turn", turn: { id: "guide-turn" } } } });
      expect(await codexClient.emitRequest({ ...call, params: { ...call.params, callId: "guide-2", requestId: "guide-2" } })).toMatchObject({
        success: true,
        contentItems: [{ type: "inputText", text: expect.stringContaining("Use get_thread_status for compact state.") }],
      });
    } finally { await registry.close(); }
  });

  it("refreshes tool discovery in both directions and authorizes only live searches", async () => {
    let enabled = false;
    const codexClient = new MockBackendClient({
      threads: [],
      serverCapabilities: { codeModeOutputReducer: { protocolVersion: 1, dynamicToolsResumeField: "dynamicTools" } },
    });
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore: createOverlayStoreMock(),
      resolveCodexToolDiscovery: () => enabled,
    });
    try {
      await registry.startThread({ backend: "codex", cwd: nonRepositoryCwd });
      const initial = pwragentDynamicTools(codexClient.lastStartThreadParams?.dynamicTools);
      expect(initial.some((tool) => tool.name === "tool_search")).toBe(false);
      enabled = true;
      await registry.startThread({ backend: "codex", cwd: nonRepositoryCwd });
      const deferred = pwragentDynamicTools(codexClient.lastStartThreadParams?.dynamicTools);
      expect(deferred.filter((tool) => !(tool as { deferLoading?: boolean }).deferLoading).map((tool) => tool.name).sort())
        .toEqual(["get_current_turn_input_source", "tool_search"]);
      await registry.startTurn({ backend: "codex", threadId: "thread-1", input: [{ type: "text", text: "Continue." }] });
      expect(pwragentDynamicTools(codexClient.lastStartTurnParams?.dynamicTools).map((tool) => tool.name)).toEqual(deferred.map((tool) => tool.name));
      await emitCompletedTurn(registry, "codex", "thread-1");
      enabled = false;
      await registry.startTurn({ backend: "codex", threadId: "thread-1", input: [{ type: "text", text: "Continue." }] });
      expect(pwragentDynamicTools(codexClient.lastStartTurnParams?.dynamicTools)).toEqual(initial);

      const call = {
        method: "item/tool/call",
        params: { threadId: "thread-1", turnId: "turn-discovery", callId: "search-1", requestId: "search-1", namespace: "pwragent", tool: "tool_search", arguments: { query: "get_thread_status", limit: 1 } },
      } as AppServerPendingRequestNotification;
      expect(await codexClient.emitRequest(call)).toMatchObject({ success: false });
      await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId: "thread-1", turnId: "turn-discovery", turn: { id: "turn-discovery" } } } });
      // A persisted bootstrap remains usable after switching the experiment off.
      const result = await codexClient.emitRequest({
        ...call,
        params: { ...call.params, callId: "search-2", requestId: "search-2" },
      }) as { success: boolean; contentItems: Array<{ text: string }> };
      expect(result.success).toBe(true);
      expect(JSON.parse(result.contentItems[0].text).tools[0]).toMatchObject({ name: "get_thread_status", inputSchema: { type: "object" } });
    } finally {
      await registry.close();
    }
  });

  it("loads a known working set eagerly for the Voice manager and messaging-bound threads", async () => {
    let discovery = true;
    const overlayStore = Object.assign(createOverlayStoreMock(), {
      getVoiceManagerThread: () => ({ backend: "codex", threadId: "voice-manager" }),
    });
    const codexClient = new MockBackendClient({
      threads: [],
      serverCapabilities: { codeModeOutputReducer: { protocolVersion: 1, dynamicToolsResumeField: "dynamicTools" } },
    });
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore,
      messagingStore: createMessagingArchiveCleanupStoreMock({
        bindings: [{ id: "binding-bound", backend: "codex", threadId: "bound-thread" }],
      }),
      resolveCodexToolDiscovery: () => discovery,
    });
    const eagerNames = async (threadId: string) => {
      await registry.startTurn({ backend: "codex", threadId, input: [{ type: "text", text: "Continue." }] });
      await emitCompletedTurn(registry, "codex", threadId);
      return pwragentDynamicTools(codexClient.lastStartTurnParams?.dynamicTools)
        .filter((tool) => !(tool as { deferLoading?: boolean }).deferLoading)
        .map((tool) => tool.name)
        .sort();
    };
    try {
      // The 2026-10-01 Voice manager turn had only tool_search eager and
      // searched seven times before its first useful call.
      const baseline = ["get_current_turn_input_source", "tool_search"];
      expect(await eagerNames("voice-manager")).toEqual([...baseline, ...VOICE_MANAGER_EAGER_TOOLS].sort());
      expect(await eagerNames("bound-thread")).toEqual([...baseline, ...MESSAGING_EAGER_TOOLS].sort());
      expect(await eagerNames("thread-1")).toEqual(baseline);
      // Without discovery nothing is deferred, so the sets change nothing.
      discovery = false;
      expect(pwragentDynamicTools(codexClient.lastStartTurnParams?.dynamicTools).length).toBeGreaterThan(0);
      await registry.startTurn({ backend: "codex", threadId: "voice-manager", input: [{ type: "text", text: "Continue." }] });
      expect(pwragentDynamicTools(codexClient.lastStartTurnParams?.dynamicTools).some((tool) => tool.name === "tool_search")).toBe(false);
    } finally {
      await registry.close();
    }
  });

  // A desktop and an Outpost are the same kind of federation member. The
  // host only supplies the operator's settings: an Outpost from its
  // environment, a desktop from config.toml (which has no approvals switch,
  // so it always asks). Whether the host is headless must decide nothing.
  //
  // The host services are global. A property that outlives its test (a
  // timeout) keeps running, and each run it starts would install a member
  // under the next test. So the test restores its own services when it
  // finishes, and no member is installed once its signal has aborted.
  function memberInstaller(signal: AbortSignal) {
    const original = getOwnerHostServices();
    onTestFinished(() => {
      installOwnerHostServices(original);
      configuredMemberRole.role = undefined;
    });
    return (host: "desktop" | "outpost", settings: { approvals: "ask" | "never"; role: "full" | "contained" }): void => {
      signal.throwIfAborted();
      if (host === "outpost") {
        installOwnerHostServices({ ...original, runtimePolicy: createOutpostRuntimePolicy({
          PWRAGENT_OUTPOST_APPROVALS: settings.approvals,
          PWRAGENT_OUTPOST_FEDERATION_ROLE: settings.role,
        }) });
        configuredMemberRole.role = undefined;
      } else {
        installOwnerHostServices({ ...original, runtimePolicy: undefined });
        configuredMemberRole.role = settings.role;
      }
    };
  }

  // The member properties start their threads here, never in the test's own
  // checkout: nothing about the machine running them may reach the answer.
  function emptyThreadDirectory(): string {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "member-thread-"));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
    return cwd;
  }

  it("asks for approval by execution mode, approvals setting and role on every host, never by whether it is headless", async ({ signal }) => {
    const installMember = memberInstaller(signal);
    const cwd = emptyThreadDirectory();
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("desktop" as const, "outpost" as const), fc.constantFrom("ask" as const, "never" as const),
      fc.constantFrom("full" as const, "contained" as const), fc.constantFrom("default" as const, "auto" as const),
      async (host, generatedApprovals, role, mode) => {
        const approvals = host === "desktop" ? "ask" : generatedApprovals;
        installMember(host, { approvals, role });
        // Oracle, from the product rule: Default and Auto ask on request; a
        // person reviews, except in Auto on a full member, where Codex's Auto
        // reviewer does; an operator who turned approvals off is never asked.
        const expected = approvals === "never"
          ? { approvalPolicy: "never", approvalsReviewer: "user" }
          : { approvalPolicy: "on-request", approvalsReviewer: mode === "auto" && role === "full" ? "auto_review" : "user" };
        const codexClient = new MockBackendClient({ threads: [] });
        const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
        try {
          const { threadId } = await registry.startThread({ backend: "codex", cwd, executionMode: mode });
          expect(codexClient.lastStartThreadParams).toMatchObject(expected);
          await registry.startTurn({ backend: "codex", threadId, executionMode: mode, input: [{ type: "text", text: "Invented request." }] });
          expect(codexClient.lastStartTurnParams).toMatchObject(expected);
        } finally {
          await registry.close();
        }
      },
    ), { numRuns: 40 });
  });

  it("lists and runs agent tools by the member's role alone, on every host", async ({ signal }) => {
    const installMember = memberInstaller(signal);
    const allowed = ["read_tool_guide"];
    const refused = ["get_thread_status", "send_message_to_thread", "list_federation_instances"];
    // Role alone decides; nothing on the machine running the test may.
    // get_thread_status reads its thread's Git working state. With the
    // test's own checkout as the thread's directory, that was ten Git
    // commands per call, about a second on CI runners. The thread lives in
    // an empty directory, the real working-state service runs Git through a
    // runner that finds no repository, and the property runs no process.
    const cwd = emptyThreadDirectory();
    const gitWorkingStateService = new GitWorkingStateService({
      runGit: async () => { throw new Error("not a git repository"); },
    });
    // Every process launch passes through this internal method.
    const childProcess = ChildProcess.prototype as unknown as { spawn(options: { args: string[] }): unknown };
    const spawn = vi.spyOn(childProcess, "spawn");
    onTestFinished(() => spawn.mockRestore());
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("desktop" as const, "outpost" as const), fc.constantFrom("full" as const, "contained" as const),
      fc.constantFrom(...allowed, ...refused),
      async (host, role, tool) => {
        installMember(host, { approvals: "ask", role });
        const reachable = role === "full" || allowed.includes(tool);
        const codexClient = new MockBackendClient({ threads: [] });
        const registry = createDesktopBackendRegistry({ codexClient, gitWorkingStateService, overlayStore: createOverlayStoreMock() });
        const mcp = new McpClient({ name: "member-role-fixture", version: "1.0.0" });
        try {
          const { threadId } = await registry.startThread({ backend: "codex", cwd });
          // A dynamic tool call from the model, advertised or made up.
          const call = await codexClient.emitRequest({
            method: "item/tool/call",
            params: { threadId, turnId: "role-turn", callId: "role-call", requestId: "role-call", namespace: "pwragent", tool, arguments: {} },
          } as AppServerPendingRequestNotification);
          expect(JSON.stringify(call).includes("does not allow this PwrAgent tool")).toBe(!reachable);
          // The same tools over the MCP server other providers use.
          // MCP calls need a live turn on the registered thread.
          const { turnId } = await registry.startTurn({ backend: "codex", threadId, input: [{ type: "text", text: "Invented request." }] });
          await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: { threadId, turnId, turn: { id: turnId } } } });
          const server = (registry as unknown as { claudeAgentToolMcpServer: AgentToolMcpServerLike }).claudeAgentToolMcpServer;
          const registration = await server.registerClient({ backend: "codex", threadId });
          await mcp.connect(new StreamableHTTPClientTransport(new URL(registration.server.url), {
            requestInit: { headers: Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])) },
          }));
          const listed = (await mcp.listTools()).tools.map(({ name }) => name);
          expect(listed.includes(tool)).toBe(reachable);
          for (const name of refused) expect(listed.includes(name)).toBe(role === "full");
          const result = await mcp.callTool({ name: tool, arguments: {} });
          expect(JSON.stringify(result).includes("does not allow this PwrAgent tool"), JSON.stringify(result)).toBe(!reachable);
        } finally {
          await mcp.close();
          await registry.close();
        }
      },
    ), { numRuns: 30 });
    expect(spawn.mock.calls.map(([options]) => options.args.join(" "))).toEqual([]);
  });

  // On an Outpost the operator's execution mode chooses the sandbox. Agent
  // tools pass a free-form sandbox, and admission sees no mode when a turn
  // inherits it from the thread, so `default` + `workspace-write` once reached
  // Codex as writes under Default Access.
  it("never lets a caller's sandbox outrank the Outpost execution mode", async () => {
    const policy = createOutpostRuntimePolicy({});
    const previous = getOwnerHostServices();
    installOwnerHostServices({ ...previous, runtimePolicy: policy });
    onTestFinished(() => installOwnerHostServices(previous));
    const modes = ["default", "auto"] as const;
    const sandboxes = [undefined, "read-only", "workspace-write"] as const;
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...modes), fc.constantFrom(...sandboxes),
      fc.constantFrom(undefined, ...modes), fc.constantFrom(...sandboxes),
      async (threadMode, threadSandbox, turnMode, turnSandbox) => {
        const codexClient = new MockBackendClient({ threads: [] });
        const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
        try {
          const threadExpected = policy.sandboxByMode[threadMode];
          const thread = registry.startThread({ backend: "codex", cwd: nonRepositoryCwd, executionMode: threadMode,
            approvalPolicy: "never", sandbox: threadSandbox });
          if (threadSandbox !== undefined && threadSandbox !== threadExpected) {
            await expect(thread).rejects.toThrow();
            expect(codexClient.lastStartThreadParams).toBeUndefined();
            return;
          }
          const { threadId } = await thread;
          expect(codexClient.lastStartThreadParams?.sandbox).toBe(threadExpected);
          const fork = registry.forkThread({ backend: "codex", sourceThreadId: threadId, executionMode: threadMode,
            approvalPolicy: "never", sandbox: threadSandbox });
          await fork;
          expect(codexClient.lastForkThreadParams?.sandbox).toBe(threadExpected);
          const turnExpected = policy.sandboxByMode[turnMode ?? threadMode];
          const turn = registry.startTurn({ backend: "codex", threadId, executionMode: turnMode,
            sandbox: turnSandbox, input: [{ type: "text", text: "Invented request." }] });
          // A sandbox needs a named mode on an Outpost, and must be that mode's.
          if (turnSandbox !== undefined && (turnMode === undefined || turnSandbox !== turnExpected)) {
            await expect(turn).rejects.toThrow();
            expect(codexClient.startTurnCalls).toEqual([]);
            return;
          }
          await turn;
          expect(codexClient.lastStartTurnParams?.sandbox).toBe(turnExpected);
        } finally {
          await registry.close();
        }
      },
    ), { numRuns: 40 });
  });

  it("advertises PwrAgent dynamic tools when starting ordinary Codex threads", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await registry.startThread({ backend: "codex" });

    expectPwragentDynamicTools(codexClient.lastStartThreadParams?.dynamicTools, [
      "list_automations",
      "search_threads",
      "read_thread",
      "get_current_messaging_surface",
      "send_messaging_file",
      "handoff_task",
      "send_message_to_thread",
      "start_review",
      "create_monitor_delegation",
      "cancel_monitor_delegation",
    ]);
    expect(pwragentDynamicTools(codexClient.lastStartThreadParams?.dynamicTools).map((tool) => tool.name))
      .not.toContain("manage_pwragent");

    await registry.close();
  });

  it("passes Agent dynamic tools when starting Agent Codex threads", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await registry.startThread({
      backend: "codex",
      agent: {
        name: "Inbox Agent",
        instructions: "Track inbox automations.",
      },
    });

    const dynamicTools = codexClient.lastStartThreadParams?.dynamicTools;
    expectPwragentDynamicTools(dynamicTools, [
      "list_automations",
      "get_automation_run_artifact",
      "create_monitor_delegation",
      "cancel_monitor_delegation",
      "search_threads",
      "read_thread",
      "get_thread_status",
      "mutate_thread",
      "get_current_messaging_surface",
      "send_messaging_file",
      "attach_thread_here",
      "handoff_task",
      "send_message_to_thread",
      "start_review",
    ]);
    expect(pwragentDynamicTools(dynamicTools).map((tool) => tool.name)).not.toContain("manage_pwragent");
    const getThreadStatusTool = pwragentDynamicTools(dynamicTools)
      .find((tool) => tool.name === "get_thread_status");
    expect(getThreadStatusTool?.description).toContain(
      "Omit backend and threadId for the current thread",
    );
    expect(getThreadStatusTool?.inputSchema?.required ?? []).toEqual([]);
    const attachPullRequestTool = pwragentDynamicTools(dynamicTools)
      .find((tool) => tool.name === "attach_thread_pull_request");
    expect(attachPullRequestTool?.description).toContain(
      "Omit backend and threadId for the current thread",
    );
    expect(attachPullRequestTool?.inputSchema?.required ?? []).toEqual([]);
    const checkPullRequestStatusTool = pwragentDynamicTools(dynamicTools)
      .find((tool) => tool.name === "check_thread_pull_request_status");
    expect(checkPullRequestStatusTool?.description).toContain(
      "Omit backend and threadId for the current thread",
    );
    expect(checkPullRequestStatusTool?.inputSchema?.required ?? []).toEqual([]);
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      agent: expect.objectContaining({
        name: "Inbox Agent",
      }),
    });

    await registry.close();
  });

  it("omits dynamic tool refresh when the exact Codex capability is absent", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["turn/start"],
      },
      serverCapabilities: {
        codeModeOutputReducer: {
          protocolVersion: 1,
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "existing-thread",
      input: [{ type: "text", text: "continue" }],
    });

    expect(codexClient.lastStartTurnParams?.dynamicTools).toBeUndefined();
    expect(codexClient.readServerCapabilitiesCallCount).toBe(1);

    await registry.close();
  });
  it("passes Agent dynamic tools when materializing Agent Codex launchpads", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "workspace:/tmp/pwragent-scratch",
      agent: {
        name: "Messaging Agent",
        instructions: "Shared messaging context.",
      },
      input: [{ type: "text", text: "Start the Agent thread." }],
      launchpad: {
        directoryKey: "workspace:/tmp/pwragent-scratch",
        directoryKind: "workspace",
        directoryLabel: "Workspaces",
        directoryPath: "/tmp/pwragent-scratch",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "local",
        model: "gpt-5.5",
        reasoningEffort: "medium",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    expectPwragentDynamicTools(codexClient.lastStartThreadParams?.dynamicTools, [
      "list_automations",
      "search_threads",
      "get_current_messaging_surface",
      "send_messaging_file",
      "attach_thread_here",
      "handoff_task",
    ]);
    expect(pwragentDynamicTools(codexClient.lastStartThreadParams?.dynamicTools).map((tool) => tool.name))
      .not.toContain("manage_pwragent");

    await registry.close();
  });

  it("handles app management dynamic tool calls from active turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const appManagementHandler = vi.fn(async () => ({
      ok: true as const,
      data: {
        action: "status" as const,
        runtime: {
          currentVersion: "1.2.3",
          startedAt: 1_000,
          startedAtIso: "1970-01-01T00:00:01.000Z",
          startedAtLocal: "Jan 1, 1970, 12:00:01 AM",
          now: 61_000,
          nowIso: "1970-01-01T00:01:01.000Z",
          nowLocal: "Jan 1, 1970, 12:01:01 AM",
          uptimeMs: 60_000,
          uptimeHuman: "1m 0s",
        },
        update: {
          status: { status: "idle" as const },
          updateAvailableToDownload: false,
          updateDownloadedWillInstallOnRestart: false,
        },
        result: { status: "reported" as const },
      },
    }));
    const overlayStore = createOverlayStoreMock({ overlays: { "codex:agent-thread": createAgentOverlay() } });
    await overlayStore.upsertThreadMessageOrigin!({ backend: "codex", threadId: "agent-thread", messageId: "user:turn-1",
      origin: { kind: "messaging", causalMessagingSource: { ownerId: "profile", requestId: "request" } } });
    const registry = createDesktopBackendRegistry({ appManagementHandler, codexClient, overlayStore });
    let actorAllowed = true;
    registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(),
      checkDynamicToolPermission: () => ({ allowed: true }), authorizeRetainedTool: async () => ({ allowed: actorAllowed }) });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "manage_pwragent",
        arguments: {
          action: "status",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining('"currentVersion": "1.2.3"'),
        },
      ],
    });
    expect(appManagementHandler).toHaveBeenCalledWith({
      operation: "manage_pwragent",
      context: { backend: "codex", threadId: "agent-thread", turnId: "turn-1" },
      args: { action: "status" },
    });

    const acceptedContext = { backend: "codex" as const, threadId: "agent-thread", turnId: "turn-1" };
    expect(await registry.canManagePwrAgent(acceptedContext)).toBe(true);
    await emitCompletedTurn(registry, "codex", "agent-thread", "turn-1");
    expect(await registry.canManagePwrAgent(acceptedContext)).toBe(false);
    expect(await registry.canManagePwrAgent({ ...acceptedContext }, false, true)).toBe(false);
    expect(await registry.canManagePwrAgent(acceptedContext, false, true)).toBe(true);
    actorAllowed = false;
    expect(await registry.canManagePwrAgent(acceptedContext, false, true)).toBe(false);

    await registry.close();
  });

  it("finds a peer's thread for a to-do request raised without its owner", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "sender", title: "Sender", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const federatedSend = vi.fn(async (request: PwrAgentFederatedThreadMessageRequest) =>
      request.resolutionMode === "remembered_only" ? undefined : {
        backend: request.backend, threadId: request.threadId, turnId: "remote-turn",
        instanceId: "peer", instanceLabel: "Studio",
      });
    registry.setFederatedThreadMessageHandler(federatedSend);

    await registry.sendThreadTodoMessage({ sourceBackend: "codex", sourceThreadId: "sender",
      target: { backend: "codex", threadId: "remote-recipient" },
      prompt: "Pick this up", todo: { id: "todo-9", title: "Hand it over" } });

    expect(federatedSend.mock.lastCall?.[0]).toEqual(expect.objectContaining({
      threadId: "remote-recipient", resolutionMode: "discover_only",
    }));
  });

  it("records the owning peer of a to-do's destination thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "sender", title: "Sender", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const search = vi.fn(async (_request: unknown) => ({
      ok: true as const,
      data: {
        query: "remote-recipient", totalCount: 2, truncated: false, searchedInstances: [], failures: [],
        results: [
          { instanceId: "other", instanceLabel: "Laptop", isLocal: false, backend: "claude" as const,
            threadId: "remote-recipient", title: "Wrong backend", score: 1 },
          { instanceId: "peer", instanceLabel: "M4 Mini / default", isLocal: false, backend: "codex" as const,
            threadId: "remote-recipient", title: "Archived worktree cleanup", score: 1 },
        ],
      },
    }));
    registry.setPwrAgentFederationHandler(search);
    const source = { backend: "codex" as const, threadId: "sender" };

    await expect(registry.locateThreadTodoMessageTarget(source, { backend: "codex", threadId: "remote-recipient" }))
      .resolves.toEqual({
        backend: "codex", threadId: "remote-recipient",
        instanceId: "peer", instanceLabel: "M4 Mini / default", title: "Archived worktree cleanup",
      });
    expect(search.mock.lastCall?.[0]).toEqual(expect.objectContaining({
      operation: "search_federation_threads", context: source,
      args: expect.objectContaining({ query: "remote-recipient", scope: "remote", backend: "codex" }),
    }));

    // A thread this instance owns stays local, and no peer is asked.
    search.mockClear();
    await expect(registry.locateThreadTodoMessageTarget(source, { backend: "codex", threadId: "sender" }))
      .resolves.toEqual({ backend: "codex", threadId: "sender", title: "Sender" });
    expect(search).not.toHaveBeenCalled();

    // A thread nobody reports keeps the agent's target.
    search.mockResolvedValueOnce({ ok: true, data: {
      query: "gone", totalCount: 0, truncated: false, searchedInstances: [], failures: [], results: [],
    } });
    await expect(registry.locateThreadTodoMessageTarget(source, { backend: "codex", threadId: "gone" }))
      .resolves.toEqual({ backend: "codex", threadId: "gone" });
  });

  it("sends a follow-up prompt to another thread from an active turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{
        id: "target-thread",
        title: "target-thread",
        titleSource: "fallback",
        source: "codex",
        linkedDirectories: [],
      }, {
        id: "parent-thread",
        title: "M4 runner-host conversion preflight",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const readTurnRoot = vi.fn(async () => "root-original");
    Object.assign(codexClient, { readTurnRoot });
    // A Full Access caller may run a Full Access turn in a Full Access thread.
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:parent-thread": {
          backend: "codex",
          threadId: "parent-thread",
          executionMode: "full-access",
          extraLinkedDirectories: [],
        },
        "codex:target-thread": {
          backend: "codex",
          threadId: "target-thread",
          executionMode: "full-access",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: null,
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "send_message_to_thread",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          prompt: "Please pick up the CI failure.",
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "priority",
          fastMode: true,
          executionMode: "full-access",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const receiptEvents = events.filter((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { origin?: { systemReason?: string } })?.origin?.systemReason === "thread-correspondence");
    expect(receiptEvents.length).toBeGreaterThan(0);
    for (const event of receiptEvents) {
      expect(((event.notification.params as { item: { text: string } }).item).text).toContain("**Message to [target-thread]");
      expect(((event.notification.params as { item: { origin: unknown } }).item).origin).toMatchObject({
        sourceThread: { threadId: "parent-thread", title: "M4 runner-host conversion preflight" },
      });
    }
    expect(events).toContainEqual(expect.objectContaining({ notification: {
      method: "thread/turnQueue/updated", params: expect.objectContaining({
        status: "started", incomingWork: {
          recipientTitle: "target-thread", omittedMessageCount: 0,
          messages: [{ origin: expect.objectContaining({ sourceThread: expect.objectContaining({ threadId: "parent-thread" }) }), preview: "Please pick up the CI failure." }],
        },
      }),
    } }));
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toEqual({
      backend: "codex",
      threadId: "target-thread",
      turnId: "turn-1",
      promptPreview: "Please pick up the CI failure.",
      // The model gets a finished link, not just an id to paraphrase into a
      // bare uuid. It is told to reproduce `threadLink` verbatim.
      threadUrl: "pwragent://thread/target-thread?backend=codex",
      threadLink: "[target-thread](pwragent://thread/target-thread?backend=codex)",
      messageId: "user:turn-1",
      messageUrl:
        "pwragent://thread/target-thread?backend=codex&messageId=user%3Aturn-1",
      messageLink:
        "[target-thread](pwragent://thread/target-thread?backend=codex&messageId=user%3Aturn-1)",
      settings: {
        executionMode: "full-access",
        model: "gpt-5.5",
        reasoningEffort: "high",
        serviceTier: "priority",
        fastMode: true,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
    expect(readTurnRoot).toHaveBeenCalledWith({ threadId: "parent-thread", turnId: "turn-1" });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      parentTurnId: "turn-1", rootTurnId: "root-original",
      threadId: "target-thread",
      input: [{ type: "text", text: "Please pick up the CI failure." }],
      model: "gpt-5.5",
      reasoningEffort: "high",
      serviceTier: "priority",
      fastMode: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "target-thread",
        turnId: "turn-1",
        item: {
          id: "message-injected",
          type: "userMessage",
          text: "Please pick up the CI failure.",
        },
      },
    });
    expect(
      events.find(
        (event) =>
          event.notification.method === "item/completed"
          && (
            event.notification.params.item as { id?: string } | undefined
          )?.id === "message-injected",
      ),
    ).toMatchObject({
      notification: {
        params: {
          item: {
            origin: {
              kind: "agent",
              sourceThread: {
                backend: "codex",
                threadId: "parent-thread",
                title: "M4 runner-host conversion preflight",
          turnId: "turn-1", rootTurnId: "root-original",
          messageId: expect.stringMatching(/^correspondence:/),
              },
            },
          },
        },
      },
    });
    expect(overlayStore.upsertThreadMessageOrigin).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "target-thread",
      messageId: "message-injected",
      origin: {
        kind: "agent",
        sourceThread: {
          backend: "codex",
          threadId: "parent-thread",
          title: "M4 runner-host conversion preflight",
          turnId: "turn-1", rootTurnId: "root-original",
          messageId: expect.stringMatching(/^correspondence:/),
        },
      },
    });

    await registry.close();
  });

  it.each([
    { tool: "send_message_to_thread", remote: false },
    { tool: "send_message_to_thread", remote: true },
    { tool: "steer_thread", remote: false },
    { tool: "steer_thread", remote: true },
  ] as const)("does not replay source images through $tool (remote=$remote)", async ({ tool, remote }) => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-source-image-"));
    const previousHome = process.env.PWRAGENT_HOME;
    const previousProfile = process.env.PWRAGENT_PROFILE;
    process.env.PWRAGENT_HOME = tempRoot;
    process.env.PWRAGENT_PROFILE = "test";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer"] },
      threads: [{
        id: "source-thread",
        title: "Source",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }, {
        id: "target-thread",
        title: "Target",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    const federatedMessage = vi.fn(async (request) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "remote-turn",
      instanceId: "remote-instance",
      instanceLabel: "Remote",
    }));
    const federatedControl = vi.fn(async (request) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "remote-turn",
      disposition: "steered" as const,
      instanceId: "remote-instance",
      instanceLabel: "Remote",
    }));
    registry.setFederatedThreadMessageHandler(federatedMessage);
    registry.setFederatedThreadControlHandler(federatedControl);
    try {
      await discoverCodexBackendForTest(registry);
      const source = await registry.startTurn({
        backend: "codex",
        threadId: "source-thread",
        input: [
          { type: "text", text: "Inspect this screenshot." },
          {
            type: "image",
            name: "screen.png",
            url: "data:image/png;base64,AQID",
          },
        ],
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "source-thread",
            turnId: source.turnId,
            turn: { id: source.turnId },
          },
        },
      });
      const remembered = registry.getTurnInputAttachments({
        backend: "codex",
        threadId: "source-thread",
        turnId: source.turnId,
      });
      expect(remembered).toEqual([expect.objectContaining({
        type: "localImage",
        name: "screen.png",
        path: expect.stringContaining(path.join("thread-assets", "codex", "source-thread")),
      })]);
      expect(JSON.stringify(remembered)).not.toContain("base64");

      if (tool === "steer_thread" && !remote) {
        await registry.publishLocalEvent({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId: "target-thread",
              turnId: "target-turn",
              turn: { id: "target-turn" },
            },
          },
        });
      }
      const response = await callRegistryMcpTool({
        registry,
        backend: "codex",
        threadId: "source-thread",
        turnId: source.turnId,
        tool,
        args: {
          backend: "codex",
          threadId: "target-thread",
          prompt: "The screenshot review is complete.",
          ...(remote ? { instanceId: "remote-instance" } : {}),
          ...(tool === "steer_thread" ? { requestId: "steer-with-source-image" } : {}),
        },
      });

      expect(response, JSON.stringify(response)).not.toHaveProperty("isError", true);
      const expectedInput = [{ type: "text", text: "The screenshot review is complete." }];
      if (remote) {
        const handler = tool === "steer_thread" ? federatedControl : federatedMessage;
        expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          threadId: "target-thread",
          input: expectedInput,
        }));
      } else {
        if (tool === "steer_thread") await waitForCondition(() => codexClient.lastSteerTurnParams !== undefined);
        const delivered = tool === "steer_thread"
          ? codexClient.lastSteerTurnParams
          : codexClient.lastStartTurnParams;
        expect(delivered).toMatchObject({ threadId: "target-thread" });
        expect(delivered?.input).toEqual(expectedInput);
      }
      // The source still owns its image; sending an update must not consume it.
      expect(registry.getTurnInputAttachments({
        backend: "codex",
        threadId: "source-thread",
        turnId: source.turnId,
      })).toEqual(remembered);
    } finally {
      await registry.close();
      if (previousHome === undefined) delete process.env.PWRAGENT_HOME;
      else process.env.PWRAGENT_HOME = previousHome;
      if (previousProfile === undefined) delete process.env.PWRAGENT_PROFILE;
      else process.env.PWRAGENT_PROFILE = previousProfile;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("queues a follow-up prompt while the target thread has an active turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{
        id: "target-thread",
        title: "target-thread",
        titleSource: "fallback",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "target-thread",
          turnId: "target-turn",
          turn: { id: "target-turn" },
        },
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });

    const response = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "send_message_to_thread",
      args: {
        backend: "codex",
        threadId: "target-thread",
        prompt: "The controller audit is complete.",
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "target-thread",
        queueStatus: "queued",
        queueEntryId: expect.stringMatching(/^thread-turn:/),
      },
    });
    expect(codexClient.startTurnCallCount).toBe(0);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "target-thread",
          turnId: "target-turn",
          turn: {
            id: "target-turn",
            status: "completed",
            output: [],
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(codexClient.lastStartTurnParams).toMatchObject({
        threadId: "target-thread",
        input: [{ type: "text", text: "The controller audit is complete." }],
      });
    });

    await registry.close();
  });

  it("stops and steers another active local thread with distinct dispositions", async () => {
    const codexClient = new MockBackendClient({
      interruptEndsTurn: true,
      initializeResult: {
        methods: ["thread/resume", "turn/interrupt", "turn/steer"],
      },
      threads: [{
        id: "target-thread",
        title: "target-thread",
        titleSource: "fallback",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    const federatedControl = vi.fn(async () => {
      throw new PwrAgentFederatedThreadMessageError("peer_unavailable", "Remembered peer is offline.");
    });
    registry.setFederatedThreadControlHandler(federatedControl);
    await discoverCodexBackendForTest(registry);
    for (const [threadId, turnId] of [
      ["target-thread", "target-turn"],
      ["parent-thread", "parent-turn"],
    ] as const) {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId,
            turnId,
            turn: { id: turnId },
          },
        },
      });
    }

    const steer = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "steer_thread",
      args: {
        backend: "codex",
        threadId: "target-thread",
        requestId: "steer-request-1",
        expectedTurnId: "target-turn",
        prompt: "Use the smaller fixture before continuing.",
      },
    });
    expect(steer).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "target-thread",
        requestId: "steer-request-1",
        turnId: expect.stringMatching(/^thread-turn:/),
        disposition: "queued",
        promptPreview: "Use the smaller fixture before continuing.",
      },
    });
    await waitForCondition(() => codexClient.lastSteerTurnParams !== undefined);
    expect(codexClient.lastSteerTurnParams).toEqual({
      threadId: "target-thread",
      expectedTurnId: "target-turn",
      onInputTextPrepared: expect.any(Function),
      input: [{
        type: "text",
        text: "Use the smaller fixture before continuing.",
      }],
    });
    expect(codexClient.startTurnCallCount).toBe(0);

    const stopArgs = {
      backend: "codex",
      threadId: "target-thread",
      requestId: "stop-request-1",
      expectedTurnId: "target-turn",
    };
    const stop = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "stop_thread",
      args: stopArgs,
    });
    expect(stop).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "target-thread",
        requestId: "stop-request-1",
        turnId: "target-turn",
        disposition: "interrupted",
        interruptedAt: expect.any(Number),
      },
    });
    expect(codexClient.interruptTurnCallCount).toBe(1);

    const stopReplay = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "stop_thread",
      args: stopArgs,
    });
    expect(stopReplay).toMatchObject({
      structuredContent: {
        disposition: "interrupted",
        idempotentReplay: true,
        requestId: "stop-request-1",
      },
    });
    expect(codexClient.interruptTurnCallCount).toBe(1);

    await expect(registry.controlActiveTurn({
      operation: "stop",
      backend: "codex",
      threadId: "target-thread",
      requestId: "stop-request-1",
      expectedTurnId: "target-turn",
      messageOrigin: {
        kind: "agent",
        sourceThread: {
          backend: "codex",
          threadId: "parent-thread",
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      disposition: "interrupted",
      idempotentReplay: true,
    });
    expect(codexClient.interruptTurnCallCount).toBe(1);

    expect(federatedControl).not.toHaveBeenCalled();
    await registry.close();
  });

  it("atomically rejects a stale ACP stop and replays an accepted owner stop", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const { acpClient, registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: "acp-target-thread",
      sessions: [{
        backendId: acpBackendId,
        sessionId: "acp-target-thread",
        title: "ACP target thread",
        createdAt: 1_000,
        updatedAt: 1_000,
        executionMode: "default",
        status: "idle",
      }],
    });
    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: "acp-target-thread",
          turnId: "turn-a",
          turn: { id: "turn-a" },
        },
      },
    });
    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/completed",
        params: {
          threadId: "acp-target-thread",
          turnId: "turn-a",
          turn: {
            id: "turn-a",
            status: "completed",
            output: [],
          },
        },
      },
    });
    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: "acp-target-thread",
          turnId: "turn-b",
          turn: { id: "turn-b" },
        },
      },
    });

    await expect(registry.controlActiveTurn({
      operation: "stop",
      backend: acpBackendId,
      threadId: "acp-target-thread",
      requestId: "stop-stale-a",
      expectedTurnId: "turn-a",
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "stale_target",
        activeTurnId: "turn-b",
        expectedTurnId: "turn-a",
      },
    });
    expect(acpClient.cancelSession).not.toHaveBeenCalled();

    const acceptedRequest = {
      operation: "stop" as const,
      backend: acpBackendId,
      threadId: "acp-target-thread",
      requestId: "stop-turn-b",
      expectedTurnId: "turn-b",
    };
    await expect(registry.controlActiveTurn(acceptedRequest)).resolves.toMatchObject({
      ok: true,
      turnId: "turn-b",
      disposition: "interrupted",
    });
    await expect(registry.controlActiveTurn(acceptedRequest)).resolves.toMatchObject({
      ok: true,
      turnId: "turn-b",
      disposition: "interrupted",
      idempotentReplay: true,
    });
    expect(acpClient.cancelSession).toHaveBeenCalledTimes(1);
    expect(acpClient.cancelSession).toHaveBeenCalledWith("acp-target-thread");

    await registry.close();
  });

  it("preserves idle and stale steers as follow-ups while rejecting invalid stops", async () => {
    const codexClient = new MockBackendClient({
      interruptEndsTurn: true,
      initializeResult: {
        methods: [
          "thread/resume",
          "turn/start",
          "turn/interrupt",
          "turn/steer",
        ],
      },
      threads: [{
        id: "idle-thread",
        title: "idle-thread",
        titleSource: "fallback",
        source: "codex",
        linkedDirectories: [],
      }, {
        id: "live-thread",
        title: "live-thread",
        titleSource: "fallback",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    await discoverCodexBackendForTest(registry);
    for (const [threadId, turnId] of [
      ["live-thread", "turn-new"],
      ["parent-thread", "parent-turn"],
    ] as const) {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: { threadId, turnId, turn: { id: turnId } },
        },
      });
    }

    const idle = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "stop_thread",
      args: {
        backend: "codex",
        threadId: "idle-thread",
        requestId: "stop-idle",
      },
    });
    expect(idle).toMatchObject({
      isError: true,
      structuredContent: { code: "no_active_turn" },
    });

    const idleSteer = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "steer_thread",
      args: {
        backend: "codex",
        threadId: "idle-thread",
        requestId: "steer-idle",
        prompt: "Apply the corrected branch guidance.",
      },
    });
    expect(idleSteer).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "idle-thread",
        requestId: "steer-idle",
        turnId: "turn-1",
        disposition: "started",
        fallbackReason: "no_active_turn",
      },
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "idle-thread",
      input: [{ type: "text", text: "Apply the corrected branch guidance." }],
    });

    const stale = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "steer_thread",
      args: {
        backend: "codex",
        threadId: "live-thread",
        requestId: "steer-stale",
        expectedTurnId: "turn-old",
        prompt: "Stop now.",
      },
    });
    expect(stale).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "live-thread",
        requestId: "steer-stale",
        disposition: "queued",
        fallbackReason: "stale_target",
        queueEntryId: expect.stringMatching(/^thread-turn:/),
      },
    });

    const self = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "stop_thread",
      args: {
        backend: "codex",
        threadId: "parent-thread",
        requestId: "stop-self",
      },
    });
    expect(self).toMatchObject({
      isError: true,
      structuredContent: { code: "forbidden" },
    });
    expect(codexClient.interruptTurnCallCount).toBe(0);

    await registry.close();
  });

  it("starts one follow-up when the target finishes during steer admission", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/resume", "turn/start", "turn/steer"],
      },
      threads: [{
        id: "target-thread",
        title: "target-thread",
        titleSource: "fallback",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    await discoverCodexBackendForTest(registry);
    for (const [threadId, turnId] of [
      ["target-thread", "target-turn"],
      ["parent-thread", "parent-turn"],
    ] as const) {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: { threadId, turnId, turn: { id: turnId } },
        },
      });
    }

    const steerTurn = vi.spyOn(codexClient, "steerTurn")
      .mockImplementationOnce(async () => {
        await registry.publishLocalEvent({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "target-thread",
              turnId: "target-turn",
              turn: {
                id: "target-turn",
                status: "completed",
                output: [],
              },
            },
          },
        });
        throw new Error("no active turn to steer");
      });
    const args = {
      backend: "codex",
      threadId: "target-thread",
      requestId: "steer-race",
      expectedTurnId: "target-turn",
      prompt: "Switch to the real remote-tracking branch.",
    };

    const response = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "steer_thread",
      args,
    });
    expect(response).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "target-thread",
        requestId: "steer-race",
        turnId: expect.stringMatching(/^thread-turn:/),
        disposition: "queued",
      },
    });
    await waitForCondition(() => codexClient.startTurnCallCount === 1);
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "target-thread",
      input: [{
        type: "text",
        text: "Switch to the real remote-tracking branch.",
      }],
    });

    const replay = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "steer_thread",
      args,
    });
    expect(replay).toMatchObject({
      structuredContent: {
        disposition: "queued",
        idempotentReplay: true,
        requestId: "steer-race",
      },
    });
    expect(steerTurn).toHaveBeenCalledTimes(1);
    expect(codexClient.startTurnCallCount).toBe(1);

    await registry.close();
  });

  it("reports a local backend turn-control capability denial", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/resume"] },
      threads: [{
        id: "target-thread",
        title: "target-thread",
        titleSource: "fallback",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    await discoverCodexBackendForTest(registry);
    for (const [threadId, turnId] of [
      ["target-thread", "target-turn"],
      ["parent-thread", "parent-turn"],
    ] as const) {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: { threadId, turnId, turn: { id: turnId } },
        },
      });
    }

    const response = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "stop_thread",
      args: {
        backend: "codex",
        threadId: "target-thread",
        requestId: "stop-unsupported",
      },
    });

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { code: "unsupported_capability" },
    });
    expect(codexClient.interruptTurnCallCount).toBe(0);
    await registry.close();
  });
  it("queues a follow-up prompt while an ACP target has an active turn", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const startPrompt = vi.fn((params: { sessionId: string }) => ({
      sessionId: params.sessionId,
      turnId: "queued-acp-turn",
    }));
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      codexClient,
      sessionId: "acp-target-thread",
      sessions: [{
        backendId: acpBackendId,
        sessionId: "acp-target-thread",
        title: "ACP target thread",
        createdAt: 1_000,
        updatedAt: 1_000,
        executionMode: "default",
        status: "idle",
      }],
      startPrompt,
    });
    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: "acp-target-thread",
          turnId: "acp-target-turn",
          turn: { id: "acp-target-turn" },
        },
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });

    const response = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "send_message_to_thread",
      args: {
        backend: acpBackendId,
        threadId: "acp-target-thread",
        prompt: "The controller audit is complete.",
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        backend: acpBackendId,
        threadId: "acp-target-thread",
        queueStatus: "queued",
        queueEntryId: expect.stringMatching(/^thread-turn:/),
      },
    });
    expect(startPrompt).not.toHaveBeenCalled();

    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/completed",
        params: {
          threadId: "acp-target-thread",
          turnId: "acp-target-turn",
          turn: {
            id: "acp-target-turn",
            status: "completed",
            output: [],
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(startPrompt).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "acp-target-thread",
        prompt: "The controller audit is complete.",
      }));
    });

    await registry.close();
  });

  it("resolves and sends to a federated thread after a local UUID miss", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{
        id: "parent-thread",
        title: "M4 runner-host conversion preflight",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    const federatedSend = vi.fn(
      async (sendRequest: PwrAgentFederatedThreadMessageRequest) =>
        sendRequest.resolutionMode === "remembered_only"
          ? undefined
          : {
              backend: "codex" as const,
              threadId: "019fd821-1450-7952-85ca-3bb8e5d150da",
              turnId: "remote-turn-1",
              title: "Thread list stays disabled after reconnect",
              instanceId: "pwr_harold",
              instanceLabel: "Harold-Mac-Mini-M4",
            },
    );
    registry.setFederatedThreadMessageHandler(federatedSend);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "turn-1",
      tool: "send_message_to_thread",
      args: {
        backend: "codex",
        threadId: "019fd821-1450-7952-85ca-3bb8e5d150da",
        prompt: "Please handle the expanded reconnect scope.",
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "019fd821-1450-7952-85ca-3bb8e5d150da",
        instanceId: "pwr_harold",
        turnId: "remote-turn-1",
        threadLink:
          "[Thread list stays disabled after reconnect](pwragent://thread/019fd821-1450-7952-85ca-3bb8e5d150da?backend=codex&instanceId=pwr_harold)",
        threadUrl:
          "pwragent://thread/019fd821-1450-7952-85ca-3bb8e5d150da?backend=codex&instanceId=pwr_harold",
      },
    });
    expect(codexClient.startTurnCallCount).toBe(0);
    expect(federatedSend).toHaveBeenCalledTimes(2);
    expect(federatedSend).toHaveBeenNthCalledWith(1, expect.objectContaining({
      backend: "codex",
      threadId: "019fd821-1450-7952-85ca-3bb8e5d150da",
      resolutionMode: "remembered_only",
    }));
    expect(federatedSend).toHaveBeenNthCalledWith(2, {
      backend: "codex",
      threadId: "019fd821-1450-7952-85ca-3bb8e5d150da",
      resolutionMode: "discover_only",
      replaceQueueEntryId: undefined,
      input: [
        { type: "text", text: "Please handle the expanded reconnect scope." },
      ],
      messageOrigin: {
        kind: "agent",
        sourceThread: {
          backend: "codex",
          threadId: "parent-thread",
          title: "M4 runner-host conversion preflight",
          turnId: "turn-1",
          messageId: expect.stringMatching(/^correspondence:/),
        },
      },
      executionMode: undefined,
      model: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined,
      fastMode: undefined,
      approvalPolicy: undefined,
      sandbox: undefined,
    });

    await registry.close();
  });

  it("keeps send_message_to_thread local when includeRemote is false", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{
        source: "codex",
        id: "local-thread",
        title: "Local target",
        titleSource: "explicit",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    const federatedSend = vi.fn();
    registry.setFederatedThreadMessageHandler(federatedSend);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "turn-1",
      tool: "send_message_to_thread",
      args: {
        backend: "codex",
        threadId: "local-thread",
        prompt: "Keep this local.",
        includeRemote: false,
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "local-thread",
      },
    });
    expect(federatedSend).not.toHaveBeenCalled();
    expect(codexClient.startTurnCallCount).toBe(1);

    await registry.close();
  });

  it("routes stop and steer controls to an explicit federated owner", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{
        id: "parent-thread",
        title: "M4 runner-host conversion preflight",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    await discoverCodexBackendForTest(registry);
    const federatedControl = vi.fn(async (controlRequest) => ({
      backend: controlRequest.backend,
      threadId: controlRequest.threadId,
      turnId: "remote-turn-live",
      disposition: controlRequest.operation === "stop"
        ? "interrupted" as const
        : "steered" as const,
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac",
    }));
    registry.setFederatedThreadControlHandler(federatedControl);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });

    const steer = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "steer_thread",
      args: {
        backend: "codex",
        threadId: "remote-thread",
        instanceId: "pwr_studio",
        requestId: "steer-remote",
        prompt: "Avoid the expensive test lane.",
      },
    });
    expect(steer).toMatchObject({
      structuredContent: {
        instanceId: "pwr_studio",
        disposition: "steered",
        turnId: "remote-turn-live",
      },
    });
    expect(federatedControl).toHaveBeenLastCalledWith({
      operation: "steer",
      backend: "codex",
      threadId: "remote-thread",
      instanceId: "pwr_studio",
      requestId: "steer-remote",
      input: [{ type: "text", text: "Avoid the expensive test lane." }],
      messageOrigin: {
        kind: "agent",
        sourceThread: {
          backend: "codex",
          threadId: "parent-thread",
          title: "M4 runner-host conversion preflight",
          turnId: "parent-turn",
        },
      },
    });

    const stop = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "stop_thread",
      args: {
        backend: "codex",
        threadId: "remote-thread",
        instanceId: "pwr_studio",
        requestId: "stop-remote",
      },
    });
    expect(stop).toMatchObject({
      structuredContent: {
        instanceId: "pwr_studio",
        disposition: "interrupted",
        turnId: "remote-turn-live",
      },
    });
    await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "stop_thread",
      args: {
        backend: "codex",
        threadId: "remote-thread",
        instanceId: "pwr_studio",
        requestId: "stop-remote",
      },
    });
    expect(federatedControl).toHaveBeenCalledTimes(2);
    expect(codexClient.interruptTurnCallCount).toBe(0);
    expect(codexClient.steerTurnCallCount).toBe(0);

    federatedControl.mockClear();
    const localOnly = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "stop_thread",
      args: {
        backend: "codex",
        threadId: "remote-thread",
        includeRemote: false,
        requestId: "stop-local-only",
      },
    });
    expect(localOnly).toMatchObject({
      isError: true,
      structuredContent: { code: "not_found" },
    });
    expect(federatedControl).not.toHaveBeenCalled();

    await registry.close();
  });

  it("preserves a stale remote steer through the federated follow-up path", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{
        id: "parent-thread",
        title: "M4 runner-host conversion preflight",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    const federatedControl = vi.fn(async () => {
      throw new PwrAgentFederatedThreadMessageError(
        "no_active_turn",
        "Remote thread has no active turn.",
      );
    });
    const federatedSend = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "remote-thread",
      turnId: "remote-follow-up",
      title: "Remote target",
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac",
    }));
    registry.setFederatedThreadControlHandler(federatedControl);
    registry.setFederatedThreadMessageHandler(federatedSend);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });

    const response = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "parent-turn",
      tool: "steer_thread",
      args: {
        backend: "codex",
        threadId: "remote-thread",
        instanceId: "pwr_studio",
        requestId: "steer-remote-stale",
        prompt: "Apply the branch correction before continuing.",
      },
    });
    expect(response).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "remote-thread",
        instanceId: "pwr_studio",
        requestId: "steer-remote-stale",
        turnId: "remote-follow-up",
        disposition: "started",
        fallbackReason: "no_active_turn",
      },
    });
    expect(federatedControl).toHaveBeenCalledOnce();
    expect(federatedSend).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      threadId: "remote-thread",
      instanceId: "pwr_studio",
      input: [{
        type: "text",
        text: "Apply the branch correction before continuing.",
      }],
    }));
    expect(codexClient.startTurnCallCount).toBe(0);

    await registry.close();
  });

  it.each(["connected", "disconnected", "explicit", "writer-conflict"])(
    "prefers the local harness over a %s remembered owner unless explicitly addressed",
    async (owner) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start"] },
        ...(owner === "writer-conflict"
          ? { startTurnError: new Error("thread shared-thread-id already has an active writer") }
          : {}),
        threads: [{
          source: "codex",
          id: "shared-thread-id",
          title: "Shared Codex profile thread",
          titleSource: "explicit",
          linkedDirectories: [],
        }],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        threadTitleGenerationService: null,
      });
      const federatedSend = vi.fn(async () => {
        if (owner === "disconnected") {
          throw new PwrAgentFederatedThreadMessageError("peer_unavailable", "Peer is offline.");
        }
        return {
          backend: "codex" as const,
          threadId: "shared-thread-id",
          turnId: "remote-turn-1",
          title: "Remembered remote thread",
          instanceId: "pwr_studio",
          instanceLabel: "Studio Mac",
        };
      });
      registry.setFederatedThreadMessageHandler(federatedSend);
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "parent-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      const response = await callRegistryMcpTool({
        registry,
        backend: "codex",
        threadId: "parent-thread",
        turnId: "turn-1",
        tool: "send_message_to_thread",
        args: {
          backend: "codex",
          threadId: "shared-thread-id",
          prompt: "Continue on the resolved thread.",
          ...(owner === "explicit" ? { instanceId: "pwr_studio" } : {}),
        },
      });

      if (owner === "writer-conflict") {
        expect(response).toMatchObject({
          isError: true,
          structuredContent: {
            message: expect.stringContaining("already has an active writer"),
          },
        });
        expect(codexClient.startTurnCallCount).toBe(1);
        expect(federatedSend).not.toHaveBeenCalled();
        await registry.close();
        return;
      }

      expect(response).toMatchObject({
        structuredContent: {
          threadId: "shared-thread-id",
          ...(owner === "explicit" ? { instanceId: "pwr_studio", turnId: "remote-turn-1" } : {}),
        },
      });
      if (owner === "explicit") {
        expect(codexClient.startTurnCallCount).toBe(0);
        expect(federatedSend).toHaveBeenCalledOnce();
      } else {
        expect(response.structuredContent).not.toHaveProperty("instanceId");
        expect(codexClient.startTurnCallCount).toBe(1);
        expect(federatedSend).not.toHaveBeenCalled();
      }

      await registry.close();
    },
  );

  it("returns peer_unavailable for an addressed remote owner without a local turn attempt", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    registry.setFederatedThreadMessageHandler(async () => {
      throw new PwrAgentFederatedThreadMessageError(
        "peer_unavailable",
        "Federation instance Studio Mac, the known owner of thread remote-thread, is disconnected; the message was not sent.",
      );
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "send_message_to_thread",
        arguments: {
          backend: "codex",
          threadId: "remote-thread",
          instanceId: "pwr_studio",
          prompt: "Continue when available.",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: false,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify(
          {
            code: "peer_unavailable",
            message:
              "Federation instance Studio Mac, the known owner of thread remote-thread, is disconnected; the message was not sent.",
          },
          null,
          2,
        ),
      }],
    });
    expect(codexClient.startTurnCallCount).toBe(0);

    await registry.close();
  });

  it("routes an ACP target through federation when no local session owns it", async () => {
    const { acpBackendId, registry, startPrompt } = createKimiAcpRegistry({
      sessions: [],
    });
    const federatedSend = vi.fn(async () => ({
      backend: acpBackendId,
      threadId: "remote-acp-session",
      turnId: "remote-acp-turn",
      title: "Remote ACP thread",
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac",
    }));
    registry.setFederatedThreadMessageHandler(federatedSend);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await callRegistryMcpTool({
      registry,
      backend: "codex",
      threadId: "parent-thread",
      turnId: "turn-1",
      tool: "send_message_to_thread",
      args: {
        backend: acpBackendId,
        threadId: "remote-acp-session",
        prompt: "Continue on the remote ACP agent.",
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        backend: acpBackendId,
        threadId: "remote-acp-session",
        turnId: "remote-acp-turn",
        threadUrl:
          "pwragent://thread/remote-acp-session?backend=acp:kimi&instanceId=pwr_studio",
      },
    });
    expect(startPrompt).not.toHaveBeenCalled();
    expect(federatedSend).toHaveBeenCalledOnce();

    await registry.close();
  });

  it("rejects sending a follow-up prompt to the invoking thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "send_message_to_thread",
        arguments: {
          backend: "codex",
          threadId: "parent-thread",
          prompt: "Loop back into myself.",
        },
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
                "send_message_to_thread targets another thread. Continue the current thread by replying normally.",
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(codexClient.lastStartTurnParams).toBeUndefined();

    await registry.close();
  });

  it("routes durable dependencies with the trusted waiting thread defaults", async () => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["thread/list"] } });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const handler = vi.fn(async () => ({ ok: true as const, data: { threadDependencies: { dependencies: [] } } }));
    registry.setThreadDependencyToolHandler(handler);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "waiting-thread", turnId: "turn-1", turn: { id: "turn-1" } },
    } });
    const response = await codexClient.emitRequest({ method: "item/tool/call", params: {
      threadId: "waiting-thread", turnId: "turn-1", callId: "call-dependency", requestId: "call-dependency",
      namespace: "pwragent", tool: "manage_thread_dependencies",
      arguments: { action: "create", continuation: "Rebase onto the helper.", conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed" }] },
    } } as AppServerPendingRequestNotification);
    expect(handler).toHaveBeenCalledExactlyOnceWith({ action: "create", backend: "codex", threadId: "waiting-thread",
      continuation: "Rebase onto the helper.",
      conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed" }],
    }, {}, "agent:codex:waiting-thread");
    expect(response).toMatchObject({ success: true });
    await registry.close();
  });

  it("requires agents to write down what the resumed turn should do", async () => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["thread/list"] } });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const handler = vi.fn(async () => ({ ok: true as const, data: { threadDependencies: { dependencies: [] } } }));
    registry.setThreadDependencyToolHandler(handler);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "waiting-thread", turnId: "turn-1", turn: { id: "turn-1" } },
    } });
    for (const [index, continuation] of [undefined, "   "].entries()) {
      const response = await codexClient.emitRequest({ method: "item/tool/call", params: {
        threadId: "waiting-thread", turnId: "turn-1", callId: `call-dependency-${index}`, requestId: `call-dependency-${index}`,
        namespace: "pwragent", tool: "manage_thread_dependencies",
        arguments: { action: "create", ...(continuation === undefined ? {} : { continuation }), conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed" }] },
      } } as AppServerPendingRequestNotification);
      expect(response).toMatchObject({ success: false });
      expect(JSON.stringify(response)).toContain("Provide continuation");
    }
    expect(handler).not.toHaveBeenCalled();
    await registry.close();
  });

  it("saves prerequisite titles for agent-registered dependencies that omit them", async () => {
    const foundation: AppServerThreadSummary = { id: "foundation", title: "Extract retry helper", titleSource: "explicit", source: "codex", updatedAt: 1000, linkedDirectories: [] };
    const codexClient = new MockBackendClient({ threads: [foundation], initializeResult: { methods: ["thread/list"] } });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const handler = vi.fn(async () => ({ ok: true as const, data: { threadDependencies: { dependencies: [] } } }));
    registry.setThreadDependencyToolHandler(handler);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "waiting-thread", turnId: "turn-1", turn: { id: "turn-1" } },
    } });
    await codexClient.emitRequest({ method: "item/tool/call", params: {
      threadId: "waiting-thread", turnId: "turn-1", callId: "call-dependency", requestId: "call-dependency",
      namespace: "pwragent", tool: "manage_thread_dependencies",
      arguments: { action: "create", continuation: "Adopt the helper.", conditions: [
        { backend: "codex", threadId: "foundation", when: "ci_passed" },
        { backend: "codex", threadId: "unknown", when: "pr_merged" },
        { backend: "codex", threadId: "foundation", when: "turn_completed", title: "Agent's name" },
      ] },
    } } as AppServerPendingRequestNotification);
    expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conditions: [
      { backend: "codex", threadId: "foundation", when: "ci_passed", title: "Extract retry helper" },
      { backend: "codex", threadId: "unknown", when: "pr_merged" },
      { backend: "codex", threadId: "foundation", when: "turn_completed", title: "Agent's name" },
    ] }), {}, "agent:codex:waiting-thread");
    await registry.close();
  });

  it("routes mutate_thread remotely when local resolution fails", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      listThreadsError: new Error("local codex backend unavailable"),
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: { "codex:agent-thread": createAgentOverlay() },
      }),
    });
    const mutationHandler = vi.fn(async () => ({
      instanceId: "pwr_remote",
      instanceLabel: "Remote Mac",
    }));
    registry.setFederatedThreadMutationHandler(mutationHandler);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-mutate",
        requestId: "call-mutate",
        namespace: "pwragent",
        tool: "mutate_thread",
        arguments: {
          backend: "codex",
          threadId: "remote-thread",
          title: "Remote title",
        },
      },
    } as AppServerPendingRequestNotification);
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );

    expect(payload.mutation).toMatchObject({
      backend: "codex",
      threadId: "remote-thread",
      instanceId: "pwr_remote",
      instanceLabel: "Remote Mac",
      dryRun: false,
    });
    expect(mutationHandler).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "remote-thread",
      title: "Remote title",
      dryRun: false,
    });
    expect(codexClient.lastRenameThreadParams).toBeUndefined();

    await registry.close();
  });

  describe("mutate_thread archive, restore, pins, read state and project moves", () => {
    function listedThread(
      id: string,
      overrides: Partial<AppServerThreadSummary> = {},
    ): AppServerThreadSummary {
      return {
        id,
        title: `Thread ${id}`,
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
        ...overrides,
      };
    }

    async function setup(
      options: {
        targetActive?: boolean;
        threads?: AppServerThreadSummary[];
        archivedThreads?: AppServerThreadSummary[];
        overlays?: Record<string, MockOverlayState>;
      } = {},
    ) {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        ...(options.threads ? { threads: options.threads } : {}),
        ...(options.archivedThreads
          ? { archivedThreads: options.archivedThreads }
          : {}),
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
          "codex:target-thread": {
            backend: "codex",
            threadId: "target-thread",
            executionMode: "default",
            extraLinkedDirectories: [],
          },
          ...options.overlays,
        },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
      });
      const setThreadParent = vi.fn(async (request: SetThreadParentRequest) => ({
        backend: request.backend ?? "codex",
        threadId: request.threadId,
        ...(request.parentThreadId
          ? { parentThreadId: request.parentThreadId, parentThreadBackend: request.parentThreadBackend ?? "codex" }
          : {}),
      }));
      const archiver = vi.fn(async (request: ArchiveThreadRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        archivedAt: 1,
        cleanup: [] as ArchiveThreadCleanupResult[],
      }));
      const setThreadPin = vi.fn(async (request: SetThreadPinRequest) => ({
        backend: request.backend ?? "codex",
        threadId: request.threadId,
        ...(request.pinned ? { pinnedRank: "a0" } : {}),
      }));
      const markThreadSeen = vi.fn(async (request: MarkThreadSeenRequest) => ({
        backend: request.backend ?? "codex",
        threadId: request.threadId,
        seenAt: 1,
        seenUpdatedAt: request.seenUpdatedAt,
      }));
      registry.setAgentThreadActions({
        archiveThread: archiver,
        setThreadPin,
        markThreadSeen,
        setThreadParent,
      });
      // mutate_thread reaches handoff through the inspection tools' host,
      // which delegates to the workspace service.
      const handoff = vi
        .spyOn(registryModules(registry).threadWorkspaceService, "handoffThreadWorkspace")
        .mockResolvedValue({} as HandoffThreadWorkspaceResponse);
      // mutate_thread reaches restore through the inspection tools' host,
      // which delegates to the archive coordinator.
      const restore = vi
        .spyOn(registryModules(registry).threadArchiveCoordinator, "restoreThread")
        .mockImplementation(async (request) => ({
          backend: request.backend,
          threadId: request.threadId,
          restoredAt: 1,
        }));
      const running = [
        "agent-thread",
        ...(options.targetActive ? ["target-thread"] : []),
      ];
      for (const threadId of running) {
        await registry.publishLocalEvent({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId,
              turnId: `turn-${threadId}`,
              turn: { id: `turn-${threadId}` },
            },
          },
        });
      }
      let callSequence = 0;
      const call = async (args: Record<string, unknown>) => {
        const callId = `call-${++callSequence}`;
        const response = (await codexClient.emitRequest({
          method: "item/tool/call",
          params: {
            threadId: "agent-thread",
            turnId: "turn-agent-thread",
            callId,
            requestId: callId,
            namespace: "pwragent",
            tool: "mutate_thread",
            arguments: { backend: "codex", threadId: "target-thread", ...args },
          },
        } as AppServerPendingRequestNotification)) as {
          success: boolean;
          contentItems: Array<{ text: string }>;
        };
        return {
          success: response.success,
          payload: JSON.parse(response.contentItems[0]!.text),
        };
      };
      return {
        archiver,
        call,
        codexClient,
        handoff,
        markThreadSeen,
        overlayStore,
        registry,
        restore,
        setThreadParent,
        setThreadPin,
      };
    }

    it.each([
      { parentThreadId: "parent-thread", parentBackend: "claude" },
      { detachFromParent: true },
    ])("routes remote parent changes with explicit and discovered owners: %j", async (change) => {
      const { call, registry, setThreadParent } = await setup();
      const handler = vi.fn(async () => ({ instanceId: "pwr_remote", instanceLabel: "Remote Mac" }));
      registry.setFederatedThreadMutationHandler(handler);
      for (const target of [
        { threadId: "target-thread", instanceId: "pwr_remote" },
        { threadId: "remote-thread" },
      ]) {
        for (const dryRun of [false, true]) {
          const result = await call({ ...target, ...change, dryRun });
          expect(result.success).toBe(true);
          expect(result.payload.mutation).toMatchObject({
            ...target, instanceId: "pwr_remote", dryRun,
            changes: [{ field: "parent", status: dryRun ? "would_apply" : "applied" }],
          });
          expect(handler).toHaveBeenLastCalledWith({ backend: "codex", ...target, ...change, dryRun });
        }
      }
      expect(setThreadParent).not.toHaveBeenCalled();
      const calls = handler.mock.calls.length;
      const localOnly = await call({ threadId: "remote-thread", ...change, includeRemote: false });
      expect(localOnly.payload.code).toBe("not_found");
      expect(handler).toHaveBeenCalledTimes(calls);
      await registry.close();
    });

    it("requires remote control after a parent target misses locally, while local grouping remains allowed", async () => {
      const { call, registry, setThreadParent } = await setup({
        threads: [listedThread("target-thread"), listedThread("parent-thread")],
      });
      const handler = vi.fn(async () => ({ instanceId: "pwr_remote", instanceLabel: "Remote Mac" }));
      registry.setFederatedThreadMutationHandler(handler);
      const checkDynamicToolPermission = vi.fn((check) => check.arguments?.includeRemote === true
        ? { allowed: false, permission: "federation.remote_control" }
        : { allowed: true });
      registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(), checkDynamicToolPermission });
      const local = await call({ parentThreadId: "parent-thread" });
      expect(local.success).toBe(true);
      expect(setThreadParent).toHaveBeenCalledOnce();
      const remote = await call({ threadId: "remote-thread", parentThreadId: "parent-thread" });
      expect(remote.payload).toMatchObject({ code: "forbidden", message: expect.stringContaining("federation.remote_control") });
      expect(checkDynamicToolPermission).toHaveBeenLastCalledWith(expect.objectContaining({
        threadId: "agent-thread", turnId: "turn-agent-thread",
        arguments: expect.objectContaining({ includeRemote: true, parentThreadId: "parent-thread" }),
      }));
      expect(handler).not.toHaveBeenCalled();
      registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(),
        checkDynamicToolPermission: () => ({ allowed: false, permission: "thread.control.organize" }),
      });
      expect((await call({ parentThreadId: "parent-thread", instanceId: "pwr_remote" })).payload)
        .toMatchObject({ code: "forbidden", message: expect.stringContaining("thread.control.organize") });
      expect(handler).not.toHaveBeenCalled();
      await registry.close();
    });

    it("validates versioned parent requests on the owner and ignores inbound routing and other mutations", async () => {
      const { registry, setThreadParent } = await setup({
        threads: [listedThread("target-thread"), listedThread("parent-thread"), listedThread("child-thread")],
        archivedThreads: [listedThread("archived-parent", { archivedAt: 1_000 })],
        overlays: { "codex:child-thread": {
          backend: "codex", threadId: "child-thread", executionMode: "default", extraLinkedDirectories: [],
          parentThreadId: "target-thread",
        } },
      });
      const handler = vi.fn();
      registry.setFederatedThreadMutationHandler(handler);
      for (const dryRun of [false, true]) {
        for (const [parentThreadId, code] of [
          ["missing-parent", "not_found"], ["archived-parent", "invalid_arguments"],
          ["child-thread", "invalid_arguments"], ["target-thread", "invalid_arguments"],
        ]) {
          expect(await registry.mutateThreadParentV1({ backend: "codex", threadId: "target-thread", parentThreadId, dryRun }))
            .toMatchObject({ ok: false, error: { code } });
        }
      }
      expect(setThreadParent).not.toHaveBeenCalled();
      const request = { backend: "codex" as const, threadId: "target-thread", parentThreadId: "parent-thread",
        dryRun: true, instanceId: "another-peer", includeRemote: true, title: "must not rename" };
      expect(await registry.mutateThreadParentV1(request)).toMatchObject({ ok: true });
      expect(setThreadParent).not.toHaveBeenCalled();
      expect(await registry.mutateThreadParentV1({ ...request, dryRun: false })).toMatchObject({ ok: true });
      expect(setThreadParent).toHaveBeenCalledExactlyOnceWith({
        backend: "codex", threadId: "target-thread", parentThreadId: "parent-thread", parentThreadBackend: "codex",
      });
      expect(handler).not.toHaveBeenCalled();
      await registry.close();
    });

    it("nests a thread under another and makes it top-level again through the app's own path", async () => {
      const threads = [listedThread("target-thread"), listedThread("parent-thread")];
      const nested = await setup({ threads });
      const preview = await nested.call({ parentThreadId: "parent-thread", dryRun: true });
      expect(preview.payload.mutation.changes).toEqual([
        { field: "parent", status: "would_apply", to: { backend: "codex", threadId: "parent-thread" } },
      ]);
      expect(nested.setThreadParent).not.toHaveBeenCalled();
      const result = await nested.call({ parentThreadId: "parent-thread" });
      expect(result.success).toBe(true);
      expect(result.payload.mutation.changes).toEqual([
        { field: "parent", status: "applied", to: { backend: "codex", threadId: "parent-thread" } },
      ]);
      expect(nested.setThreadParent).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "target-thread",
        parentThreadId: "parent-thread",
        parentThreadBackend: "codex",
      });
      await nested.registry.close();

      const detached = await setup({
        threads,
        overlays: {
          "codex:target-thread": {
            backend: "codex",
            threadId: "target-thread",
            executionMode: "default",
            extraLinkedDirectories: [],
            parentThreadId: "parent-thread",
          },
        },
      });
      const cleared = await detached.call({ detachFromParent: true });
      expect(cleared.payload.mutation.changes).toEqual([{ field: "parent", status: "applied", to: null }]);
      expect(detached.setThreadParent).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "target-thread",
        parentThreadId: null,
        parentThreadBackend: null,
      });
      await detached.registry.close();
    });

    it("refuses a parent change it cannot keep, before anything changes and on a dry run too", async () => {
      const { call, registry, setThreadParent, setThreadPin } = await setup({
        threads: [listedThread("target-thread"), listedThread("child-thread")],
        archivedThreads: [listedThread("archived-parent", { archivedAt: 1_000 })],
        overlays: {
          // child-thread is already a sub-thread of target-thread.
          "codex:child-thread": {
            backend: "codex",
            threadId: "child-thread",
            executionMode: "default",
            extraLinkedDirectories: [],
            parentThreadId: "target-thread",
          },
        },
      });
      const refusals: Array<[Record<string, unknown>, string, RegExp]> = [
        [{ parentThreadId: "target-thread" }, "invalid_arguments", /its own parent/],
        [{ parentThreadId: "child-thread" }, "invalid_arguments", /own sub-thread/],
        [{ parentThreadId: "child-thread", dryRun: true }, "invalid_arguments", /own sub-thread/],
        [{ parentThreadId: "missing-thread" }, "not_found", /was not found on this instance/],
        [{ parentThreadId: "archived-parent" }, "invalid_arguments", /is archived/],
        [{ detachFromParent: true }, "invalid_arguments", /is not a sub-thread/],
        [{ parentThreadId: "child-thread", detachFromParent: true }, "invalid_arguments", /cannot be combined/],
        [{ parentThreadId: "child-thread", pinned: true }, "invalid_arguments", /not pinned/],
        [{ parentBackend: "codex" }, "invalid_arguments", /requires parentThreadId/],
        [{ parentThreadId: "child-thread", parentBackend: "nope" }, "invalid_arguments", /known PwrAgent backend/],
        [{ parentThreadId: "" }, "invalid_arguments", /non-empty string/],
        [{ detachFromParent: "yes" }, "invalid_arguments", /must be a boolean/],
      ];
      for (const [args, code, message] of refusals) {
        const result = await call(args);
        expect({ args, code: result.payload.code }).toEqual({ args, code });
        expect(result.payload.message).toMatch(message);
      }
      expect(setThreadParent).not.toHaveBeenCalled();
      expect(setThreadPin).not.toHaveBeenCalled();
      await registry.close();
    });

    it("locks a thread with a note as the agent tool, and unlocks it", async () => {
      const { call, overlayStore, registry } = await setup();
      const target = { backend: "codex" as const, threadId: "target-thread" };

      const locked = await call({ lockNote: "Worktree handed to the repair thread." });
      expect(locked.success).toBe(true);
      expect(locked.payload.mutation.changes).toEqual([
        { field: "locked", status: "applied", to: true },
        { field: "lock_note", status: "applied", to: "Worktree handed to the repair thread." },
      ]);
      expect((await overlayStore.getThreadOverlayState(target))?.lock).toMatchObject({
        note: "Worktree handed to the repair thread.",
        source: "agent_tool",
      });

      const unlocked = await call({ locked: false });
      expect(unlocked.payload.mutation.changes).toEqual([
        { field: "locked", status: "applied", to: false },
      ]);
      expect((await overlayStore.getThreadOverlayState(target))?.lock).toBeUndefined();
      await registry.close();
    });

    it("refuses a lock note beside an unlock, and previews a lock without making it", async () => {
      const { call, overlayStore, registry } = await setup();

      const refused = await call({ locked: false, lockNote: "Parked" });
      expect(refused.success).toBe(false);
      expect(refused.payload.code).toBe("invalid_arguments");

      const preview = await call({ locked: true, dryRun: true });
      expect(preview.payload.mutation.changes).toEqual([
        { field: "locked", status: "would_apply", to: true },
      ]);
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "target-thread" }))?.lock)
        .toBeUndefined();
      await registry.close();
    });

    it("archives a local thread through the app's own archive path", async () => {
      const { archiver, call, registry } = await setup();

      const result = await call({ archive: true });

      expect(result.success).toBe(true);
      expect(result.payload.mutation.changes).toEqual([
        { field: "archive", status: "applied", to: true },
      ]);
      // The installed path, not the registry's own: only the app's archive
      // also ungroups the thread's children on other instances.
      expect(archiver).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "target-thread",
      });
      await registry.close();
    });

    it("reports a worktree archive kept because Git has it locked, and never asks to unlock", async () => {
      const { archiver, call, registry } = await setup();
      const kept = { reason: "worktree-locked" as const, worktreePath: "/contrived/worktrees/orbit", lockReason: "release prep, do not remove" };
      archiver.mockResolvedValueOnce({
        backend: "codex", threadId: "target-thread", archivedAt: 1,
        cleanup: [{ worktreePath: kept.worktreePath, removedWorktree: false, deletedBranch: false, skippedReason: "Locked worktree", kept }],
      });

      const result = await call({ archive: true });

      expect(result.success).toBe(true);
      expect(result.payload.mutation.keptWorktrees).toEqual([kept]);
      expect(result.payload.mutation.notes.join("\n")).toContain("Git has it locked: release prep, do not remove");
      expect(archiver).toHaveBeenCalledWith({ backend: "codex", threadId: "target-thread" });
      expect(archiver.mock.calls[0]?.[0]).not.toHaveProperty("approvedLockReason");
      await registry.close();
    });

    it("reports a failed archive as a tool error", async () => {
      const { archiver, call, registry } = await setup();
      archiver.mockRejectedValueOnce(
        new Error("thread target-thread not found"),
      );

      const result = await call({ archive: true });

      expect(result.success).toBe(false);
      expect(result.payload).toEqual({
        code: "not_found",
        message: "thread target-thread not found",
      });
      await registry.close();
    });

    it("previews an archive without making it", async () => {
      const { archiver, call, registry } = await setup();

      const result = await call({ archive: true, dryRun: true });

      expect(result.payload.mutation.changes).toEqual([
        { field: "archive", status: "would_apply", to: true },
      ]);
      expect(archiver).not.toHaveBeenCalled();
      await registry.close();
    });

    it("refuses to archive a thread with a turn running, even on a dry run", async () => {
      // A preview that said yes would be a lie the real call then takes back.
      const { archiver, call, registry } = await setup({ targetActive: true });

      const result = await call({ archive: true, dryRun: true });

      expect(result.success).toBe(false);
      expect(result.payload.code).toBe("forbidden");
      expect(result.payload.message).toMatch(/stop_thread/);
      expect(archiver).not.toHaveBeenCalled();
      await registry.close();
    });

    it("archives and restores alone, and only with a boolean", async () => {
      const { archiver, call, registry, restore } = await setup();

      const combined = await call({ archive: true, title: "Last words" });
      const restoreAndPin = await call({ archive: false, pinned: true });
      const loose = await call({ archive: "yes" });

      expect(combined.payload.code).toBe("invalid_arguments");
      expect(restoreAndPin.payload.code).toBe("invalid_arguments");
      expect(loose.payload.code).toBe("invalid_arguments");
      expect(archiver).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      await registry.close();
    });

    it("restores an archived thread, and says so for one that is not", async () => {
      const { archiver, call, registry, restore } = await setup({
        threads: [listedThread("target-thread")],
        archivedThreads: [listedThread("gone-thread", { archivedAt: 1_000 })],
      });

      const restored = await call({ threadId: "gone-thread", archive: false });
      const notArchived = await call({ archive: false });
      const twice = await call({ threadId: "gone-thread", archive: true });

      expect(restored.success).toBe(true);
      expect(restored.payload.mutation.changes).toEqual([
        { field: "archive", status: "applied", to: false },
      ]);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(restore).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "gone-thread",
      });
      expect(notArchived.payload).toEqual({
        code: "invalid_arguments",
        message: "Thread codex:target-thread is not archived.",
      });
      expect(twice.payload).toEqual({
        code: "invalid_arguments",
        message: "Thread codex:gone-thread is already archived.",
      });
      expect(archiver).not.toHaveBeenCalled();
      await registry.close();
    });

    it("pins and marks a thread read through the app's own paths", async () => {
      const { call, markThreadSeen, registry, setThreadPin } = await setup({
        threads: [listedThread("target-thread", { updatedAt: 5_000 })],
      });

      const result = await call({ pinned: true, unread: false });

      expect(result.payload.mutation.changes).toEqual([
        { field: "pinned", status: "applied", to: true },
        { field: "unread", status: "applied", to: false },
      ]);
      expect(setThreadPin).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "target-thread",
        pinned: true,
      });
      // At the thread's last update: without a watermark the store keeps
      // the old one, and the thread stays unread.
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "target-thread",
        seenUpdatedAt: 5_000,
      });
      await registry.close();
    });

    it("marks a thread unread one tick behind its last update", async () => {
      const { call, markThreadSeen, registry, setThreadPin } = await setup({
        threads: [listedThread("target-thread", { updatedAt: 5_000 })],
      });

      await call({ unread: true, pinned: false });

      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "target-thread",
        seenUpdatedAt: 4_999,
      });
      expect(setThreadPin).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "target-thread",
        pinned: false,
      });
      await registry.close();
    });

    it("marks read at the thread's latest update, not a cached one", async () => {
      const { call, codexClient, markThreadSeen, registry } = await setup({
        threads: [listedThread("target-thread", { updatedAt: 5_000 })],
      });
      // An earlier call leaves the thread list cached at 5_000.
      await call({ pinned: true });
      codexClient.setThreads([
        listedThread("target-thread", { updatedAt: 6_000 }),
      ]);

      await call({ unread: false });

      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "target-thread",
        seenUpdatedAt: 6_000,
      });
      await registry.close();
    });

    it("cannot mark unread a thread with no update time", async () => {
      const { call, markThreadSeen, registry } = await setup();

      const result = await call({ unread: true });

      expect(result.payload.code).toBe("invalid_arguments");
      expect(markThreadSeen).not.toHaveBeenCalled();
      await registry.close();
    });

    it("previews pins and read state without changing them", async () => {
      const { call, markThreadSeen, registry, setThreadPin } = await setup({
        threads: [listedThread("target-thread", { updatedAt: 5_000 })],
      });

      const result = await call({ pinned: true, unread: true, dryRun: true });

      expect(result.payload.mutation.changes).toEqual([
        { field: "pinned", status: "would_apply", to: true },
        { field: "unread", status: "would_apply", to: true },
      ]);
      expect(setThreadPin).not.toHaveBeenCalled();
      expect(markThreadSeen).not.toHaveBeenCalled();
      await registry.close();
    });

    it("will not archive or move the thread running the call", async () => {
      const { archiver, call, handoff, registry } = await setup();

      const archived = await call({ threadId: "agent-thread", archive: true });
      const moved = await call({
        threadId: "agent-thread",
        projectPath: "/repos/elsewhere",
      });

      expect(archived.payload.code).toBe("forbidden");
      expect(moved.payload.code).toBe("forbidden");
      expect(archiver).not.toHaveBeenCalled();
      expect(handoff).not.toHaveBeenCalled();
      await registry.close();
    });

    it("moves a local thread to another project", async () => {
      const { call, codexClient, handoff, registry } = await setup();

      const result = await call({
        projectPath: " /repos/elsewhere ",
        title: "Moved",
      });

      expect(result.success).toBe(true);
      expect(handoff).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "target-thread",
        direction: "to-project",
        targetPath: "/repos/elsewhere",
      });
      expect(result.payload.mutation.changes).toContainEqual({
        field: "project",
        status: "applied",
        to: "/repos/elsewhere",
      });
      expect(codexClient.lastRenameThreadParams).toEqual({
        threadId: "target-thread",
        name: "Moved",
      });
      await registry.close();
    });

    it("changes nothing else when the move is refused", async () => {
      // The destination is only checked on disk, so the move goes first: a
      // bad path must not leave the thread renamed and still unmoved.
      const { call, codexClient, handoff, registry } = await setup();
      handoff.mockRejectedValueOnce(
        new Error("Select a Git project checkout or worktree as the destination."),
      );

      const result = await call({
        projectPath: "/tmp/not-a-repo",
        title: "Moved",
      });

      expect(result.success).toBe(false);
      expect(result.payload).toEqual({
        code: "invalid_arguments",
        message: "Select a Git project checkout or worktree as the destination.",
      });
      expect(codexClient.lastRenameThreadParams).toBeUndefined();
      await registry.close();
    });

    it("puts an unlocked lock back as it was when the move is refused", async () => {
      const { call, handoff, overlayStore, registry } = await setup();
      const target = { backend: "codex" as const, threadId: "target-thread" };
      const { lock } = await registry.setThreadLock({ ...target, locked: true, note: "Parked" }, { source: "operator" });
      handoff.mockRejectedValueOnce(
        new Error("Select a Git project checkout or worktree as the destination."),
      );

      const result = await call({ locked: false, projectPath: "/tmp/not-a-repo" });

      expect(result.success).toBe(false);
      expect((await overlayStore.getThreadOverlayState(target))?.lock).toEqual(lock);
      await registry.close();
    });

    it("resumes what the lock held only after an unlock's move lands", async () => {
      const { call, codexClient, handoff, registry } = await setup();
      const target = { backend: "codex" as const, threadId: "target-thread" };
      const { lock } = await registry.setThreadLock({ ...target, locked: true, note: "Parked" }, { source: "operator" });
      await registry.submitHeldTurn({
        ...target,
        input: [{ type: "text", text: "Held while parked" }],
        queueEntryId: "held-while-parked",
        holdReason: threadLockRefusalMessage(lock!),
      });
      let startsDuringMove: number | undefined;
      handoff.mockImplementationOnce(async () => {
        // Give a drain scheduled by the unlock every chance to run.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        startsDuringMove = codexClient.startTurnCallCount;
        return {} as HandoffThreadWorkspaceResponse;
      });

      const result = await call({ locked: false, projectPath: "/Users/fixture-user/repos/app" });

      expect(result.success).toBe(true);
      expect(startsDuringMove).toBe(0);
      await vi.waitFor(() => expect(codexClient.startTurnCallCount).toBe(1));
      await registry.close();
    });

    it("hands an archive, a restore, a move or a pin to the peer that owns the thread", async () => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        listThreadsError: new Error("local codex backend unavailable"),
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock({
          overlays: { "codex:agent-thread": createAgentOverlay() },
        }),
      });
      const mutationHandler = vi.fn(async () => ({
        instanceId: "pwr_remote",
        instanceLabel: "Remote Mac",
      }));
      registry.setFederatedThreadMutationHandler(mutationHandler);
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "agent-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });
      let callSequence = 0;
      const call = async (args: Record<string, unknown>) => {
        const callId = `call-${++callSequence}`;
        return await codexClient.emitRequest({
          method: "item/tool/call",
          params: {
            threadId: "agent-thread",
            turnId: "turn-1",
            callId,
            requestId: callId,
            namespace: "pwragent",
            tool: "mutate_thread",
            arguments: { backend: "codex", threadId: "remote-thread", ...args },
          },
        } as AppServerPendingRequestNotification);
      };

      await call({ archive: true });
      await call({ projectPath: "/Users/studio/repos/app" });
      await call({ archive: false });
      await call({ pinned: true, unread: false });

      expect(mutationHandler).toHaveBeenNthCalledWith(1, {
        backend: "codex",
        threadId: "remote-thread",
        archive: true,
        dryRun: false,
      });
      expect(mutationHandler).toHaveBeenNthCalledWith(2, {
        backend: "codex",
        threadId: "remote-thread",
        projectPath: "/Users/studio/repos/app",
        dryRun: false,
      });
      expect(mutationHandler).toHaveBeenNthCalledWith(3, {
        backend: "codex",
        threadId: "remote-thread",
        archive: false,
        dryRun: false,
      });
      expect(mutationHandler).toHaveBeenNthCalledWith(4, {
        backend: "codex",
        threadId: "remote-thread",
        pinned: true,
        unread: false,
        dryRun: false,
      });
      await call({ title: "Grouped", parentThreadId: "remote-parent" });
      expect(mutationHandler).toHaveBeenNthCalledWith(5, {
        backend: "codex", threadId: "remote-thread", title: "Grouped",
        parentThreadId: "remote-parent", parentBackend: "codex", dryRun: false,
      });
      await call({ detachFromParent: true });
      expect(mutationHandler).toHaveBeenNthCalledWith(6, {
        backend: "codex", threadId: "remote-thread", detachFromParent: true, dryRun: false,
      });
      expect(mutationHandler).toHaveBeenCalledTimes(6);
      await registry.close();
    });
  });

  describe("rename_current_thread", () => {
    async function setup() {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [{ id: "ordinary-thread", title: "Original title", titleSource: "explicit", source: "codex", linkedDirectories: [] }],
      });
      Object.assign(codexClient, { readThreadName: async () => "Original title" });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
      });
      onTestFinished(async () => { await registry.close(); });
      await registry.publishLocalEvent({ backend: "codex", notification: {
        method: "turn/started", params: { threadId: "ordinary-thread", turnId: "turn-rename", turn: { id: "turn-rename" } },
      } });
      const call = (args: Record<string, unknown>, turnId = "turn-rename") => codexClient.emitRequest({
        method: "item/tool/call", params: {
          threadId: "ordinary-thread", turnId, callId: "call-rename", requestId: "call-rename",
          namespace: "pwragent", tool: "rename_current_thread", arguments: args,
        },
      } as AppServerPendingRequestNotification);
      return { codexClient, registry, call };
    }

    it("renames an ordinary calling thread and emits a notice with its prior title", async () => {
      const { call, codexClient, registry } = await setup();
      const events: AgentEvent[] = [];
      registry.onEvent((event) => { events.push(event); });
      const response = await call({ title: "  Investigate rename feedback  " });
      expect(response).toMatchObject({ success: true });
      expect(codexClient.lastRenameThreadParams).toEqual({ threadId: "ordinary-thread", name: "Investigate rename feedback" });
      expect(events).toContainEqual({ backend: "codex", notification: {
        method: "thread/name/updated", params: {
          threadId: "ordinary-thread", threadName: "Investigate rename feedback", titleSource: "explicit",
          renameOrigin: "agent_tool", previousThreadName: "Original title",
        },
      } });
    });

    it("still renames when optional notice metadata is unavailable", async () => {
      const { call, codexClient } = await setup();
      Object.assign(codexClient, { readThreadName: async () => { throw new Error("Metadata unavailable"); } });
      expect(await call({ title: "New title" })).toMatchObject({ success: true });
      expect(codexClient.lastRenameThreadParams).toEqual({ threadId: "ordinary-thread", name: "New title" });
    });

    it("allows Undo when the persisted name differs from the normalized display title", async () => {
      const { registry, codexClient } = await setup();
      Object.assign(codexClient, {
        readThreadName: async () => "Please fix the parser",
        readThreadSummary: async () => ({ id: "ordinary-thread", title: "Fix the parser", titleSource: "derived", source: "codex", linkedDirectories: [] }),
      });
      await expect(registry.renameThread({ backend: "codex", threadId: "ordinary-thread",
        name: "Original title", expectedName: "Please fix the parser" })).resolves.toMatchObject({ threadId: "ordinary-thread" });
      expect(codexClient.lastRenameThreadParams).toEqual({ threadId: "ordinary-thread", name: "Original title" });
    });

    it("captures the persisted prior name for Undo instead of its normalized display title", async () => {
      const { call, codexClient, registry } = await setup();
      Object.assign(codexClient, {
        readThreadName: async () => "Please fix the parser",
        readThreadSummary: async () => ({ id: "ordinary-thread", title: "Fix the parser", titleSource: "derived", source: "codex", linkedDirectories: [] }),
      });
      const events: AgentEvent[] = [];
      registry.onEvent((event) => { events.push(event); });
      expect(await call({ title: "Investigate rename feedback" })).toMatchObject({ success: true });
      expect(events).toContainEqual({ backend: "codex", notification: {
        method: "thread/name/updated", params: {
          threadId: "ordinary-thread", threadName: "Investigate rename feedback", titleSource: "explicit",
          renameOrigin: "agent_tool", previousThreadName: "Please fix the parser",
        },
      } });
    });

    it.each(["Please fix the parser", undefined])("rejects Undo when only the normalized display title matches: %s", async (name) => {
      const { registry, codexClient } = await setup();
      Object.assign(codexClient, {
        readThreadName: async () => name,
        readThreadSummary: async () => ({ id: "ordinary-thread", title: "Fix the parser", titleSource: "derived", source: "codex", linkedDirectories: [] }),
      });
      await expect(registry.renameThread({ backend: "codex", threadId: "ordinary-thread",
        name: "Original title", expectedName: "Fix the parser" })).rejects.toThrow("The thread title has changed. Undo was not applied.");
      expect(codexClient.lastRenameThreadParams).toBeUndefined();
    });

    it.each([
      { title: " " }, { title: "x".repeat(201) }, { title: 123 },
      { title: "New title", threadId: "someone-else" },
      { title: "New title", backend: "acp:kimi" },
      { title: "New title", instanceId: "peer" },
    ])("rejects invalid or caller-supplied targeting arguments: %j", async (args) => {
      const { call, codexClient } = await setup();
      expect(await call(args)).toMatchObject({ success: false });
      expect(codexClient.lastRenameThreadParams).toBeUndefined();
    });

    it("rejects a call from a different turn", async () => {
      const { call, codexClient } = await setup();
      expect(await call({ title: "New title" }, "stale-turn")).toMatchObject({ success: false });
      expect(codexClient.lastRenameThreadParams).toBeUndefined();
    });

    it("checks Undo against owner metadata after earlier renames settle", async () => {
      const { registry, codexClient } = await setup();
      let title = "Original title";
      let finish!: () => void;
      const rename = vi.spyOn(codexClient, "renameThread").mockImplementation(async ({ threadId, name }) => {
        await new Promise<void>((resolve) => { finish = resolve; });
        title = name;
        return { threadId };
      });
      const readName = vi.fn(async () => title);
      Object.assign(codexClient, { readThreadName: readName });
      const first = registry.renameThread({ backend: "codex", threadId: "ordinary-thread", name: "User's later title" });
      await waitForCondition(() => rename.mock.calls.length === 1);
      const undo = registry.renameThread({ backend: "codex", threadId: "ordinary-thread",
        name: "Before agent rename", expectedName: "Original title" });
      const refused = expect(undo).rejects.toThrow("The thread title has changed. Undo was not applied.");
      finish();
      await first;
      await refused;
      expect(rename).toHaveBeenCalledTimes(1);
      expect(readName).toHaveBeenCalledTimes(1);
      expect(title).toBe("User's later title");
    });
  });

  it("mutates PwrAgent thread settings from active turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": createAgentOverlay(),
        "codex:target-thread": {
          backend: "codex",
          threadId: "target-thread",
          executionMode: "default",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "mutate_thread",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          title: "Pizza Agent",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          fastMode: true,
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: expect.any(String),
        },
      ],
    });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toEqual({
      mutation: {
        backend: "codex",
        threadId: "target-thread",
        dryRun: false,
        changes: [
          {
            field: "title",
            status: "applied",
            to: "Pizza Agent",
          },
          {
            field: "model_settings",
            status: "applied",
            to: {
              model: "gpt-5.5",
              reasoningEffort: "medium",
              fastMode: true,
            },
          },
        ],
      },
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "target-thread",
      name: "Pizza Agent",
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "target-thread",
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      reasoningEffort: "medium",
      fastMode: true,
    });

    await registry.close();
  });

  it("dry-runs thread mutations without applying them", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": {
          ...createAgentOverlay(),
          executionMode: "full-access",
        },
        "codex:target-thread": {
          backend: "codex",
          threadId: "target-thread",
          executionMode: "default",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "mutate_thread",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          title: "Pizza Agent",
          executionMode: "full-access",
          dryRun: true,
        },
      },
    } as AppServerPendingRequestNotification);

    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toEqual({
      mutation: {
        backend: "codex",
        threadId: "target-thread",
        dryRun: true,
        changes: [
          {
            field: "title",
            status: "would_apply",
            to: "Pizza Agent",
          },
          {
            field: "execution_mode",
            status: "would_apply",
            to: "full-access",
          },
        ],
      },
    });
    expect(codexClient.lastRenameThreadParams).toBeUndefined();
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "target-thread",
      }),
    ).resolves.toMatchObject({
      executionMode: "default",
    });

    await registry.close();
  });

  it("rejects invalid thread mutations before applying earlier requested fields", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": createAgentOverlay(),
        "codex:target-thread": {
          backend: "codex",
          threadId: "target-thread",
          executionMode: "default",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "mutate_thread",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          title: "Pizza Agent",
          model: "gpt-5.5",
          executionMode: "yolo",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "invalid_arguments",
              message:
                "executionMode must be default, auto, or full-access when provided.",
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(codexClient.lastRenameThreadParams).toBeUndefined();
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "target-thread",
    });
    expect(overlay).toMatchObject({
      executionMode: "default",
    });
    expect(overlay?.model).toBeUndefined();

    await registry.close();
  });

  it("rejects stale Token Miser retrieval tools after a thread opts out", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const tokenMiserRoot = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-disabled-call-"),
    );
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [],
            tokenMiserEnabled: false,
          },
        },
      }),
    });
    const internals = registry as unknown as {
      tokenMiserStore?: TokenMiserStore;
    };
    internals.tokenMiserStore = new TokenMiserStore(
      path.join(tokenMiserRoot, "objects"),
    );

    try {
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
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "read_token_miser_output",
          arguments: {
            objectId: "stale-object",
          },
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
                message: "Token Miser retrieval is disabled for this thread.",
              },
              null,
              2,
            ),
          },
        ],
      });
    } finally {
      await registry.close();
      await rm(tokenMiserRoot, { force: true, recursive: true });
    }
  });
});

describe("mark_project_read dynamic tool", () => {
  async function setup() {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["thread/list"] } });
    const registry = createDesktopBackendRegistry({ codexClient,
      overlayStore: createOverlayStoreMock({ overlays: { "codex:agent-thread": createAgentOverlay() } }),
    });
    onTestFinished(() => registry.close());
    const markProjectRead = vi.fn(async () => ({
      projectKey: "directory:/repo", instanceId: "local", isLocal: true, changedCount: 140,
    }));
    registry.setAgentThreadActions({ markProjectRead, archiveThread: vi.fn(), setThreadPin: vi.fn(), markThreadSeen: vi.fn() });
    await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: {
      threadId: "agent-thread", turnId: "turn-1", turn: { id: "turn-1" },
    } } });
    const call = async (args: Record<string, unknown>, turnId = "turn-1") => {
      const response = await codexClient.emitRequest({ method: "item/tool/call", params: {
        threadId: "agent-thread", turnId, callId: "bulk-call", requestId: "bulk-call",
        namespace: "pwragent", tool: "mark_project_read", arguments: args,
      } } as AppServerPendingRequestNotification) as { success: boolean; contentItems: Array<{ text: string }> };
      return { success: response.success, payload: JSON.parse(response.contentItems[0]!.text) };
    };
    return { registry, call, markProjectRead };
  }

  it("dispatches one project action without enumerating target threads", async () => {
    const { call, markProjectRead } = await setup();
    expect(await call({ projectKey: "directory:/repo" })).toEqual({ success: true, payload: { projectRead: {
      projectKey: "directory:/repo", instanceId: "local", isLocal: true, changedCount: 140,
    } } });
    expect(markProjectRead).toHaveBeenCalledExactlyOnceWith({ projectKey: "directory:/repo" });
  });

  it.each([{}, { projectKey: " " }, { projectKey: 1 }, { projectKey: "directory:/repo", instanceId: " " },
    { projectKey: "directory:/repo", archive: true }])("rejects invalid project arguments %j without mutations", async (args) => {
    const { call, markProjectRead } = await setup();
    expect(await call(args)).toMatchObject({ success: false, payload: { code: "invalid_arguments" } });
    expect(markProjectRead).not.toHaveBeenCalled();
  });

  it("rejects a call outside the active turn", async () => {
    const { call, markProjectRead } = await setup();
    expect(await call({ projectKey: "directory:/repo" }, "stale-turn")).toMatchObject({ success: false });
    expect(markProjectRead).not.toHaveBeenCalled();
  });

  it("enforces the messaging permission gate before applying the bulk action", async () => {
    const { registry, call, markProjectRead } = await setup();
    const checkDynamicToolPermission = vi.fn(() => ({ owns: true, allowed: false, permission: "thread.control.organize" }));
    registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(), checkDynamicToolPermission });
    expect(await call({ projectKey: "directory:/repo", instanceId: "peer" })).toMatchObject({ success: false });
    expect(checkDynamicToolPermission).toHaveBeenCalledWith(expect.objectContaining({
      category: "thread_inspection", tool: "mark_project_read", arguments: { projectKey: "directory:/repo", instanceId: "peer" },
    }));
    expect(markProjectRead).not.toHaveBeenCalled();
  });

  it("returns an owner error without another attempt", async () => {
    const { call, markProjectRead } = await setup();
    markProjectRead.mockRejectedValue(new Error("Owner directory membership is still checking"));
    expect(await call({ projectKey: "directory:/repo" })).toMatchObject({ success: false, payload: {
      code: "internal_error", message: "Owner directory membership is still checking",
    } });
    expect(markProjectRead).toHaveBeenCalledTimes(1);
  });
});

describe("thread maintenance agent tools", () => {
  const scan = {
    scanId: "scan-1", startedAt: 1, finishedAt: 2,
    rules: { mode: "count" as const, keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    spaceSource: "none" as const,
    threads: { checked: 3, kept: { "Pinned thread": 1 }, projects: [{
      key: "/repo", label: "repo", path: "/repo", kept: { "Pinned thread": 1 }, idle: [
        { backend: "codex", threadId: "idle-clean", title: "Old fix", lastActivityAt: 1, subThreads: 0,
          workspace: { kind: "clean" as const } },
        { backend: "codex", threadId: "idle-big", title: "Load harness", lastActivityAt: 1, subThreads: 0,
          workspace: { kind: "overLimit" as const, files: 3, bytes: 2_000_000_000, limitBytes: 104_857_600, largest: [] } },
      ],
    }] },
    checkouts: { kept: {}, emptyFolders: 2, items: [
      { backend: "codex", threadId: "archived", worktreePath: "/wt/a/repo", kind: "removable" as const },
      { backend: "codex", threadId: "orphan", worktreePath: "/wt/b/kit", kind: "repositoryGone" as const, missingRepositoryPath: "/tmp/kit" },
    ] },
    hibernate: { idleDays: 7, maxSnapshotMb: 25, removeRebuildableOutput: true, checked: 2, kept: { "Kept awake": 1 }, items: [
      { backend: "codex", threadId: "idle-checkout", title: "Cart drawer", worktreePath: "/wt/c/repo", lastActivityAt: 1,
        files: 3, bytes: 41_000, removedOutput: ["node_modules"] },
      { backend: "codex", threadId: "idle-clean", title: "Old fix", worktreePath: "/wt/d/repo", lastActivityAt: 1,
        files: 0, bytes: 0, archiveKey: "codex:idle-clean" },
    ] },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
  const finished = { runId: "run-1", revision: 2, scanId: "scan-1", running: false, startedAt: 3, finishedAt: 4,
    steps: [{ step: "threads" as const, ran: true, done: 1, kept: 0, failed: 0 }], problems: [] };

  async function setup() {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["thread/list"] } });
    const registry = createDesktopBackendRegistry({ codexClient,
      overlayStore: createOverlayStoreMock({ overlays: { "codex:agent-thread": createAgentOverlay() } }),
    });
    onTestFinished(() => registry.close());
    const handler = {
      scan: vi.fn(async (_request: { scanId: string }): Promise<typeof scan> => scan),
      getScan: vi.fn((scanId: string) => scanId === "scan-1" ? scan : undefined),
      getRun: vi.fn((): typeof finished | undefined => undefined),
      start: vi.fn(() => ({ run: { ...finished, running: true }, done: Promise.resolve(finished) })),
      open: vi.fn(() => true),
    };
    registry.setThreadMaintenanceToolHandler(handler);
    await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started", params: {
      threadId: "agent-thread", turnId: "turn-1", turn: { id: "turn-1" },
    } } });
    const events: AgentEvent[] = [];
    onTestFinished(registry.onEvent((event) => { events.push(event); }));
    const call = (tool: string, args: Record<string, unknown>, callId = "maint-call") =>
      codexClient.emitRequest({ method: "item/tool/call", params: {
        threadId: "agent-thread", turnId: "turn-1", callId, requestId: callId,
        namespace: "pwragent", tool, arguments: args,
      } } as AppServerPendingRequestNotification) as Promise<{ success: boolean; contentItems: Array<{ text: string }> }>;
    const payload = (response: { contentItems: Array<{ text: string }> }) => JSON.parse(response.contentItems[0]!.text);
    const answer = async (label: string) => {
      await vi.waitFor(() => expect(events.some((event) => event.notification.method === "item/tool/requestUserInput")).toBe(true));
      const request = events.find((event) => event.notification.method === "item/tool/requestUserInput")!.notification;
      if (request.method !== "item/tool/requestUserInput") throw new Error("Expected a confirmation card");
      await registry.submitServerRequest({ backend: "codex", threadId: "agent-thread", turnId: "turn-1",
        requestId: request.params.requestId,
        response: { answers: { thread_maintenance: { answers: [label] } } },
      });
      return request.params;
    };
    return { registry, handler, call, payload, answer, events };
  }

  it("scans read-only and returns a bounded summary", async () => {
    const { handler, call, payload } = await setup();
    const response = await call("scan_thread_maintenance", { projectKey: "/repo", rules: { mode: "age", inactivityDays: 30 } });
    expect(response.success).toBe(true);
    expect(handler.scan).toHaveBeenCalledExactlyOnceWith({ projectKey: "/repo", rules: { mode: "age", inactivityDays: 30 },
      scanId: expect.any(String) });
    expect(payload(response).maintenanceScan).toMatchObject({
      scanId: "scan-1",
      threads: { checked: 3, idleCount: 2, truncated: false, projects: [{ key: "/repo", idleCount: 2 }] },
      checkouts: { removable: [{ worktreePath: "/wt/a/repo" }], repositoryGone: [{ worktreePath: "/wt/b/kit" }], emptyFolders: 2 },
      hibernate: { idleDays: 7, checked: 2, kept: { "Kept awake": 1 }, truncated: false, items: [{
        backend: "codex", threadId: "idle-checkout", worktreePath: "/wt/c/repo", changedFiles: 3, changedBytes: 41_000,
      }, { threadId: "idle-clean", offeredForArchive: true }] },
    });
    expect(handler.start).not.toHaveBeenCalled();
  });

  // Claude Code aborts an MCP call with no response after 60 seconds, and a
  // full scan of a large fleet took over two minutes. The call must answer
  // within its wait whatever the scan takes, a retry must join the running
  // scan, and reading by scanId must return the scan the service produced.
  it("answers a scan that outlasts one call, then reads it by scanId", async () => {
    const { handler, call, payload } = await setup();
    let finish!: () => void;
    handler.scan.mockImplementation(async (request) => await new Promise<typeof scan>((resolve) => {
      finish = () => resolve({ ...scan, scanId: request.scanId });
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => { vi.useRealTimers(); });

    const first = call("scan_thread_maintenance", { projectKey: "/repo" });
    await vi.advanceTimersByTimeAsync(THREAD_MAINTENANCE_TOOL_WAIT_MS);
    const firstPayload = payload(await first);
    expect(firstPayload.maintenanceScan).toBeUndefined();
    const pending = firstPayload.maintenanceScanPending;
    expect(pending).toMatchObject({ running: true, projectKey: "/repo", scanId: expect.any(String) });
    expect(pending.guidance).toContain("only this scanId");

    const retry = call("scan_thread_maintenance", { projectKey: "/repo" }, "maint-retry");
    await vi.advanceTimersByTimeAsync(THREAD_MAINTENANCE_TOOL_WAIT_MS);
    expect(payload(await retry).maintenanceScanPending.scanId).toBe(pending.scanId);
    expect(handler.scan).toHaveBeenCalledExactlyOnceWith({ projectKey: "/repo", scanId: pending.scanId });

    const read = call("scan_thread_maintenance", { scanId: pending.scanId }, "maint-read");
    await vi.advanceTimersByTimeAsync(1_000);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(payload(await read).maintenanceScan).toMatchObject({ scanId: pending.scanId, threads: { checked: 3, idleCount: 2 } });
    expect(handler.scan).toHaveBeenCalledOnce();
  });

  it.each([
    [{ scanId: "scan-1", projectKey: "/repo" }, "Pass scanId alone"],
    [{ scanId: "" }, "nonempty scanId"],
  ])("refuses scan arguments %j", async (args, message) => {
    const { handler, call, payload } = await setup();
    const response = await call("scan_thread_maintenance", args);
    expect(payload(response)).toMatchObject({ code: "invalid_arguments" });
    expect(payload(response).message).toContain(message);
    expect(handler.scan).not.toHaveBeenCalled();
  });

  it("reports a scan it no longer has as not found", async () => {
    const { call, payload } = await setup();
    expect(payload(await call("scan_thread_maintenance", { scanId: "gone" }))).toMatchObject({ code: "not_found" });
  });

  it("opens the dialog for the operator without starting a run", async () => {
    const { handler, call, payload } = await setup();
    expect(payload(await call("open_thread_maintenance", { projectKey: "/repo" }))).toEqual({ maintenanceDialog: { opened: true } });
    expect(handler.open).toHaveBeenCalledExactlyOnceWith({ projectKey: "/repo" });
    expect(handler.start).not.toHaveBeenCalled();
  });

  it("previews a dry run without a card or a run", async () => {
    const { handler, call, payload, events } = await setup();
    const response = await call("apply_thread_maintenance", { scanId: "scan-1", dryRun: true,
      archive: [{ backend: "codex", threadId: "idle-big", overLimit: "snapshotAll" }] });
    expect(payload(response)).toMatchObject({ dryRun: true, maintenancePlan: {
      archive: 1, snapshotApprovals: [{ threadId: "idle-big", bytes: 2_000_000_000 }],
    } });
    expect(events.some((event) => event.notification.method === "item/tool/requestUserInput")).toBe(false);
    expect(handler.start).not.toHaveBeenCalled();
  });

  it("runs the reviewed selection only after the operator approves the card", async () => {
    const { handler, call, payload, answer } = await setup();
    const pending = call("apply_thread_maintenance", { scanId: "scan-1",
      archive: [{ backend: "codex", threadId: "idle-clean" }],
      removeCheckouts: [{ backend: "codex", threadId: "archived", worktreePath: "/wt/a/repo" }],
      trashCheckouts: [{ worktreePath: "/wt/b/kit" }] });
    const card = await answer("Run maintenance");
    expect(card.itemId).toBe("maint-call");
    expect((card.questions as Array<{ question: string }>)[0]!.question).toContain("archive 1 thread, remove 1 archived checkout and move 1 orphaned checkout to the Trash");
    const response = await pending;
    expect(response.success).toBe(true);
    expect(handler.start).toHaveBeenCalledExactlyOnceWith({ scanId: "scan-1",
      archive: [{ backend: "codex", threadId: "idle-clean" }],
      removeCheckouts: [{ backend: "codex", threadId: "archived", worktreePath: "/wt/a/repo" }],
      trashCheckouts: [{ worktreePath: "/wt/b/kit" }], removeEmptyFolders: false });
    expect(payload(response).maintenanceRun).toMatchObject({ runId: "run-1", running: false });
  });

  // The card and the run share one call's limit, so a long run is reported
  // as running instead of holding the call open for minutes.
  it("answers an approved run that outlasts one call as running", async () => {
    const { handler, call, payload, answer, events } = await setup();
    handler.start.mockReturnValue({ run: { ...finished, running: true }, done: new Promise<typeof finished>(() => {}) });
    let answered = false;
    const pending = call("apply_thread_maintenance", { scanId: "scan-1", archive: [{ backend: "codex", threadId: "idle-clean" }] })
      .then((response) => { answered = true; return response; });
    await vi.waitFor(() => expect(events.some((event) => event.notification.method === "item/tool/requestUserInput")).toBe(true));
    handler.getRun.mockReturnValue({ ...finished, running: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    onTestFinished(() => { vi.useRealTimers(); });
    await answer("Run maintenance");
    await vi.advanceTimersByTimeAsync(THREAD_MAINTENANCE_TOOL_WAIT_MS);
    expect(answered).toBe(true);
    expect(payload(await pending).maintenanceRun).toMatchObject({ runId: "run-1", running: true });
  });

  it("hibernates reviewed idle checkouts after the operator approves the card", async () => {
    const { handler, call, answer } = await setup();
    const pending = call("apply_thread_maintenance", { scanId: "scan-1",
      hibernate: [{ backend: "codex", threadId: "idle-checkout" }] });
    const card = await answer("Run maintenance");
    expect((card.questions as Array<{ question: string }>)[0]!.question).toContain("hibernate 1 idle checkout");
    expect((card.questions as Array<{ question: string }>)[0]!.question).toContain("comes back when its thread gets a message");
    expect((await pending).success).toBe(true);
    expect(handler.start).toHaveBeenCalledExactlyOnceWith({ scanId: "scan-1", archive: [], removeCheckouts: [],
      trashCheckouts: [], removeEmptyFolders: false, hibernate: [{ backend: "codex", threadId: "idle-checkout" }] });
  });

  it("changes nothing when the operator declines the card", async () => {
    const { handler, call, payload, answer } = await setup();
    const pending = call("apply_thread_maintenance", { scanId: "scan-1", archive: [{ backend: "codex", threadId: "idle-clean" }] });
    await answer("Cancel");
    const response = await pending;
    expect(response.success).toBe(false);
    expect(payload(response)).toMatchObject({ code: "forbidden" });
    expect(payload(response).message).toContain("Do not retry it");
    expect(handler.start).not.toHaveBeenCalled();
  });

  it.each([
    [{ scanId: "scan-1", archive: [{ backend: "codex", threadId: "agent-thread" }] }, "running this tool"],
    [{ scanId: "scan-1", archive: [{ backend: "codex", threadId: "idle-big" }] }, "over the snapshot limit"],
    [{ scanId: "scan-1", archive: [{ backend: "codex", threadId: "idle-clean", overLimit: "snapshotAll" }] }, "under the snapshot limit"],
    [{ scanId: "scan-1", archive: [{ backend: "codex", threadId: "elsewhere" }] }, "not an idle thread"],
    [{ scanId: "scan-1", trashCheckouts: [{ worktreePath: "/wt/a/repo" }] }, "repository is gone"],
    [{ scanId: "scan-1", hibernate: [{ backend: "codex", threadId: "elsewhere" }] }, "no idle checkout to hibernate"],
    [{ scanId: "scan-1", archive: [{ backend: "codex", threadId: "idle-clean" }], hibernate: [{ backend: "codex", threadId: "idle-clean" }] },
      "not both"],
    [{ scanId: "scan-1", hibernate: [{ backend: "codex", threadId: "agent-thread" }] }, "running this tool"],
    [{ scanId: "scan-1", hibernate: { backend: "codex", threadId: "idle-checkout" } }, "hibernate must be an array"],
    [{ scanId: "scan-1" }, "at least one"],
    [{ scanId: "scan-1", archive: [], extra: true }, "Pass only"],
  ])("refuses %j before any card", async (args, message) => {
    const { handler, call, payload, events } = await setup();
    const response = await call("apply_thread_maintenance", args);
    expect(response.success).toBe(false);
    expect(payload(response)).toMatchObject({ code: "invalid_arguments" });
    expect(payload(response).message).toContain(message);
    expect(events.some((event) => event.notification.method === "item/tool/requestUserInput")).toBe(false);
    expect(handler.start).not.toHaveBeenCalled();
  });

  it("reports an expired scan as not found", async () => {
    const { call, payload } = await setup();
    expect(payload(await call("apply_thread_maintenance", { scanId: "gone", archive: [] }))).toMatchObject({ code: "not_found" });
  });

  it("gates apply on the archive permission for messaging turns", async () => {
    const { registry, handler, call } = await setup();
    const checkDynamicToolPermission = vi.fn(() => ({ owns: true, allowed: false, permission: "thread.control.archive" }));
    registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(), checkDynamicToolPermission });
    expect(await call("apply_thread_maintenance", { scanId: "scan-1", archive: [{ backend: "codex", threadId: "idle-clean" }] }))
      .toMatchObject({ success: false });
    expect(checkDynamicToolPermission).toHaveBeenCalledWith(expect.objectContaining({
      category: "thread_inspection", tool: "apply_thread_maintenance",
    }));
    expect(handler.start).not.toHaveBeenCalled();
  });
});

describe("agent tool access ceiling", () => {
  type Mode = "default" | "auto" | "full-access";

  async function startCaller(params: {
    callerMode: Mode;
    /** Stored after the turn starts, so it differs from the live turn mode. */
    storedCallerMode?: Mode;
    /** The target thread's own stored mode. Default Access unless named. */
    targetMode?: Mode;
    /** Registers the caller as the Voice and Star Map manager thread. */
    manager?: boolean;
  }) {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [
        {
          id: "agent-thread",
          title: "Parent Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 1000,
        },
        {
          id: "target-thread",
          title: "Target Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 1000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": {
          ...createAgentOverlay(),
          executionMode: params.callerMode,
        },
        "codex:target-thread": {
          backend: "codex",
          threadId: "target-thread",
          executionMode: params.targetMode ?? "default",
          extraLinkedDirectories: [],
        },
      },
    });
    if (params.manager) {
      const manager = { backend: "codex" as const, threadId: "agent-thread" };
      Object.assign(overlayStore, {
        getVoiceManagerThread: () => manager,
        getStarMapManagerThread: () => manager,
      });
    }
    const registry = createDesktopBackendRegistry({
      codexClient,
      createScratchProjectDirectory: async () => "/repo/scratch",
      overlayStore,
      threadTitleGenerationService: null,
    });
    // The live turn takes the thread's stored mode as it starts.
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    if (params.storedCallerMode) {
      await overlayStore.setThreadExecutionMode({
        backend: "codex",
        threadId: "agent-thread",
        executionMode: params.storedCallerMode,
      });
    }
    let callCount = 0;
    const call = async (tool: string, args: Record<string, unknown>) => {
      callCount += 1;
      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: `call-${callCount}`,
          requestId: `call-${callCount}`,
          namespace: "pwragent",
          tool,
          arguments: args,
        },
      } as AppServerPendingRequestNotification);
      const result = response as {
        success: boolean;
        contentItems: Array<{ text: string }>;
      };
      return {
        success: result.success,
        payload: JSON.parse(result.contentItems[0]!.text) as Record<string, unknown>,
      };
    };
    return { codexClient, overlayStore, registry, call };
  }

  const forbidden = {
    success: false,
    payload: {
      code: "forbidden",
      message: expect.stringContaining("An agent cannot raise access"),
    },
  };

  describe("handoff_task", () => {
    const handoff = (extra: Record<string, unknown> = {}) => ({
      task: "Investigate the flaky test.",
      title: "Flaky test",
      workspaceMode: "none",
      ...extra,
    });

    it.each(["auto", "full-access"] as const)(
      "refuses a Default Access caller asking for %s",
      async (executionMode) => {
        const { codexClient, registry, call } = await startCaller({ callerMode: "default" });

        expect(await call("handoff_task", handoff({ executionMode }))).toMatchObject(forbidden);
        expect(codexClient.lastStartThreadParams).toBeUndefined();
        expect(codexClient.startTurnCalls).toHaveLength(0);

        await registry.close();
      },
    );

    it("refuses raw approval and sandbox overrides above the caller", async () => {
      const { codexClient, registry, call } = await startCaller({ callerMode: "auto" });

      expect(await call("handoff_task", handoff({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }))).toMatchObject(forbidden);
      expect(codexClient.lastStartThreadParams).toBeUndefined();

      await registry.close();
    });

    it.each([
      { callerMode: "default", executionMode: "default" },
      { callerMode: "full-access", executionMode: "auto" },
      { callerMode: "full-access", executionMode: "full-access" },
    ] as const)(
      "lets a $callerMode caller hand off at $executionMode",
      async ({ callerMode, executionMode }) => {
        const { registry, call } = await startCaller({ callerMode });

        const result = await call("handoff_task", handoff({ executionMode }));

        expect(result.success).toBe(true);
        expect(result.payload.inheritedSettings).toMatchObject({ executionMode });

        await registry.close();
      },
    );

    it("inherits the caller's mode when the request names none", async () => {
      const { registry, call } = await startCaller({ callerMode: "auto" });

      const result = await call("handoff_task", handoff());

      expect(result.success).toBe(true);
      expect(result.payload.inheritedSettings).toMatchObject({ executionMode: "auto" });

      await registry.close();
    });
  });

  describe("send_message_to_thread", () => {
    const message = (extra: Record<string, unknown> = {}) => ({
      backend: "codex",
      threadId: "target-thread",
      prompt: "Please pick up the CI failure.",
      ...extra,
    });

    it.each(["auto", "full-access"] as const)(
      "refuses a Default Access caller asking for %s",
      async (executionMode) => {
        const { codexClient, registry, call } = await startCaller({ callerMode: "default" });

        expect(await call("send_message_to_thread", message({ executionMode })))
          .toMatchObject(forbidden);
        expect(codexClient.startTurnCalls).toHaveLength(0);

        await registry.close();
      },
    );

    it("refuses a raw Full Access sandbox from a Default Access caller", async () => {
      const { codexClient, registry, call } = await startCaller({ callerMode: "default" });

      expect(await call("send_message_to_thread", message({ sandbox: "danger-full-access" })))
        .toMatchObject(forbidden);
      expect(codexClient.startTurnCalls).toHaveLength(0);

      await registry.close();
    });

    it.each([
      { callerMode: "default", targetMode: "default", extra: { executionMode: "default" } },
      { callerMode: "full-access", targetMode: "full-access", extra: { executionMode: "auto" } },
      { callerMode: "default", targetMode: "default", extra: {} },
    ] as const)(
      "lets a $callerMode caller send $extra to a $targetMode thread",
      async ({ callerMode, targetMode, extra }) => {
        const { codexClient, registry, call } = await startCaller({ callerMode, targetMode });

        expect(await call("send_message_to_thread", message(extra)))
          .toMatchObject({ success: true });
        expect(codexClient.startTurnCalls).toHaveLength(1);

        await registry.close();
      },
    );
  });

  describe("mutate_thread", () => {
    it.each(["auto", "full-access"] as const)(
      "refuses raising the caller's own thread to %s",
      async (executionMode) => {
        const { overlayStore, registry, call } = await startCaller({ callerMode: "default" });

        expect(await call("mutate_thread", {
          backend: "codex",
          threadId: "agent-thread",
          executionMode,
        })).toMatchObject(forbidden);
        await expect(overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "agent-thread",
        })).resolves.toMatchObject({ executionMode: "default" });

        await registry.close();
      },
    );

    it("refuses another thread above the caller, dry run included", async () => {
      const { overlayStore, registry, call } = await startCaller({ callerMode: "auto" });

      for (const dryRun of [true, false]) {
        expect(await call("mutate_thread", {
          backend: "codex",
          threadId: "target-thread",
          executionMode: "full-access",
          dryRun,
        })).toMatchObject(forbidden);
      }
      await expect(overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "target-thread",
      })).resolves.toMatchObject({ executionMode: "default" });

      await registry.close();
    });

    it.each([
      { callerMode: "auto", threadId: "target-thread", executionMode: "auto" },
      { callerMode: "full-access", threadId: "agent-thread", executionMode: "default" },
      { callerMode: "auto", threadId: "agent-thread", executionMode: "auto" },
    ] as const)(
      "lets a $callerMode caller set $threadId to $executionMode",
      async ({ callerMode, threadId, executionMode }) => {
        const { registry, call } = await startCaller({ callerMode });

        const result = await call("mutate_thread", {
          backend: "codex",
          threadId,
          executionMode,
          dryRun: true,
        });

        expect(result).toMatchObject({
          success: true,
          payload: {
            mutation: {
              changes: [{ field: "execution_mode", status: "would_apply", to: executionMode }],
            },
          },
        });

        await registry.close();
      },
    );
  });

  // The Voice and Star Map managers start at the launchpad default, which is
  // Default Access unless the operator changed it. Being a manager grants no
  // access: an operator's spoken or typed "start a Full Access thread" is
  // still the manager's own tool call, and the operator never saw a gate.
  describe("a manager thread started at the launchpad default", () => {
    it.each([
      {
        tool: "handoff_task",
        args: {
          task: "Fix the flaky test.",
          title: "Flaky test",
          workspaceMode: "none",
          executionMode: "full-access",
        },
      },
      {
        tool: "send_message_to_thread",
        args: {
          backend: "codex",
          threadId: "target-thread",
          prompt: "Pick this up.",
          executionMode: "full-access",
        },
      },
      {
        tool: "mutate_thread",
        args: { backend: "codex", threadId: "target-thread", executionMode: "full-access" },
      },
    ])("refuses $tool asking for Full Access", async ({ tool, args }) => {
      const { codexClient, overlayStore, registry, call } = await startCaller({
        callerMode: "default",
        manager: true,
      });

      expect(await call(tool, args)).toMatchObject(forbidden);
      expect(codexClient.lastStartThreadParams).toBeUndefined();
      expect(codexClient.startTurnCalls).toHaveLength(0);
      await expect(overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "target-thread",
      })).resolves.toMatchObject({ executionMode: "default" });

      await registry.close();
    });

    it("hands off at Full Access only once the operator raised the manager itself", async () => {
      const { registry, call } = await startCaller({ callerMode: "full-access", manager: true });

      const result = await call("handoff_task", {
        task: "Fix the flaky test.",
        title: "Flaky test",
        workspaceMode: "none",
        executionMode: "full-access",
      });

      expect(result.success).toBe(true);
      expect(result.payload.inheritedSettings).toMatchObject({ executionMode: "full-access" });

      await registry.close();
    });
  });

  describe("a lower mode the operator queued mid-turn", () => {
    it("caps what the agent may ask for and what a handoff inherits", async () => {
      const { registry, call } = await startCaller({ callerMode: "full-access" });
      await registry.setThreadExecutionMode({
        backend: "codex",
        threadId: "agent-thread",
        executionMode: "auto",
      });
      expect(registry.getQueuedExecutionModeForThread({
        backend: "codex",
        threadId: "agent-thread",
      })?.mode).toBe("auto");

      expect(await call("mutate_thread", {
        backend: "codex",
        threadId: "target-thread",
        executionMode: "full-access",
        dryRun: true,
      })).toMatchObject(forbidden);
      const handoff = await call("handoff_task", {
        task: "Investigate the flaky test.",
        title: "Flaky test",
        workspaceMode: "none",
      });
      expect(handoff.success).toBe(true);
      expect(handoff.payload.inheritedSettings).toMatchObject({ executionMode: "auto" });

      await registry.close();
    });
  });

  describe("send_message_to_thread per-turn override", () => {
    const MODES = THREAD_EXECUTION_MODES_BY_ACCESS;
    const rank = threadExecutionModeRank;
    // The access a started turn actually got from the provider call.
    const turnAccess = (call: NonNullable<MockBackendClient["lastStartTurnParams"]>) =>
      Math.max(
        rank(call.executionMode ?? "default"),
        rank(threadExecutionModeForRawPermissions({
          approvalPolicy: call.approvalPolicy,
          sandbox: call.sandbox,
        })),
      );
    const SANDBOXES = [undefined, "workspace-write", "danger-full-access"] as const;

    // Property: whatever the caller's mode, the target's stored mode and the
    // requested per-turn mode and sandbox, the turn runs at or below
    // min(caller, target), or is refused before the provider is called. A
    // request at or below that ceiling is never refused.
    it("runs at or below min(caller, target), or refuses before the provider", async () => {
      for (const callerMode of MODES) {
        for (const targetMode of MODES) {
          for (const executionMode of MODES) {
            for (const sandbox of SANDBOXES) {
              const { codexClient, registry, call } = await startCaller({ callerMode, targetMode });
              const ceiling = Math.min(rank(callerMode), rank(targetMode));
              const requested = Math.max(
                rank(executionMode),
                sandbox ? rank(threadExecutionModeForRawPermissions({ sandbox })) : 0,
              );
              const result = await call("send_message_to_thread", {
                backend: "codex",
                threadId: "target-thread",
                prompt: "Take this one.",
                executionMode,
                ...(sandbox ? { sandbox } : {}),
              });
              const turns = codexClient.startTurnCalls.filter((turn) => turn.threadId === "target-thread");
              const scenario = { callerMode, targetMode, executionMode, sandbox };
              if (requested > ceiling) {
                expect({ ...scenario, success: result.success, turns: turns.length })
                  .toEqual({ ...scenario, success: false, turns: 0 });
                expect(result.payload).toMatchObject({ code: "forbidden" });
              } else {
                expect({ ...scenario, success: result.success }).toEqual({ ...scenario, success: true });
                expect(turns).toHaveLength(1);
                expect({ ...scenario, access: turnAccess(turns[0]!) <= ceiling })
                  .toEqual({ ...scenario, access: true });
              }
              await registry.close();
            }
          }
        }
      }
    });

    it("refuses a Full Access caller's Full Access turn in a Default Access thread", async () => {
      const { codexClient, overlayStore, registry, call } = await startCaller({
        callerMode: "full-access",
        targetMode: "default",
      });

      expect(await call("send_message_to_thread", {
        backend: "codex",
        threadId: "target-thread",
        prompt: "Take this one.",
        executionMode: "full-access",
        sandbox: "danger-full-access",
      })).toMatchObject({
        success: false,
        payload: {
          code: "forbidden",
          message: expect.stringContaining("more access than the target thread has (Default Access)"),
        },
      });
      expect(codexClient.startTurnCalls.filter((turn) => turn.threadId === "target-thread")).toHaveLength(0);
      await expect(overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "target-thread",
      })).resolves.toMatchObject({ executionMode: "default" });

      await registry.close();
    });

    // A peer's agent message reaches this owner as a submitTurn carrying the
    // peer's origin; the owner holds its own thread's ceiling.
    it("holds the target ceiling on the owner for a peer's agent message", async () => {
      const { codexClient, registry } = await startCaller({ callerMode: "default", targetMode: "default" });
      const peerOrigin = {
        kind: "agent" as const,
        sourceThread: { backend: "codex" as const, instanceId: "pwr_peer", threadId: "peer-thread" },
      };

      await expect(registry.submitTurn({
        backend: "codex",
        threadId: "target-thread",
        input: [{ type: "text", text: "Run this as Full Access." }],
        messageOrigin: peerOrigin,
        executionMode: "full-access",
      })).rejects.toThrow(/more access than the target thread has \(Default Access\)/);
      await expect(registry.submitHeldTurn({
        queueEntryId: "held-1",
        backend: "codex",
        threadId: "target-thread",
        input: [{ type: "text", text: "Hold this as Full Access." }],
        holdReason: "locked",
        messageOrigin: peerOrigin,
        sandbox: "danger-full-access",
      })).rejects.toThrow(/An agent cannot raise access/);
      expect(codexClient.startTurnCalls.filter((turn) => turn.threadId === "target-thread")).toHaveLength(0);

      // The operator's to-do click approves the mode its card shows.
      await registry.submitTurn({
        backend: "codex",
        threadId: "target-thread",
        input: [{ type: "text", text: "Approved by the operator." }],
        messageOrigin: { ...peerOrigin, operatorApproved: true },
        executionMode: "full-access",
      });
      expect(codexClient.startTurnCalls.filter((turn) => turn.threadId === "target-thread")).toHaveLength(1);

      await registry.close();
    });

    // Property: a sender's replacement of its queued message is submitted
    // again under the override the entry keeps, so it meets the target's
    // stored mode as it stands then. It can neither take nor drop the
    // operator's approval of the text it replaces.
    it("checks a sender's replacement against the target's current mode and keeps approval with its text", async () => {
      const sourceThread = { backend: "codex" as const, instanceId: "pwr_peer", threadId: "peer-thread" };
      const origin = (approved: boolean) => ({
        kind: "agent" as const,
        sourceThread,
        ...(approved ? { operatorApproved: true } : {}),
      });
      for (const submittedMode of MODES) {
        for (const executionMode of MODES) {
          for (const currentMode of MODES) {
            for (const originalApproved of [false, true]) {
              for (const replacementApproved of [false, true]) {
                if (!originalApproved && rank(executionMode) > rank(submittedMode)) continue;
                const { codexClient, overlayStore, registry } = await startCaller({
                  callerMode: "full-access",
                  targetMode: submittedMode,
                });
                const target = { backend: "codex" as const, threadId: "target-thread" };
                await registry.submitHeldTurn({
                  ...target,
                  queueEntryId: "queued-1",
                  input: [{ type: "text", text: "Original" }],
                  holdReason: "locked",
                  messageOrigin: origin(originalApproved),
                  executionMode,
                });
                await overlayStore.setThreadExecutionMode({ ...target, executionMode: currentMode });
                const scenario = { submittedMode, executionMode, currentMode, originalApproved, replacementApproved };
                const replacing = registry.replaceQueuedAgentMessage({
                  ...target,
                  queueEntryId: "queued-1",
                  input: [{ type: "text", text: "Replacement" }],
                  messageOrigin: origin(replacementApproved),
                });
                const queue = (registry as unknown as {
                  threadTurnQueue: import("@pwragent/owner-core/thread-turn-queue").ThreadTurnQueue;
                }).threadTurnQueue;
                const queued = () => queue.getQueuedEntries(target).map((entry) => ({
                  text: entry.input.map((item) => item.type === "text" ? item.text : "").join(""),
                  executionMode: entry.executionMode,
                  approved: Boolean(entry.messageOrigin?.operatorApproved),
                }));
                if (replacementApproved !== originalApproved) {
                  await expect(replacing, JSON.stringify(scenario))
                    .rejects.toThrow("cannot change whether the operator approved");
                  expect({ ...scenario, queued: queued() }).toEqual({
                    ...scenario,
                    queued: [{ text: "Original", executionMode, approved: originalApproved }],
                  });
                } else if (!replacementApproved && rank(executionMode) > rank(currentMode)) {
                  await expect(replacing, JSON.stringify(scenario)).rejects.toThrow(/An agent cannot raise access/);
                  expect({ ...scenario, queued: queued() }).toEqual({
                    ...scenario,
                    queued: [{ text: "Original", executionMode, approved: originalApproved }],
                  });
                } else {
                  await expect(replacing, JSON.stringify(scenario)).resolves.toMatchObject({ queueStatus: "queued" });
                  expect({ ...scenario, queued: queued() }).toEqual({
                    ...scenario,
                    queued: [{ text: "Replacement", executionMode, approved: originalApproved }],
                  });
                }
                expect(codexClient.startTurnCalls.filter((turn) => turn.threadId === "target-thread")).toHaveLength(0);
                await registry.close();
              }
            }
          }
        }
      }
    });

    it("never raises a target with a raw sandbox override alone", async () => {
      for (const callerMode of MODES) {
        for (const targetMode of MODES) {
          for (const sandbox of SANDBOXES.filter((value) => value !== undefined)) {
            const { codexClient, registry, call } = await startCaller({ callerMode, targetMode });
            const ceiling = Math.min(rank(callerMode), rank(targetMode));
            const result = await call("send_message_to_thread", {
              backend: "codex",
              threadId: "target-thread",
              prompt: "Take this one.",
              sandbox,
            });
            const turns = codexClient.startTurnCalls.filter((turn) => turn.threadId === "target-thread");
            const scenario = { callerMode, targetMode, sandbox };
            if (rank(threadExecutionModeForRawPermissions({ sandbox })) > ceiling) {
              expect({ ...scenario, success: result.success, turns: turns.length })
                .toEqual({ ...scenario, success: false, turns: 0 });
            } else {
              // No mode named: the turn runs at the target's own mode, never above it.
              expect({ ...scenario, success: result.success }).toEqual({ ...scenario, success: true });
              expect({ ...scenario, access: turnAccess(turns[0]!) <= rank(targetMode) })
                .toEqual({ ...scenario, access: true });
            }
            await registry.close();
          }
        }
      }
    });

    it("refuses a turn in the caller's own thread before the provider", async () => {
      for (const callerMode of MODES) {
        for (const executionMode of MODES) {
          const { codexClient, registry, call } = await startCaller({ callerMode });
          const before = codexClient.startTurnCalls.length;
          const result = await call("send_message_to_thread", {
            backend: "codex",
            threadId: "agent-thread",
            prompt: "Run this in my own thread.",
            executionMode,
          });
          expect({ callerMode, executionMode, success: result.success })
            .toEqual({ callerMode, executionMode, success: false });
          expect(codexClient.startTurnCalls.length).toBe(before);
          await registry.close();
        }
      }
    });
  });

  describe("the caller's mode is its live Codex turn's", () => {
    it("refuses Full Access when only the stored mode was raised mid-turn", async () => {
      const { registry, call } = await startCaller({
        callerMode: "default",
        storedCallerMode: "full-access",
      });

      expect(await call("mutate_thread", {
        backend: "codex",
        threadId: "target-thread",
        executionMode: "full-access",
        dryRun: true,
      })).toMatchObject(forbidden);
      expect(await call("send_message_to_thread", {
        backend: "codex",
        threadId: "target-thread",
        prompt: "Take this one.",
        executionMode: "full-access",
      })).toMatchObject(forbidden);

      await registry.close();
    });

    it("allows Full Access when the live turn runs at Full Access", async () => {
      const { registry, call } = await startCaller({
        callerMode: "full-access",
        storedCallerMode: "default",
      });

      expect(await call("mutate_thread", {
        backend: "codex",
        threadId: "target-thread",
        executionMode: "full-access",
        dryRun: true,
      })).toMatchObject({ success: true });

      await registry.close();
    });
  });
});
