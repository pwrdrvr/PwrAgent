import {
  mainLoggerMock,
  mockArchiveWorktreePresence,
  isCompletedItemType,
  createDeferred,
  waitForCondition,
  expectEventually,
  createOverlayStoreMock,
  TEST_TASK_MONITOR_MODELS,
  MockBackendClient,
  KIMI_HIGHSPEED_MODEL,
  KIMI_K3_MODEL,
  createKimiModelCapabilities,
  createKimiAcpRegistry,
  callRegistryMcpTool,
  emitCompletedTurn,
  emitStartedTurn,
  discoverCodexBackendForTest,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type { Options as ClaudeOptions, Query as ClaudeQuery, SDKMessage as ClaudeMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AcpLiveToolUpdateResolver, acpToolUpdateNotifications } from "../acp/acp-live-notifications";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import * as gitExecutable from "../app-server/git-executable";
import * as gitHeadBranch from "../app-server/git-head-branch";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { buildPricingSpendByModel } from "@pwragent/shared/pricing-spend-by-model";
import { CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS } from "@pwragent/shared/subagent-visibility";
import type {
  AcpBackendId,
  AppServerBackendKind,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerThreadReplay,
  AppServerThreadSummary,
  CodexThreadEnvironmentRuntime,
  LinkedDirectorySummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopTaskMonitorModelChoice } from "@pwragent/shared/helper-models";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { TaskMonitorWakeStore } from "@pwragent/sqlite-storage/task-monitor-wake-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";

describe("DesktopBackendRegistry", () => {
  it.each([
    { name: "default on", global: undefined, override: undefined, active: true, claimed: true, expected: 1 },
    { name: "global off", global: false, override: undefined, active: true, claimed: true, expected: 0 },
    { name: "thread off", global: true, override: false, active: true, claimed: true, expected: 0 },
    { name: "thread on", global: false, override: true, active: true, claimed: true, expected: 1 },
    { name: "stale turn", global: true, override: undefined, active: false, claimed: true, expected: 0 },
    { name: "already claimed", global: true, override: undefined, active: true, claimed: false, expected: 0 },
    { name: "failed steer is not retried", global: true, override: undefined, active: true, claimed: true, expected: 1, fail: true },
    { name: "monitor child", global: true, override: undefined, active: true, claimed: true, expected: 0, monitor: true },
    { name: "varied PR reads", global: true, override: undefined, active: true, claimed: true, expected: 0, commands: [
      "gh pr view 2535 --repo owner/repo --json statusCheckRollup",
      "gh pr view 2535 --repo owner/repo --json body --jq .body",
      "gh pr view 2535 --repo owner/repo --json url,headRefOid,body",
    ] },
    { name: "repeated PR status query", global: true, override: undefined, active: true, claimed: true, expected: 1, commands: [
      "gh pr view 2535 --repo owner/repo --json statusCheckRollup",
    ] },
  ])("delivers a monitor job suggestion only to the eligible active turn: $name", async (scenario) => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer"] },
      ...(scenario.fail ? { steerTurnError: new Error("stale active turn") } : {}),
    });
    const overlayStore = createOverlayStoreMock({ executionMode: "full-access" });
    const claim = vi.fn(() => scenario.claimed);
    const getThreadOverlayState = vi.fn(async () => ({
      backend: "codex" as const, threadId: "thread-1", extraLinkedDirectories: [],
      executionMode: "full-access" as const,
      monitorJobSuggestionsEnabled: scenario.override,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: { ...overlayStore, getThreadOverlayState, claimMonitorJobSuggestion: claim },
      resolveToolOutputAlertPolicy: () => ({
        outputCapHitsEnabled: false, repeatedLargeOutputsEnabled: false,
        repeatedLargeOutputMinimumCalls: 5, repeatedLargeOutputMinimumPercent: 50,
        repeatedQueuedChecksEnabled: false,
        monitorJobSuggestionsEnabled: scenario.global,
      }),
    });
    try {
      const turn = await registry.startTurn({
        backend: "codex", threadId: "thread-1",
        input: [{ type: "text", text: "Wait for CI" }],
      });
      const steer = vi.spyOn(registry, "steerTurn");
      if (scenario.monitor) {
        (registryModules(registry).subAgentMonitorService as unknown as { completedTaskMonitorsByThread: Map<string, unknown> })
          .completedTaskMonitorsByThread.set("codex:thread-1", {});
      }
      if (!scenario.active) vi.spyOn(registry, "getActiveTurnForThread").mockReturnValue(undefined);
      const record = registryModules(registry).threadUsageLedger.recordToolInvocationAccounting.bind(registryModules(registry).threadUsageLedger);
      const now = vi.spyOn(Date, "now");
      for (let index = 0; index < 5; index++) {
        now.mockReturnValue(1_000_000 + index * 120_000);
        const command = scenario.commands
          ? scenario.commands[index % scenario.commands.length]!
          : "gh run view 123 --repo owner/repo --json status";
        await record({ backend: "codex", notification: { method: "item/completed", params: {
          threadId: "thread-1", turnId: turn.turnId,
          item: { id: `poll-${index}`, type: "commandExecution", command, status: "completed", aggregatedOutput: "queued" },
        } } } as AgentEvent);
      }
      now.mockRestore();
      await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(scenario.expected));
      if (scenario.expected) {
        expect(claim).toHaveBeenCalledTimes(1);
        expect(steer).toHaveBeenCalledWith(expect.objectContaining({
          threadId: "thread-1", expectedTurnId: turn.turnId,
          input: [{ type: "text", text: expect.stringContaining("create_monitor_delegation") }],
        }), { kind: "pwragent", systemReason: "monitor-job-suggestion" });
        await vi.waitFor(() => expect(codexClient.steerTurnCallCount).toBe(1));
      }
    } finally {
      vi.restoreAllMocks();
      await registry.close();
    }
  });

  it.each([
    { name: "repeated status checks", command: "gh run view 123 --json status", count: 3, expected: 1 },
    { name: "single run watch", command: "gh run watch 123 --exit-status", count: 1, expected: 1 },
    { name: "single PR watch", command: "gh pr checks 123 --watch", count: 1, expected: 1 },
    { name: "brief check", command: "gh pr checks 123", count: 1, expected: 0 },
    { name: "thread opt-out", command: "gh run watch 123", count: 1, expected: 0, disabled: true },
    { name: "already claimed", command: "gh run watch 123", count: 1, expected: 0, claimed: true },
    { name: "monitor child", command: "gh run watch 123", count: 1, expected: 0, monitor: true },
    { name: "finished turn", command: "gh run watch 123", count: 1, expected: 0, terminal: "turn/completed" },
    { name: "failed turn", command: "gh run watch 123", count: 1, expected: 0, terminal: "turn/failed" },
    { name: "cancelled turn", command: "gh run watch 123", count: 1, expected: 0, terminal: "turn/cancelled" },
    { name: "turn ends during response", command: "gh run watch 123", count: 1, expected: 0, duringResult: true },
  ])("delivers ACP monitor reminders only on an existing same-turn MCP response: $name", async (scenario) => {
    const backend = "acp:kimi" as const;
    const threadId = "kimi-session-1";
    const overlayStore = createOverlayStoreMock();
    const readOverlay = overlayStore.getThreadOverlayState.bind(overlayStore);
    vi.spyOn(overlayStore, "getThreadOverlayState").mockImplementation(async (params) => ({
      ...await readOverlay(params), backend, threadId, extraLinkedDirectories: [],
      monitorJobSuggestionsEnabled: !scenario.disabled,
    }));
    let claimed = scenario.claimed ?? false;
    const claim = vi.fn(() => {
      if (claimed) return false;
      claimed = true;
      return true;
    });
    Object.assign(overlayStore, { claimMonitorJobSuggestion: claim });
    const { registry, startPrompt, steerSession } = createKimiAcpRegistry({
      overlayStore,
      startPrompt: vi.fn((params) => ({ sessionId: params.sessionId, turnId: params.turnId! })),
    });
    const client = new McpClient({ name: "acp-monitor-fixture", version: "1.0.0" });
    try {
      await registry.startThread({ backend, cwd: "/repo", executionMode: "default" });
      const turn = await registry.startTurn({ backend, threadId, input: [{ type: "text", text: "Wait for CI" }] });
      expect(registry.getActiveTurnForThread({ backend, threadId })?.turnId).toBe(turn.turnId);
      const steer = vi.spyOn(registry, "steerTurn");
      if (scenario.monitor) {
        (registryModules(registry).subAgentMonitorService as unknown as { completedTaskMonitorsByThread: Map<string, unknown> })
          .completedTaskMonitorsByThread.set(`${backend}:${threadId}`, {
            backend, monitorThreadId: threadId, monitorTurnId: turn.turnId,
            monitorId: "finished-monitor", parentBackend: backend, parentThreadId: "parent-session",
            parentTurnId: "parent-turn", activeCommandCount: 0,
            createdAt: 1, lastActivityAt: 1, task: "Wait for CI",
            heartbeatIntervalSeconds: 30, pollIntervalSeconds: 30, startupTimeoutSeconds: 45,
            preferredModel: "fixture", preferredReasoningEffort: "low",
          });
      }
      const server = registry["agentToolMcpServer"]!;
      const registration = await server.registerClient({ backend, threadId });
      await client.connect(new StreamableHTTPClientTransport(new URL(registration.server.url), {
        requestInit: { headers: Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])) },
      }));
      const resolver = new AcpLiveToolUpdateResolver();
      const now = vi.spyOn(Date, "now");
      for (let index = 0; index < scenario.count; index++) {
        now.mockReturnValue(1_000_000 + index * 20_000);
        // Providers commonly finish with just an id and status. Preserve the
        // command from tool_call through the same ACP boundary as live sessions.
        for (const update of [
          { sessionUpdate: "tool_call", toolCallId: `poll-${index}`, kind: "execute", title: "Bash", rawInput: { command: scenario.command }, status: "in_progress" },
          { sessionUpdate: "tool_call_update", toolCallId: `poll-${index}`, status: "completed" },
        ]) {
          const resolved = resolver.resolve({ backendId: backend, threadId, turnId: turn.turnId, update })!;
          for (const notification of acpToolUpdateNotifications({ threadId, turnId: turn.turnId, update: resolved })) {
            await registry.publishLocalEvent({ backend, notification });
          }
        }
      }
      now.mockRestore();
      expect(claim).not.toHaveBeenCalled();
      if (scenario.terminal) {
        await registry.publishLocalEvent({ backend, notification: {
          method: scenario.terminal, params: {
            threadId, turnId: turn.turnId,
            turn: { id: turn.turnId, status: "failed", error: { message: "fixture failure" } },
          },
        } } as AgentEvent);
        // A later active turn must not inherit the old reminder.
        await emitStartedTurn(registry, backend, threadId, "turn-2");
      }
      let response;
      if (scenario.duringResult) {
        const overlay = await overlayStore.getThreadOverlayState({ backend, threadId });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const reading = new Promise<void>((resolve) => { entered = resolve; });
        vi.mocked(overlayStore.getThreadOverlayState).mockImplementationOnce(async () => {
          entered();
          await gate;
          return overlay;
        });
        const pendingResponse = client.callTool({ name: "read_tool_guide", arguments: {} });
        await reading;
        await emitCompletedTurn(registry, backend, threadId, turn.turnId);
        release();
        response = await pendingResponse;
        expect(claim).not.toHaveBeenCalled();
      } else {
        response = await client.callTool({ name: "read_tool_guide", arguments: {} });
      }
      const reminders = (response.content as Array<{ text?: string }>).filter((item) => item.text?.includes("Monitor Job Suggestion"));
      expect(reminders).toHaveLength(scenario.expected);
      if (!scenario.duringResult) {
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toHaveProperty("guide");
      }
      const repeated = await client.callTool({ name: "read_tool_guide", arguments: {} });
      expect(JSON.stringify(repeated)).not.toContain("Monitor Job Suggestion");
      expect(steer).not.toHaveBeenCalled();
      expect(steerSession).not.toHaveBeenCalled();
      expect(startPrompt).toHaveBeenCalledTimes(1);
      if (scenario.expected) expect(claim).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      await client.close();
      await emitCompletedTurn(registry, backend, threadId, registry.getActiveTurnForThread({ backend, threadId })?.turnId ?? "turn-1");
      await registry.close();
    }
  });

  it("does not emit an incident notification for managed sub-agent accounting", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    (registryModules(registry).subAgentMonitorService as unknown as {
      taskMonitorDelegations: Map<string, {
        backend: "codex";
        monitorThreadId: string;
        parentBackend: "codex";
        parentThreadId: string;
      }>;
    }).taskMonitorDelegations.set("monitor-1", {
      backend: "codex",
      monitorThreadId: "managed-child",
      parentBackend: "codex",
      parentThreadId: "parent-thread",
    });

    await registryModules(registry).threadUsageLedger.emitThreadToolAccountingUpdated({
      backend: "codex",
      threadId: "managed-child",
      triggeredAlerts: [{
        alertId: "large-output:codex:managed-child:child-turn",
        backend: "codex",
        createdAt: 1,
        estimatedOutputTokens: 2_000,
        firstObservedAt: 1,
        invocationCount: 1,
        kind: "large-output",
        lastObservedAt: 1,
        message: "The sub-agent returned too much output.",
        severity: "warning",
        suggestedPrompt: "Use a bounded command.",
        threadId: "managed-child",
        toolName: "commandExecution",
        totalOutputChars: 8_000,
        turnId: "child-turn",
        updatedAt: 1,
      }],
    });

    const accountingEvent = events.find(
      (event) => event.notification.method === "thread/toolAccounting/updated",
    );
    expect(accountingEvent).toEqual(expect.objectContaining({
      backend: "codex",
      notification: expect.objectContaining({
        method: "thread/toolAccounting/updated",
        params: expect.objectContaining({
          threadId: "managed-child",
          toolAccounting: expect.any(Object),
        }),
      }),
    }));
    expect(accountingEvent?.notification.params).not.toHaveProperty("triggeredAlerts");
    await registry.close();
  });

  it("runs explicit PwrAgent Sub Agent as one child turn and attributes usage to it", async () => {
    await mockArchiveWorktreePresence(["/repo/worktree"]);
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [
        {
          id: "gpt-5.5",
          label: "GPT-5.5",
          current: true,
          supportsFast: true,
          supportsReasoning: true,
        },
      ],
      readThreadErrorsByThreadId: {
        "managed-review-child": new Error(
          "ephemeral threads do not support includeTurns",
        ),
      },
      startThreadResult: { threadId: "managed-review-child" },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-parent": {
          backend: "codex",
          threadId: "thread-parent",
          executionMode: "full-access",
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "priority",
          fastMode: true,
          extraLinkedDirectories: [
            {
              id: "/repo/worktree",
              kind: "worktree",
              label: "worktree",
              path: "/repo",
              worktreePath: "/repo/worktree",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      resolveManagedReviewEnabled: () => true, // Legacy config no longer selects the engine.
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });

    const codexBackend = (await registry.listBackends({ includeUnavailable: true }))
      .backends.find((backend) => backend.kind === "codex");
    expect(codexBackend?.methods).not.toContain("review/start");
    expect(codexBackend?.capabilities.startReview).toBe(true);

    const response = await registry.startReview({
      runMode: "pwragent-sub-agent",
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-parent",
      reviewThreadId: "managed-review-child",
      turnId: "turn-1",
    });
    expect(codexClient.lastStartReviewParams).toBeUndefined();
    expect(codexClient.lastStartThreadParams).toMatchObject({
      approvalPolicy: "never",
      cwd: "/repo/worktree",
      ephemeral: true,
      fastMode: true,
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "danger-full-access",
      serviceTier: "priority",
      threadSource: "subagent",
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "managed-review-child",
      cwd: "/repo/worktree",
      fastMode: true,
      model: "gpt-5.5",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
    expect(codexClient.lastStartTurnParams?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("against base branch 'main'"),
    });

    const approvalResponse = codexClient.emitRequest({
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "managed-review-child",
        turnId: "turn-1",
        itemId: "review-command",
        requestId: "review-approval",
        command: "git diff main...HEAD",
      },
    } as AppServerPendingRequestNotification);
    await waitForCondition(() => events.some((event) =>
      event.notification.method === "item/commandExecution/requestApproval"
    ));
    expect(events.find((event) =>
      event.notification.method === "item/commandExecution/requestApproval"
    )).toMatchObject({
      backend: "codex",
      notification: {
        params: {
          threadId: "thread-parent",
          turnId: "turn-1",
          requestId: "review-approval",
        },
      },
    });
    await registry.submitServerRequest({
      backend: "codex",
      threadId: "thread-parent",
      turnId: "turn-1",
      requestId: "review-approval",
      response: { decision: "accept" },
    });
    await expect(approvalResponse).resolves.toEqual({ decision: "accept" });

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "managed-review-child",
        turnId: "turn-1",
        model: "gpt-5.5",
        tokenUsage: {
          total: {
            inputTokens: 1_000,
            cachedInputTokens: 250,
            outputTokens: 100,
            reasoningOutputTokens: 25,
            fastMode: true,
            serviceTier: "priority",
          },
        },
      },
    });
    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "managed-review-child",
        turnId: "turn-1",
        item: {
          id: "review-output",
          type: "agentMessage",
          text: JSON.stringify({
            findings: [],
            overall_correctness: "patch is correct",
            overall_explanation: "No blocking findings.",
            overall_confidence_score: 0.96,
          }),
        },
      },
    });
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "managed-review-child",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [],
        },
      },
    });

    const parentEvents = events.filter(
      (event) => "threadId" in event.notification.params
        && event.notification.params.threadId === "thread-parent",
    );
    expect(parentEvents.filter((event) =>
      isCompletedItemType(event, "enteredReviewMode")
    )).toHaveLength(1);
    expect(parentEvents.filter((event) =>
      isCompletedItemType(event, "exitedReviewMode")
    )).toHaveLength(1);
    expect(parentEvents.filter((event) =>
      event.notification.method === "turn/completed"
    )).toHaveLength(1);

    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents?.[0]).toMatchObject({
      monitorId: "review:turn-1",
      monitorThreadId: "managed-review-child",
      monitorTurnId: "turn-1",
      outcome: "success",
      status: "success",
    });
    expect(overlay?.managedReviewEntries).toEqual([
      expect.objectContaining({
        id: "managed-review:turn-1:started",
        displayText: "Review changes against main",
        turn: expect.objectContaining({
          id: "turn-1",
          status: "in_progress",
        }),
      }),
      expect.objectContaining({
        id: "managed-review:turn-1:result",
        output: expect.objectContaining({
          overall_correctness: "patch is correct",
          overall_explanation: "No blocking findings.",
        }),
        turn: expect.objectContaining({
          id: "turn-1",
          status: "completed",
        }),
      }),
    ]);
    expect(codexClient.readThreadCalls).not.toContainEqual(
      expect.objectContaining({ threadId: "managed-review-child" }),
    );
    const hydratedParent = await registry.readThread({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(hydratedParent.replay.entries.filter(
      (entry) => entry.type === "review",
    )).toEqual(overlay?.managedReviewEntries);
    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(pricing.lines[0]).toMatchObject({
      parentThreadId: "thread-parent",
      scope: "monitor",
      threadId: "managed-review-child",
      turnId: "turn-1",
    });

    await expect(registry.startTurn({
      backend: "codex",
      threadId: "thread-parent",
      input: [{ type: "text", text: "Continue after review" }],
    })).resolves.toMatchObject({ threadId: "thread-parent" });

    await registry.close();
  });

  it.each([0.007023, 0, undefined, -1, Number.NaN])(
    "retains Claude monitor provider costs (%s) across usage normalization", async (reportedCost) => {
      const overlayStore = createOverlayStoreMock();
      const registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({ initializeResult: { methods: ["thread/read"] } }),
        overlayStore,
      });
      const internals = registryModules(registry).subAgentMonitorService as unknown as {
        completedTaskMonitorsByThread: Map<string, Record<string, unknown>>;
        recordTaskMonitorUsage: (event: AgentEvent) => Promise<void>;
      };
      internals.completedTaskMonitorsByThread.set("claude:haiku-monitor", {
        backend: "claude", parentBackend: "claude", parentThreadId: "parent-thread",
        monitorId: "monitor-1", monitorThreadId: "haiku-monitor", monitorTurnId: "monitor-turn",
        createdAt: Date.now(), task: "Check the build", preferredModel: "claude-haiku-5-5",
      });
      try {
        await internals.recordTaskMonitorUsage({
          backend: "claude",
          notification: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "haiku-monitor", turnId: "monitor-turn", model: "claude-haiku-5-5",
              tokenUsage: {
                claudeCostUSD: reportedCost,
                last: { inputTokens: 121_054, cachedInputTokens: 120_220, outputTokens: 238, totalTokens: 121_292 },
              },
            },
          },
        });
        const pricing = await overlayStore.readThreadPricing({ backend: "claude", threadId: "parent-thread" });
        expect(pricing.lines).toHaveLength(1);
        const valid = reportedCost !== undefined && Number.isFinite(reportedCost) && reportedCost >= 0;
        expect(pricing.lines[0]).toMatchObject({
          scope: "monitor", model: "claude-haiku-5-5", provider: "anthropic",
          inputTokens: 121_054, cachedInputTokens: 120_220, outputTokens: 238,
          priceStatus: valid ? "priced" : "unpriced",
          totalCostMicros: valid ? Math.round(reportedCost! * 1_000_000) : 0,
          cachedInputCostMicros: 0, uncachedInputCostMicros: 0, outputCostMicros: 0,
        });
        expect(pricing.lines[0]?.pricingBasis).toBe(valid ? "provider-reported" : undefined);
        expect(pricing.lines[0]?.priceUnavailableReason).toBe(valid ? undefined : "insufficient-token-breakdown");
        expect(pricing.lines[0]?.pricingRateId).toBeUndefined();
        if (valid) {
          const card = await overlayStore.getThreadSubAgent({ backend: "claude", threadId: "parent-thread", monitorId: "monitor-1" });
          expect(card?.monitorUsage?.summary).toContain("provider estimate");
          expect(card?.monitorUsage?.cost).toMatchObject({ pricingBasis: "provider-reported", totalUsd: reportedCost });
        }
      } finally {
        internals.completedTaskMonitorsByThread.clear();
        await registry.close();
      }
    },
  );

  it("counts observed context replays on Codex native sub-agent usage lines", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const nativeThreadId = "019ebb70-2c58-7143-850e-0a699607c799";

    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "thread-parent",
        turnId: "turn-1",
        item: {
          id: "collab-spawn-1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: [nativeThreadId],
          prompt: "You are the correctness reviewer. Inspect the diff.",
          model: "gpt-5.4-mini",
          agentsStates: {
            [nativeThreadId]: {
              status: "running",
              message: "Inspecting the diff.",
            },
          },
        },
      },
    } as AppServerNotification);

    const usageEvents: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => { usageEvents.push(event); });

    // Two cache-served context replays on the agent's own thread.
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: nativeThreadId,
        turnId: "turn-native-1",
        model: "gpt-5.4-mini",
        tokenUsage: {
          total: { inputTokens: 65_000, cachedInputTokens: 60_000, outputTokens: 1_000 },
          last: { inputTokens: 65_000, cachedInputTokens: 60_000, outputTokens: 1_000 },
        },
      },
    });
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: nativeThreadId,
        turnId: "turn-native-1",
        model: "gpt-5.4-mini",
        tokenUsage: {
          total: { inputTokens: 131_000, cachedInputTokens: 124_000, outputTokens: 1_800 },
          last: { inputTokens: 66_000, cachedInputTokens: 64_000, outputTokens: 800 },
        },
      },
    });

    await expect
      .poll(async () => {
        const pricing = await overlayStore.readThreadPricing({
          backend: "codex",
          threadId: "thread-parent",
        });
        return pricing.lines[0];
      })
      .toMatchObject({
        scope: "monitor",
        threadId: nativeThreadId,
        turnId: "turn-native-1",
        observedColdReplayCount: 0,
        observedColdReplayUncachedTokens: 0,
        observedHotReplayCount: 2,
        observedHotReplayCachedTokens: 124_000,
      });

    const updates = usageEvents.filter((event) => event.notification.method === "thread/subAgents/updated");
    expect(updates).toHaveLength(2);
    expect(updates.every((event) => (event.notification.params as { navigationChanged?: false }).navigationChanged === false)).toBe(true);
    const budgetView = await registry.readThread({ backend: "codex", threadId: "thread-parent", includeTurns: false });
    expect(budgetView.pricing?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "monitor", threadId: nativeThreadId, inputTokens: 131_000, cachedInputTokens: 124_000, outputTokens: 1_800 }),
    ]));
    expect(codexClient.readThreadCalls.at(-1)).toMatchObject({ threadId: "thread-parent", includeTurns: false });
    unsubscribe();
    await registry.close();
  });

  it("tracks Codex subAgentActivity lifecycle without writing for interactions or duplicate events", async () => {
    const codexClient = new MockBackendClient({
      threads: [{
        id: "thread-parent",
        source: "codex",
        title: "Review audit",
        titleSource: "explicit",
        linkedDirectories: [],
      }],
    });
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgent = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    const emitActivity = async (kind: "started" | "interacted" | "completed" | "interrupted") => {
      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: "thread-parent", turnId: "turn-review",
          item: { type: "subAgentActivity", id: `activity-${kind}`, kind,
            agentThreadId: "worker-review", agentPath: "/root/review_savers" },
        },
      } as AppServerNotification);
    };
    try {
      await emitActivity("started");
      let overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-parent" });
      expect(overlay?.subAgents).toEqual([expect.objectContaining({
        monitorId: "codex-native:worker-review", monitorThreadId: "worker-review",
        monitorTurnId: "turn-review", agentName: "review_savers", status: "running",
      })]);
      const threads = await registry.listThreads({ backend: "codex" });
      expect(threads[0]?.codexNativeSubAgents).toEqual([expect.objectContaining({
        threadId: "worker-review", agentNickname: "review_savers", threadStatus: "active",
      })]);
      upsertSubAgent.mockClear();
      await emitActivity("started");
      await emitActivity("interacted");
      expect(upsertSubAgent).not.toHaveBeenCalled();
      await codexClient.emit({
        method: "item/completed", params: { threadId: "thread-parent", turnId: "turn-review",
          item: { type: "subAgentActivity", id: "activity-started", kind: "started",
            agentThreadId: "worker-review", agentPath: "/root/review_savers",
            model: "resolved-model", reasoningEffort: "high" },
        },
      } as AppServerNotification);
      overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-parent" });
      expect(overlay?.subAgents?.[0]).toMatchObject({ preferredModel: "resolved-model", preferredReasoningEffort: "high" });
      upsertSubAgent.mockClear();
      await emitActivity("completed");
      overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-parent" });
      expect(overlay?.subAgents?.[0]).toMatchObject({ status: "success", outcome: "success", preferredModel: "resolved-model", preferredReasoningEffort: "high" });
      upsertSubAgent.mockClear();
      await emitActivity("started");
      await emitActivity("completed");
      expect(upsertSubAgent).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  });

  it("publishes what a Codex worker is doing from its own steps, without recording them", async () => {
    const codexClient = new MockBackendClient({
      threads: [{ id: "thread-parent", source: "codex", title: "Inspect", titleSource: "explicit", linkedDirectories: [] }],
    });
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgent = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    const events: AgentEvent[] = [];
    const stopEvents = registry.onEvent((event) => { events.push(event); });
    const activity = () => events
      .filter((event) => event.notification.method === "thread/subAgentActivity/updated")
      .map((event) => event.notification.params);
    // The captured worker turn (codex-cli 0.169.0): spawned through a
    // subAgentActivity report, then its own commands under its thread id.
    const step = async (id: string, command: string, actions: Record<string, unknown>[]) => {
      await codexClient.emit({ method: "item/started", params: { threadId: "worker-inspect", turnId: "turn-worker",
        item: { type: "commandExecution", id, command, commandActions: actions, status: "inProgress" } } } as AppServerNotification);
    };
    try {
      await codexClient.emit({ method: "item/completed", params: { threadId: "thread-parent", turnId: "turn-parent",
        item: { type: "subAgentActivity", id: "activity-started", kind: "started",
          agentThreadId: "worker-inspect", agentPath: "/root/folder_inspector" } } } as AppServerNotification);
      upsertSubAgent.mockClear();
      await codexClient.emit({ method: "turn/started", params: { threadId: "worker-inspect", turn: { id: "turn-worker" } } } as AppServerNotification);
      await step("call-1", "/bin/zsh -lc 'ls -la'", [{ type: "listFiles", command: "ls -la", path: null }]);
      await step("call-2", "/bin/zsh -lc 'cat notes.txt'", [{ type: "read", command: "cat notes.txt", name: "notes.txt", path: "/work/notes.txt" }]);
      await vi.waitFor(() => expect(activity()).toEqual([
        { threadId: "thread-parent", activities: [{ monitorId: "codex-native:worker-inspect", activity: "Running ls -la" }] },
        { threadId: "thread-parent", activities: [{ monitorId: "codex-native:worker-inspect", activity: "Reading notes.txt" }] },
      ]));
      // A step is live only: no card write.
      expect(upsertSubAgent).not.toHaveBeenCalled();
      await codexClient.emit({ method: "turn/completed", params: { threadId: "worker-inspect", turn: { id: "turn-worker", status: "completed" } } } as AppServerNotification);
      await vi.waitFor(() => expect(activity().at(-1)).toEqual({
        threadId: "thread-parent", activities: [], cleared: ["codex-native:worker-inspect"],
      }));
    } finally {
      stopEvents();
      await registry.close();
    }
  });

  it("still delivers a Codex worker's own step when its activity line cannot be published", async () => {
    const codexClient = new MockBackendClient({
      threads: [{ id: "thread-parent", source: "codex", title: "Inspect", titleSource: "explicit", linkedDirectories: [] }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const internals = registry as unknown as { emit: (event: AgentEvent, ...rest: unknown[]) => Promise<void> };
    const emit = internals.emit.bind(registry);
    // The activity line is live only; losing it must not cost the step itself.
    internals.emit = async (event, ...rest) => {
      if (event.notification.method === "thread/subAgentActivity/updated") throw new Error("renderer gone");
      await emit(event, ...rest);
    };
    const events: AgentEvent[] = [];
    const stopEvents = registry.onEvent((event) => { events.push(event); });
    try {
      await codexClient.emit({ method: "item/completed", params: { threadId: "thread-parent", turnId: "turn-parent",
        item: { type: "subAgentActivity", id: "activity-started", kind: "started",
          agentThreadId: "worker-inspect", agentPath: "/root/folder_inspector" } } } as AppServerNotification);
      await codexClient.emit({ method: "item/started", params: { threadId: "worker-inspect", turnId: "turn-worker",
        item: { type: "commandExecution", id: "call-1", command: "/bin/zsh -lc 'ls -la'",
          commandActions: [{ type: "listFiles", command: "ls -la", path: null }], status: "inProgress" } } } as AppServerNotification);
      await vi.waitFor(() => expect(events.some((event) => event.notification.method === "item/started"
        && (event.notification.params as { threadId?: string }).threadId === "worker-inspect")).toBe(true));
    } finally {
      stopEvents();
      await registry.close();
    }
  });

  it("reads a path-based worker's model from Codex before pricing its usage", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const readThreadModelSettings = vi.fn(async () => ({
      model: "gpt-5.5", reasoningEffort: "high",
    }));
    Object.assign(codexClient, { readThreadModelSettings });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    const workerThreadId = "019ebb70-2c58-7143-850e-0a699607c7aa";
    const emitUsage = async (total: number) => {
      await codexClient.emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: workerThreadId,
          turnId: "turn-worker",
          tokenUsage: {
            total: { inputTokens: total, cachedInputTokens: 0, outputTokens: 50 },
            last: { inputTokens: total, cachedInputTokens: 0, outputTokens: 50 },
          },
        },
      } as AppServerNotification);
    };
    try {
      // subAgentActivity names the worker and nothing about how it runs.
      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: "thread-parent", turnId: "turn-parent",
          item: { type: "subAgentActivity", id: "activity-started", kind: "started",
            agentThreadId: workerThreadId, agentPath: "/root/breakfast_picker" },
        },
      } as AppServerNotification);
      await emitUsage(1_000);
      await emitUsage(2_000);

      expect(readThreadModelSettings).toHaveBeenCalledTimes(1);
      expect(readThreadModelSettings).toHaveBeenCalledWith({ threadId: workerThreadId });
      const pricing = await overlayStore.readThreadPricing({
        backend: "codex", threadId: "thread-parent",
      });
      expect(pricing.lines).toEqual([expect.objectContaining({
        scope: "monitor", threadId: workerThreadId,
        model: "gpt-5.5", reasoningEffort: "high", priceStatus: "priced",
      })]);
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex", threadId: "thread-parent",
      });
      expect(overlay?.subAgents?.[0]).toMatchObject({
        agentName: "breakfast_picker", preferredModel: "gpt-5.5", preferredReasoningEffort: "high",
      });
    } finally {
      await registry.close();
    }
  });

  it("keeps a worker's finish that lands while its model is being read", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    const workerThreadId = "019ebb70-2c58-7143-850e-0a699607c7ab";
    // The worker finishes during the model read; its card is written then.
    const readThreadModelSettings = vi.fn(async () => {
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex", threadId: "thread-parent",
      });
      const card = overlay?.subAgents?.[0];
      if (card) {
        await overlayStore.upsertThreadSubAgent({
          backend: "codex", threadId: "thread-parent",
          subAgent: { ...card, status: "success", outcome: "success", lastMessage: "Done." },
        });
      }
      return { model: "gpt-5.5" };
    });
    Object.assign(codexClient, { readThreadModelSettings });
    try {
      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: "thread-parent", turnId: "turn-parent",
          item: { type: "subAgentActivity", id: "activity-started", kind: "started",
            agentThreadId: workerThreadId, agentPath: "/root/breakfast_picker" },
        },
      } as AppServerNotification);
      await codexClient.emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: workerThreadId,
          turnId: "turn-worker",
          tokenUsage: {
            total: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 50 },
            last: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 50 },
          },
        },
      } as AppServerNotification);

      expect(readThreadModelSettings).toHaveBeenCalledTimes(1);
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex", threadId: "thread-parent",
      });
      expect(overlay?.subAgents?.[0]).toMatchObject({
        status: "success", outcome: "success", lastMessage: "Done.",
        preferredModel: "gpt-5.5", monitorUsage: expect.anything(),
      });
    } finally {
      await registry.close();
    }
  });

  it("fills Codex native sub-agent names from parent assistant output", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const nativeThreadId = "019ebb70-2c58-7143-850e-0a699607c755";

    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "thread-parent",
        turnId: "turn-1",
        item: {
          id: "collab-spawn-1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: [nativeThreadId],
          prompt: "Check the status of PR #783.",
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
          agentsStates: {
            [nativeThreadId]: {
              status: "running",
            },
          },
        },
      },
    } as AppServerNotification);
    let overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents?.[0]).toMatchObject({
      monitorTurnId: "turn-1",
    });
    expect(overlay?.subAgents?.[0]?.agentName).toBeUndefined();

    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "thread-parent",
        turnId: "turn-1",
        item: {
          id: "assistant-message-1",
          type: "agentMessage",
          text: "The child is running as Huygens for PR #783 using `gpt-5.4-mini` with low reasoning. I did not wait.",
        },
      },
    } as AppServerNotification);

    overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents?.[0]).toMatchObject({
      agentName: "Huygens",
      monitorTurnId: "turn-1",
      preferredModel: "gpt-5.4-mini",
      preferredReasoningEffort: "low",
    });

    await registry.close();
  });

  it("ignores Codex terminal notifications without turn output when parsing native sub-agent text", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      } as AppServerNotification),
    ).resolves.toBeUndefined();

    await registry.close();
  });

  it("completes no-wait Codex native sub-agents from async transcript notifications", async () => {
    vi.useFakeTimers();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const nativeThreadId = "019ed784-fd83-7c43-9c5a-cad810e5bee8";

    try {
      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: "thread-parent",
          turnId: "turn-1",
          item: {
            id: "collab-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            receiverThreadIds: [nativeThreadId],
            prompt: "Check the status of PR #783.",
            model: "gpt-5.4-mini",
            agentsStates: {
              [nativeThreadId]: {
                status: "running",
              },
            },
          },
        },
      } as AppServerNotification);

      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: "thread-parent",
          turnId: "turn-1",
          item: {
            id: "subagent-notification-1",
            type: "agentMessage",
            text:
              "<subagent_notification>\n" +
              JSON.stringify({
                agent_path: nativeThreadId,
                status: {
                  completed: "PR #783 checks are all green.",
                },
              }) +
              "\n</subagent_notification>",
          },
        },
      } as AppServerNotification);

      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-parent",
      });
      expect(overlay?.subAgents?.[0]).toMatchObject({
        completedAt: expect.any(Number),
        lastMessage: "PR #783 checks are all green.",
        outcome: "success",
        status: "success",
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(codexClient.readThreadCalls).toHaveLength(0);
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("ignores receiverless Codex native wait calls without warning", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    mainLoggerMock.warn.mockClear();

    for (const method of ["item/started", "item/completed"] as const) {
      await codexClient.emit({
        method,
        params: {
          threadId: "thread-parent",
          turnId: "turn-1",
          item: {
            id: "collab-wait-1",
            type: "collabAgentToolCall",
            tool: "wait",
            status: method === "item/started" ? "inProgress" : "completed",
            receiverThreadIds: [],
          },
        },
      } as AppServerNotification);
    }

    expect(
      mainLoggerMock.warn.mock.calls.some(
        ([message]) =>
          message === "codex native subagent call missing receiver thread ids",
      ),
    ).toBe(false);
    expect(
      (
        await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-parent",
        })
      )?.subAgents,
    ).toBeUndefined();

    await registry.close();
  });

  it("warns when a directed Codex native sub-agent call has no receiver", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    mainLoggerMock.warn.mockClear();

    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "thread-parent",
        turnId: "turn-1",
        item: {
          id: "collab-close-1",
          type: "collabAgentToolCall",
          tool: "closeAgent",
          status: "completed",
          receiverThreadIds: [],
        },
      },
    } as AppServerNotification);

    expect(mainLoggerMock.warn).toHaveBeenCalledWith(
      "codex native subagent call missing receiver thread ids",
      {
        itemId: "collab-close-1",
        method: "item/completed",
        threadId: "thread-parent",
        tool: "closeAgent",
      },
    );

    await registry.close();
  });

  it("updates Codex native sub-agent summaries from later wait calls", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const nativeThreadId = "019ebb70-2c58-7143-850e-0a699607c755";

    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "thread-parent",
        turnId: "turn-1",
        item: {
          id: "collab-spawn-1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: [nativeThreadId],
          receiverThreads: [
            {
              threadId: nativeThreadId,
              thread: {
                source: {
                  subAgent: {
                    thread_spawn: {
                      agent_nickname: "Poincare",
                    },
                  },
                },
              },
            },
          ],
          prompt: "You are the correctness reviewer. Inspect the diff.",
          model: "gpt-5.4-mini",
          agentsStates: {
            [nativeThreadId]: {
              status: "running",
            },
          },
        },
      },
    } as AppServerNotification);
    const createdAt = (
      await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-parent",
      })
    )?.subAgents?.[0]?.createdAt;

    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "thread-parent",
        turnId: "turn-1",
        item: {
          id: "collab-wait-1",
          type: "collabAgentToolCall",
          tool: "wait",
          status: "completed",
          receiverThreadIds: [nativeThreadId],
          agentsStates: {
            [nativeThreadId]: {
              status: "completed",
              message: "Review completed with no findings.",
            },
          },
        },
      },
    } as AppServerNotification);

    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents?.[0]).toMatchObject({
      monitorId: `codex-native:${nativeThreadId}`,
      createdAt,
      monitorThreadId: nativeThreadId,
      agentName: "Poincare",
      outcome: "success",
      status: "success",
      lastMessage: "Review completed with no findings.",
    });
    expect(overlay?.subAgents?.[0]?.completedAt).toEqual(expect.any(Number));

    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "thread-parent",
        turnId: "turn-1",
        item: {
          id: "collab-close-1",
          type: "collabAgentToolCall",
          tool: "closeAgent",
          status: "completed",
          receiverThreadIds: [nativeThreadId],
          agentsStates: {
            [nativeThreadId]: {
              status: "shutdown",
            },
          },
        },
      },
    } as AppServerNotification);
    const afterCloseOverlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(afterCloseOverlay?.subAgents?.[0]).toMatchObject({
      agentName: "Poincare",
      outcome: "success",
      status: "success",
      lastMessage: "Review completed with no findings.",
    });

    await registry.close();
  });

  it("reconciles no-wait Codex native sub-agents from child thread status", async () => {
    vi.useFakeTimers();
    const nativeThreadId = "019ebb70-2c58-7143-850e-0a699607c755";
    const replay = (
      threadStatus: AppServerThreadReplay["threadStatus"],
      lastAssistantMessage?: string,
      agentName?: string,
    ): AppServerThreadReplay => ({
      entries: [],
      messages: lastAssistantMessage
        ? [
            {
              id: "assistant-final",
              role: "assistant",
              text: lastAssistantMessage,
            },
          ]
        : [],
      ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      ...(threadStatus ? { threadStatus } : {}),
      ...(agentName ? { agentName } : {}),
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "turn/start"] },
      readThreadReplays: [
        replay("active", undefined, "Huygens"),
        replay("idle"),
        replay("idle", "PR #783 checks are passing."),
      ],
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    try {
      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: "thread-parent",
          turnId: "turn-1",
          item: {
            id: "collab-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            receiverThreadIds: [nativeThreadId],
            prompt: "Check the status of PR #783.",
            model: "gpt-5.4-mini",
            agentsStates: {
              [nativeThreadId]: {
                status: "running",
              },
            },
          },
        },
      } as AppServerNotification);

      expect(codexClient.readThreadCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(codexClient.readThreadCalls).toEqual([
        {
          threadId: nativeThreadId,
          includeTurns: false,
          limit: 0,
        },
      ]);

      let overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-parent",
      });
      expect(overlay?.subAgents?.[0]).toMatchObject({
        agentName: "Huygens",
        status: "running",
      });
      // The card's status already says it was spawned; no narration.
      expect(overlay?.subAgents?.[0]?.lastMessage).toBeUndefined();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(codexClient.readThreadCalls).toEqual([
        {
          threadId: nativeThreadId,
          includeTurns: false,
          limit: 0,
        },
        {
          threadId: nativeThreadId,
          includeTurns: false,
          limit: 0,
        },
        {
          threadId: nativeThreadId,
          includeTurns: true,
          limit: 12,
        },
      ]);

      overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-parent",
      });
      expect(overlay?.subAgents?.[0]).toMatchObject({
        outcome: "success",
        status: "success",
        lastMessage: "PR #783 checks are passing.",
        completedAt: expect.any(Number),
      });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("shows queued-message titles on one Sub-agents row and charges them to the thread", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-queued-message-titles-");
    const db = StateDb.open(temp.dbPath);
    const overlayStore = new SqliteOverlayStore(db);
    onTestFinished(() => {
      db.close();
      removeTempStateDbDir(temp.tempDir);
      vi.unstubAllEnvs();
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "recipient", title: "recipient", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const helperTurns: Array<{ prompt: string; resolve: (title: string) => void }> = [];
    (
      codexClient as unknown as {
        generateStructuredObject: (request: { prompt: string }) => Promise<unknown>;
      }
    ).generateStructuredObject = (request) => new Promise((resolve) => {
      const run = helperTurns.length + 1;
      helperTurns.push({ prompt: request.prompt, resolve: (title) => resolve({
        status: "ok",
        object: { title },
        helperThreadId: `queued-title-helper-${run}`,
        helperTurnId: `queued-title-turn-${run}`,
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        tokenUsage: { inputTokens: 100 * run, cachedInputTokens: 20, outputTokens: 10, totalTokens: 100 * run + 10 },
      }) });
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore, threadTitleGenerationService: null, queuedMessageTitleSettleMs: 0 });
    onTestFinished(() => registry.close());
    await discoverCodexBackendForTest(registry);
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "recipient", turnId: "active", turn: { id: "active" } },
    } });
    const firstText = "Docs child: the migration guide now covers the renamed config keys and the new default port.";
    const secondText = "Tests child: the flaky upload spec now waits for the server ack before it asserts the row.";
    await registry.submitTurn({ backend: "codex", threadId: "recipient", queueEntryId: "first", input: [{ type: "text", text: firstText }] });
    await registry.submitTurn({ backend: "codex", threadId: "recipient", queueEntryId: "second", input: [{ type: "text", text: secondText }] });
    await waitForCondition(() => helperTurns.length === 1);
    const monitorId = "system:queued-message-titles:codex:recipient";
    const readRow = async () =>
      (await overlayStore.listThreadSubAgents({ backend: "codex", threadId: "recipient" }))
        .filter((subAgent) => subAgent.monitorId.startsWith("system:queued-message-titles:"));

    // Three runs: one lands, one is outgrown by an edit, one lands the edit.
    const { writes } = await measureSqliteWrites(async () => {
      helperTurns[0]!.resolve("Migration guide covers renamed keys");
      await waitForCondition(() => helperTurns.length === 2);
      registry.updateQueuedTurnInput("second", [{ type: "text", text: `${secondText}\nAlso retried the export spec.` }]);
      helperTurns[1]!.resolve("Upload spec waits for ack");
      await waitForCondition(() => helperTurns.length === 3);
      helperTurns[2]!.resolve("Upload and export specs fixed");
      await registry.queuedMessageTitlesIdle();
    });
    expectSqliteWriteBudget({ scenario: "queued-message-title-helper-row", writes,
      note: "Three queued-message title runs, two commits each: the thread's one Sub-agents row (~19 KB) plus the run's usage line (~65 KB); no running state, no idle writes. ~85 KB/title: ~4 MB/day at 50 long queued messages, ~17 MB/day at 200" });

    expect(await readRow()).toEqual([expect.objectContaining({
      monitorId,
      task: "Name queued messages",
      status: "success",
      outcome: "success",
      backend: "codex",
      agentName: "PwrAgent",
      preferredModel: "gpt-5.6-luna",
      preferredReasoningEffort: "low",
      monitorThreadId: "queued-title-helper-3",
      monitorTurnId: "queued-title-turn-3",
      lastMessage: "Named 2 queued messages. Latest: Upload and export specs fixed",
      monitorUsage: expect.objectContaining({
        model: "gpt-5.6-luna",
        tokenUsage: expect.objectContaining({
          inputTokens: 600,
          cachedInputTokens: 60,
          uncachedInputTokens: 540,
          outputTokens: 30,
          totalTokens: 630,
        }),
      }),
    })]);
    const pricing = await overlayStore.readThreadPricing({ backend: "codex", threadId: "recipient" });
    expect(pricing.lines.map((line) => [line.sourceItemId, line.scope, line.parentThreadId, line.threadId, line.inputTokens]))
      .toEqual(expect.arrayContaining([
        [monitorId, "monitor", "recipient", "queued-title-helper-1", 100],
        [monitorId, "monitor", "recipient", "queued-title-helper-2", 200],
        [monitorId, "monitor", "recipient", "queued-title-helper-3", 300],
      ]));
    expect(pricing.lines).toHaveLength(3);
    expect(pricing.lines.every((line) => line.priceStatus === "priced")).toBe(true);
    // The Pricing rail counts helpers, not runs: three runs are one system helper.
    expect(buildPricingSpendByModel({ lines: pricing.lines }).flatMap((provider) => provider.models))
      .toEqual([expect.objectContaining({ model: "gpt-5.6-luna", systemHelperCount: 1, subAgentCount: 0 })]);
    expect(events.filter((event) => event.notification.method === "thread/subAgents/updated"))
      .toHaveLength(3);
    expect(events.some((event) =>
      event.notification.method === "thread/subAgents/updated"
      && event.notification.params.threadId === "recipient")).toBe(true);
  });
  it("reconstructs repeated legacy monitor handoffs one-to-one", async () => {
    const task = "Monitor GitHub CI for PR #1107 until all checks finish.";
    const summary = "All required checks passed.";
    const text = [
      "A lightweight PwrAgent monitor subagent finished a long-running task.",
      "",
      `Task: ${task}`,
      "Outcome: success",
      `Summary: ${summary}`,
      "",
      "Process this final monitor result.",
    ].join("\n");
    const replay: AppServerThreadReplay = {
      entries: [
        {
          type: "message",
          id: "legacy-monitor-handoff-1",
          role: "user",
          text,
          createdAt: 2_100,
        },
        {
          type: "message",
          id: "legacy-monitor-handoff-2",
          role: "user",
          text,
          createdAt: 4_100,
        },
      ],
      messages: [
        {
          id: "legacy-monitor-handoff-1",
          role: "user",
          text,
          createdAt: 2_100,
        },
        {
          id: "legacy-monitor-handoff-2",
          role: "user",
          text,
          createdAt: 4_100,
        },
      ],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          subAgents: [
            {
              monitorId: "monitor-2",
              monitorThreadId: "monitor-thread-2",
              task,
              status: "success",
              outcome: "success",
              lastMessage: summary,
              createdAt: 3_000,
              updatedAt: 4_000,
              completedAt: 4_000,
              backend: "codex",
            },
            {
              monitorId: "monitor-1",
              monitorThreadId: "monitor-thread-1",
              task,
              status: "success",
              outcome: "success",
              lastMessage: summary,
              createdAt: 1_000,
              updatedAt: 2_000,
              completedAt: 2_000,
              backend: "codex",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ replay }),
      overlayStore,
      threadTitleGenerationService: null,
    });

    const response = await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response.replay.entries[0]).toMatchObject({
      id: "legacy-monitor-handoff-1",
      origin: {
        kind: "sub-agent",
        sourceThread: {
          backend: "codex",
          threadId: "monitor-thread-1",
          title: task,
        },
        subAgent: {
          kind: "monitor",
          monitorId: "monitor-1",
          outcome: "success",
          summary,
          task,
        },
      },
    });
    expect(response.replay.messages[0]).toMatchObject({
      id: "legacy-monitor-handoff-1",
      origin: {
        kind: "sub-agent",
        subAgent: { monitorId: "monitor-1" },
      },
    });
    expect(response.replay.entries[1]).toMatchObject({
      id: "legacy-monitor-handoff-2",
      origin: {
        kind: "sub-agent",
        sourceThread: {
          backend: "codex",
          threadId: "monitor-thread-2",
          title: task,
        },
        subAgent: {
          kind: "monitor",
          monitorId: "monitor-2",
          outcome: "success",
          summary,
          task,
        },
      },
    });
    expect(response.replay.messages[1]).toMatchObject({
      id: "legacy-monitor-handoff-2",
      origin: {
        kind: "sub-agent",
        subAgent: { monitorId: "monitor-2" },
      },
    });

    await registry.close();
  });

  it("tracks managed task monitor turns as in-progress quit work", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
      threads: [
        {
          id: "parent-thread",
          title: "Deploy recoverable M2 Max runner",
          titleSource: "explicit",
          threadStatus: "idle",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    await registry.listThreads({ backend: "codex" });
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

    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        callId: "call-monitor",
        requestId: "call-monitor",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch PR checks until they finish.",
        },
      },
    } as AppServerPendingRequestNotification);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          turn: {
            id: "parent-turn",
            status: "completed",
            output: [],
          },
        },
      },
    });

    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 1,
      threadIds: ["codex:parent-thread"],
      subAgentThreadKeys: ["codex:parent-thread"],
      threadTitles: {
        "codex:parent-thread": "Deploy recoverable M2 Max runner",
      },
    });
    const navigationParent = {
      id: "parent-thread", source: "codex" as const, title: "Parent", titleSource: "explicit" as const,
      threadStatus: "idle" as const, linkedDirectories: [], inbox: { inInbox: false },
    };
    expect(registry.withNavigationSubAgentActivity([navigationParent])[0]).toMatchObject({
      threadStatus: "idle", hasActiveSubAgent: true,
    });


    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "monitor-thread",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    });
    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 0,
      threadIds: [],
    });

    expect(registry.withNavigationSubAgentActivity([navigationParent])[0]).toMatchObject({
      threadStatus: "idle", hasActiveSubAgent: false,
    });

    await registry.close();
  });

  it("marks idle Claude threads with running background tasks as working in navigation", () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const claude = (registry as unknown as {
      claudeBackend: { backgroundTaskThreadIds: () => string[] };
    }).claudeBackend;
    const backgroundTaskThreadIds = vi.spyOn(claude, "backgroundTaskThreadIds").mockReturnValue(["claude-thread"]);
    const row = (id: string, source: "claude" | "codex") => ({
      id, source, title: id, titleSource: "explicit" as const,
      threadStatus: "idle" as const, linkedDirectories: [], inbox: { inInbox: false },
    });

    const [claudeRow, codexRow] = registry.withNavigationSubAgentActivity([
      row("claude-thread", "claude"),
      // The same id under another backend is a different thread.
      row("claude-thread", "codex"),
    ]);
    // Only the navigation marker changes: the turn itself stays idle, so the
    // composer sends rather than queues.
    expect(claudeRow).toMatchObject({ threadStatus: "idle", hasBackgroundTasks: true });
    expect(codexRow).not.toHaveProperty("hasBackgroundTasks");

    backgroundTaskThreadIds.mockReturnValue([]);
    const [settled] = registry.withNavigationSubAgentActivity([claudeRow!]);
    expect(settled).not.toHaveProperty("hasBackgroundTasks");
    expect(settled).toMatchObject({ threadStatus: "idle", hasActiveSubAgent: false });
  });

  it("rejects task monitor delegations that only reference a parent Codex exec session", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
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
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Monitor exec session 89902 until ./scripts/verify-example-button-swift.sh exits.",
          monitorContext:
            "Poll write_stdin with session_id: 89902 and collect stdout/stderr.",
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
                "Task monitor delegations cannot use a parent-scoped write_stdin session_id as the local-command polling handle. Keep polling that already-started Codex exec session in the parent turn, or create a fresh monitor delegation with the command text, cwd, terminal criteria, and desired stdout/stderr capture-file paths so the monitor child starts the command in its own session.",
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(codexClient.lastStartThreadParams).toBeUndefined();
    expect(codexClient.startTurnCallCount).toBe(0);

    await registry.close();
  });

  it("allows external numeric session ids in task monitor delegations", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
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
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Poll the external build service until session_id: 89902 finishes.",
          monitorContext:
            "Call ./scripts/check-build-status --session_id=89902 and stop when the service reports success or failure.",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    expect(codexClient.lastStartThreadParams).toMatchObject({
      ephemeral: true,
      model: "gpt-5.6-luna",
    });
    expect(codexClient.lastStartThreadParams?.threadSource).toBe("subagent");
    expect(codexClient.startTurnCallCount).toBe(1);

    await registry.close();
  });

  it("inherits Codex environment runtime and Full Access for managed task monitors", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
    });
    const codexEnvironmentRuntime: CodexThreadEnvironmentRuntime = {
      environmentId: "env",
      environmentName: "Env",
      executionTarget: "local",
      shellEnvironment: {
        GH_TOKEN: "test-gh-token",
        PATH: "/repo/app/.bin:/usr/bin",
      },
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-env": {
            backend: "codex",
            threadId: "thread-env",
            executionMode: "full-access",
            codexEnvironmentRuntime,
            extraLinkedDirectories: [
              {
                id: "/repo/app",
                kind: "local",
                label: "app",
                path: "/repo/app",
              },
            ],
          },
        },
      }),
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-env",
          turnId: "turn-env",
          turn: { id: "turn-env" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-env",
        turnId: "turn-env",
        callId: "call-env",
        requestId: "call-env",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch PR #123 checks until they finish.",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    expect(codexClient.lastStartThreadParams).toMatchObject({
      approvalPolicy: "never",
      codexEnvironmentRuntime,
      cwd: "/repo/app",
      ephemeral: true,
      sandbox: "danger-full-access",
    });
    expect(codexClient.lastStartThreadParams?.threadSource).toBe("subagent");
    expect(codexClient.lastStartTurnParams).toMatchObject({
      approvalPolicy: "never",
      codexEnvironmentRuntime,
      cwd: "/repo/app",
      sandbox: "danger-full-access",
      threadId: "monitor-thread",
    });

    await registry.close();
  });

  it.each([
    { available: [], requested: "gpt-5", expected: "gpt-5.4-mini" },
    { available: ["gpt-5.6-luna"], requested: undefined, expected: "gpt-5.6-luna" },
    { available: ["gpt-5.6-luna", "gpt-6-luna"], requested: undefined, expected: "gpt-6-luna" },
    { available: ["gpt-5.6-luna", "gpt-6-luna"], requested: "gpt-5.6-luna", expected: "gpt-5.6-luna" },
  ])("selects an available monitor model: $expected (requested $requested)", async ({
    available, requested, expected,
  }) => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: [
        ...available.map((id) => ({ id, label: id, supportsReasoning: true })),
        { id: "gpt-5.5", label: "GPT-5.5", supportsReasoning: true },
        { id: "gpt-5.4-mini", label: "GPT-5.4-Mini", supportsReasoning: true },
      ],
      startThreadResult: { threadId: "monitor-thread" },
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
          threadId: "thread-model",
          turnId: "turn-model",
          turn: { id: "turn-model" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-model",
        turnId: "turn-model",
        callId: "call-model",
        requestId: "call-model",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch PR checks until they finish.",
          preferredModel: requested,
          preferredReasoningEffort: "low",
        },
      },
    } as AppServerPendingRequestNotification);
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]?.text ?? "{}",
    ) as Record<string, unknown>;

    expect(response).toMatchObject({ success: true });
    expect(payload.preferredModel).toBe(expected);
    expect(payload.preferredReasoningEffort).toBe("low");
    expect(codexClient.lastStartThreadParams).toMatchObject({
      model: expected,
      reasoningEffort: "low",
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      model: expected,
      reasoningEffort: "low",
    });

    await registry.close();
  });

  // A parent on GPT-6-Astra xhigh once passed its own model and effort to
  // every monitor it created, and each ran for minutes at the parent's price.
  // An agent may steer a monitor only toward a cheaper setting.
  it.each([
    {
      requested: "gpt-5.5",
      requestedEffort: "xhigh",
      expected: "gpt-6-luna",
      expectedEffort: "medium",
    },
    {
      requested: "gpt-5.5",
      requestedEffort: "low",
      expected: "gpt-6-luna",
      expectedEffort: "low",
    },
    {
      requested: "gpt-6-luna",
      requestedEffort: "xhigh",
      expected: "gpt-6-luna",
      expectedEffort: "medium",
    },
    {
      requested: "gemini-3-pro",
      requestedEffort: "low",
      expected: "gpt-6-luna",
      expectedEffort: "low",
    },
    {
      requested: "gpt-5.4-mini",
      requestedEffort: "high",
      expected: "gpt-5.4-mini",
      expectedEffort: "medium",
    },
    {
      requested: "gpt-6-luna",
      requestedEffort: "max",
      expected: "gpt-6-luna",
      expectedEffort: "medium",
    },
    {
      requested: "gpt-5.4-mini",
      requestedEffort: "low",
      expected: "gpt-5.4-mini",
      expectedEffort: "low",
    },
  ])("does not let an agent run a monitor on $requested $requestedEffort", async ({
    requested, requestedEffort, expected, expectedEffort,
  }) => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: [
        // GPT-6 catalogs offer `max`, so the cap must refuse it by name.
        {
          id: "gpt-6-luna",
          label: "GPT-6-Luna",
          supportsReasoning: true,
          reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
        { id: "gpt-5.5", label: "GPT-5.5", supportsReasoning: true },
        { id: "gpt-5.4-mini", label: "GPT-5.4-Mini", supportsReasoning: true },
        { id: "gemini-3-pro", label: "Gemini 3 Pro", supportsReasoning: true },
      ],
      startThreadResult: { threadId: "monitor-thread" },
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
          threadId: "thread-model",
          turnId: "turn-model",
          turn: { id: "turn-model" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-model",
        turnId: "turn-model",
        callId: "call-model",
        requestId: "call-model",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch PR checks until they finish.",
          preferredModel: requested,
          preferredReasoningEffort: requestedEffort,
        },
      },
    } as AppServerPendingRequestNotification);
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]?.text ?? "{}",
    ) as Record<string, unknown>;

    expect(response).toMatchObject({ success: true });
    expect(payload.preferredModel).toBe(expected);
    expect(payload.preferredReasoningEffort).toBe(expectedEffort);
    expect(codexClient.lastStartTurnParams).toMatchObject({
      model: expected,
      reasoningEffort: expectedEffort,
    });

    await registry.close();
  });

  it("still runs a monitor on the operator's own Task monitors model", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: [
        { id: "gpt-6-luna", label: "GPT-6-Luna", supportsReasoning: true },
        { id: "gpt-5.5", label: "GPT-5.5", supportsReasoning: true },
      ],
      startThreadResult: { threadId: "monitor-thread" },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      resolveHelperModelSettings: () => ({
        helpers: {
          task_monitors: { model: "gpt-5.5", reasoningEffort: "high" },
        },
      }),
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-model",
          turnId: "turn-model",
          turn: { id: "turn-model" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-model",
        turnId: "turn-model",
        callId: "call-model",
        requestId: "call-model",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch PR checks until they finish.",
          preferredModel: "gpt-5.5",
          preferredReasoningEffort: "xhigh",
        },
      },
    } as AppServerPendingRequestNotification);
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]?.text ?? "{}",
    ) as Record<string, unknown>;

    expect(payload.preferredModel).toBe("gpt-5.5");
    expect(payload.preferredReasoningEffort).toBe("high");

    await registry.close();
  });

  describe("a Claude parent's monitor", () => {
    const parentThreadId = "c2222222-2222-4222-8222-222222222222";

    async function createClaudeMonitorRegistry(params: {
      taskMonitorModels?: Record<string, DesktopTaskMonitorModelChoice>;
      /** Holds every query after the first until it settles. */
      laterQueriesHeld?: Promise<void>;
      /** Replaces each query's messages, for a monitor that runs tasks. */
      script?: (options: ClaudeOptions) => AsyncGenerator<ClaudeMessage>;
    }) {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-monitor-"));
      const store = new ClaudeSessionStore(path.join(root, "sessions"));
      await store.save({ cwd: root, thread: {
        id: parentThreadId, source: "claude", title: "Claude parent", titleSource: "explicit",
        linkedDirectories: [{ id: root, kind: "local", label: "repo", path: root }],
      } });
      const prompts: ClaudeOptions[] = [];
      const queries: { close: ReturnType<typeof vi.fn> }[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start"] },
        models: TEST_TASK_MONITOR_MODELS,
        startThreadResult: { threadId: "codex-monitor-thread" },
      });
      const claimedTurns = new Set<string>();
      const overlayStore = {
        ...createOverlayStoreMock(),
        claimMonitorJobSuggestion: ({ turnId }: { turnId: string }) => {
          if (claimedTurns.has(turnId)) return false;
          claimedTurns.add(turnId);
          return true;
        },
      };
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
        agentToolMcpServer: null,
        pdfToolMcpServer: null,
        resolveTaskMonitorModels: () => params.taskMonitorModels ?? {},
        claudeBackendOptions: {
          store,
          inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
          discoverModels: async () => [
            { id: "sonnet", label: "Sonnet", current: true },
            { id: "haiku", label: "Haiku" },
          ],
          query: ({ options = {} }) => {
            prompts.push(options);
            async function* messages(): AsyncGenerator<ClaudeMessage> {
              yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume } as ClaudeMessage;
              // The monitor stays busy until the test has completed it.
              await (prompts.length > 1 && params.laterQueriesHeld ? params.laterQueriesHeld : held);
              yield { type: "result", subtype: "success", is_error: false, result: "Done" } as ClaudeMessage;
            }
            let endStream!: () => void;
            const closed = new Promise<undefined>((resolve) => { endStream = () => resolve(undefined); });
            const query = { close: vi.fn(endStream), setPermissionMode: vi.fn() };
            queries.push(query);
            // Closing a real query ends its process, and with it the stream.
            async function* scripted(source: AsyncGenerator<ClaudeMessage>): AsyncGenerator<ClaudeMessage> {
              for (;;) {
                const step = await Promise.race([source.next(), closed]);
                if (!step || step.done) return;
                yield step.value;
              }
            }
            const stream = params.script ? scripted(params.script(options)) : messages();
            return Object.assign(stream, query) as unknown as ClaudeQuery;
          },
        },
      });
      await registry.publishLocalEvent({
        backend: "claude",
        notification: {
          method: "turn/started",
          params: { threadId: parentThreadId, turnId: "parent-turn", turn: { id: "parent-turn" } },
        },
      });
      const close = async () => {
        release();
        await registry.publishLocalEvent({
          backend: "claude",
          notification: {
            method: "turn/completed",
            params: {
              threadId: parentThreadId,
              turnId: "parent-turn",
              turn: { id: "parent-turn", status: "completed", output: [] },
            },
          },
        });
        await registry.close();
        await rm(root, { recursive: true, force: true });
      };
      return { close, codexClient, overlayStore, prompts, queries, registry, release, root, store };
    }

    it("runs on Claude's lightweight model in an ephemeral thread, and can complete", async () => {
      const { close, codexClient, prompts, registry, root } = await createClaudeMonitorRegistry({});
      try {
        const response = await callRegistryMcpTool({
          registry,
          backend: "claude",
          threadId: parentThreadId,
          turnId: "parent-turn",
          tool: "create_monitor_delegation",
          args: { task: "Watch PR #8 checks until they finish." },
        });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({
          parentThreadId,
          preferredModel: "haiku",
          preferredReasoningEffort: "provider-default",
        });
        const monitorId = String(response.structuredContent?.monitorId);
        const monitorThreadId = String(response.structuredContent?.monitorThreadId);
        expect(codexClient.lastStartThreadParams).toBeUndefined();
        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        expect(prompts[0]!.model).toBe("haiku");
        // Like a Codex ephemeral monitor, it leaves no session behind.
        expect(prompts[0]!.persistSession).toBe(false);
        expect(prompts[0]!.enableFileCheckpointing).toBe(false);
        await expect(readFile(path.join(root, "sessions", `${monitorThreadId}.json`), "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
        const threads = await registry.listThreads({ backend: "claude", forceRefresh: true });
        expect(threads.map((thread) => thread.id)).toContain(parentThreadId);
        expect(threads.map((thread) => thread.id)).not.toContain(monitorThreadId);

        const completed = await callRegistryMcpTool({
          registry,
          backend: "claude",
          threadId: monitorThreadId,
          turnId: String(response.structuredContent?.monitorTurnId),
          tool: "complete_monitoring",
          args: { monitorId, outcome: "success", summary: "All checks passed.", triggerParentTurn: false },
        });
        expect(completed.isError).not.toBe(true);
        expect(completed.structuredContent).toMatchObject({ monitorId });
      } finally {
        await close();
      }
    });

    it("keeps the monitor thread for a recovery turn after its process exits", async () => {
      let releaseRecovery!: () => void;
      const laterQueriesHeld = new Promise<void>((resolve) => { releaseRecovery = resolve; });
      const { close, prompts, registry, release, store } = await createClaudeMonitorRegistry({ laterQueriesHeld });
      try {
        const response = await callRegistryMcpTool({
          registry,
          backend: "claude",
          threadId: parentThreadId,
          turnId: "parent-turn",
          tool: "create_monitor_delegation",
          args: { task: "Watch PR #8 checks until they finish." },
        });
        expect(response.isError).not.toBe(true);
        const monitorThreadId = String(response.structuredContent?.monitorThreadId);
        await vi.waitFor(() => expect(prompts).toHaveLength(1));

        // The first turn ends without complete_monitoring, and its process
        // exits with it. The recovery turn must still find the thread.
        release();
        await vi.waitFor(() => expect(prompts.length).toBeGreaterThanOrEqual(2));
        expect(prompts[1]!.model).toBe("haiku");
        expect(prompts[1]!.persistSession).toBe(false);
        // Mid-recovery, after the first process exited, the thread is held.
        await vi.waitFor(() => expect(registry.readThread({ backend: "claude", threadId: monitorThreadId }))
          .resolves.toHaveProperty("replay"));
        // The recovery turn ends too, so the delegation finishes and the
        // thread is released.
        releaseRecovery();
        await vi.waitFor(async () => {
          await expect(store.read(monitorThreadId)).rejects.toBeDefined();
        });
      } finally {
        releaseRecovery();
        await close();
      }
    });

    // Claude Code blocks a long foreground sleep, so a Claude monitor waits in
    // a Monitor watcher and ends its native turn; the watcher's notification
    // starts its next one. These are the messages the CLI sends for that.
    const watcherStarted = [
      { type: "system", subtype: "background_tasks_changed",
        tasks: [{ task_id: "watch-1", task_type: "local_bash", description: "Watch PR #8 checks" }] },
      { type: "system", subtype: "task_started", task_id: "watch-1", tool_use_id: "toolu-watch",
        task_type: "local_bash", description: "Watch PR #8 checks", is_backgrounded: true },
    ] as ClaudeMessage[];
    const watcherEnded = [
      { type: "system", subtype: "task_notification", task_id: "watch-1", tool_use_id: "toolu-watch",
        status: "completed", output_file: "", summary: "PR #8 checks: pass" },
      { type: "system", subtype: "background_tasks_changed", tasks: [] },
    ] as ClaudeMessage[];
    const nativeResult = {
      type: "result", subtype: "success", is_error: false, result: "Watching.", num_turns: 8, stop_reason: "end_turn",
    } as ClaudeMessage;
    const monitorRecord = (registry: DesktopBackendRegistry, monitorId: string) =>
      registryModules(registry).subAgentMonitorService.taskMonitorDelegationRecords.get(monitorId);
    const userMessageCount = async (registry: DesktopBackendRegistry, threadId: string) =>
      (await registry.readThread({ backend: "claude", threadId })).replay.messages
        .filter((message) => message.role === "user").length;

    it("waits for its background watcher instead of starting a recovery turn", async () => {
      let endWatcher!: () => void;
      const watcherRunning = new Promise<void>((resolve) => { endWatcher = resolve; });
      let endFollowUp!: () => void;
      const followUpRunning = new Promise<void>((resolve) => { endFollowUp = resolve; });
      const { close, prompts, registry, store } = await createClaudeMonitorRegistry({
        script: async function* (options) {
          yield { type: "system", subtype: "init", session_id: options.sessionId } as ClaudeMessage;
          yield* watcherStarted;
          yield nativeResult;
          await watcherRunning;
          yield* watcherEnded;
          // Claude answers the notification with a native turn of its own.
          yield { type: "system", subtype: "init", session_id: options.sessionId } as ClaudeMessage;
          await followUpRunning;
          yield nativeResult;
        },
      });
      const monitorTurnStarts: string[] = [];
      try {
        const response = await callRegistryMcpTool({
          registry, backend: "claude", threadId: parentThreadId, turnId: "parent-turn",
          tool: "create_monitor_delegation", args: { task: "Watch PR #8 checks until they finish." },
        });
        expect(response.isError).not.toBe(true);
        const monitorId = String(response.structuredContent?.monitorId);
        const monitorThreadId = String(response.structuredContent?.monitorThreadId);
        const monitorTurnId = String(response.structuredContent?.monitorTurnId);
        registry.onEvent((event) => {
          if (event.notification.method === "turn/started" && event.notification.params.threadId === monitorThreadId) {
            monitorTurnStarts.push((event.notification.params as { turn: { id: string } }).turn.id);
          }
        });

        // The first turn ends with the watcher running: no recovery prompt.
        await vi.waitFor(() => expect(monitorRecord(registry, monitorId)?.awaitingClaudeTaskWake).toBe(true));
        await expect(userMessageCount(registry, monitorThreadId)).resolves.toBe(1);

        // The watcher's notification wakes the monitor, which reports.
        endWatcher();
        await vi.waitFor(() => expect(monitorTurnStarts.filter((id) => id !== monitorTurnId)).toHaveLength(1));
        const followUpTurnId = monitorTurnStarts.find((id) => id !== monitorTurnId)!;
        expect(monitorRecord(registry, monitorId)?.awaitingClaudeTaskWake).toBe(false);
        const completed = await callRegistryMcpTool({
          registry, backend: "claude", threadId: monitorThreadId, turnId: followUpTurnId,
          tool: "complete_monitoring",
          args: { monitorId, outcome: "success", summary: "PR #8 checks passed.", triggerParentTurn: false },
        });
        expect(completed.isError).not.toBe(true);
        expect(completed.structuredContent).toMatchObject({ monitorId });
        endFollowUp();
        await vi.waitFor(async () => {
          await expect(store.read(monitorThreadId)).rejects.toBeDefined();
        });
        // One process, one brief, and no recovery turn.
        expect(prompts).toHaveLength(1);
      } finally {
        endWatcher();
        endFollowUp();
        await close();
      }
    });

    it("recovers a monitor whose watcher ended without Claude answering it", async () => {
      let endWatcher!: () => void;
      const watcherRunning = new Promise<void>((resolve) => { endWatcher = resolve; });
      const { close, registry, release } = await createClaudeMonitorRegistry({
        script: async function* (options) {
          yield { type: "system", subtype: "init", session_id: options.sessionId } as ClaudeMessage;
          yield* watcherStarted;
          yield nativeResult;
          await watcherRunning;
          yield* watcherEnded;
          // Claude never starts a turn for the notification.
          await new Promise<void>(() => {});
        },
      });
      const checkStale = (now: number) =>
        registryModules(registry).subAgentMonitorService.checkStaleTaskMonitors(now);
      const tasks = async (threadId: string) =>
        (await registry.listBackgroundTerminals({ backend: "claude", threadId })).terminals;
      try {
        const response = await callRegistryMcpTool({
          registry, backend: "claude", threadId: parentThreadId, turnId: "parent-turn",
          tool: "create_monitor_delegation", args: { task: "Watch PR #8 checks until they finish." },
        });
        const monitorId = String(response.structuredContent?.monitorId);
        const monitorThreadId = String(response.structuredContent?.monitorThreadId);
        await vi.waitFor(() => expect(monitorRecord(registry, monitorId)?.awaitingClaudeTaskWake).toBe(true));

        // A running watcher is the monitor's running command: never stale.
        await checkStale(Date.now() + 24 * 60 * 60 * 1000);
        await expect(userMessageCount(registry, monitorThreadId)).resolves.toBe(1);
        expect(monitorRecord(registry, monitorId)?.awaitingClaudeTaskWake).toBe(true);

        endWatcher();
        await vi.waitFor(async () => expect(await tasks(monitorThreadId)).toHaveLength(0));
        await checkStale(Date.now() + 24 * 60 * 60 * 1000);
        await vi.waitFor(() => expect(userMessageCount(registry, monitorThreadId)).resolves.toBe(2));
      } finally {
        endWatcher();
        release();
        await close();
      }
    });

    it("gives a recovery turn in a new process the brief and the last observed state", async () => {
      let endFirstTurn!: () => void;
      const firstTurnRunning = new Promise<void>((resolve) => { endFirstTurn = resolve; });
      let launches = 0;
      const { close, prompts, registry } = await createClaudeMonitorRegistry({
        script: async function* (options) {
          launches += 1;
          yield { type: "system", subtype: "init", session_id: options.sessionId } as ClaudeMessage;
          if (launches > 1) {
            // The recovery turn stays open while the test reads its prompt.
            await new Promise<void>(() => {});
          }
          yield { type: "assistant", parent_tool_use_id: null, message: {
            id: "poll", content: [{ type: "tool_use", id: "tool-poll", name: "Bash",
              input: { command: "gh run view 42 --json jobs" } }],
          } } as ClaudeMessage;
          yield { type: "user", parent_tool_use_id: null, message: { content: [{
            type: "tool_result", tool_use_id: "tool-poll", content: "E2E job: in_progress (3 of 5 shards done)",
          }] } } as ClaudeMessage;
          yield { type: "assistant", parent_tool_use_id: null, message: {
            id: "said", content: [{ type: "text", text: "Run 42 is still running; E2E has 3 of 5 shards done." }],
          } } as ClaudeMessage;
          await firstTurnRunning;
          // The turn ends with no watcher and no complete_monitoring.
          yield nativeResult;
        },
      });
      try {
        const response = await callRegistryMcpTool({
          registry, backend: "claude", threadId: parentThreadId, turnId: "parent-turn",
          tool: "create_monitor_delegation",
          args: {
            task: "Watch CI run 42 until the E2E job finishes.",
            monitorContext: "Poll `gh run view 42 --json jobs`. The E2E job is terminal at DONE or FAILURE.",
          },
        });
        expect(response.isError).not.toBe(true);
        const monitorId = String(response.structuredContent?.monitorId);
        const monitorThreadId = String(response.structuredContent?.monitorThreadId);
        const progress = await callRegistryMcpTool({
          registry, backend: "claude", threadId: monitorThreadId,
          turnId: String(response.structuredContent?.monitorTurnId),
          tool: "inject_progress",
          args: { monitorId, status: "running", message: "E2E job: 3 of 5 shards done." },
        });
        expect(progress.isError).not.toBe(true);
        await vi.waitFor(async () => {
          const { replay } = await registry.readThread({ backend: "claude", threadId: monitorThreadId });
          expect(replay.lastAssistantMessage).toContain("3 of 5 shards");
        });

        endFirstTurn();
        await vi.waitFor(() => expect(userMessageCount(registry, monitorThreadId)).resolves.toBe(2));
        // An ephemeral session cannot be resumed: the recovery is a new one.
        expect(prompts).toHaveLength(2);
        expect(prompts[1]!.resume).toBeUndefined();
        expect(prompts[1]!.sessionId).not.toBe(prompts[0]!.sessionId);
        const recovery = (await registry.readThread({ backend: "claude", threadId: monitorThreadId }))
          .replay.lastUserMessage ?? "";
        expect(recovery).toContain("PwrAgent monitor recovery instruction");
        // The procedure the monitor was given.
        expect(recovery).toContain("<original_monitor_brief>");
        expect(recovery).toContain("Poll `gh run view 42 --json jobs`. The E2E job is terminal at DONE or FAILURE.");
        // What it last reported and observed.
        expect(recovery).toContain("[running] E2E job: 3 of 5 shards done.");
        expect(recovery).toContain("gh run view 42 --json jobs");
        expect(recovery).toContain("E2E job: in_progress (3 of 5 shards done)");
        expect(recovery).toContain("Run 42 is still running; E2E has 3 of 5 shards done.");
        expect(recovery).not.toContain("Use only the monitor task context you already have");
        // The brief's watcher steps would end the recovery without a result.
        expect(recovery).toContain("do not start a watcher or a background command");
      } finally {
        endFirstTurn();
        await close();
      }
    });

    it("ends a finished monitor's watcher with its process", async () => {
      const { close, queries, registry, release } = await createClaudeMonitorRegistry({
        script: async function* (options) {
          yield { type: "system", subtype: "init", session_id: options.sessionId } as ClaudeMessage;
          yield* watcherStarted;
          yield nativeResult;
          await new Promise<void>(() => {});
        },
      });
      try {
        const response = await callRegistryMcpTool({
          registry, backend: "claude", threadId: parentThreadId, turnId: "parent-turn",
          tool: "create_monitor_delegation", args: { task: "Watch PR #8 checks until they finish." },
        });
        const monitorId = String(response.structuredContent?.monitorId);
        const monitorThreadId = String(response.structuredContent?.monitorThreadId);
        await vi.waitFor(() => expect(monitorRecord(registry, monitorId)?.awaitingClaudeTaskWake).toBe(true));
        expect(queries[0]!.close).not.toHaveBeenCalled();

        const completed = await callRegistryMcpTool({
          registry, backend: "claude", threadId: monitorThreadId,
          turnId: String(response.structuredContent?.monitorTurnId), tool: "complete_monitoring",
          args: { monitorId, outcome: "success", summary: "Done.", triggerParentTurn: false },
        });
        expect(completed.isError).not.toBe(true);
        // A watcher left running would wake a monitor nothing owns.
        await vi.waitFor(() => expect(queries[0]!.close).toHaveBeenCalled());
      } finally {
        release();
        await close();
      }
    });

    it("cancels a monitor that is waiting on its watcher", async () => {
      const { close, queries, registry, release } = await createClaudeMonitorRegistry({
        script: async function* (options) {
          yield { type: "system", subtype: "init", session_id: options.sessionId } as ClaudeMessage;
          yield* watcherStarted;
          yield nativeResult;
          await new Promise<void>(() => {});
        },
      });
      try {
        const response = await callRegistryMcpTool({
          registry, backend: "claude", threadId: parentThreadId, turnId: "parent-turn",
          tool: "create_monitor_delegation", args: { task: "Watch PR #8 checks until they finish." },
        });
        const monitorId = String(response.structuredContent?.monitorId);
        await vi.waitFor(() => expect(monitorRecord(registry, monitorId)?.awaitingClaudeTaskWake).toBe(true));

        // No turn is running, so no terminal event can finish the cancel.
        const cancelled = await callRegistryMcpTool({
          registry, backend: "claude", threadId: parentThreadId, turnId: "parent-turn",
          tool: "cancel_monitor_delegation", args: { monitorId },
        });
        expect(cancelled.isError).not.toBe(true);
        expect(cancelled.structuredContent).toMatchObject({ monitorId, outcome: "cancelled" });
        expect(monitorRecord(registry, monitorId)).toBeUndefined();
        await vi.waitFor(() => expect(queries[0]!.close).toHaveBeenCalled());
      } finally {
        release();
        await close();
      }
    });

    it.each([
      { name: "without causal context", causalContext: {} },
      {
        name: "with causal context",
        causalContext: { causalMessagingSource: { ownerId: "owner-1", requestId: "request-1" } },
      },
    ])("labels the monitor's brief and recovery prompt as sub-agent input $name", async ({ causalContext }) => {
      let releaseRecovery!: () => void;
      const laterQueriesHeld = new Promise<void>((resolve) => { releaseRecovery = resolve; });
      const { close, overlayStore, prompts, registry, release } = await createClaudeMonitorRegistry({ laterQueriesHeld });
      try {
        if (causalContext.causalMessagingSource) {
          // The parent turn came from messaging, and its tools are allowed.
          await overlayStore.upsertThreadMessageOrigin!({
            backend: "claude", threadId: parentThreadId, messageId: "user:parent-turn",
            origin: { kind: "messaging", ...causalContext },
          });
          registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(),
            checkDynamicToolPermission: () => ({ allowed: true }),
            authorizeRetainedTool: async () => ({ allowed: true }),
          });
        }
        const response = await callRegistryMcpTool({
          registry,
          backend: "claude",
          threadId: parentThreadId,
          turnId: "parent-turn",
          tool: "create_monitor_delegation",
          args: { task: "Watch PR #8 checks until they finish." },
        });
        expect(response.isError).not.toBe(true);
        const monitorThreadId = String(response.structuredContent?.monitorThreadId);
        const monitorTurnId = String(response.structuredContent?.monitorTurnId);
        const origin = { kind: "sub-agent", ...causalContext };
        const readUserOrigins = async () =>
          (await registry.readThread({ backend: "claude", threadId: monitorThreadId })).replay.messages
            .flatMap((message) => message.role === "user" ? [{ id: message.id, origin: message.origin }] : []);

        // The live monitor thread's brief carries its origin.
        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        await expect(readUserOrigins()).resolves.toEqual([{ id: `user:${monitorTurnId}`, origin }]);

        // The first turn ends without complete_monitoring, so PwrAgent
        // writes a recovery instruction into the same thread.
        release();
        await vi.waitFor(() => expect(prompts.length).toBeGreaterThanOrEqual(2));
        await vi.waitFor(async () => {
          const origins = await readUserOrigins();
          expect(origins).toHaveLength(2);
          expect(origins[1]?.id).not.toBe(`user:${monitorTurnId}`);
          expect(origins[1]?.origin).toEqual(origin);
        });
        expect(overlayStore.upsertThreadMessageOrigin).toHaveBeenCalledWith({
          backend: "claude", threadId: monitorThreadId, messageId: `user:${monitorTurnId}`, origin,
        });
      } finally {
        releaseRecovery();
        await close();
      }
    });

    it("does not start a Claude monitor on a Codex model the agent asked for", async () => {
      const { close, registry } = await createClaudeMonitorRegistry({});
      const branchRead = vi.spyOn(gitExecutable, "runGitCommand")
        .mockResolvedValue({ stdout: "main\n", stderr: "" });
      try {
        const response = await callRegistryMcpTool({
          registry,
          backend: "claude",
          threadId: parentThreadId,
          turnId: "parent-turn",
          tool: "create_monitor_delegation",
          args: { task: "Watch PR #8 checks until they finish.", preferredModel: "gpt-5.6-luna" },
        });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({ preferredModel: "haiku" });
      } finally {
        try {
          await close();
        } finally {
          branchRead.mockRestore();
        }
      }
    });

    it("does not start a Claude monitor recovery turn during shutdown", async () => {
      const { registry, prompts, release, root } = await createClaudeMonitorRegistry({});
      const branchRead = vi.spyOn(gitExecutable, "runGitCommand")
        .mockResolvedValue({ stdout: "main\n", stderr: "" });
      try {
        const response = await callRegistryMcpTool({
          registry,
          backend: "claude",
          threadId: parentThreadId,
          turnId: "parent-turn",
          tool: "create_monitor_delegation",
          args: { task: "Watch PR #8 checks until they finish." },
        });
        expect(response.isError).not.toBe(true);
        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        await registry.publishLocalEvent({
          backend: "claude",
          notification: {
            method: "turn/completed",
            params: {
              threadId: parentThreadId,
              turnId: "parent-turn",
              turn: { id: "parent-turn", status: "completed", output: [] },
            },
          },
        });

        const closing = registry.close();
        release();
        await closing;
        expect(prompts).toHaveLength(1);
      } finally {
        release();
        try {
          await registry.close();
          await rm(root, { recursive: true, force: true });
        } finally {
          branchRead.mockRestore();
        }
      }
    });

    it("owns the branch read until the monitor workspace can be removed", async () => {
      const { close, registry, root } = await createClaudeMonitorRegistry({});
      // An unproven layout reads its branch through the owned Git process.
      const unproven = vi.spyOn(gitHeadBranch, "probeCurrentGitBranch").mockResolvedValue(undefined);
      const runGitCommand = gitExecutable.runGitCommand;
      let releaseBranch!: () => void;
      const heldBranch = new Promise<void>((resolve) => { releaseBranch = resolve; });
      const branchRead = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (cwd !== root) return await runGitCommand(cwd, args, options);
        await heldBranch;
        return { stdout: "main\n", stderr: "" };
      });
      let closing: Promise<void> | undefined;
      try {
        const response = await callRegistryMcpTool({
          registry, backend: "claude", threadId: parentThreadId, turnId: "parent-turn",
          tool: "create_monitor_delegation", args: { task: "Watch a long job." },
        });
        expect(response.isError).not.toBe(true);
        let closed = false;
        closing = close().then(() => { closed = true; });
        await vi.waitFor(() => expect(branchRead).toHaveBeenCalledWith(
          root, ["rev-parse", "--abbrev-ref", "HEAD"], expect.objectContaining({ ownProcessTree: true }),
        ));
        expect(closed).toBe(false);
        await expect(stat(root)).resolves.toBeDefined();
        releaseBranch();
        await closing;
        await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        releaseBranch();
        try {
          await (closing ?? close());
        } finally {
          branchRead.mockRestore();
          unproven.mockRestore();
        }
      }
    });

    it("points one CI wait per turn at PwrAgent's PR watch", async () => {
      const { close, registry } = await createClaudeMonitorRegistry({});
      const internal = registryModules(registry).threadUsageLedger;
      try {
        const ask = (command: string, toolUseId: string, turnId = "parent-turn") =>
          internal.suggestClaudeMonitorJob({ threadId: parentThreadId, turnId, toolName: "Bash", command, toolUseId });
        await expect(ask("git status", "tool-1")).resolves.toBeUndefined();
        await expect(ask("gh pr checks 8 -R o/r --watch --interval 30", "tool-2"))
          .resolves.toContain("watch_thread_pull_request");
        await expect(ask("gh run watch 12 --exit-status", "tool-3")).resolves.toBeUndefined();
        await expect(ask("gh run watch 12 --exit-status", "tool-4", "next-turn"))
          .resolves.toContain("create_monitor_delegation");
      } finally {
        await close();
      }
    });

    it("runs on the Helper model when the operator chose it for Claude", async () => {
      const { close, codexClient, registry } = await createClaudeMonitorRegistry({
        taskMonitorModels: { claude: { source: "helper" } },
      });
      try {
        const response = await callRegistryMcpTool({
          registry,
          backend: "claude",
          threadId: parentThreadId,
          turnId: "parent-turn",
          tool: "create_monitor_delegation",
          args: { task: "Watch PR #8 checks until they finish." },
        });
        expect(response.isError).not.toBe(true);
        const monitorId = String(response.structuredContent?.monitorId);
        const monitorThreadId = String(response.structuredContent?.monitorThreadId);
        expect(monitorThreadId).toBe("codex-monitor-thread");
        // A Codex monitor reports through its own dynamic tools.
        expect(codexClient.lastStartThreadParams?.dynamicTools).toEqual(
          expect.arrayContaining([expect.anything()]),
        );

        // The monitor calls back as a Codex thread; it once was refused as
        // "another provider runtime" because the record kept the parent's.
        const completed = await callRegistryMcpTool({
          registry,
          backend: "codex",
          threadId: monitorThreadId,
          turnId: String(response.structuredContent?.monitorTurnId),
          tool: "complete_monitoring",
          args: { monitorId, outcome: "success", summary: "All checks passed.", triggerParentTurn: false },
        });
        expect(completed.isError).not.toBe(true);
      } finally {
        await close();
      }
    });
  });

  it("injects task monitor progress without waking the parent and completes with one parent turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const events: AgentEvent[] = [];
    const unsubscribeEvents = registry.onEvent((event) => {
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
    const delegationResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch PR #123 checks until they finish.",
          finalHandoffPrompt: "Tell me whether to merge.",
        },
      },
    } as AppServerPendingRequestNotification);
    const monitorId = JSON.parse(
      (delegationResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ).monitorId as string;
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      subAgents: [
        {
          monitorId,
          monitorThreadId: "monitor-thread",
          status: "running",
          task: "Watch PR #123 checks until they finish.",
        },
      ],
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      },
    });
    const expectedUsageSummary =
      "800 uncached in · 200 cached · 50 out (10 reasoning) · <$0.001 list price";
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "monitor-thread",
          turnId: "monitor-turn",
          tokenUsage: {
            total: {
              inputTokens: 1_000,
              cachedInputTokens: 200,
              outputTokens: 50,
              reasoningOutputTokens: 10,
            },
          },
        },
      },
    });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "monitor-thread",
        turnId: "monitor-turn",
        callId: "call-2",
        requestId: "call-2",
        namespace: "pwragent_task_monitors",
        tool: "inject_progress",
        arguments: {
          monitorId,
          status: "running",
          message: "lint is running",
        },
      },
    } as AppServerPendingRequestNotification);
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      subAgents: [
        {
          monitorId,
          monitorUsage: {
            cost: {
              model: "gpt-5.6-luna",
              totalUsd: 0.000236,
            },
            summary: expectedUsageSummary,
          },
          status: "running",
        },
      ],
    });

    expect(events).toContainEqual(expect.objectContaining({
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: `monitor:${monitorId}`,
          item: {
            id: `${monitorId}:created`,
            type: "taskMonitorCreated",
            data: {
              source: "pwragent_task_monitor",
              monitorId,
              parentTurnId: "turn-1",
              task: "Watch PR #123 checks until they finish.",
            },
          },
        },
      },
    }));

    const progressEvent = events.find((event) => {
      if (event.notification.method !== "item/completed") {
        return false;
      }
      const item = event.notification.params.item as {
        text?: string;
        type?: string;
      };
      return (
        event.notification.params.threadId === "thread-1" &&
        item.type === "agentMessage" &&
        item.text?.includes("lint is running") === true
      );
    });
    const progressText =
      progressEvent?.notification.method === "item/completed"
        ? (progressEvent.notification.params.item as { text?: string }).text
        : undefined;
    expect(progressText).toBe(
      "Monitor · Watch PR #123 checks until they finish\nlint is running",
    );
    expect(progressText).not.toContain("Monitor usage");
    expect(progressEvent).toMatchObject({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: `monitor:${monitorId}`,
          item: {
            type: "agentMessage",
            data: {
              source: "pwragent_task_monitor",
              monitorId,
              monitorUsage: {
                model: "gpt-5.6-luna",
                summary: expectedUsageSummary,
                tokenUsage: {
                  cachedInputTokens: 200,
                  inputTokens: 1_000,
                  outputTokens: 50,
                  reasoningOutputTokens: 10,
                  totalTokens: 1_060,
                  uncachedInputTokens: 800,
                },
                cost: {
                  model: "gpt-5.6-luna",
                  totalUsd: 0.000236,
                },
                phase: "progress",
              },
              transient: true,
            },
          },
        },
      },
    });
    expect(codexClient.injectedThreadItems).toHaveLength(0);
    expect(codexClient.startTurnCallCount).toBe(1);

    const completionResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "monitor-thread",
        turnId: "monitor-turn",
        callId: "call-3",
        requestId: "call-3",
        namespace: "pwragent_task_monitors",
        tool: "complete_monitoring",
        arguments: {
          monitorId,
          outcome: "failure",
          summary: "Tests failed in CI.",
          details: "unit-test reported 2 failures.",
        },
      },
    } as AppServerPendingRequestNotification);
    const completionPayload = JSON.parse(
      (completionResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ) as Record<string, unknown>;

    expect(completionResponse).toMatchObject({ success: true });
    expect(codexClient.injectedThreadItems).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      notification: expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          threadId: "thread-1",
          turnId: `monitor:${monitorId}`,
          item: expect.objectContaining({
            type: "taskMonitorCompletion",
            data: expect.objectContaining({ monitorId, parentTurnId: "turn-1", outcome: "failure" }),
          }),
        }),
      }),
    }));
    const completionUsageEvent = events.find((event) => {
      if (event.notification.method !== "item/completed") {
        return false;
      }
      const item = event.notification.params.item as {
        data?: Record<string, unknown>;
        type?: string;
      };
      return (
        event.notification.params.threadId === "thread-1" &&
        item.type === "taskMonitorUsage"
      );
    });
    expect(completionUsageEvent).toMatchObject({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: `monitor:${monitorId}`,
          item: {
            type: "taskMonitorUsage",
            data: {
              source: "pwragent_task_monitor",
              monitorId,
              monitorUsage: {
                summary: expectedUsageSummary,
                phase: "completion",
              },
              transient: false,
            },
          },
        },
      },
    });
    expect(codexClient.startTurnCallCount).toBe(2);
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: expect.stringContaining("Tests failed in CI."),
        },
      ],
    });
    expect(
      String(
        codexClient.lastStartTurnParams?.input[0]?.type === "text"
          ? codexClient.lastStartTurnParams.input[0].text
          : "",
      ),
    ).not.toContain("Monitor usage");
    expect(
      String(
        codexClient.lastStartTurnParams?.input[0]?.type === "text"
          ? codexClient.lastStartTurnParams.input[0].text
          : "",
      ),
    ).toContain(
      "Tell me whether to merge.",
    );
    const handoffText =
      codexClient.lastStartTurnParams?.input[0]?.type === "text"
        ? codexClient.lastStartTurnParams.input[0].text
        : "";
    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "monitor-handoff-message",
          type: "userMessage",
          text: handoffText,
        },
      },
    });
    expect(
      events.find(
        (event) =>
          event.notification.method === "item/completed"
          && (
            event.notification.params.item as { id?: string } | undefined
          )?.id === "monitor-handoff-message",
      ),
    ).toMatchObject({
      notification: {
        params: {
          item: {
            origin: {
              kind: "sub-agent",
              sourceThread: {
                backend: "codex",
                threadId: "monitor-thread",
                title: "Watch PR #123 checks until they finish.",
              },
              subAgent: {
                kind: "monitor",
                monitorId,
                outcome: "failure",
                summary: "Tests failed in CI.",
                task: "Watch PR #123 checks until they finish.",
              },
            },
          },
        },
      },
    });
    expect(overlayStore.upsertThreadMessageOrigin).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      messageId: "monitor-handoff-message",
      origin: {
        kind: "sub-agent",
        sourceThread: {
          backend: "codex",
          threadId: "monitor-thread",
          title: "Watch PR #123 checks until they finish.",
        },
        subAgent: {
          kind: "monitor",
          monitorId,
          outcome: "failure",
          summary: "Tests failed in CI.",
          task: "Watch PR #123 checks until they finish.",
        },
      },
    });
    expect(completionPayload).toMatchObject({
      monitorId,
      parentThreadId: "thread-1",
      outcome: "failure",
      monitorUsage: {
        summary: expectedUsageSummary,
      },
      parentTurn: {
        status: "started",
        turnId: "turn-1",
      },
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      subAgents: [
        {
          completedAt: expect.any(Number),
          lastMessage: "Tests failed in CI.",
          monitorId,
          monitorThreadId: "monitor-thread",
          monitorUsage: {
            cost: {
              model: "gpt-5.6-luna",
              totalUsd: 0.000236,
            },
            summary: expectedUsageSummary,
          },
          outcome: "failure",
          status: "failure",
        },
      ],
    });

    unsubscribeEvents();
    await registry.close();
  });

  it("queues task monitor handoffs behind an active parent without transcript injection", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
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
          threadId: "thread-1",
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });
    const delegationResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "parent-turn",
        callId: "call-create",
        requestId: "call-create",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch an asynchronous task until it finishes.",
        },
      },
    } as AppServerPendingRequestNotification);
    const monitorId = JSON.parse(
      (delegationResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ).monitorId as string;
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "parent-turn",
          turn: { id: "parent-turn", status: "completed", output: [] },
        },
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "review-turn",
          turn: { id: "review-turn" },
        },
      },
    });

    const completionResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "monitor-thread",
        turnId: "turn-1",
        callId: "call-complete",
        requestId: "call-complete",
        namespace: "pwragent_task_monitors",
        tool: "complete_monitoring",
        arguments: {
          monitorId,
          outcome: "failure",
          summary: "The monitored task failed.",
        },
      },
    } as AppServerPendingRequestNotification);
    const completionPayload = JSON.parse(
      (completionResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ) as Record<string, unknown>;

    expect(completionResponse).toMatchObject({ success: true });
    expect(completionPayload).toMatchObject({
      parentTurn: {
        status: "queued",
        position: 1,
      },
    });
    expect(codexClient.injectedThreadItems).toHaveLength(0);
    expect(codexClient.startTurnCallCount).toBe(1);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "review-turn",
          turn: { id: "review-turn", status: "completed", output: [] },
        },
      },
    });

    await expect.poll(() => codexClient.startTurnCallCount).toBe(2);
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: expect.stringContaining("The monitored task failed."),
        },
      ],
    });
    await registry.close();
  });

  it.each([true, false])("uses one lightweight verdict to distinguish a release loop from real work (loop: %s)", async (loop) => {
    const parent = "thread-1";
    const outcomes = loop ? ["failure", "cancelled", "success", "fallback"] as const
      : ["success", "failure", "success", "success", "success", "success", "success"] as const;
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startTurnResults: outcomes.flatMap((outcome, index) => [
        { threadId: `observer-${index}`, turnId: `watch-${index}` },
        ...(!loop || index < 3 ? [{ threadId: parent, turnId: `follow-up-${index}` }] : []),
        ...(outcome === "fallback" ? [{ threadId: `observer-${index}`, turnId: `recover-${index}` }] : []),
      ]),
    });
    const assess = vi.fn(async (_request: { prompt: string }) => ({ status: "ok" as const, object: { loop } }));
    Object.assign(codexClient, { generateStructuredObject: assess });
    let observer = 0;
    vi.spyOn(codexClient, "startThread").mockImplementation(async () => ({ threadId: `observer-${observer++}` }));
    const storeMock = createOverlayStoreMock();
    const overlayStore = {
      ...storeMock,
      listEndedThreadTaskMonitors: async (request: Parameters<typeof storeMock.listThreadSubAgents>[0] & { limit: number }) =>
        (await storeMock.listThreadSubAgents(request)).filter((row) => row.completedAt !== undefined).slice(0, request.limit),
    };
    const db = openInMemoryStateDb();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore, taskMonitorWakeStore: new TaskMonitorWakeStore(db.raw) });
    onTestFinished(async () => { await registry.close(); db.close(); });
    const guardChanges = vi.fn();
    registry.onEvent((event) => {
      if (event.notification.method === "thread/taskMonitorWakeGuard/updated") guardChanges();
    });
    const toolCall = async (threadId: string, turnId: string, tool: string, args: Record<string, unknown>) => {
      const result = await codexClient.emitRequest({
        method: "item/tool/call",
        params: { threadId, turnId, callId: `${turnId}-${tool}`, requestId: `${turnId}-${tool}`,
          namespace: "pwragent_task_monitors", tool, arguments: args },
      } as AppServerPendingRequestNotification) as { success: boolean; contentItems: Array<{ text: string }> };
      expect(result.success).toBe(true);
      return JSON.parse(result.contentItems[0]!.text) as {
        monitorId: string;
        parentTurn?: { status: string };
        parentWakeSuppressed?: true;
      };
    };
    const monitorIds = new Set<string>();
    let parentTurn = "initial";
    for (const [index, outcome] of outcomes.entries()) {
      await emitStartedTurn(registry, "codex", parent, parentTurn);
      const created = await toolCall(parent, parentTurn, "create_monitor_delegation", {
        task: loop ? "Observe the same pending release watcher." : `Observe independent workflow ${index}.`,
      });
      monitorIds.add(created.monitorId);
      await emitCompletedTurn(registry, "codex", parent, parentTurn);
      if (outcome === "fallback") {
        await emitCompletedTurn(registry, "codex", `observer-${index}`, `watch-${index}`);
        await emitCompletedTurn(registry, "codex", `observer-${index}`, `recover-${index}`);
        expect(await overlayStore.getThreadSubAgent({ backend: "codex", threadId: parent, monitorId: created.monitorId }))
          .toMatchObject({ outcome: "failure", completionSource: { type: "pwragent_fallback" } });
        continue;
      }
      const report = await toolCall(`observer-${index}`, `watch-${index}`, "complete_monitoring", {
        monitorId: created.monitorId,
        outcome,
        summary: outcome === "success" ? "The release finished." : "The observer stopped while the release was pending.",
      });
      expect(report.parentTurn?.status).toBe("started");
      expect(report.parentWakeSuppressed).toBeUndefined();
      expect(await overlayStore.getThreadSubAgent({ backend: "codex", threadId: parent, monitorId: created.monitorId }))
        .toMatchObject({ outcome });
      parentTurn = `follow-up-${index}`;
    }
    expect(monitorIds.size).toBe(outcomes.length);
    expect(assess).toHaveBeenCalledTimes(loop ? 1 : 2);
    const { wakingMonitorIds, attempts: evidence } = JSON.parse(assess.mock.calls.at(-1)![0].prompt) as {
      wakingMonitorIds: string[];
      attempts: Array<{ monitorId: string; outcome: string; elapsedMs: number }>;
    };
    expect(wakingMonitorIds).toEqual([Array.from(monitorIds).at(-1)]);
    expect(evidence).toHaveLength(loop ? 4 : 5);
    expect(new Set(evidence.map((attempt) => attempt.monitorId)).size).toBe(evidence.length);
    expect(evidence.every((attempt) => attempt.elapsedMs >= 0)).toBe(true);
    expect(evidence.map((attempt) => attempt.outcome)).toEqual(expect.arrayContaining(loop ? ["failure", "cancelled", "success"] : ["success"]));
    expect(assess).toHaveBeenCalledWith(expect.objectContaining({ disableExecution: true, model: "gpt-5.6-luna", reasoningEffort: "low" }));
    expect(codexClient.startTurnCalls.filter((call) => call.threadId === parent)).toHaveLength(loop ? 3 : 7);
    const owner = { backend: "codex", threadId: parent } as const;
    expect(registry.taskMonitorWakesTripped(owner)).toBe(loop);
    expect(guardChanges).toHaveBeenCalledTimes(loop ? 1 : 0);
    if (loop) {
      expect(registry.listTaskMonitorWakeAlerts()).toEqual([expect.objectContaining(owner)]);
      expect(registry.acknowledgeTaskMonitorWakeAlert(owner, 0)).toBe(true);
      expect(registry.listTaskMonitorWakeAlerts()).toEqual([]);
      expect(registry.taskMonitorWakesTripped(owner)).toBe(true);
      await emitStartedTurn(registry, "codex", parent, "operator-turn");
      const rejected = await codexClient.emitRequest({ method: "item/tool/call", params: {
        threadId: parent, turnId: "operator-turn", callId: "blocked-monitor", requestId: "blocked-monitor",
        namespace: "pwragent_task_monitors", tool: "create_monitor_delegation", arguments: { task: "Start another observer" },
      } } as AppServerPendingRequestNotification);
      expect(rejected).toMatchObject({ success: false });
      await emitCompletedTurn(registry, "codex", parent, "operator-turn");
    } else {
      await emitCompletedTurn(registry, "codex", parent, parentTurn);
    }
    await expect(registry.submitTurn({ backend: "codex", threadId: parent, input: [{ type: "text", text: "Verify the release." }] }))
      .resolves.toMatchObject({ status: "started" });
    expect(registry.taskMonitorWakesTripped(owner)).toBe(loop);
  });

  it("holds a task monitor's result for a locked parent and delivers it on unlock", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    onTestFinished(() => registry.close());
    const turnEvent = async (method: "turn/started" | "turn/completed") =>
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method,
          params: {
            threadId: "thread-1",
            turnId: "parent-turn",
            turn: method === "turn/started"
              ? { id: "parent-turn" }
              : { id: "parent-turn", status: "completed", output: [] },
          },
        },
      } as AgentEvent);
    const toolCall = async (threadId: string, tool: string, args: Record<string, unknown>) => {
      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId,
          turnId: threadId === "thread-1" ? "parent-turn" : "turn-1",
          callId: `call-${tool}`,
          requestId: `call-${tool}`,
          namespace: "pwragent_task_monitors",
          tool,
          arguments: args,
        },
      } as AppServerPendingRequestNotification);
      return {
        response,
        payload: JSON.parse(
          (response as { contentItems: Array<{ text: string }> }).contentItems[0]?.text ?? "{}",
        ) as Record<string, unknown>,
      };
    };
    await turnEvent("turn/started");
    const created = await toolCall("thread-1", "create_monitor_delegation", {
      task: "Watch an asynchronous task until it finishes.",
    });
    await turnEvent("turn/completed");
    await registry.setThreadLock({
      backend: "codex",
      threadId: "thread-1",
      locked: true,
      note: "Worktree handed to the repair thread.",
    }, { source: "operator" });

    const completed = await toolCall("monitor-thread", "complete_monitoring", {
      monitorId: created.payload.monitorId,
      outcome: "success",
      summary: "The monitored task finished.",
    });

    expect(completed.response).toMatchObject({ success: true });
    expect(completed.payload).toMatchObject({ parentTurn: { status: "queued", position: 1 } });
    // Only the monitor's own turn has started.
    expect(codexClient.startTurnCallCount).toBe(1);

    await registry.setThreadLock({ backend: "codex", threadId: "thread-1", locked: false }, { source: "operator" });
    await expect.poll(() => codexClient.startTurnCallCount).toBe(2);
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: expect.stringContaining("The monitored task finished.") }],
    });
  });

  it("lets only the active parent cancel a managed monitor without waking another turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
    });
    const overlayStore = createOverlayStoreMock();
    let jobMonitorCreationEnabled = true;
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: {
        ...overlayStore,
        getThreadOverlayState: async (identity) => {
          const overlay = await overlayStore.getThreadOverlayState(identity);
          return overlay && identity.threadId === "thread-1"
            ? { ...overlay, jobMonitorCreationEnabled }
            : overlay;
        },
      },
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
    const delegationResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Recover the runner after its current job finishes.",
        },
      },
    } as AppServerPendingRequestNotification);
    const monitorId = JSON.parse(
      (delegationResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ).monitorId as string;
    jobMonitorCreationEnabled = false;
    expect(registryModules(registry).subAgentMonitorService.isTaskMonitorThread({
      backend: "codex", threadId: "monitor-thread",
    })).toBe(true);
    expect(codexClient.interruptTurnCallCount).toBe(0);
    const legacyCancellationResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-cancel-legacy",
        requestId: "call-cancel-legacy",
        namespace: "pwragent_task_monitors",
        tool: "cancel_monitor_delegation",
        arguments: { monitorId },
      },
    } as AppServerPendingRequestNotification);
    expect(legacyCancellationResponse).toMatchObject({ success: false });
    expect(codexClient.interruptTurnCallCount).toBe(0);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-2",
          turnId: "turn-2",
          turn: { id: "turn-2" },
        },
      },
    });

    const forbiddenResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-2",
        turnId: "turn-2",
        callId: "call-forbidden",
        requestId: "call-forbidden",
        namespace: "pwragent",
        tool: "cancel_monitor_delegation",
        arguments: { monitorId },
      },
    } as AppServerPendingRequestNotification);
    expect(forbiddenResponse).toMatchObject({ success: false });
    expect(codexClient.interruptTurnCallCount).toBe(0);

    const cancellationResponsePromise = codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-cancel",
        requestId: "call-cancel",
        namespace: "pwragent",
        tool: "cancel_monitor_delegation",
        arguments: {
          monitorId,
          reason: "The monitor was targeting the wrong runner.",
        },
      },
    } as AppServerPendingRequestNotification);
    await expectEventually(
      async () => codexClient.interruptTurnCallCount,
      1,
    );
    const overlappingResponsePromise = codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-cancel-overlap",
        requestId: "call-cancel-overlap",
        namespace: "pwragent",
        tool: "cancel_monitor_delegation",
        arguments: { monitorId },
      },
    } as AppServerPendingRequestNotification);
    let cancellationSettled = false;
    void cancellationResponsePromise.then(() => {
      cancellationSettled = true;
    });
    await Promise.resolve();

    expect(codexClient.interruptTurnCallCount).toBe(1);
    expect(cancellationSettled).toBe(false);
    expect(codexClient.injectedThreadItems).toHaveLength(0);
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      subAgents: [
        {
          lastMessage:
            "Cancellation requested; waiting for the monitor turn to stop.",
          monitorId,
          status: "cancelling",
        },
      ],
    });
    const lateCompletionResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "monitor-thread",
        turnId: "turn-1",
        callId: "call-complete-late",
        requestId: "call-complete-late",
        namespace: "pwragent_task_monitors",
        tool: "complete_monitoring",
        arguments: {
          monitorId,
          outcome: "success",
          summary: "The monitor finished while cancellation was pending.",
        },
      },
    } as AppServerPendingRequestNotification);
    expect(lateCompletionResponse).toMatchObject({ success: false });
    expect(codexClient.injectedThreadItems).toHaveLength(0);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/cancelled",
        params: {
          threadId: "monitor-thread",
          turnId: "some-other-turn",
          turn: { id: "some-other-turn", status: "cancelled", output: [] },
        },
      },
    });
    expect(codexClient.injectedThreadItems).toHaveLength(0);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/cancelled",
        params: {
          threadId: "monitor-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "cancelled", output: [] },
        },
      },
    });
    const [cancellationResponse, overlappingResponse] = await Promise.all([
      cancellationResponsePromise,
      overlappingResponsePromise,
    ]);
    const cancellationPayload = JSON.parse(
      (cancellationResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ) as Record<string, unknown>;

    expect(cancellationResponse).toMatchObject({ success: true });
    expect(overlappingResponse).toEqual(cancellationResponse);
    expect(cancellationPayload).toMatchObject({
      monitorId,
      parentThreadId: "thread-1",
      outcome: "cancelled",
      completionSource: { type: "parent_cancel" },
    });
    expect(codexClient.interruptTurnCallCount).toBe(1);
    expect(codexClient.lastInterruptTurnParams).toEqual({
      threadId: "monitor-thread",
      turnId: "turn-1",
    });
    expect(codexClient.startTurnCallCount).toBe(1);
    expect(codexClient.injectedThreadItems).toHaveLength(0);
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      subAgents: [
        {
          completedAt: expect.any(Number),
          completionSource: { type: "parent_cancel" },
          lastMessage: "The monitor was targeting the wrong runner.",
          monitorId,
          outcome: "cancelled",
          status: "cancelled",
        },
      ],
    });

    const repeatedResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-cancel-again",
        requestId: "call-cancel-again",
        namespace: "pwragent",
        tool: "cancel_monitor_delegation",
        arguments: { monitorId },
      },
    } as AppServerPendingRequestNotification);
    expect(repeatedResponse).toMatchObject({ success: true });
    expect(codexClient.interruptTurnCallCount).toBe(1);
    expect(codexClient.injectedThreadItems).toHaveLength(0);
    expect(codexClient.startTurnCallCount).toBe(1);

    await registry.close();
  });

  it("recovers an ended monitor turn once before synthesizing fallback completion", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribeEvents = registry.onEvent((event) => {
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
    const delegationResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch an asynchronous task until it finishes.",
        },
      },
    } as AppServerPendingRequestNotification);
    const monitorId = JSON.parse(
      (delegationResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ).monitorId as string;
    expect(codexClient.startTurnCallCount).toBe(1);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      },
    });

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "monitor-thread",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "I stopped without a tool call." }],
          },
        },
      },
    });

    expect(codexClient.startTurnCallCount).toBe(2);
    expect(codexClient.startTurnCalls[1]).toMatchObject({
      threadId: "monitor-thread",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
    });
    expect(
      codexClient.startTurnCalls[1]?.input[0]?.type === "text"
        ? codexClient.startTurnCalls[1].input[0].text
        : "",
    ).toContain("pwragent.complete_monitoring");
    expect(
      codexClient.startTurnCalls[1]?.input[0]?.type === "text"
        ? codexClient.startTurnCalls[1].input[0].text
        : "",
    ).toContain(monitorId);
    expect(codexClient.injectedThreadItems).toHaveLength(0);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "monitor-thread",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "Still no completion tool." }],
          },
        },
      },
    });

    expect(codexClient.injectedThreadItems).toHaveLength(0);
    expect(codexClient.startTurnCallCount).toBe(3);
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: expect.stringContaining("Completion source: pwragent_fallback"),
        },
      ],
    });
    const completionStateEvent = events.find((event) => {
      if (event.notification.method !== "item/completed") {
        return false;
      }
      const item = event.notification.params.item as {
        data?: Record<string, unknown>;
        type?: string;
      };
      return item.type === "taskMonitorCompletion";
    });
    expect(completionStateEvent).toMatchObject({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: `monitor:${monitorId}`,
          item: {
            type: "taskMonitorCompletion",
            data: {
              source: "pwragent_task_monitor",
              monitorId,
              outcome: "failure",
              fallbackGenerated: true,
              completionSource: {
                type: "pwragent_fallback",
                reason: "monitor_recovery_turn_ended_without_completion",
                recoveryAttempted: true,
                terminalStatus: "completed",
              },
            },
          },
        },
      },
    });

    unsubscribeEvents();
    await registry.close();
  });

  it("does not release a later monitor thread reservation while persisting its start origin", async () => {
    const causalMessagingSource = { ownerId: "owner-1", requestId: "request-1" };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
      startTurnResults: [{ threadId: "monitor-thread", turnId: "monitor-turn" }],
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    await overlayStore.upsertThreadMessageOrigin!({
      backend: "codex", threadId: "thread-1", messageId: "user:turn-1",
      origin: { kind: "messaging", causalMessagingSource },
    });
    const persistenceStarted = createDeferred<void>();
    const releasePersistence = createDeferred<void>();
    const upsertOrigin = overlayStore.upsertThreadMessageOrigin!;
    overlayStore.upsertThreadMessageOrigin = async (params) => {
      if (params.threadId === "monitor-thread" && params.messageId === "user:monitor-turn") {
        persistenceStarted.resolve();
        await releasePersistence.promise;
      }
      await upsertOrigin(params);
    };
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1" } },
      },
    });
    const delegation = codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: { task: "Watch an asynchronous task until it finishes." },
      },
    } as AppServerPendingRequestNotification);
    try {
      await persistenceStarted.promise;
      const activity = registryModules(registry).turnState;
      expect(activity.hasStartReservation("monitor-thread")).toBe(false);
      // A later operation acquires the same thread while persistence is pending.
      const reservation = activity.reserveStart("monitor-thread", "worker");
      releasePersistence.resolve();
      await delegation;
      expect(activity.hasStartReservation("monitor-thread")).toBe(true);
      activity.releaseStart("monitor-thread", reservation);
    } finally {
      releasePersistence.resolve();
      await registry.close();
    }
  });

  it("gates a Codex monitor's recovery turn by its messaging origin", async () => {
    const causalMessagingSource = { ownerId: "owner-1", requestId: "request-1" };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
      startTurnResults: [
        { threadId: "monitor-thread", turnId: "monitor-turn" },
        { threadId: "monitor-thread", turnId: "monitor-recovery-turn" },
      ],
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    const authorizeRetainedTool = vi.fn(async (
      _context: unknown,
      check: { tool: string },
    ) => check.tool === "read_thread"
      ? { allowed: false, permission: "thread.read" }
      : { allowed: true });
    const checkDynamicToolPermission = vi.fn(() => ({ allowed: true }));
    registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(),
      checkDynamicToolPermission,
      authorizeRetainedTool,
    });
    // The parent turn came from messaging.
    await overlayStore.upsertThreadMessageOrigin!({
      backend: "codex", threadId: "thread-1", messageId: "user:turn-1",
      origin: { kind: "messaging", causalMessagingSource },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1" } },
      },
    });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: { task: "Watch an asynchronous task until it finishes." },
      },
    } as AppServerPendingRequestNotification);
    expect(codexClient.startTurnCallCount).toBe(1);
    const origin = { kind: "sub-agent", causalMessagingSource };
    expect(overlayStore.upsertThreadMessageOrigin).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "monitor-thread",
      messageId: "user:monitor-turn",
      origin,
    });

    await emitCompletedTurn(registry, "codex", "thread-1", "turn-1");
    // The monitor turn ends without complete_monitoring, so recovery starts.
    await emitCompletedTurn(registry, "codex", "monitor-thread", "monitor-turn");
    expect(codexClient.startTurnCallCount).toBe(2);
    expect(codexClient.startTurnCalls[1]).toMatchObject({ threadId: "monitor-thread" });
    expect(overlayStore.upsertThreadMessageOrigin).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "monitor-thread",
      messageId: "user:monitor-recovery-turn",
      origin,
    });

    authorizeRetainedTool.mockClear();
    const denied = await (registry as unknown as {
      authorizeAgentToolMcpCall(params: {
        backend: AppServerBackendKind;
        catalogId?: string;
        threadId: string;
        tool: string;
        turnId: string;
      }): Promise<string | null>;
    }).authorizeAgentToolMcpCall({
      backend: "codex",
      catalogId: "thread_inspection",
      threadId: "monitor-thread",
      tool: "read_thread",
      turnId: "monitor-recovery-turn",
    });
    expect(denied).toBe("thread.read");
    expect(authorizeRetainedTool).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "monitor-thread",
        turnId: "monitor-recovery-turn",
        causalMessagingSource,
      }),
      expect.objectContaining({ category: "thread_inspection", tool: "read_thread" }),
    );
    expect(checkDynamicToolPermission).not.toHaveBeenCalled();

    await registry.close();
  });

  it("forgets a Codex monitor recovery turn's origin when the start fails", async () => {
    const causalMessagingSource = { ownerId: "owner-1", requestId: "request-1" };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
      startTurnErrors: [undefined, new Error("recovery start failed")],
      startTurnResults: [{ threadId: "monitor-thread", turnId: "monitor-turn" }],
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(),
      checkDynamicToolPermission: () => ({ allowed: true }),
      authorizeRetainedTool: async () => ({ allowed: true }),
    });
    await overlayStore.upsertThreadMessageOrigin!({
      backend: "codex", threadId: "thread-1", messageId: "user:turn-1",
      origin: { kind: "messaging", causalMessagingSource },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1" } },
      },
    });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: { task: "Watch an asynchronous task until it finishes." },
      },
    } as AppServerPendingRequestNotification);
    await emitCompletedTurn(registry, "codex", "thread-1", "turn-1");
    await emitCompletedTurn(registry, "codex", "monitor-thread", "monitor-turn");

    // The recovery start threw, so the fallback completion woke the parent.
    expect(codexClient.startTurnCallCount).toBe(3);
    expect(codexClient.lastStartTurnParams).toMatchObject({ threadId: "thread-1" });
    // A later turn on the monitor thread must not inherit the failed start's origin.
    await expect(registry.readCausalMessagingContext({
      backend: "codex",
      threadId: "monitor-thread",
      turnId: "later-turn",
    })).resolves.toEqual({});

    await registry.close();
  });

  it("reconciles orphaned sub-agents before serving threads after startup", async () => {
    const reconcileOrphanedThreadSubAgents = vi.fn(async () => ({
      repairedSubAgents: 0,
      repairedThreads: 0,
      skippedLiveOwners: 1,
      skippedOwnerlessWithOtherRuntimes: 1,
    }));
    const overlayStore = {
      ...createOverlayStoreMock(),
      reconcileOrphanedThreadSubAgents,
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      runtimeInstanceId: "runtime-current",
      registrySessionId: "registry-current",
      resolveLiveProfileRuntimeInstanceIds: () => [
        "runtime-current",
        "runtime-other",
      ],
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([]);
    expect(reconcileOrphanedThreadSubAgents).toHaveBeenCalledOnce();
    expect(reconcileOrphanedThreadSubAgents).toHaveBeenCalledWith({
      currentRuntimeInstanceId: "runtime-current",
      currentRegistrySessionId: "registry-current",
      liveRuntimeInstanceIds: ["runtime-current", "runtime-other"],
      sessionStartedAt: expect.any(Number),
    });
    await registry.close();
  });

  it("stops pending active task monitors without starting recovery", async () => {
    const codexClient = new MockBackendClient({
      interruptEndsTurn: true,
      initializeResult: { methods: ["turn/start", "turn/interrupt"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      runtimeInstanceId: "runtime-current",
      registrySessionId: "registry-current",
      resolveLiveProfileRuntimeInstanceIds: () => ["runtime-current"],
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
    const delegationResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch an asynchronous task until it finishes.",
          pollIntervalSeconds: 20,
        },
      },
    } as AppServerPendingRequestNotification);
    const monitorId = JSON.parse(
      (delegationResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ).monitorId as string;
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "monitor-thread",
        turnId: "turn-1",
        callId: "call-2",
        requestId: "call-2",
        namespace: "pwragent_task_monitors",
        tool: "inject_progress",
        arguments: {
          monitorId,
          status: "pending",
          message: "Waiting for external work.",
        },
      },
    } as AppServerPendingRequestNotification);
    await expect(overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      subAgents: [expect.objectContaining({ status: "pending" })],
    });
    const monitorRecord = registryModules(registry).subAgentMonitorService.taskMonitorDelegationRecords.get(monitorId);
    expect(monitorRecord).toBeDefined();
    monitorRecord!.finalizationStarted = true;
    await expect(registry.stopSubAgent({
      backend: "codex",
      threadId: "thread-1",
      monitorId,
    })).rejects.toThrow("Sub-agent is already completing.");
    expect(codexClient.interruptTurnCallCount).toBe(0);
    monitorRecord!.finalizationStarted = false;

    await expect(registry.stopSubAgent({
      backend: "codex",
      threadId: "thread-1",
      monitorId,
    })).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      monitorId,
    });

    expect(codexClient.lastInterruptTurnParams).toMatchObject({
      threadId: "monitor-thread",
      turnId: "turn-1",
    });
    await expect(overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      subAgents: [
        expect.objectContaining({
          monitorId,
          status: "cancelled",
          outcome: "cancelled",
          lastMessage: "Stopped by user.",
          ownerRuntimeInstanceId: "runtime-current",
          ownerRegistrySessionId: "registry-current",
        }),
      ],
    });

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/cancelled",
        params: {
          threadId: "monitor-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "cancelled", output: [] },
        },
      },
    });

    expect(codexClient.startTurnCallCount).toBe(1);
    expect(codexClient.injectedThreadItems).toHaveLength(0);
    await registry.close();
  });

  it("keeps monitor failure navigation on the parent when recovery cannot read the helper", async () => {
    const codexClient = new MockBackendClient({
      interruptEndsTurn: true,
      initializeResult: { methods: ["turn/start", "turn/interrupt"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
      startTurnResults: [{ threadId: "monitor-thread", turnId: "monitor-turn" }],
      startTurnErrors: [undefined, new Error("no rollout found for thread id monitor-thread")],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    try {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: { threadId: "thread-1", turnId: "parent-turn", turn: { id: "parent-turn" } },
        },
      });
      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "parent-turn",
          callId: "call-monitor",
          requestId: "call-monitor",
          namespace: "pwragent_task_monitors",
          tool: "create_monitor_delegation",
          arguments: { task: "Watch the fixture task.", pollIntervalSeconds: 20 },
        },
      } as AppServerPendingRequestNotification);
      expect(response).toMatchObject({ success: true });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: { threadId: "monitor-thread", status: { type: "systemError" } },
        },
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/failed",
          params: {
            threadId: "monitor-thread",
            turnId: "monitor-turn",
            turn: {
              id: "monitor-turn",
              status: "failed",
              output: [],
              error: { message: "Selected model is at capacity. Please try a different model." },
            },
          },
        },
      });
      for (const method of ["thread/status/changed", "turn/failed"]) {
        expect(events.find((event) => event.notification.method === method
          && "threadId" in event.notification.params
          && event.notification.params.threadId === "monitor-thread")).toMatchObject({
          errorNoticeContext: { backend: "codex", threadId: "thread-1", taskMonitor: true },
          notification: { params: { threadId: "monitor-thread" } },
        });
      }
    } finally {
      await registry.close();
    }
  });

  it("stops a task monitor on its live recovery turn", async () => {
    const codexClient = new MockBackendClient({
      interruptEndsTurn: true,
      initializeResult: { methods: ["turn/start", "turn/interrupt"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
      startTurnResults: [
        { threadId: "monitor-thread", turnId: "monitor-turn-1" },
        { threadId: "monitor-thread", turnId: "monitor-recovery-turn" },
      ],
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });
    const delegationResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "parent-turn",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch an asynchronous task until it finishes.",
          pollIntervalSeconds: 20,
        },
      },
    } as AppServerPendingRequestNotification);
    const monitorId = JSON.parse(
      (delegationResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ).monitorId as string;

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "monitor-thread",
          turnId: "monitor-turn-1",
          turn: {
            id: "monitor-turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    });

    await expect(overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      subAgents: [
        expect.objectContaining({
          monitorId,
          monitorTurnId: "monitor-turn-1",
          status: "running",
        }),
      ],
    });

    await registry.stopSubAgent({
      backend: "codex",
      threadId: "thread-1",
      monitorId,
    });

    expect(codexClient.lastInterruptTurnParams).toEqual({
      threadId: "monitor-thread",
      turnId: "monitor-recovery-turn",
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/cancelled",
        params: {
          threadId: "monitor-thread",
          turnId: "monitor-recovery-turn",
          turn: {
            id: "monitor-recovery-turn",
            status: "cancelled",
            output: [],
          },
        },
      },
    });

    expect(codexClient.startTurnCallCount).toBe(2);
    await registry.close();
  });

  it("stops native Codex sub-agents using the child's active turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "turn/interrupt"] },
      replay: {
        entries: [
          {
            type: "activity",
            id: "activity-1",
            summary: "Working",
            details: [],
            turn: {
              id: "child-turn",
              status: "in_progress",
            },
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          subAgents: [
            {
              monitorId: "codex-native:child-thread",
              task: "Investigate the issue",
              status: "running",
              createdAt: 1,
              updatedAt: 1,
              ownerRuntimeInstanceId: "runtime-current",
              backend: "codex",
              monitorThreadId: "child-thread",
              monitorTurnId: "parent-turn",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      runtimeInstanceId: "runtime-current",
      resolveLiveProfileRuntimeInstanceIds: () => ["runtime-current"],
    });

    await registry.stopSubAgent({
      backend: "codex",
      threadId: "thread-1",
      monitorId: "codex-native:child-thread",
    });

    expect(codexClient.lastReadThreadParams).toMatchObject({
      threadId: "child-thread",
      includeTurns: true,
    });
    expect(codexClient.lastInterruptTurnParams).toMatchObject({
      threadId: "child-thread",
      turnId: "child-turn",
    });
    await expect(overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      subAgents: [
        expect.objectContaining({
          monitorId: "codex-native:child-thread",
          status: "cancelled",
          outcome: "cancelled",
        }),
      ],
    });
    await registry.close();
  });

  it("locally closes an orphaned sub-agent when Stop cannot reach its old runtime", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/interrupt"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          subAgents: [
            {
              monitorId: "monitor-orphaned",
              task: "Monitor work from before a reboot",
              status: "running",
              createdAt: 1_000,
              updatedAt: 1_500,
              ownerRuntimeInstanceId: "runtime-dead",
              backend: "codex",
              monitorThreadId: "monitor-thread",
              monitorTurnId: "monitor-turn",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      runtimeInstanceId: "runtime-current",
      resolveLiveProfileRuntimeInstanceIds: () => ["runtime-current"],
    });

    await expect(registry.stopSubAgent({
      backend: "codex",
      threadId: "thread-1",
      monitorId: "monitor-orphaned",
    })).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      monitorId: "monitor-orphaned",
    });

    expect(codexClient.interruptTurnCallCount).toBe(0);
    await expect(overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    })).resolves.toMatchObject({
      subAgents: [
        expect.objectContaining({
          monitorId: "monitor-orphaned",
          status: "cancelled",
          outcome: "cancelled",
          completedAt: 1_500,
          updatedAt: 1_500,
          lastMessage:
            "Stop was requested after its owning PwrAgent runtime had already stopped.",
          completionSource: {
            type: "parent_cancel",
          },
        }),
      ],
    });
    await registry.close();
  });

  it("does not stop a sub-agent owned by another live PwrAgent instance", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/interrupt"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          subAgents: [
            {
              monitorId: "monitor-other-runtime",
              task: "Monitor work owned elsewhere",
              status: "running",
              createdAt: 1_000,
              updatedAt: 1_500,
              ownerRuntimeInstanceId: "runtime-other",
              backend: "codex",
              monitorThreadId: "monitor-thread",
              monitorTurnId: "monitor-turn",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      runtimeInstanceId: "runtime-current",
      resolveLiveProfileRuntimeInstanceIds: () => [
        "runtime-current",
        "runtime-other",
      ],
    });

    await expect(registry.stopSubAgent({
      backend: "codex",
      threadId: "thread-1",
      monitorId: "monitor-other-runtime",
    })).rejects.toThrow(
      "Sub-agent is controlled by another live PwrAgent instance.",
    );
    expect(codexClient.interruptTurnCallCount).toBe(0);
    await registry.close();
  });

  it("interrupts stale active monitors before fallback completion", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread" },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribeEvents = registry.onEvent((event) => {
      events.push(event);
    });
    const checkStaleTaskMonitors = async (now?: number) =>
      await registryModules(registry).subAgentMonitorService.checkStaleTaskMonitors(now);
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
    const delegationResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch an asynchronous task until it finishes.",
          pollIntervalSeconds: 20,
        },
      },
    } as AppServerPendingRequestNotification);
    const monitorId = JSON.parse(
      (delegationResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ).monitorId as string;
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/started",
        params: {
          threadId: "monitor-thread",
          turnId: "turn-1",
          item: { id: "cmd-1", type: "commandExecution" },
        },
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "monitor-thread",
          turnId: "turn-1",
          item: { id: "cmd-1", type: "commandExecution" },
        },
      },
    });

    await checkStaleTaskMonitors(Date.now() + 90_000);

    expect(codexClient.interruptTurnCallCount).toBe(1);
    expect(codexClient.lastInterruptTurnParams).toEqual({
      threadId: "monitor-thread",
      turnId: "turn-1",
    });
    expect(codexClient.injectedThreadItems).toHaveLength(0);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/cancelled",
        params: {
          threadId: "monitor-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "cancelled", output: [] },
        },
      },
    });

    expect(codexClient.startTurnCallCount).toBe(2);
    expect(codexClient.startTurnCalls[1]).toMatchObject({
      threadId: "monitor-thread",
      model: "gpt-5.6-luna",
    });
    expect(
      codexClient.startTurnCalls[1]?.input[0]?.type === "text"
        ? codexClient.startTurnCalls[1].input[0].text
        : "",
    ).toContain("pwragent.complete_monitoring");

    await checkStaleTaskMonitors(Date.now() + 180_000);

    expect(codexClient.injectedThreadItems).toHaveLength(0);
    const completionStateEvent = events.find((event) => {
      if (event.notification.method !== "item/completed") {
        return false;
      }
      const item = event.notification.params.item as {
        data?: Record<string, unknown>;
        type?: string;
      };
      return item.type === "taskMonitorCompletion";
    });
    expect(completionStateEvent).toMatchObject({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: `monitor:${monitorId}`,
          item: {
            type: "taskMonitorCompletion",
            data: {
              source: "pwragent_task_monitor",
              monitorId,
              outcome: "failure",
              fallbackGenerated: true,
              completionSource: {
                type: "pwragent_fallback",
                reason: "monitor_recovery_turn_stale_without_completion",
                recoveryAttempted: true,
              },
            },
          },
        },
      },
    });

    unsubscribeEvents();
    await registry.close();
  });

  it("rejects task monitor updates from a different monitor thread after binding", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      models: TEST_TASK_MONITOR_MODELS,
      startThreadResult: { threadId: "monitor-thread-1" },
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
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    const delegationResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch PR checks.",
        },
      },
    } as AppServerPendingRequestNotification);
    const monitorId = JSON.parse(
      (delegationResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]?.text ?? "{}",
    ).monitorId as string;
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "monitor-thread-1",
          turnId: "monitor-turn-1",
          turn: { id: "monitor-turn-1" },
        },
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "monitor-thread-2",
          turnId: "monitor-turn-2",
          turn: { id: "monitor-turn-2" },
        },
      },
    });
    await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "monitor-thread-1",
        turnId: "monitor-turn-1",
        callId: "call-2",
        requestId: "call-2",
        namespace: "pwragent_task_monitors",
        tool: "inject_progress",
        arguments: {
          monitorId,
          message: "build is running",
        },
      },
    } as AppServerPendingRequestNotification);

    const rejected = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "monitor-thread-2",
        turnId: "monitor-turn-2",
        callId: "call-3",
        requestId: "call-3",
        namespace: "pwragent_task_monitors",
        tool: "inject_progress",
        arguments: {
          monitorId,
          message: "spoofed update",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(rejected).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "forbidden",
              message: "This monitorId is already bound to another monitor thread.",
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(codexClient.injectedThreadItems).toHaveLength(0);

    await registry.close();
  });

  it("forwards pagination parameters when reading a thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
      before: "cursor-1",
      limit: 25,
    });

    expect(codexClient.lastReadThreadParams).toEqual({
      threadId: "thread-1",
      before: "cursor-1",
      limit: 25,
    });

    await registry.close();
  });

  it.each(["idle", "active"] as const)("checks a persisted running worker outside global discovery before exposing its disclosure (%s)", async (status) => {
    vi.useFakeTimers();
    const now = Date.now();
    const codexClient = new MockBackendClient({
      threads: [{
        id: "thread-parent", source: "codex", title: "Review audit",
        titleSource: "explicit", linkedDirectories: [], updatedAt: now,
      }],
    });
    const read = vi.spyOn(codexClient, "readThread").mockResolvedValue({
      threadStatus: status, lastAssistantMessage: "Finished while offline",
      entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false },
    });
    const overlayStore = createOverlayStoreMock();
    await overlayStore.upsertThreadSubAgent({
      backend: "codex", threadId: "thread-parent",
      subAgent: {
        monitorId: "codex-native:worker-review", monitorThreadId: "worker-review",
        backend: "codex", task: "Review savers", status: "running",
        createdAt: now - 10_000, updatedAt: now - 1_000, lastMessage: "Still running",
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    try {
      const threads = await registry.listThreads({ backend: "codex" });
      expect(threads[0]?.codexNativeSubAgents?.[0]?.threadStatus).toBe(status);
      expect(read).toHaveBeenCalledWith({ threadId: "worker-review", includeTurns: false, limit: 0 });
      read.mockClear();
      await registry.listThreads({ backend: "codex", forceRefresh: true });
      expect(read).not.toHaveBeenCalled();
      if (status === "active") {
        read.mockResolvedValue({
          threadStatus: "idle", lastAssistantMessage: "Finished while offline",
          entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false },
        });
        await vi.advanceTimersByTimeAsync(15_000);
      }
      const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-parent" });
      expect(overlay?.subAgents?.[0]).toMatchObject({ status: "success", lastMessage: "Finished while offline" });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it.each([
    { state: "completed", expected: "success", stored: false, nested: false, threadStatus: "notLoaded" },
    { state: "interrupted", expected: "cancelled", stored: false, nested: false, threadStatus: "idle" },
    { state: "completed", expected: "success", stored: true, nested: false, threadStatus: "notLoaded" },
    { state: "interrupted", expected: "cancelled", stored: "success", nested: false, threadStatus: "idle" },
    { state: "completed", expected: "success", stored: false, nested: true, threadStatus: "notLoaded" },
  ] as const)("recovers opened-thread workers outside global discovery ($state, stored=$stored, nested=$nested)", async ({ state, expected, stored, nested, threadStatus }) => {
    const now = Date.now();
    const parent: AppServerThreadSummary = {
      id: "thread-parent", source: "codex", title: "Review audit",
      titleSource: "explicit", linkedDirectories: [], updatedAt: now,
    };
    const worker: AppServerThreadSummary = {
      id: "worker-review", source: "codex", title: "Review savers",
      titleSource: "derived", linkedDirectories: [], createdAt: now - 10_000,
      updatedAt: now - 1_000, threadStatus, model: "gpt-6-luna",
      reasoningEffort: "high",
      codexNativeSubAgent: { parentThreadId: parent.id, agentNickname: "Noether" },
    };
    const codexClient = new MockBackendClient({
      threads: [parent],
      replay: {
        messages: [], pagination: { supportsPagination: true, hasPreviousPage: false },
        entries: [{
          type: "activity", id: "review-completed", summary: "Worker completed", status: "completed",
          turn: { id: "turn-review", status: "completed", completedAt: now },
          details: [{
            id: "completed-review", kind: "command", label: "Completed review",
            command: {
              displayCommand: "wait worker-review",
              subAgent: {
                backend: "codex", origin: "codex-native", operation: state === "interrupted" ? "close" : "wait",
                agents: [{ threadId: worker.id, name: "review_savers", status: state }],
              },
            },
          }],
        }],
      },
    });
    const descendant: AppServerThreadSummary = {
      ...worker, id: "worker-descendant", threadStatus: "active",
      codexNativeSubAgent: { parentThreadId: worker.id, depth: 2, agentNickname: "Erdos" },
    };
    const discovery = vi.spyOn(codexClient, "listNativeSubAgentThreads")
      .mockImplementation(async (params) => params?.ancestorThreadId === parent.id
        ? [worker, ...(nested ? [descendant] : [])] : []);
    const overlayStore = createOverlayStoreMock();
    if (stored) {
      await overlayStore.upsertThreadSubAgent({
        backend: "codex", threadId: parent.id,
        subAgent: {
          monitorId: "codex-native:worker-review", monitorThreadId: worker.id,
          task: "Review savers", status: stored === "success" ? "success" : "running", backend: "codex",
          createdAt: now - 10_000, updatedAt: now - 1_000, lastMessage: "Still running",
        },
      });
    }
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    try {
      if (!stored) {
        expect((await registry.listThreads({ backend: "codex" }))[0]?.codexNativeSubAgents).toBeUndefined();
      }
      await registry.readThread({ backend: "codex", threadId: parent.id });
      await (registry as unknown as { transcriptRepairs: Map<string, Promise<void>> }).transcriptRepairs.get(parent.id);
      const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: parent.id });
      expect(overlay?.subAgents).toEqual(expect.arrayContaining([expect.objectContaining({
        monitorThreadId: worker.id, agentName: "Noether", status: expected, outcome: expected,
        preferredModel: "gpt-6-luna", preferredReasoningEffort: "high",
      })]));
      expect(discovery).toHaveBeenCalledWith({ ancestorThreadId: parent.id });
      const threads = await registry.listThreads({ backend: "codex", forceRefresh: true });
      expect(threads[0]?.codexNativeSubAgents).toEqual(expect.arrayContaining([expect.objectContaining({
        threadId: worker.id, agentNickname: "Noether", threadStatus: "idle",
      })]));
      if (nested) {
        await codexClient.emit({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: descendant.id, turnId: "turn-descendant", model: "gpt-6-luna",
            tokenUsage: {
              total: { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 50 },
              last: { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 50 },
            },
          },
        });
        const updated = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: parent.id });
        expect(updated?.subAgents?.find((agent) => agent.monitorThreadId === descendant.id)?.monitorUsage?.tokenUsage)
          .toMatchObject({ inputTokens: 1_000, outputTokens: 50 });
        const pricing = await overlayStore.readThreadPricing({ backend: "codex", threadId: parent.id });
        expect(pricing.lines).toEqual(expect.arrayContaining([expect.objectContaining({
          parentThreadId: parent.id, threadId: descendant.id, scope: "monitor", turnId: "turn-descendant",
        })]));
      }
      discovery.mockClear();
      await registry.readThread({ backend: "codex", threadId: parent.id });
      expect(discovery).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  });

  it("discovers a finished worker's model when its parent opens, and prices its existing usage", async () => {
    const now = Date.now();
    const parent: AppServerThreadSummary = {
      id: "thread-parent", source: "codex", title: "Breakfast poem",
      titleSource: "explicit", linkedDirectories: [], updatedAt: now,
    };
    const worker: AppServerThreadSummary = {
      id: "worker-poet", source: "codex", title: "",
      titleSource: "fallback", linkedDirectories: [], createdAt: now - 10_000,
      updatedAt: now - 1_000, threadStatus: "notLoaded", model: "gpt-5.5",
      reasoningEffort: "high",
      codexNativeSubAgent: { parentThreadId: parent.id, agentNickname: "Descartes" },
    };
    const codexClient = new MockBackendClient({
      threads: [parent],
      replay: {
        messages: [], pagination: { supportsPagination: true, hasPreviousPage: false },
        entries: [{
          type: "activity", id: "poet-finished", summary: "1 finished", status: "completed",
          turn: { id: "turn-parent", status: "completed", completedAt: now },
          details: [{
            id: "completed-poet", kind: "command", label: "Descartes finished", status: "completed",
            command: {
              displayCommand: "subAgentActivity completed /root/breakfast_poet",
              rawCommand: "subAgentActivity",
              subAgent: {
                backend: "codex", origin: "codex-native", operation: "complete",
                agents: [{ threadId: worker.id, name: "breakfast_poet", status: "completed" }],
              },
            },
          }],
        }],
      },
    });
    const discovery = vi.spyOn(codexClient, "listNativeSubAgentThreads")
      .mockImplementation(async (params) => params?.ancestorThreadId === parent.id ? [worker] : []);
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    // Lifecycle reports finish the card, so its status already matches the
    // replay. This client cannot read thread settings, so the card and its
    // usage line have no model: the state an earlier build left behind.
    for (const kind of ["started", "completed"] as const) {
      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: parent.id, turnId: "turn-parent",
          item: { type: "subAgentActivity", id: `activity-${kind}`, kind,
            agentThreadId: worker.id, agentPath: "/root/breakfast_poet" },
        },
      } as AppServerNotification);
    }
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: worker.id, turnId: "turn-worker",
        tokenUsage: {
          total: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 50 },
          last: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 50 },
        },
      },
    } as AppServerNotification);
    expect((await overlayStore.readThreadPricing({ backend: "codex", threadId: parent.id })).lines)
      .toEqual([expect.objectContaining({ priceUnavailableReason: "missing-model" })]);
    expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: parent.id }))
      ?.subAgents?.[0]).toMatchObject({ status: "success" });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => { events.push(event); });
    try {
      await registry.readThread({ backend: "codex", threadId: parent.id });
      await (registry as unknown as { transcriptRepairs: Map<string, Promise<void>> }).transcriptRepairs.get(parent.id);
      expect(discovery).toHaveBeenCalledWith({ ancestorThreadId: parent.id });
      const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: parent.id });
      expect(overlay?.subAgents?.[0]).toMatchObject({
        status: "success", preferredModel: "gpt-5.5", preferredReasoningEffort: "high",
      });
      // The same line, with its own worker turn, now carrying the model. The
      // sqlite store reprices it on write; this mock stores lines verbatim.
      const pricing = await overlayStore.readThreadPricing({ backend: "codex", threadId: parent.id });
      expect(pricing.lines).toEqual([expect.objectContaining({
        threadId: worker.id, turnId: "turn-worker", model: "gpt-5.5", reasoningEffort: "high",
      })]);
      expect(events.some((event) => event.notification.method === "thread/pricing/updated")).toBe(true);
      // The card has its model now, so reopening the parent asks nothing.
      discovery.mockClear();
      await registry.readThread({ backend: "codex", threadId: parent.id });
      await (registry as unknown as { transcriptRepairs: Map<string, Promise<void>> }).transcriptRepairs.get(parent.id);
      expect(discovery).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      await registry.close();
    }
  });

  it("names Codex workers pathName, then nickname, whichever source reports first", async () => {
    const now = Date.now();
    const spawned = (id: string, agentPath: string | undefined, agentNickname: string): AppServerThreadSummary => ({
      id, title: "", titleSource: "fallback", linkedDirectories: [], source: "codex",
      createdAt: now - 20, updatedAt: now - 10, threadStatus: "active",
      codexNativeSubAgent: {
        parentThreadId: "thread-parent", depth: 1,
        ...(agentPath ? { agentPath } : {}), agentNickname,
      },
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [{
        id: "thread-parent", title: "Breakfast", titleSource: "explicit",
        linkedDirectories: [], source: "codex", updatedAt: now,
      }],
      nativeSubAgentThreads: [
        spawned("worker-politics", "/root/breakfast_politics", "Jason"),
        spawned("worker-poem", "/root/breakfast_poem", "Planck"),
        // A spawnAgent worker has no path; Codex's nickname is its name.
        spawned("worker-legacy", undefined, "Euler"),
      ],
    });
    const overlayStore = createOverlayStoreMock();
    // A card an earlier build named after the nickname.
    await overlayStore.upsertThreadSubAgent({
      backend: "codex", threadId: "thread-parent",
      subAgent: {
        monitorId: "codex-native:worker-poem", monitorThreadId: "worker-poem",
        task: "Codex sub-agent poem", agentName: "Planck", status: "running", backend: "codex",
        createdAt: now - 20, updatedAt: now - 10,
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    try {
      // The lifecycle report names the worker by its path before discovery runs.
      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: "thread-parent", turnId: "turn-parent",
          item: { type: "subAgentActivity", id: "politics-started", kind: "started",
            agentThreadId: "worker-politics", agentPath: "/root/breakfast_politics" },
        },
      } as AppServerNotification);
      const names = async () => (await overlayStore.getThreadOverlayState({
        backend: "codex", threadId: "thread-parent",
      }))?.subAgents?.map((card) => [card.monitorThreadId, card.agentName]);
      expect(await names()).toEqual(expect.arrayContaining([
        ["worker-politics", "breakfast_politics"],
      ]));

      const threads = await registry.listThreads({ backend: "codex", forceRefresh: true });
      expect(await names()).toEqual(expect.arrayContaining([
        ["worker-politics", "breakfast_politics"],
        ["worker-poem", "breakfast_poem"],
        ["worker-legacy", "Euler"],
      ]));
      // The sidebar tray reads the same names.
      expect(threads[0]?.codexNativeSubAgents?.map((agent) => [agent.threadId, agent.agentNickname]))
        .toEqual(expect.arrayContaining([
          ["worker-politics", "breakfast_politics"],
          ["worker-poem", "breakfast_poem"],
          ["worker-legacy", "Euler"],
        ]));
    } finally {
      await registry.close();
    }
  });

  it("groups native Codex workers below their ordinary parent without making rows", async () => {
    const now = Date.now();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-parent",
          title: "Plan the release",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 100,
        },
      ],
      nativeSubAgentThreads: [
        {
          id: "thread-worker-b",
          title: "Review release notes",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          createdAt: now - CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS - 2,
          updatedAt: now - CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS - 1,
          threadStatus: "idle",
          codexNativeSubAgent: {
            parentThreadId: "thread-parent",
            depth: 1,
            agentNickname: "release-reviewer",
            agentRole: "reviewer",
          },
        },
        {
          id: "thread-worker-a-child",
          title: "Check release links",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          createdAt: now - (2 * CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS),
          updatedAt: now - (2 * CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS),
          threadStatus: "active",
          codexNativeSubAgent: {
            parentThreadId: "thread-worker-a",
            depth: 2,
            agentNickname: "link-checker",
            agentRole: "researcher",
          },
        },
        {
          id: "thread-worker-a",
          title: "Draft release notes",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          createdAt: now - 20,
          updatedAt: now - 10,
          threadStatus: "idle",
          codexNativeSubAgent: {
            parentThreadId: "thread-parent",
            depth: 1,
            agentNickname: "release-writer",
            agentRole: "writer",
          },
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({ executionMode: "default" });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    const threads = await registry.listThreads({ backend: "codex" });

    expect(threads.map((thread) => thread.id)).toEqual(["thread-parent"]);
    expect(threads[0]?.codexNativeSubAgents).toEqual([
      {
        threadId: "thread-worker-a",
        title: "Draft release notes",
        createdAt: now - 20,
        updatedAt: now - 10,
        threadStatus: "idle",
        depth: 1,
        agentNickname: "release-writer",
        agentRole: "writer",
      },
      {
        threadId: "thread-worker-a-child",
        title: "Check release links",
        createdAt: now - (2 * CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS),
        updatedAt: now - (2 * CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS),
        threadStatus: "active",
        depth: 2,
        agentNickname: "link-checker",
        agentRole: "researcher",
      },
    ]);
    expect(codexClient.listNativeSubAgentThreadsCallCount).toBe(1);
    expect(codexClient.lastListNativeSubAgentThreadsParams).toEqual({});
    expect(
      (
        await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-parent",
        })
      )?.subAgents,
    ).toEqual([
      expect.objectContaining({
        monitorId: "codex-native:thread-worker-a",
        monitorThreadId: "thread-worker-a",
        agentName: "release-writer",
        status: "success",
      }),
      expect.objectContaining({
        monitorId: "codex-native:thread-worker-a-child",
        monitorThreadId: "thread-worker-a-child",
        agentName: "link-checker",
        status: "running",
      }),
    ]);

    await registry.close();
  });

  it("does not reconcile a grouped handoff discovered as a native Codex worker", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "handoff-parent",
          title: "Parent investigation",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 100,
        },
      ],
      nativeSubAgentThreads: [
        {
          id: "handoff-child",
          title: "Repair the child issue",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          createdAt: 20,
          updatedAt: 40,
          threadStatus: "idle",
          codexNativeSubAgent: {
            parentThreadId: "handoff-parent",
            depth: 1,
          },
        },
      ],
    });
    const overlayStore = createOverlayStoreMock();
    await overlayStore.setThreadHandoffOrigin({
      backend: "codex",
      threadId: "handoff-child",
      handoffOrigin: {
        sourceBackend: "codex",
        sourceThreadId: "handoff-parent",
        sourceTurnId: "turn-handoff-parent",
        seedMode: "clean",
        groupingMode: "subthread",
        createdAt: 1_800_000_000_000,
        workspace: {
          mode: "new_worktree",
          cwd: "/tmp/pwragent-handoff-child",
          git: {
            kind: "git_worktree",
            worktreeCreationAvailable: true,
          },
        },
      },
    });
    const upsertThreadSubAgent = vi.spyOn(
      overlayStore,
      "upsertThreadSubAgent",
    );
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({ backend: "codex" });

    expect(upsertThreadSubAgent).not.toHaveBeenCalled();
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "handoff-parent",
      }),
    ).resolves.toBeUndefined();

    await registry.close();
  });

  it.each(["mock", "sqlite"] as const)("backfills native Codex cards and pricing from durable child turn usage (%s)", async (storeKind) => {
    const nativeThreadId = "thread-epicurus";
    const now = Date.now();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-parent",
          title: "Investigate the regression",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 100,
        },
      ],
      nativeSubAgentThreads: [
        {
          id: nativeThreadId,
          title: "Audit settings discovery calls",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          createdAt: now - 40,
          updatedAt: now - 20,
          threadStatus: "idle",
          // Codex reports the worker's own settings, which are not its parent's.
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
          codexNativeSubAgent: {
            parentThreadId: "thread-parent",
            depth: 1,
            agentNickname: "Epicurus",
          },
        },
      ],
    });
    const stateDb = storeKind === "sqlite" ? openInMemoryStateDb() : undefined;
    const overlayStore = stateDb ? new SqliteOverlayStore(stateDb) : createOverlayStoreMock();
    let registry: DesktopBackendRegistry | undefined;
    onTestFinished(async () => { await registry?.close(); stateDb?.close(); });
    await overlayStore.upsertThreadUsageLine({
      line: {
        usageLineId: "codex:thread-parent:turn-parent:live-token-usage",
        backend: "codex",
        provider: "openai",
        threadId: "thread-parent",
        turnId: "turn-parent",
        source: "live",
        scope: "turn",
        status: "finalized",
        createdAt: 25,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        fastMode: false,
        settingsSource: "event",
        settingsConfidence: "exact",
        inputTokens: 1_000,
        cachedInputTokens: 800,
        uncachedInputTokens: 200,
        outputTokens: 50,
        reasoningOutputTokens: 10,
        totalTokens: 1_060,
        priceStatus: "priced",
        currency: "USD",
        uncachedInputCostMicros: 0,
        cachedInputCostMicros: 0,
        outputCostMicros: 0,
        totalCostMicros: 0,
      },
    });
    await overlayStore.persistThreadUsageActivity({
      backend: "codex",
      threadId: nativeThreadId,
      activity: {
        type: "activity",
        id: "live-turn-usage-turn-epicurus",
        createdAt: 35,
        summary:
          "Turn usage: 106,640 uncached in · 2,811,136 cached · 11,224 out (4,269 reasoning)",
        status: "completed",
        details: [],
        turn: {
          id: "turn-epicurus",
          status: "completed",
          completedAt: 35,
        },
      },
    });
    const upsertThreadSubAgent = vi.spyOn(
      overlayStore,
      "upsertThreadSubAgent",
    );
    const upsertThreadUsageLine = vi.spyOn(
      overlayStore,
      "upsertThreadUsageLine",
    );
    const fullOverlayReads = vi.spyOn(overlayStore, "getThreadOverlayStates");
    const usageActivityReads = vi.spyOn(overlayStore as SqliteOverlayStore, "readThreadUsageActivities");
    registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({ backend: "codex" });
    await registry.listThreads({ backend: "codex", forceRefresh: true });

    const parentSubAgents = await overlayStore.listThreadSubAgents({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(parentSubAgents).toHaveLength(1);
    expect(parentSubAgents[0]).toMatchObject({
      monitorId: `codex-native:${nativeThreadId}`,
      monitorThreadId: nativeThreadId,
      monitorTurnId: "turn-epicurus",
      agentName: "Epicurus",
      task: "Audit settings discovery calls",
      status: "success",
      outcome: "success",
      preferredModel: "gpt-5.4-mini",
      preferredReasoningEffort: "low",
      preferredFastMode: false,
      monitorUsage: {
        tokenUsage: {
          cachedInputTokens: 2_811_136,
          inputTokens: 2_917_776,
          outputTokens: 11_224,
          reasoningOutputTokens: 4_269,
          uncachedInputTokens: 106_640,
        },
      },
    });
    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(pricing.lines).toHaveLength(2);
    const nativePricing = pricing.lines.find(
      (line) => line.sourceItemId === `codex-native:${nativeThreadId}`,
    );
    expect(nativePricing).toMatchObject({
      parentThreadId: "thread-parent",
      threadId: nativeThreadId,
      turnId: "turn-epicurus",
      source: "monitor",
      scope: "monitor",
      status: "finalized",
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      cachedInputTokens: 2_811_136,
      uncachedInputTokens: 106_640,
      outputTokens: 11_224,
      reasoningOutputTokens: 4_269,
    });
    expect(nativePricing?.totalCostMicros).toBeGreaterThan(0);
    expect(upsertThreadSubAgent).toHaveBeenCalledTimes(1);
    expect(upsertThreadUsageLine).toHaveBeenCalledTimes(1);
    if (storeKind === "sqlite") {
      // Each listing loads the discovered worker's durable usage rows. No
      // overlay, parent or worker, is read in full on either pass.
      expect(fullOverlayReads).not.toHaveBeenCalled();
      expect(usageActivityReads.mock.calls).toEqual([
        [{ backend: "codex", threadIds: [nativeThreadId] }],
        [{ backend: "codex", threadIds: [nativeThreadId] }],
      ]);
    }

    await registry.close();
  });

  it("leaves a native worker unpriced rather than price it at its parent's model", async () => {
    const nativeThreadId = "thread-epicurus";
    const now = Date.now();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-parent",
          title: "Investigate the regression",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 100,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      ],
      nativeSubAgentThreads: [
        {
          id: nativeThreadId,
          title: "Audit settings discovery calls",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          createdAt: now - 40,
          updatedAt: now - 20,
          threadStatus: "idle",
          codexNativeSubAgent: {
            parentThreadId: "thread-parent",
            depth: 1,
            agentNickname: "Epicurus",
          },
        },
      ],
    });
    const overlayStore = createOverlayStoreMock();
    await overlayStore.upsertThreadUsageLine({
      line: {
        usageLineId: "codex:thread-parent:turn-parent:live-token-usage",
        backend: "codex",
        provider: "openai",
        threadId: "thread-parent",
        turnId: "turn-parent",
        source: "live",
        scope: "turn",
        status: "finalized",
        createdAt: 25,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        fastMode: false,
        settingsSource: "event",
        settingsConfidence: "exact",
        inputTokens: 1_000,
        cachedInputTokens: 800,
        uncachedInputTokens: 200,
        outputTokens: 50,
        reasoningOutputTokens: 10,
        totalTokens: 1_060,
        priceStatus: "priced",
        currency: "USD",
        uncachedInputCostMicros: 0,
        cachedInputCostMicros: 0,
        outputCostMicros: 0,
        totalCostMicros: 0,
      },
    });
    await overlayStore.persistThreadUsageActivity({
      backend: "codex",
      threadId: nativeThreadId,
      activity: {
        type: "activity",
        id: "live-turn-usage-turn-epicurus",
        createdAt: 35,
        summary:
          "Turn usage: 106,640 uncached in · 2,811,136 cached · 11,224 out (4,269 reasoning)",
        status: "completed",
        details: [],
        turn: {
          id: "turn-epicurus",
          status: "completed",
          completedAt: 35,
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({ backend: "codex" });
    await registry.listThreads({ backend: "codex", forceRefresh: true });

    const parentOverlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    // Codex named no model for the worker; the parent's gpt-5.6-sol is not it.
    expect(parentOverlay?.subAgents?.[0]?.preferredModel).toBeUndefined();
    expect(parentOverlay?.subAgents?.[0]?.preferredReasoningEffort).toBeUndefined();
    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    const nativePricing = pricing.lines.find(
      (line) => line.sourceItemId === `codex-native:${nativeThreadId}`,
    );
    expect(nativePricing).toMatchObject({ threadId: nativeThreadId, scope: "monitor" });
    expect(nativePricing?.model).toBeUndefined();
    expect(nativePricing?.priceStatus).not.toBe("priced");

    await registry.close();
  });

  it("replaces a native worker's placeholder task with its discovered title", async () => {
    // Path-based workers report no prompt, so their cards start as a
    // placeholder. Three started together share a UUIDv7 prefix, which is how
    // the rail ended up with three cards of the same title.
    const now = Date.now();
    const workers = [
      {
        id: "019dde61-c9d6-70d2-9023-28669e27a63b",
        task: "Codex sub-agent 9e27a63b",
        title: "Review the SQLite write budgets",
      },
      {
        id: "019dde61-ca10-7aa1-8a2b-4f1e2d3c4b5a",
        // Spelling persisted before the placeholder used the random tail.
        task: "Codex subagent 019dde61",
        title: "Measure WAL growth",
      },
      {
        id: "019dde61-ca44-7bb3-9c3d-5a6b7c8d9e0f",
        // Derived from a real prompt: never overwritten.
        task: "Verify the docs links",
        title: "Something else entirely",
      },
    ];
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-parent",
          title: "Audit the release checklist",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 100,
        },
      ],
      nativeSubAgentThreads: workers.map((worker) => ({
        id: worker.id,
        title: worker.title,
        titleSource: "explicit" as const,
        linkedDirectories: [],
        source: "codex" as const,
        createdAt: now - 40,
        updatedAt: now - 20,
        threadStatus: "idle" as const,
        codexNativeSubAgent: {
          parentThreadId: "thread-parent",
          depth: 1,
        },
      })),
    });
    const overlayStore = createOverlayStoreMock();
    for (const worker of workers) {
      await overlayStore.upsertThreadSubAgent({
        backend: "codex",
        threadId: "thread-parent",
        subAgent: {
          monitorId: `codex-native:${worker.id}`,
          monitorThreadId: worker.id,
          backend: "codex",
          task: worker.task,
          status: "success",
          outcome: "success",
          createdAt: now - 40,
          updatedAt: now - 20,
          completedAt: now - 20,
        },
      });
    }
    const upsertThreadSubAgent = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({ backend: "codex" });
    await registry.listThreads({ backend: "codex", forceRefresh: true });

    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    const tasks = Object.fromEntries(
      (overlay?.subAgents ?? []).map((card) => [card.monitorThreadId, card.task]),
    );
    expect(tasks).toEqual({
      [workers[0]!.id]: "Review the SQLite write budgets",
      [workers[1]!.id]: "Measure WAL growth",
      [workers[2]!.id]: "Verify the docs links",
    });
    // Once per corrected card; the second pass finds nothing to write.
    expect(upsertThreadSubAgent).toHaveBeenCalledTimes(2);

    await registry.close();
  });

  it("repairs missing native Codex pricing from an existing card usage snapshot", async () => {
    const nativeThreadId = "thread-epicurus";
    const monitorId = `codex-native:${nativeThreadId}`;
    const now = Date.now();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-parent",
          title: "Investigate the regression",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 100,
        },
      ],
      nativeSubAgentThreads: [
        {
          id: nativeThreadId,
          title: "Audit settings discovery calls",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          createdAt: now - 40,
          updatedAt: now - 20,
          threadStatus: "idle",
          codexNativeSubAgent: {
            parentThreadId: "thread-parent",
            depth: 1,
            agentNickname: "Epicurus",
          },
        },
      ],
    });
    const overlayStore = createOverlayStoreMock();
    await overlayStore.upsertThreadSubAgent({
      backend: "codex",
      threadId: "thread-parent",
      subAgent: {
        monitorId,
        task: "Audit settings discovery calls",
        status: "success",
        createdAt: 20,
        updatedAt: 40,
        backend: "codex",
        monitorThreadId: nativeThreadId,
        monitorTurnId: "turn-epicurus",
        agentName: "Epicurus",
        preferredModel: "gpt-5.6-sol",
        preferredReasoningEffort: "high",
        preferredFastMode: false,
        outcome: "success",
        completedAt: 35,
        monitorUsage: {
          model: "gpt-5.6-sol",
          fastMode: false,
          summary:
            "106,640 uncached in · 2,811,136 cached · 11,224 out (4,269 reasoning)",
          tokenUsage: {
            cachedInputTokens: 2_811_136,
            inputTokens: 2_917_776,
            outputTokens: 11_224,
            reasoningOutputTokens: 4_269,
            totalTokens: 2_933_269,
            uncachedInputTokens: 106_640,
          },
        },
      },
    });
    const upsertThreadSubAgent = vi.spyOn(
      overlayStore,
      "upsertThreadSubAgent",
    );
    const upsertThreadUsageLine = vi.spyOn(
      overlayStore,
      "upsertThreadUsageLine",
    );
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({ backend: "codex" });
    await registry.listThreads({ backend: "codex", forceRefresh: true });

    expect(upsertThreadSubAgent).not.toHaveBeenCalled();
    expect(upsertThreadUsageLine).toHaveBeenCalledTimes(1);
    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      parentThreadId: "thread-parent",
      threadId: nativeThreadId,
      turnId: "turn-epicurus",
      source: "monitor",
      sourceItemId: monitorId,
      scope: "monitor",
      status: "finalized",
      model: "gpt-5.6-sol",
      cachedInputTokens: 2_811_136,
      uncachedInputTokens: 106_640,
      outputTokens: 11_224,
      reasoningOutputTokens: 4_269,
    });
    expect(pricing.lines[0]?.totalCostMicros).toBeGreaterThan(0);

    await registry.close();
  });

  it("rejects a group archive when the owner parent changed before admission", async () => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["thread/list", "thread/archive"] }, threads: [] });
    const registry = createDesktopBackendRegistry({ codexClient,
      overlayStore: createOverlayStoreMock({ overlays: { "codex:child": { backend: "codex", threadId: "child",
        parentThreadId: "new-parent", parentThreadBackend: "codex", extraLinkedDirectories: [] } } }) });
    await expect(registry.archiveThread({ backend: "codex", threadId: "child",
      expectedParent: { backend: "codex", threadId: "old-parent" } })).rejects.toThrow("grouping changed");
    expect(codexClient.lastArchiveThreadParams).toBeUndefined();
    await registry.close();
  });

  it.each([false, true])("preserves adopted worktrees on archive (ownership on an archived thread: %s)", async (ownershipOnArchivedThread) => {
    const worktreePath = "/claude-worktrees/demo/interesting-poitras";
    const directory: LinkedDirectorySummary = {
      id: "provider-directory", kind: "worktree", label: "demo", path: "/repo/demo", worktreePath,
    };
    const thread: AppServerThreadSummary = {
      id: "thread-1", title: "Archive me", titleSource: "explicit", source: "codex", updatedAt: 1000,
      linkedDirectories: [{
        ...directory,
        worktreePath: ownershipOnArchivedThread ? worktreePath : "/.codex/worktrees/old/demo",
      }],
    };
    const markerThreadId = ownershipOnArchivedThread ? "previous-adopter" : thread.id;
    const overlayStore = createOverlayStoreMock({ overlays: {
      [`codex:${markerThreadId}`]: {
        backend: "codex", threadId: markerThreadId, extraLinkedDirectories: [{
          ...directory, id: `pwragent-handoff:codex:${markerThreadId}`, worktreeOwnership: "external",
        }],
      },
    } });
    const codexClient = new MockBackendClient({
      threads: [thread],
      archivedThreads: ownershipOnArchivedThread ? [{ ...thread, id: markerThreadId, archivedAt: 900 }] : [],
    });
    const archive = vi.fn();
    await mockArchiveWorktreePresence([worktreePath]);
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore, worktreeArchiveService: { archive } as never,
    });
    onTestFinished(() => registry.close());
    const result = await registry.archiveThread({ backend: "codex", threadId: thread.id });
    expect(codexClient.lastArchiveThreadParams).toEqual({ threadId: thread.id });
    expect(archive).not.toHaveBeenCalled();
    expect(result.cleanup).toEqual([expect.objectContaining({
      worktreePath, removedWorktree: false, deletedBranch: false,
      skippedReason: expect.stringContaining("Externally managed"),
    })]);
  });

  it("uses the ACP provider default when no monitor model catalog is available", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "acp-parent";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [],
    });
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      codexClient,
      sessions: [
        {
          backendId: acpBackendId,
          sessionId: parentThreadId,
          title: "ACP Parent",
          cwd: "/repo/app",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
        },
      ],
    });

    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: parentThreadId,
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });
    const response = await callRegistryMcpTool({
      registry,
      backend: acpBackendId,
      threadId: parentThreadId,
      turnId: "parent-turn",
      tool: "create_monitor_delegation",
      args: {
        task: "Watch the deployment until it finishes.",
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        parentThreadId,
        preferredModel: "kimi-default",
        preferredReasoningEffort: "provider-default",
        startedByPwrAgent: true,
      },
    });
    expect(codexClient.lastStartThreadParams).toBeUndefined();

    await registry.close();
  });

  it("does not borrow another session's thought levels for a monitor model without any", async () => {
    // The agent record's thought-level option is whichever session wrote
    // last. A K3 thread left K3's levels there; the monitor runs on K2.7
    // Coding, which offers none of them and refuses `low`.
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "acp-parent";
    const { acpClient, registry } = createKimiAcpRegistry({
      acpBackendId,
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        source: "session-load",
        configOptions: [
          {
            id: "model",
            label: "Model",
            type: "select",
            category: "model",
            currentValue: "kimi-code/k3",
            values: [
              { value: "kimi-code/kimi-for-coding" },
              { value: "kimi-code/k3" },
            ],
          },
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            category: "thought_level",
            currentValue: "low",
            values: [{ value: "low" }, { value: "high" }, { value: "max" }],
          },
        ],
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
              supportsReasoning: true,
              reasoningEfforts: ["low", "high", "max"],
              defaultReasoningEffort: "high",
            },
          ],
        },
      },
      sessions: [
        {
          backendId: acpBackendId,
          sessionId: parentThreadId,
          title: "ACP Parent",
          cwd: "/repo/app",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
          acpRuntime: {
            configValues: { model: "kimi-code/kimi-for-coding" },
            updatedAt: 1000,
          },
        },
      ],
    });

    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: parentThreadId,
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });
    const response = await callRegistryMcpTool({
      registry,
      backend: acpBackendId,
      threadId: parentThreadId,
      turnId: "parent-turn",
      tool: "create_monitor_delegation",
      args: {
        task: "Watch the deployment until it finishes.",
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        preferredModel: "kimi-code/kimi-for-coding",
        preferredReasoningEffort: "provider-default",
      },
    });
    expect(acpClient.setRuntimeOption).toHaveBeenCalled();
    for (const [params] of acpClient.setRuntimeOption.mock.calls) {
      expect(params).not.toMatchObject({ optionId: "thinking" });
      expect(params).not.toHaveProperty("reasoningEffort", "low");
    }

    await registry.close();
  });

  it("selects a monitor's own model without re-selecting the parent's", async () => {
    // Kimi selects the model through a config option, so the monitor's runtime
    // carries K3 there while `currentModelId` still named the parent's
    // Highspeed. Replaying that id re-selected Highspeed after K3, and paired
    // it with K3's `low` — a level Highspeed does not offer.
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "acp-parent";
    const { acpClient, registry } = createKimiAcpRegistry({
      acpBackendId,
      runtimeCapabilities: createKimiModelCapabilities(),
      sessions: [
        {
          backendId: acpBackendId,
          sessionId: parentThreadId,
          title: "ACP Parent",
          cwd: "/repo/app",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
          acpRuntime: {
            configValues: { model: KIMI_HIGHSPEED_MODEL, thinking: "on" },
            currentModelId: KIMI_HIGHSPEED_MODEL,
            reasoningEffort: "on",
            updatedAt: 1000,
          },
        },
      ],
    });

    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: parentThreadId,
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });
    await callRegistryMcpTool({
      registry,
      backend: acpBackendId,
      threadId: parentThreadId,
      turnId: "parent-turn",
      tool: "create_monitor_delegation",
      args: {
        task: "Watch the deployment until it finishes.",
        preferredModel: KIMI_K3_MODEL,
      },
    });

    expect(
      acpClient.setRuntimeOption.mock.calls.map(([params]) => params),
    ).toEqual([
      expect.objectContaining({
        source: "configOption",
        optionId: "model",
        value: "kimi-code/k3",
      }),
      expect.objectContaining({
        source: "configOption",
        optionId: "thinking",
        value: "low",
      }),
    ]);

    await registry.close();
  });

  it("recovers an ACP monitor once before a fallback wakes its parent", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "acp-parent";
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: parentThreadId,
        title: "ACP Parent",
        cwd: "/repo/app",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? `turn:${params.sessionId}`,
    }));
    const overlayStore = createOverlayStoreMock({
      overlays: {
        [`${acpBackendId}:${parentThreadId}`]: {
          backend: acpBackendId,
          threadId: parentThreadId,
          executionMode: "default",
          extraLinkedDirectories: [],
        },
      },
    });
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessions,
      sessionId: "acp-monitor",
      startPrompt,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: parentThreadId,
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });
    const response = await callRegistryMcpTool({
      registry,
      backend: acpBackendId,
      threadId: parentThreadId,
      turnId: "parent-turn",
      tool: "create_monitor_delegation",
      args: { task: "Watch the deployment until it finishes." },
    });
    const monitorId = String(response.structuredContent?.monitorId);
    const monitorThreadId = String(
      response.structuredContent?.monitorThreadId,
    );
    const firstMonitorTurnId = String(
      response.structuredContent?.monitorTurnId,
    );
    await emitCompletedTurn(
      registry,
      acpBackendId,
      parentThreadId,
      "parent-turn",
    );

    await emitCompletedTurn(
      registry,
      acpBackendId,
      monitorThreadId,
      firstMonitorTurnId,
    );
    expect(startPrompt).toHaveBeenCalledTimes(2);
    const recoveryTurnId = String(startPrompt.mock.calls[1]?.[0].turnId);
    expect(startPrompt.mock.calls[1]?.[0]).toMatchObject({
      sessionId: monitorThreadId,
      prompt: expect.stringContaining("monitor recovery instruction"),
    });

    await emitCompletedTurn(
      registry,
      acpBackendId,
      monitorThreadId,
      recoveryTurnId,
    );
    expect(startPrompt).toHaveBeenCalledTimes(3);
    expect(startPrompt.mock.calls[2]?.[0]).toMatchObject({
      sessionId: parentThreadId,
      prompt: expect.stringContaining(
        "Monitor subagent stopped without reporting a final result",
      ),
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: acpBackendId,
        threadId: parentThreadId,
      }),
    ).resolves.toMatchObject({
      subAgents: [
        expect.objectContaining({
          backend: acpBackendId,
          monitorId,
          outcome: "failure",
          completionSource: expect.objectContaining({
            type: "pwragent_fallback",
            recoveryAttempted: true,
          }),
        }),
      ],
    });

    await registry.close();
  });

  it.each([
    { name: "without causal context", causalContext: {} },
    {
      name: "with causal context",
      causalContext: { causalMessagingAmbiguous: true },
    },
  ])("persists a sub-agent origin for ACP monitor brief and recovery prompts $name", async ({ causalContext }) => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "acp-parent";
    const startPrompt = vi.fn((params: {
      sessionId: string;
      prompt: string;
      turnId?: string;
    }) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? `turn:${params.sessionId}`,
    }));
    const overlayStore = createOverlayStoreMock({
      overlays: {
        [`${acpBackendId}:${parentThreadId}`]: {
          backend: acpBackendId,
          threadId: parentThreadId,
          executionMode: "default",
          extraLinkedDirectories: [],
        },
      },
    });
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessions: [{
        backendId: acpBackendId,
        sessionId: parentThreadId,
        title: "ACP Parent",
        cwd: "/repo/app",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      }],
      sessionId: "acp-monitor",
      startPrompt,
      overlayStore,
    });
    if (causalContext.causalMessagingAmbiguous) {
      // The parent turn came from messaging, and its tools are allowed.
      await overlayStore.upsertThreadMessageOrigin!({
        backend: acpBackendId, threadId: parentThreadId, messageId: "user:parent-turn",
        origin: { kind: "messaging", ...causalContext },
      });
      registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(),
        checkDynamicToolPermission: () => ({ allowed: true }),
        authorizeRetainedTool: async () => ({ allowed: true }),
      });
    }
    await registry.publishLocalEvent({
      backend: acpBackendId,
      notification: {
        method: "turn/started",
        params: {
          threadId: parentThreadId,
          turnId: "parent-turn",
          turn: { id: "parent-turn" },
        },
      },
    });
    const response = await callRegistryMcpTool({
      registry,
      backend: acpBackendId,
      threadId: parentThreadId,
      turnId: "parent-turn",
      tool: "create_monitor_delegation",
      args: { task: "Watch the deployment until it finishes." },
    });
    expect(response.isError).not.toBe(true);
    const monitorThreadId = String(
      response.structuredContent?.monitorThreadId,
    );
    const firstMonitorTurnId = String(
      response.structuredContent?.monitorTurnId,
    );
    const origin = { kind: "sub-agent", ...causalContext };
    expect(overlayStore.upsertThreadMessageOrigin).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: monitorThreadId,
      messageId: `user:${firstMonitorTurnId}`,
      origin,
    });

    await emitCompletedTurn(
      registry,
      acpBackendId,
      parentThreadId,
      "parent-turn",
    );
    await emitCompletedTurn(
      registry,
      acpBackendId,
      monitorThreadId,
      firstMonitorTurnId,
    );
    expect(startPrompt).toHaveBeenCalledTimes(2);
    const recoveryTurnId = String(startPrompt.mock.calls[1]?.[0].turnId);
    expect(recoveryTurnId).not.toBe(firstMonitorTurnId);
    expect(overlayStore.upsertThreadMessageOrigin).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: monitorThreadId,
      messageId: `user:${recoveryTurnId}`,
      origin,
    });

    await registry.close();
  });

  it("gates an ACP tool call made before the turn's origin row is written", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const threadId = "acp-messaging-turn";
    const causalMessagingSource = { ownerId: "owner-1", requestId: "request-1" };
    const overlayStore = createOverlayStoreMock();
    // Hold the origin write open, so the tool call can only see the origin
    // through the registry's memory.
    let releaseOriginWrite!: () => void;
    const originWriteGate = new Promise<void>((resolve) => { releaseOriginWrite = resolve; });
    const writeOrigin = vi.mocked(overlayStore.upsertThreadMessageOrigin!);
    const persistOrigin = writeOrigin.getMockImplementation()!;
    writeOrigin.mockImplementation(async (params) => {
      await originWriteGate;
      return await persistOrigin(params);
    });
    let toolCall: Promise<string | null> | undefined;
    let registry!: DesktopBackendRegistry;
    // The agent calls a gated tool before startPrompt returns its turn id.
    const startPrompt = vi.fn((params: { sessionId: string; turnId?: string }) => {
      const turnId = params.turnId ?? `turn:${params.sessionId}`;
      toolCall = (registry as unknown as {
        authorizeAgentToolMcpCall(params: {
          backend: AppServerBackendKind;
          catalogId?: string;
          threadId: string;
          tool: string;
          turnId: string;
        }): Promise<string | null>;
      }).authorizeAgentToolMcpCall({
        backend: acpBackendId,
        catalogId: "thread_inspection",
        threadId: params.sessionId,
        tool: "read_thread",
        turnId,
      });
      return { sessionId: params.sessionId, turnId };
    });
    ({ registry } = createKimiAcpRegistry({
      acpBackendId,
      sessions: [{
        backendId: acpBackendId,
        sessionId: threadId,
        title: "Messaging turn",
        cwd: "/repo/app",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      }],
      sessionId: threadId,
      startPrompt,
      overlayStore,
    }));
    const authorizeRetainedTool = vi.fn(async () => ({ allowed: false, permission: "thread.read" }));
    const checkDynamicToolPermission = vi.fn(() => ({ allowed: true }));
    registry.setMessagingAgentToolService({ handlePwrAgentMessagingRequest: vi.fn(),
      checkDynamicToolPermission,
      authorizeRetainedTool,
    });

    const started = registry.startTurn({
      backend: acpBackendId,
      threadId,
      input: [{ type: "text", text: "Summarize the open threads" }],
      messageOrigin: { kind: "messaging", causalMessagingSource },
    });
    await vi.waitFor(() => expect(toolCall).toBeDefined());
    await expect(toolCall).resolves.toBe("thread.read");
    expect(authorizeRetainedTool).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, causalMessagingSource }),
      expect.objectContaining({ category: "thread_inspection", tool: "read_thread" }),
    );
    expect(checkDynamicToolPermission).not.toHaveBeenCalled();

    releaseOriginWrite();
    const turn = await started;
    expect(writeOrigin).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId,
      messageId: `user:${turn.turnId}`,
      origin: { kind: "messaging", causalMessagingSource },
    });

    await registry.close();
  });
});
