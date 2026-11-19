import {
  isCompletedItemType,
  flushAsync,
  createDeferred,
  git,
  waitForCondition,
  nextTurnEnd,
  createOverlayStoreMock,
  MockBackendClient,
  createKimiAgentRecord,
  KIMI_HIGHSPEED_MODEL,
  KIMI_K3_MODEL,
  createKimiModelCapabilities,
  type KimiStartPrompt,
  createKimiAcpRegistry,
  callRegistryMcpTool,
  discoverCodexBackendForTest,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import fc from "fast-check";
import type { Query as ClaudeQuery, SDKMessage as ClaudeMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import {
  mkdir,
  mkdtemp,
  rm,
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
import { buildThreadIdentityKey } from "@pwragent/shared";
import type {
  AcpBackendId,
  AgentEvent,
  AppServerBackendKind,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReviewContext,
  AppServerThreadEntry,
  AppServerTurnInputItem,
  BackendAcpSessionRuntimeState,
  CodexThreadEnvironmentRuntime,
  LinkedDirectorySummary,
  ThreadOverlayState,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { reviewStartFailureFingerprint } from "../app-server/thread-orchestration-prompts";
import { getReviewAutoFixArming } from "../thread-reviews/review-auto-fix";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
import type { PwrAgentThreadTodoHandler } from "../agent-tools/pwragent-thread-todo-agent-tools";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { admitSteerTurn } from "../scheduled-actions/steer-turn-admission";
import { ScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";

describe("DesktopBackendRegistry", () => {
  it("uses submitted launchpad model settings when materializing Codex review launchpads", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "review/start"],
      },
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          supportsFast: true,
          supportsReasoning: true,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/app",
      reviewTarget: { type: "baseBranch", branch: "main" },
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "/review main",
        workMode: "local",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "priority",
        fastMode: true,
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    expect(codexClient.lastStartThreadParams).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "priority",
      fastMode: true,
    });
    expect(codexClient.lastStartReviewParams).toMatchObject({
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "priority",
      fastMode: true,
    });

    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "priority",
      fastMode: true,
      prAutoDispatchEnabled: true,
    });

    await registry.close();
  });

  it("names a thread launched straight into a review", async () => {
    // A /review launch never calls startTurn, so the thread was born with no
    // user prompt for the title generator to work from and kept its fallback
    // name forever. Synthesize a prompt from what the review already knows:
    // the repository, the branch, and the review target.
    const titleService = {
      generateTitle: vi.fn(async (_params: { userPrompt: string }) => ({
        status: "generated" as const,
        title: "Review app against main",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/start", "thread/name/set", "review/start"],
      },
      threads: [],
    });
    // Title generation runs in the background. Observe its actual rename
    // boundary rather than assuming a fixed number of event-loop turns is enough.
    let resolveRenamed!: () => void;
    const renamed = new Promise<void>((resolve) => { resolveRenamed = resolve; });
    const renameThread = codexClient.renameThread.bind(codexClient);
    vi.spyOn(codexClient, "renameThread").mockImplementation(async (params) => {
      const result = await renameThread(params);
      resolveRenamed();
      return result;
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/app",
      reviewTarget: { type: "baseBranch", branch: "main" },
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        branchName: "agent/fix-remote-thread-project-home",
        backend: "codex",
        executionMode: "default",
        prompt: "/review main",
        workMode: "local",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    await renamed;
    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      userPrompt: expect.stringContaining("Review changes against main"),
    });
    const userPrompt =
      titleService.generateTitle.mock.calls[0]?.[0].userPrompt ?? "";
    expect(userPrompt).toContain("app");
    expect(userPrompt).toContain("agent/fix-remote-thread-project-home");
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-1",
      name: "Review app against main",
    });

    await registry.close();
  });

  it("names a Grok thread launched straight into a managed review", async () => {
    const acpBackendId = "acp:grok" as AcpBackendId;
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Review commit abc1234",
      })),
    };
    const { registry, sessions } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: "grok-review-launch",
      threadTitleGenerationService: titleService,
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/PwrAgnt",
      reviewTarget: { type: "commit", sha: "abc1234", title: "Fix homing" },
      launchpad: {
        directoryKey: "directory:/repo/PwrAgnt",
        directoryKind: "directory",
        directoryLabel: "PwrAgnt",
        directoryPath: "/repo/PwrAgnt",
        backend: acpBackendId,
        executionMode: "default",
        prompt: "/review --commit abc1234",
        workMode: "local",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    await registry.whenThreadTitleGenerationSettledForTests();
    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: "grok-review-launch",
      userPrompt: expect.stringContaining("Review commit abc1234 (Fix homing)"),
    });
    expect(sessions.some((session) => session.hidden)).toBe(true);

    await registry.close();
  });

  it("keeps an explicitly picked reviewer out of the thread's own model settings", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start", "review/start"] },
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", current: true, supportsReasoning: true },
        { id: "gpt-5.2", label: "GPT-5.2", supportsReasoning: true },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-parent": {
          backend: "codex",
          threadId: "thread-parent",
          model: "gpt-5.5",
          reasoningEffort: "medium",
        } as ThreadOverlayState,
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    await registry.startReview({
      backend: "codex",
      reviewBackend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
      model: "gpt-5.2",
      reasoningEffort: "high",
    });

    // The review itself runs on the picked model...
    expect(codexClient.lastStartReviewParams).toMatchObject({
      model: "gpt-5.2",
      reasoningEffort: "high",
    });
    // ...but the thread keeps answering as it did before.
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.model).toBe("gpt-5.5");
    expect(overlay?.reasoningEffort).toBe("medium");

    await registry.close();
  });

  it("still persists review model settings when no reviewer was picked", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start", "review/start"] },
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", current: true, supportsReasoning: true },
        { id: "gpt-5.2", label: "GPT-5.2", supportsReasoning: true },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-parent": {
          backend: "codex",
          threadId: "thread-parent",
          model: "gpt-5.5",
          reasoningEffort: "medium",
        } as ThreadOverlayState,
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    await registry.startReview({
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
      model: "gpt-5.2",
      reasoningEffort: "high",
    });

    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.model).toBe("gpt-5.2");

    await registry.close();
  });

  it("rejects a reviewer the instance cannot run reviews on", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start", "review/start"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    await expect(
      registry.startReview({
        backend: "codex",
        reviewBackend: "acp:gemini",
        threadId: "thread-parent",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      }),
    ).rejects.toThrow(/cannot run reviews/);

    await registry.close();
  });

  it("rejects a Claude thread's own review before checking its model against Codex", async () => {
    // A Claude thread's composer once sent its own provider and model as the
    // reviewer. The model check then read the Codex catalog and reported
    // "opus" missing from a list of GPT models.
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start", "review/start"] },
      models: [{ id: "gpt-5.5", label: "GPT-5.5", current: true, supportsReasoning: true }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      claudeBackendOptions: {
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [],
      },
    });
    try {
      const review = registry.startReview({
        backend: "claude",
        threadId: "claude-thread",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
        model: "opus",
        reasoningEffort: "high",
      });
      await expect(review).rejects.toThrow(
        "Selected review provider cannot run reviews: claude",
      );
      expect(codexClient.lastStartReviewParams).toBeUndefined();
      expect(codexClient.lastStartThreadParams).toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it("runs a Codex review child in its Claude parent's workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-review-"));
    const worktreePath = "/repo/.worktrees/claude-review";
    const claudeId = "7b2e3d4c-5f60-4b8c-9dae-1f2a3b4c5d6e";
    const store = new ClaudeSessionStore(path.join(root, "sessions"));
    await store.save({ cwd: worktreePath, thread: {
      id: claudeId, title: "Claude parent", titleSource: "explicit", source: "claude", updatedAt: 1,
      linkedDirectories: [{ id: worktreePath, kind: "local", label: "claude-review", path: worktreePath }],
    } });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [{ id: "gpt-5.5", label: "GPT-5.5", current: true, supportsReasoning: true }],
      startThreadResult: { threadId: "codex-review-child" },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      claudeBackendOptions: {
        store,
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [],
      },
    });
    try {
      const response = await registry.startReview({
        backend: "claude",
        reviewBackend: "codex",
        runMode: "pwragent-sub-agent",
        threadId: claudeId,
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
        model: "gpt-5.5",
        reasoningEffort: "high",
      });
      expect(response).toMatchObject({
        backend: "claude",
        threadId: claudeId,
        reviewThreadId: "codex-review-child",
      });
      // Without the parent's directory Codex reviews whatever directory its
      // own process started in.
      expect(codexClient.lastStartThreadParams).toMatchObject({
        cwd: worktreePath,
        ephemeral: true,
        model: "gpt-5.5",
      });
      expect(codexClient.lastStartTurnParams).toMatchObject({
        cwd: worktreePath,
        model: "gpt-5.5",
        reasoningEffort: "high",
      });
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: response.reviewThreadId,
          turnId: response.turnId,
          turn: {
            id: response.turnId,
            status: "completed",
            output: [{ type: "text", text: JSON.stringify({
              findings: [],
              overall_correctness: "patch is correct",
              overall_explanation: "No blocking findings.",
              overall_confidence_score: 0.98,
            }) }],
          },
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("managed review interruption routing", () => {
    // The real startReview path establishes ownership. Interrupting the visible
    // parent must reach that child, even when the parent is a Claude thread.
    async function interruptClaudeReview(parentId: string, childId: string): Promise<void> {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-review-interrupt-"));
      const store = new ClaudeSessionStore(path.join(root, "sessions"));
      await store.save({ cwd: "/repo", thread: {
        id: parentId, title: "Review parent", titleSource: "explicit", source: "claude", updatedAt: 1,
        linkedDirectories: [],
      } });
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "turn/start", "turn/interrupt"] },
        startThreadResult: { threadId: childId },
        interruptEndsTurn: true,
      });
      const registry = createDesktopBackendRegistry({
        codexClient, overlayStore: createOverlayStoreMock(), pdfToolMcpServer: null,
        claudeBackendOptions: {
          store,
          inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
          discoverModels: async () => [],
        },
      });
      let review: Awaited<ReturnType<DesktopBackendRegistry["startReview"]>> | undefined;
      try {
        review = await registry.startReview({ backend: "claude", threadId: parentId,
          reviewBackend: "codex", runMode: "pwragent-sub-agent", target: { type: "uncommittedChanges" } });
        const request = { backend: "claude" as const, threadId: parentId, turnId: review.turnId };
        expect(await registry.interruptTurn(request)).toEqual(request);
        expect(codexClient.lastInterruptTurnParams).toEqual({ threadId: childId, turnId: review.turnId });
        expect(codexClient.interruptTurnCallCount).toBe(1);
      } finally {
        if (review) await codexClient.emit({ method: "turn/cancelled", params: {
          threadId: childId, turnId: review.turnId,
          turn: { id: review.turnId, status: "cancelled", completedAt: 1_000 },
        } });
        await registry.close();
        await rm(root, { recursive: true, force: true });
      }
    }

    it("interrupts the owning review child across generated Claude parent identities", async () => {
      await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), interruptClaudeReview), { numRuns: 8 });
    });

    it("interrupts a Codex reviewer rather than its idle Claude parent", async () => {
      await interruptClaudeReview("00000000-0000-4000-8000-000000000000", "codex-review-child");
    });
  });

  it("runs a Claude thread's start_review tool call on a provider that can review", async () => {
    // Claude cannot run reviews. The tool used to answer "scheduled" with
    // Claude as the reviewer, and the start then failed in a log line when
    // the turn ended, so the review the agent promised never ran.
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-tool-review-"));
    const worktreePath = "/repo/.worktrees/claude-tool-review";
    const claudeId = "4c1f2e3d-6a70-4b8c-9dae-2f3a4b5c6d7e";
    const store = new ClaudeSessionStore(path.join(root, "sessions"));
    await store.save({ cwd: worktreePath, thread: {
      id: claudeId, title: "Claude parent", titleSource: "explicit", source: "claude", updatedAt: 1,
      linkedDirectories: [{ id: worktreePath, kind: "local", label: "claude-tool-review", path: worktreePath }],
    } });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start", "turn/interrupt"] },
      models: [{ id: "gpt-5.5", label: "GPT-5.5", current: true, supportsReasoning: true }],
      startThreadResult: { threadId: "codex-review-child" },
      interruptEndsTurn: true,
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        store,
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [],
      },
    });
    try {
      await registry.publishLocalEvent({
        backend: "claude",
        notification: {
          method: "turn/started",
          params: { threadId: claudeId, turnId: "claude-turn-1", turn: { id: "claude-turn-1" } },
        },
      });

      const response = await callRegistryMcpTool({
        registry,
        backend: "claude",
        threadId: claudeId,
        turnId: "claude-turn-1",
        tool: "start_review",
        args: {
          runMode: "pwragent-sub-agent",
          target: { type: "baseBranch", branch: "main" },
        },
      });
      expect(response).toMatchObject({
        structuredContent: { backend: "claude", threadId: claudeId, status: "scheduled" },
      });
      // The agent can tell the operator who will review.
      expect(JSON.stringify(response)).toContain("Review scheduled to run on OpenAI");
      expect(codexClient.lastStartThreadParams).toBeUndefined();

      await registry.publishLocalEvent({
        backend: "claude",
        notification: {
          method: "turn/completed",
          params: {
            threadId: claudeId,
            turnId: "claude-turn-1",
            turn: { id: "claude-turn-1", status: "completed", output: [] },
          },
        },
      });

      await vi.waitFor(() => {
        expect(codexClient.lastStartThreadParams).toMatchObject({
          cwd: worktreePath,
          ephemeral: true,
        });
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails a Claude thread's start_review tool call when no provider can review", async () => {
    // Codex here supports neither review/start nor a managed review child.
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/resume"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: {
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [],
      },
    });
    try {
      await registry.publishLocalEvent({
        backend: "claude",
        notification: {
          method: "turn/started",
          params: { threadId: "claude-thread", turnId: "claude-turn-1", turn: { id: "claude-turn-1" } },
        },
      });

      const response = await callRegistryMcpTool({
        registry,
        backend: "claude",
        threadId: "claude-thread",
        turnId: "claude-turn-1",
        tool: "start_review",
        args: { target: { type: "uncommittedChanges" } },
      });
      expect(response).toMatchObject({ isError: true });
      expect(JSON.stringify(response)).toContain("unsupported_backend");
      await registry.publishLocalEvent({
        backend: "claude",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "claude-thread",
            turnId: "claude-turn-1",
            turn: { id: "claude-turn-1", status: "completed", output: [] },
          },
        },
      });
    } finally {
      await registry.close();
    }
  });

  it("advertises Claude review modes without claiming Claude runs reviews", async () => {
    // The owner accepts a run mode for a Claude thread, because the review
    // itself runs on another provider. Claude is never a reviewer.
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      claudeBackendOptions: {
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [],
      },
    });
    try {
      const claudeBackend = (
        await registry.listBackends({ includeUnavailable: true })
      ).backends.find((backend) => backend.kind === "claude");
      expect(claudeBackend?.capabilities).toMatchObject({ reviewRunMode: true });
      expect(claudeBackend?.capabilities.reviewRunner).not.toBe(true);
      expect(claudeBackend?.capabilities.reviewCodexSubAgent).not.toBe(true);
      expect(claudeBackend?.capabilities.startReview).not.toBe(true);
    } finally {
      await registry.close();
    }
  });

  it("runs a Claude Code review as the thread's own /code-review turn and arms Auto-fix on that turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-code-review-"));
    const store = new ClaudeSessionStore(path.join(root, "sessions"));
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      claudeBackendOptions: {
        store,
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [{ id: "fable", label: "Fable 5.1", current: true }],
        query: ({ options = {} }) => {
          async function* messages(): AsyncGenerator<ClaudeMessage> {
            yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume } as ClaudeMessage;
            await finished;
            yield { type: "result", subtype: "success", is_error: false, result: "Reviewed" } as ClaudeMessage;
          }
          return Object.assign(messages(), { close: vi.fn(), setPermissionMode: vi.fn() }) as unknown as ClaudeQuery;
        },
      },
    });
    try {
      await registry.listBackends({ refreshModels: "claude", includeUnavailable: true },
        issueProviderDiscoveryPermit("settings-user-action"));
      const { threadId } = await registry.startThread({ backend: "claude", cwd: root, executionMode: "default" });
      // A Codex-only target and an unknown effort are refused before anything starts.
      await expect(registry.startReview({ backend: "claude", threadId, runMode: "claude-code-review",
        target: { type: "commit", sha: "a".repeat(40), title: null } })).rejects.toThrow(/no form/);
      await expect(registry.startReview({ backend: "claude", threadId, runMode: "claude-code-review",
        target: { type: "uncommittedChanges" }, reasoningEffort: "ultra" })).rejects.toThrow(/effort/);

      const response = await registry.startReview({
        backend: "claude", threadId, runMode: "claude-code-review", afterReview: "auto-fix",
        target: { type: "uncommittedChanges" }, reasoningEffort: "high",
      });
      expect(response).toMatchObject({ backend: "claude", threadId, reviewThreadId: threadId });
      expect(registry.getActiveTurnForThread({ backend: "claude", threadId })).toMatchObject({ turnId: response.turnId });
      // Auto-fix waits on the turn that sent the command, where ReportFindings lands.
      expect(getReviewAutoFixArming().armedTurnIds({ backend: "claude", threadId })).toEqual([response.turnId]);
      expect(JSON.stringify((await registry.readThread({ backend: "claude", threadId })).replay))
        .toContain("/code-review high");
      finish();
    } finally {
      finish();
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a combined review on Codex's own reviewer, and a branch target off Claude Code, before fetching", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ initializeResult: { methods: ["thread/start", "turn/start", "review/start"] } }),
      overlayStore: createOverlayStoreMock(),
      resolveManagedReviewEnabled: () => false,
    });
    try {
      await expect(registry.startReview({ backend: "codex", threadId: "thread-parent", runMode: "codex-sub-agent",
        target: { type: "pullRequests", pullRequests: [
          { url: "https://github.com/fixture/project/pull/1" },
          { url: "https://github.com/fixture/project/pull/2" },
        ] },
      })).rejects.toThrow("PwrAgent Sub Agent is required for a review of several pull requests.");
      await expect(registry.startReview({ backend: "codex", threadId: "thread-parent",
        target: { type: "branch", branch: "feature" } })).rejects.toThrow(/only as Claude Code/);
    } finally {
      await registry.close();
    }
  });


  it("advertises codex as a reviewer override target", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    const codexBackend = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends.find((backend) => backend.kind === "codex");
    expect(codexBackend?.capabilities.reviewRunner).toBe(true);

    await registry.close();
  });

  it.each([
    { methods: ["review/start"], native: true, managed: false },
    { methods: ["thread/start", "turn/start"], native: false, managed: true },
    { methods: ["turn/start"], native: false, managed: false },
  ])("advertises review support only with a review engine ($methods)", async ({ methods, native, managed }) => {
    // An ordinary turn is not a review engine: each mode needs either native
    // review/start or a thread to run a managed reviewer in.
    const codexClient = new MockBackendClient({ initializeResult: { methods } });
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore: createOverlayStoreMock(), discoverLocalAcpAgents: async () => [],
    });
    // Discovery is what reads the initialize methods; before it runs the
    // summary assumes the full app-server surface.
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));

    const codexBackend = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends.find((backend) => backend.kind === "codex");
    expect(codexBackend?.methods).toEqual(methods);
    expect(codexBackend?.capabilities).toMatchObject({
      startReview: native || managed,
      reviewCodexSubAgent: native,
      reviewRunner: managed,
    });

    await registry.close();
  });

  it("completes a Codex review child against its ACP parent", async () => {
    const acpBackendId = "acp:grok" as AcpBackendId;
    const parentThreadId = "grok-parent-with-codex-review";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [
        {
          id: "gpt-5.5",
          label: "GPT-5.5",
          current: true,
          supportsReasoning: true,
        },
      ],
      startThreadResult: { threadId: "codex-review-child" },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        [`${acpBackendId}:${parentThreadId}`]: {
          backend: acpBackendId,
          threadId: parentThreadId,
          executionMode: "full-access",
          extraLinkedDirectories: [],
        },
      },
    });
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      codexClient,
      overlayStore,
      sessionId: parentThreadId,
      sessions: [{
        backendId: acpBackendId,
        sessionId: parentThreadId,
        title: "Grok parent",
        cwd: "/repo/worktree",
        createdAt: 1_000,
        updatedAt: 1_000,
        executionMode: "full-access",
        status: "idle",
      }],
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });

    const response = await registry.startReview({
      backend: acpBackendId,
      reviewBackend: "codex",
      threadId: parentThreadId,
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    expect(response).toMatchObject({
      backend: acpBackendId,
      threadId: parentThreadId,
      reviewThreadId: "codex-review-child",
      turnId: "turn-1",
    });
    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 1,
      threadIds: [`${acpBackendId}:${parentThreadId}`],
      subAgentThreadKeys: [`${acpBackendId}:${parentThreadId}`],
      threadTitles: {
        [`${acpBackendId}:${parentThreadId}`]: "Grok parent",
      },
    });

    const approvalResponse = codexClient.emitRequest({
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: response.reviewThreadId,
        turnId: response.turnId,
        itemId: "review-command",
        requestId: "review-approval",
        command: "git diff origin/main...HEAD",
      },
    } as AppServerPendingRequestNotification);
    await waitForCondition(() => events.some((event) =>
      event.notification.method === "item/commandExecution/requestApproval"
    ));
    expect(events.find((event) =>
      event.notification.method === "item/commandExecution/requestApproval"
    )).toMatchObject({
      backend: acpBackendId,
      notification: {
        params: {
          threadId: parentThreadId,
          turnId: response.turnId,
          requestId: "review-approval",
        },
      },
    });
    await registry.submitServerRequest({
      backend: acpBackendId,
      threadId: parentThreadId,
      turnId: response.turnId,
      requestId: "review-approval",
      response: { decision: "accept" },
    });
    await expect(approvalResponse).resolves.toEqual({ decision: "accept" });

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: response.reviewThreadId,
        turnId: response.turnId,
        model: "gpt-5.5",
        tokenUsage: {
          total: {
            inputTokens: 1_000,
            cachedInputTokens: 200,
            outputTokens: 50,
            reasoningOutputTokens: 10,
          },
        },
      },
    });
    const pricing = await overlayStore.readThreadPricing({
      backend: acpBackendId,
      threadId: parentThreadId,
    });
    expect(pricing.lines).toEqual([
      expect.objectContaining({
        backend: acpBackendId,
        model: "gpt-5.5",
        parentThreadId,
        reasoningEffort: "high",
        scope: "monitor",
      }),
    ]);

    const reviewOutput = JSON.stringify({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No blocking findings.",
      overall_confidence_score: 0.98,
    });
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: response.reviewThreadId,
        turnId: response.turnId,
        turn: {
          id: response.turnId,
          status: "completed",
          output: [{ type: "text", text: reviewOutput }],
        },
      },
    });

    const overlay = await overlayStore.getThreadOverlayState({
      backend: acpBackendId,
      threadId: parentThreadId,
    });
    expect(overlay?.subAgents).toEqual([
      expect.objectContaining({
        backend: "codex",
        monitorThreadId: response.reviewThreadId,
        monitorTurnId: response.turnId,
        preferredModel: "gpt-5.5",
        preferredReasoningEffort: "high",
        outcome: "success",
        status: "success",
      }),
    ]);
    expect(overlay?.managedReviewEntries).toEqual([
      expect.objectContaining({
        id: `managed-review:${response.turnId}:started`,
        reviewer: {
          backend: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
      }),
      expect.objectContaining({
        id: `managed-review:${response.turnId}:result`,
        reviewer: {
          backend: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
        output: expect.objectContaining({
          overall_correctness: "patch is correct",
        }),
        turn: expect.objectContaining({
          id: response.turnId,
          status: "completed",
        }),
      }),
    ]);
    expect(
      events.find((event) =>
        isCompletedItemType(event, "exitedReviewMode")
      ),
    ).toMatchObject({
      notification: {
        params: {
          item: {
            data: {
              reviewer: {
                backend: "codex",
                model: "gpt-5.5",
                reasoningEffort: "high",
              },
            },
          },
        },
      },
    });

    await registry.close();
  });

  it("mirrors managed review tool activity onto the reviewed thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      startThreadResult: { threadId: "managed-review-child" },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-parent": {
          backend: "codex",
          threadId: "thread-parent",
        } as ThreadOverlayState,
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      resolveManagedReviewEnabled: () => true, // Legacy config no longer selects the engine.
    });
    await registry.startReview({
      runMode: "pwragent-sub-agent",
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    await emit({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "managed-review-child",
          turnId: "turn-1",
          item: { id: "item-9", type: "commandExecution" },
        },
      },
    } as AgentEvent);

    const forwarded = events.filter(
      (event) =>
        (event.notification.params as { threadId?: string }).threadId
        === "thread-parent",
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.notification.params).toMatchObject({
      threadId: "thread-parent",
      turnId: "turn-1",
      // Namespaced so a forwarded item cannot collide with a real one.
      item: { id: "managed-review:item-9", type: "commandExecution" },
    });

    await registry.close();
  });

  it("mirrors command output without double-counting tool accounting", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      startThreadResult: { threadId: "managed-review-child" },
    });
    const upsertThreadToolInvocation = vi.fn(
      async (params: { invocation: unknown }) => params.invocation,
    );
    const overlayStore = {
      ...createOverlayStoreMock({
        overlays: {
          "codex:thread-parent": {
            backend: "codex",
            threadId: "thread-parent",
          } as ThreadOverlayState,
        },
      }),
      upsertThreadToolInvocation,
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: overlayStore as never,
      resolveManagedReviewEnabled: () => true, // Legacy config no longer selects the engine.
    });
    await registry.startReview({
      runMode: "pwragent-sub-agent",
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    upsertThreadToolInvocation.mockClear();

    await (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit({
      backend: "codex",
      notification: {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "managed-review-child",
          turnId: "turn-1",
          itemId: "cmd-1",
          delta: "hello from the reviewer\n",
        },
      },
    } as AgentEvent);

    // Streaming refinements reach the parent so the row animates, with the
    // item reference namespaced like the envelope that introduced it.
    const forwarded = events.filter(
      (event) =>
        (event.notification.params as { threadId?: string }).threadId
        === "thread-parent",
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.notification.params).toMatchObject({
      threadId: "thread-parent",
      itemId: "managed-review:cmd-1",
    });

    // Streamed accounting is coalesced, so nothing is written on the hot path.
    expect(upsertThreadToolInvocation).not.toHaveBeenCalled();

    await registry.close();

    // The forwarded copy is a view of activity the child already recorded.
    // Running it back through the pipeline would bill the same command twice,
    // so the flush writes the child's row and only the child's row.
    expect(upsertThreadToolInvocation).toHaveBeenCalledTimes(1);
    expect(upsertThreadToolInvocation.mock.calls[0]?.[0]).toMatchObject({
      invocation: { threadId: "managed-review-child" },
    });
  });

  it("never mirrors the review sub-agent's own prose onto the reviewed thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      startThreadResult: { threadId: "managed-review-child" },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-parent": {
          backend: "codex",
          threadId: "thread-parent",
        } as ThreadOverlayState,
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      resolveManagedReviewEnabled: () => true, // Legacy config no longer selects the engine.
    });
    await registry.startReview({
      runMode: "pwragent-sub-agent",
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    // The child's final assistant message is the raw JSON findings blob and
    // its reasoning is model prose. Either one reaching the parent would
    // render as a message in the reviewed thread's transcript.
    for (const type of ["agentMessage", "reasoning", "userMessage"]) {
      await emit({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "managed-review-child",
            turnId: "turn-1",
            item: { id: `item-${type}`, type, text: "should not appear" },
          },
        },
      } as AgentEvent);
    }

    expect(
      events.filter(
        (event) =>
          (event.notification.params as { threadId?: string }).threadId
          === "thread-parent",
      ),
    ).toHaveLength(0);

    await registry.close();
  });

  it("puts review provenance on the live managed review cards, not only the persisted ones", async () => {
    // The parent's cards are emitted under the parent thread, but the review
    // record is keyed by the child. withReviewRuntimeMetadata therefore cannot
    // decorate them, and before this the live start card showed only the
    // reviewer row until a reload read the persisted entry.
    const context: AppServerReviewContext = {
      workspacePath: "/repo/worktree",
      projectLabel: "PwrAgent",
      gitBranch: "feat/review-cards",
      baseBranch: "main",
      headCommit: "0123456789abcdef0123456789abcdef01234567",
      pullRequest: {
        provider: "github.com",
        org: "example-org",
        repo: "example-repo",
        number: 42,
        url: "https://github.com/example-org/example-repo/pull/42",
      },
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      startThreadResult: { threadId: "managed-review-child" },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-parent": {
          backend: "codex",
          threadId: "thread-parent",
        } as ThreadOverlayState,
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      resolveManagedReviewEnabled: () => true,
    });
    vi.spyOn(registryModules(registry).managedReviewService, "resolveReviewContext").mockResolvedValue(context);
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });

    const response = await registry.startReview({
      runMode: "pwragent-sub-agent",
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });
    await codexClient.emit({
      method: "item/completed",
      params: {
        threadId: response.reviewThreadId,
        turnId: response.turnId,
        item: {
          id: "review-output",
          type: "agentMessage",
          text: JSON.stringify({
            findings: [],
            overall_correctness: "patch is correct",
            overall_explanation: "No blocking findings.",
            overall_confidence_score: 0.9,
          }),
        },
      },
    });
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: response.reviewThreadId,
        turnId: response.turnId,
        turn: { id: response.turnId, status: "completed", output: [] },
      },
    });

    const liveItemData = (itemType: string): unknown => {
      const event = events.find((candidate) =>
        isCompletedItemType(candidate, itemType)
        && "threadId" in candidate.notification.params
        && candidate.notification.params.threadId === "thread-parent"
      );
      if (event?.notification.method !== "item/completed") {
        return undefined;
      }
      return (event.notification.params.item as { data?: unknown }).data;
    };
    expect(liveItemData("enteredReviewMode")).toMatchObject({ context });
    expect(liveItemData("exitedReviewMode")).toMatchObject({
      context,
      reviewOutput: expect.objectContaining({
        overall_correctness: "patch is correct",
      }),
    });

    await registry.close();
  });

  it("enriches default-model managed review cards from durable usage", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      startThreadResult: { threadId: "managed-review-child" },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-parent": {
          backend: "codex",
          threadId: "thread-parent",
        } as ThreadOverlayState,
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      resolveManagedReviewEnabled: () => true, // Legacy config no longer selects the engine.
    });

    const response = await registry.startReview({
      runMode: "pwragent-sub-agent",
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });
    expect(codexClient.lastStartThreadParams?.model).toBeUndefined();

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: response.reviewThreadId,
        turnId: response.turnId,
        model: "gpt-5.5",
        tokenUsage: {
          total: {
            inputTokens: 1_000,
            cachedInputTokens: 200,
            outputTokens: 50,
            reasoningOutputTokens: 10,
          },
        },
      },
    });
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: response.reviewThreadId,
        turnId: response.turnId,
        turn: {
          id: response.turnId,
          status: "completed",
          output: [{
            type: "text",
            text: JSON.stringify({
              findings: [],
              overall_correctness: "patch is correct",
              overall_explanation: "No blocking findings.",
              overall_confidence_score: 0.98,
            }),
          }],
        },
      },
    });

    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents?.[0]?.monitorUsage?.model).toBe("gpt-5.5");
    expect(
      overlay?.managedReviewEntries?.map((entry) => entry.reviewer),
    ).toEqual([
      { backend: "codex" },
      { backend: "codex" },
    ]);

    const hydrated = await registry.readThread({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(
      hydrated.replay.entries
        .filter((entry) => entry.type === "review")
        .map((entry) => entry.reviewer),
    ).toEqual([
      { backend: "codex", model: "gpt-5.5" },
      { backend: "codex", model: "gpt-5.5" },
    ]);

    await registry.close();
  });

  it("terminal-gates failed managed reviews and holds the parent queue for retry", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start", "review/start"] },
      startThreadResult: { threadId: "managed-review-child" },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      resolveManagedReviewEnabled: () => true, // Legacy config no longer selects the engine.
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });

    await registry.startReview({
      runMode: "pwragent-sub-agent",
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    const queuedTurn = await registry.submitTurn({
      backend: "codex",
      threadId: "thread-parent",
      input: [{ type: "text", text: "Continue after failure" }],
      origin: "messaging",
    });
    expect(queuedTurn.status).toBe("queued");
    await codexClient.emit({
      method: "turn/failed",
      params: {
        threadId: "managed-review-child",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "You have 8147 weighted tokens left" },
        },
      },
    });

    const parentEvents = events.filter(
      (event) => "threadId" in event.notification.params
        && event.notification.params.threadId === "thread-parent",
    );
    expect(parentEvents.some((event) =>
      isCompletedItemType(event, "exitedReviewMode")
    )).toBe(false);
    expect(parentEvents.filter((event) =>
      event.notification.method === "turn/completed"
    )).toHaveLength(0);
    expect(parentEvents.filter((event) =>
      event.notification.method === "turn/failed"
    )).toHaveLength(1);
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents?.[0]).toMatchObject({
      outcome: "failure",
      status: "failed",
    });
    expect(overlay?.managedReviewEntries).toEqual([
      expect.objectContaining({
        id: "managed-review:turn-1:started",
      }),
    ]);

    if (queuedTurn.status !== "queued") {
      throw new Error("Expected the parent turn to be queued.");
    }
    expect(registry.getQueuedTurnsSnapshot()).toEqual({
      [buildThreadIdentityKey("codex", "thread-parent")]: [
        expect.objectContaining({
          queueEntryId: queuedTurn.entry.id,
          manualReleaseRequired: true,
          holdReason: "You have 8147 weighted tokens left",
        }),
      ],
    });
    await expect(
      registry.releaseQueuedTurnWithDisposition(queuedTurn.entry.id),
    ).resolves.toMatchObject({
      disposition: "started",
      turnId: expect.any(String),
    });
    await expect.poll(() => codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-parent",
      input: [{ type: "text", text: "Continue after failure" }],
    });

    await registry.close();
  });

  it("starts reviews for a selected secondary project in that workspace", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/start", "turn/start", "review/start"],
      },
      startThreadResult: { threadId: "selected-project-review" },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-parent": {
            backend: "codex",
            threadId: "thread-parent",
            codexEnvironmentRuntime: {
              environmentId: "primary-env",
              environmentName: "Primary environment",
              executionTarget: "local",
              shellEnvironment: {
                PATH: "/worktrees/primary/.venv/bin:/usr/bin",
                VIRTUAL_ENV: "/worktrees/primary/.venv",
              },
            },
            executionMode: "full-access",
            extraLinkedDirectories: [
              {
                id: "/repo/primary",
                kind: "worktree",
                label: "primary",
                path: "/repo/primary",
                worktreePath: "/worktrees/primary",
              },
              {
                id: "/repo/selected",
                kind: "local",
                label: "selected",
                path: "/repo/selected",
              },
            ],
          },
        },
      }),
      resolveManagedReviewEnabled: () => false,
    });

    await expect(registry.startReview({ backend: "codex", threadId: "thread-parent",
      target: { type: "baseBranch", branch: "origin/main" }, cwd: "/repo/selected",
      runMode: "codex-sub-agent",
    })).rejects.toThrow("PwrAgent Sub Agent is required for a secondary workspace");

    const response = await registry.startReview({
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
      cwd: "/repo/selected",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-parent",
      reviewThreadId: "selected-project-review",
      turnId: "turn-1",
    });
    expect(codexClient.lastStartReviewParams).toBeUndefined();
    expect(codexClient.lastStartThreadParams).toMatchObject({
      cwd: "/repo/selected",
      ephemeral: true,
    });
    expect(
      codexClient.lastStartThreadParams?.codexEnvironmentRuntime,
    ).toBeUndefined();
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "selected-project-review",
      cwd: "/repo/selected",
    });
    expect(
      codexClient.lastStartTurnParams?.codexEnvironmentRuntime,
    ).toBeUndefined();
    expect(codexClient.lastStartTurnParams?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("against base branch 'main'"),
    });

    await registry.close();
  });

  it("preserves remote environment routing for selected secondary project reviews", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/start", "turn/start", "review/start"],
      },
      startThreadResult: { threadId: "remote-project-review" },
    });
    const remoteRuntime: CodexThreadEnvironmentRuntime = {
      environmentId: "remote-env",
      environmentName: "Remote environment",
      executionTarget: "remote",
      cwd: "/remote/primary",
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-parent": {
            backend: "codex",
            threadId: "thread-parent",
            codexEnvironmentRuntime: remoteRuntime,
            executionMode: "full-access",
            extraLinkedDirectories: [
              {
                id: "/remote/primary",
                kind: "local",
                label: "primary",
                path: "/remote/primary",
              },
              {
                id: "/remote/selected",
                kind: "local",
                label: "selected",
                path: "/remote/selected",
              },
            ],
          },
        },
      }),
      resolveManagedReviewEnabled: () => false,
    });

    await registry.startReview({
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "origin/main" },
      delivery: "inline",
      cwd: "/remote/selected",
    });

    expect(codexClient.lastStartThreadParams).toMatchObject({
      cwd: "/remote/selected",
      codexEnvironmentRuntime: remoteRuntime,
      ephemeral: true,
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "remote-project-review",
      cwd: "/remote/selected",
      codexEnvironmentRuntime: remoteRuntime,
    });

    await registry.close();
  });

  it("rejects Codex reviews with a selected model that is not in the discovered model list", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
      models: [
        {
          id: "gpt-5.5",
          label: "GPT-5.5",
          current: true,
          supportsFast: true,
          supportsReasoning: true,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.startReview({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      }),
    ).rejects.toThrow(
      "Selected review model is not available for codex: gpt-5.3-codex",
    );
    expect(codexClient.lastStartReviewParams).toBeUndefined();

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "Continue after rejected review" }],
      }),
    ).resolves.toMatchObject({ threadId: "thread-1", turnId: "turn-1" });
    expect(codexClient.lastStartTurnParams?.input).toEqual([
      { type: "text", text: "Continue after rejected review" },
    ]);

    await registry.close();
  });

  it("rejects managed review start for ACP providers without the capability", async () => {
    const geminiBackendId = "acp:gemini" as AcpBackendId;
    const { acpBackendId, registry } = createKimiAcpRegistry({
      installedAgent: {
        ...createKimiAgentRecord(geminiBackendId),
        backendId: geminiBackendId,
        registryId: "gemini",
        name: "Gemini CLI",
        launchDescriptor: {
          backendId: geminiBackendId,
          registryId: "gemini",
          distributionKind: "local",
          command: "gemini",
          args: ["--experimental-acp"],
          env: {},
        },
      },
    });

    await expect(
      registry.startReview({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      }),
    ).rejects.toThrow("Selected backend does not support review/start");

    await registry.close();
  });

  it("mirrors an ACP review sub-agent's activity onto the reviewed thread", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "kimi-parent";
    const sessions: AcpSessionMetadata[] = [{
      backendId: acpBackendId,
      sessionId: parentThreadId,
      title: "ACP session",
      titleSource: "fallback",
      cwd: "/repo/worktree",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
    }];
    const overlayStore = createOverlayStoreMock({
      overlays: {
        [`${acpBackendId}:${parentThreadId}`]: {
          backend: acpBackendId,
          threadId: parentThreadId,
          extraLinkedDirectories: [],
        },
      },
    });
    const startPrompt = vi.fn((params: Parameters<KimiStartPrompt>[0]) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? `turn-${startPrompt.mock.calls.length}`,
    }));
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      overlayStore,
      sessionId: parentThreadId,
      sessions,
      startPrompt,
    });

    const response = await registry.startReview({
      backend: acpBackendId,
      threadId: parentThreadId,
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });
    expect(response.reviewThreadId).not.toBe(parentThreadId);

    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });

    // Forwarding is backend-agnostic, but ACP reaches the child through a
    // hidden session rather than an ephemeral thread — pin that the record
    // lookup still resolves it.
    await (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit({
      backend: acpBackendId,
      notification: {
        method: "item/completed",
        params: {
          threadId: response.reviewThreadId,
          turnId: response.turnId,
          item: { id: "acp-item-3", type: "commandExecution" },
        },
      },
    } as AgentEvent);

    const forwarded = events.filter(
      (event) =>
        (event.notification.params as { threadId?: string }).threadId
        === parentThreadId,
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.notification.params).toMatchObject({
      threadId: parentThreadId,
      turnId: response.turnId,
      item: { id: "managed-review:acp-item-3", type: "commandExecution" },
    });

    await registry.close();
  });

  it("runs Kimi review in a hidden child and injects its output into the next parent turn", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "kimi-parent";
    const parentRuntime: BackendAcpSessionRuntimeState = {
      currentModeId: "default",
      currentModelId: "kimi-code/k3",
      reasoningEffort: "high",
      updatedAt: 1000,
    };
    const sessions: AcpSessionMetadata[] = [{
      backendId: acpBackendId,
      sessionId: parentThreadId,
      title: "ACP session",
      titleSource: "fallback",
      cwd: "/repo/worktree",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "full-access",
      acpRuntime: parentRuntime,
      status: "idle",
    }];
    const overlayStore = createOverlayStoreMock({
      overlays: {
        [`${acpBackendId}:${parentThreadId}`]: {
          backend: acpBackendId,
          threadId: parentThreadId,
          executionMode: "full-access",
          extraLinkedDirectories: [],
        },
      },
    });
    const startPrompt = vi.fn((params: Parameters<KimiStartPrompt>[0]) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? `turn-${startPrompt.mock.calls.length}`,
    }));
    const firstRegistry = createKimiAcpRegistry({
      acpBackendId,
      overlayStore,
      sessionId: parentThreadId,
      sessions,
      startPrompt,
    });
    const { acpClient, registry } = firstRegistry;

    const response = await registry.startReview({
      backend: acpBackendId,
      threadId: parentThreadId,
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    expect(response).toMatchObject({
      backend: acpBackendId,
      threadId: parentThreadId,
      reviewThreadId: expect.stringContaining(":title-helper:"),
      turnId: expect.stringContaining("pending:"),
    });
    expect(acpClient.startSession).toHaveBeenCalledWith(expect.objectContaining({
      acpRuntime: parentRuntime,
      cwd: "/repo/worktree",
      executionMode: "default",
      hidden: true,
    }));
    expect(acpClient.setRuntimeOption).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: response.reviewThreadId,
      source: "model",
      value: "kimi-code/k3",
      reasoningEffort: "high",
    }));
    expect(startPrompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: response.reviewThreadId,
      prompt: expect.stringContaining("against base branch 'main'"),
    }));

    const reviewOutput = JSON.stringify({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No blocking findings.",
      overall_confidence_score: 0.96,
    });
    await (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit({
      backend: acpBackendId,
      notification: {
        method: "turn/completed",
        params: {
          threadId: response.reviewThreadId,
          turnId: response.turnId,
          turn: {
            id: response.turnId,
            status: "completed",
            output: [{ type: "text", text: reviewOutput }],
          },
        },
      },
    });

    const completedOverlay = await overlayStore.getThreadOverlayState({
      backend: acpBackendId,
      threadId: parentThreadId,
    });
    expect(completedOverlay?.pendingManagedReviewContextEntryIds).toEqual([
      `managed-review:${response.turnId}:result`,
    ]);
    await registry.close();

    const followupStartPrompt = vi.fn(
      (params: Parameters<KimiStartPrompt>[0]) => ({
        sessionId: params.sessionId,
        turnId: params.turnId ?? "followup-turn",
      }),
    );
    const followup = createKimiAcpRegistry({
      acpBackendId,
      overlayStore,
      sessionId: parentThreadId,
      sessions,
      startPrompt: followupStartPrompt,
    });
    const scheduleTitleGeneration = vi.spyOn(
      followup.registry as unknown as {
        scheduleThreadTitleGeneration(params: {
          backend: AppServerBackendKind;
          threadId: string;
          input: AppServerTurnInputItem[];
        }): void;
      },
      "scheduleThreadTitleGeneration",
    );

    const nextTurn = await followup.registry.startTurn({
      backend: acpBackendId,
      threadId: parentThreadId,
      input: [{ type: "text", text: "Continue after review" }],
    });
    const nextPrompt = followupStartPrompt.mock.calls.at(-1)?.[0].prompt;
    expect(nextPrompt).toContain("PwrAgent review sub-agent results");
    expect(nextPrompt).toContain(reviewOutput);
    expect(nextPrompt).toContain("Continue after review");
    expect(scheduleTitleGeneration).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: parentThreadId,
      input: [{ type: "text", text: "Continue after review" }],
    });
    const consumedOverlay = await overlayStore.getThreadOverlayState({
      backend: acpBackendId,
      threadId: parentThreadId,
    });
    expect(
      consumedOverlay?.pendingManagedReviewContextEntryIds,
    ).toBeUndefined();

    await (followup.registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit({
      backend: acpBackendId,
      notification: {
        method: "turn/completed",
        params: {
          threadId: parentThreadId,
          turnId: nextTurn.turnId,
          turn: {
            id: nextTurn.turnId,
            status: "completed",
            output: [],
          },
        },
      },
    });
    await followup.registry.startTurn({
      backend: acpBackendId,
      threadId: parentThreadId,
      input: [{ type: "text", text: "One more turn" }],
    });
    expect(followupStartPrompt.mock.calls.at(-1)?.[0].prompt).toBe("One more turn");

    await followup.registry.close();
  });

  it("replays the parent's model with the parent's own level in a review child", async () => {
    // On Kimi the model decides which thought levels exist: K2.7 Highspeed
    // offers only `on`, and K3 offers low/high/max. A K3/high review of a
    // Highspeed thread must not send Highspeed with `high`, which Kimi
    // refuses with -32602 "Unknown thinking value".
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "kimi-parent";
    const sessions: AcpSessionMetadata[] = [{
      backendId: acpBackendId,
      sessionId: parentThreadId,
      title: "ACP session",
      cwd: "/repo/worktree",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      acpRuntime: {
        configValues: { model: KIMI_HIGHSPEED_MODEL, thinking: "on" },
        currentModelId: KIMI_HIGHSPEED_MODEL,
        reasoningEffort: "on",
        updatedAt: 1000,
      },
      status: "idle",
    }];
    const startPrompt = vi.fn((params: Parameters<KimiStartPrompt>[0]) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? `turn-${startPrompt.mock.calls.length}`,
    }));
    const { acpClient, registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: parentThreadId,
      sessions,
      startPrompt,
      runtimeCapabilities: createKimiModelCapabilities(),
    });

    const response = await registry.startReview({
      backend: acpBackendId,
      threadId: parentThreadId,
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
      model: KIMI_K3_MODEL,
      reasoningEffort: "high",
    });

    const modelWrites = acpClient.setRuntimeOption.mock.calls
      .map(([params]) => params as {
        sessionId: string;
        source?: string;
        value?: string;
        reasoningEffort?: string;
      })
      .filter((params) =>
        params.sessionId === response.reviewThreadId
        && params.source === "model"
      )
      .map((params) => [params.value, params.reasoningEffort]);
    expect(modelWrites).toEqual([
      [KIMI_HIGHSPEED_MODEL, "on"],
      [KIMI_K3_MODEL, "high"],
    ]);

    await registry.close();
  });

  it("writes a replayed model before the thought level it belongs to", async () => {
    // `configValues` carries whatever insertion order earlier merges left. A
    // level written first is measured against the fresh session's own model —
    // the agent's default, Highspeed, which offers only `on` — so the session
    // menu drops it and the child runs a level it never chose.
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "kimi-parent";
    const sessions: AcpSessionMetadata[] = [{
      backendId: acpBackendId,
      sessionId: parentThreadId,
      title: "ACP session",
      cwd: "/repo/worktree",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      acpRuntime: {
        configValues: { thinking: "high", model: KIMI_K3_MODEL },
        currentModelId: KIMI_K3_MODEL,
        reasoningEffort: "high",
        updatedAt: 1000,
      },
      status: "idle",
    }];
    const startPrompt = vi.fn((params: Parameters<KimiStartPrompt>[0]) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? `turn-${startPrompt.mock.calls.length}`,
    }));
    const { acpClient, registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: parentThreadId,
      sessions,
      startPrompt,
      runtimeCapabilities: createKimiModelCapabilities(KIMI_K3_MODEL),
    });

    const response = await registry.startReview({
      backend: acpBackendId,
      threadId: parentThreadId,
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    const configWrites = acpClient.setRuntimeOption.mock.calls
      .map(([params]) => params as {
        sessionId: string;
        source?: string;
        optionId?: string;
        value?: string;
      })
      .filter((params) =>
        params.sessionId === response.reviewThreadId
        && params.source === "configOption"
      )
      .map((params) => [params.optionId, params.value]);
    expect(configWrites).toEqual([
      ["model", KIMI_K3_MODEL],
      ["thinking", "high"],
    ]);

    await registry.close();
  });

  it("applies a review's own level when the review chose no model", async () => {
    // The replay carries the parent's level because a resolved ACP level
    // always arrives with a resolved model — here the review backend's
    // default, K3. Were that ever untrue, the level would reach no one: the
    // turn's write is gated on a model.
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "kimi-parent";
    const sessions: AcpSessionMetadata[] = [{
      backendId: acpBackendId,
      sessionId: parentThreadId,
      title: "ACP session",
      cwd: "/repo/worktree",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      acpRuntime: {
        configValues: { model: KIMI_HIGHSPEED_MODEL, thinking: "on" },
        currentModelId: KIMI_HIGHSPEED_MODEL,
        reasoningEffort: "on",
        updatedAt: 1000,
      },
      status: "idle",
    }];
    const startPrompt = vi.fn((params: Parameters<KimiStartPrompt>[0]) => ({
      sessionId: params.sessionId,
      turnId: params.turnId ?? `turn-${startPrompt.mock.calls.length}`,
    }));
    const { acpClient, registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: parentThreadId,
      sessions,
      startPrompt,
      runtimeCapabilities: createKimiModelCapabilities(KIMI_K3_MODEL),
    });

    const response = await registry.startReview({
      backend: acpBackendId,
      threadId: parentThreadId,
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
      reasoningEffort: "max",
    });

    const modelWrites = acpClient.setRuntimeOption.mock.calls
      .map(([params]) => params as {
        sessionId: string;
        source?: string;
        value?: string;
        reasoningEffort?: string;
      })
      .filter((params) =>
        params.sessionId === response.reviewThreadId
        && params.source === "model"
      )
      .map((params) => [params.value, params.reasoningEffort]);
    expect(modelWrites).toEqual([
      [KIMI_HIGHSPEED_MODEL, "on"],
      [KIMI_K3_MODEL, "max"],
    ]);

    await registry.close();
  });

  it("keys an ACP managed review on the ids its usage notifications carry", async () => {
    // Live sub-agent pricing depends on one join: recordTaskMonitorUsage looks
    // the review up by (backend, notification.threadId, notification.turnId),
    // and the ACP adapter stamps those as the child session id and its turn id
    // (see "reports Grok model-call usage while a turn is still running" in
    // acp-backend-adapter.test.ts). If startReview ever recorded the parent
    // thread or a different turn id here, every usage event would miss the
    // review record and the sub-agent card would silently stay blank again.
    const acpBackendId = "acp:grok" as AcpBackendId;
    const parentThreadId = "grok-usage-review-parent";
    const sessions: AcpSessionMetadata[] = [{
      backendId: acpBackendId,
      sessionId: parentThreadId,
      title: "Grok review parent",
      cwd: "/repo/worktree",
      createdAt: 1_000,
      updatedAt: 1_000,
      executionMode: "default",
      status: "idle",
    }];
    const startPrompt = vi.fn((params: Parameters<KimiStartPrompt>[0]) => ({
      sessionId: params.sessionId,
      turnId: "grok-review-turn",
    }));
    const overlayStore = createOverlayStoreMock();
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      overlayStore,
      sessionId: parentThreadId,
      sessions,
      startPrompt,
    });

    const review = await registry.startReview({
      backend: acpBackendId,
      threadId: parentThreadId,
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    // The hidden child session the review actually runs in — not the parent.
    const childSessionId = startPrompt.mock.calls.at(-1)?.[0].sessionId;
    expect(childSessionId).toBeDefined();
    expect(childSessionId).not.toBe(parentThreadId);
    expect(review).toMatchObject({
      threadId: parentThreadId,
      reviewThreadId: childSessionId,
      turnId: "grok-review-turn",
    });

    // And the sub-agent row the card renders is registered under that child,
    // waiting for monitorUsage to arrive.
    const overlay = await overlayStore.getThreadOverlayState({
      backend: acpBackendId,
      threadId: parentThreadId,
    });
    expect(overlay?.subAgents?.[0]).toMatchObject({
      monitorId: "review:grok-review-turn",
      monitorThreadId: childSessionId,
      monitorTurnId: "grok-review-turn",
      status: "running",
    });
    expect(overlay?.subAgents?.[0]?.monitorUsage).toBeUndefined();

    await registry.close();
  });

  it("routes direct and controlled Kimi review cancellation to the hidden child", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const parentThreadId = "kimi-review-parent";
    const sessions: AcpSessionMetadata[] = [{
      backendId: acpBackendId,
      sessionId: parentThreadId,
      title: "Kimi review parent",
      cwd: "/repo/worktree",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
    }];
    const startPrompt = vi.fn((params: Parameters<KimiStartPrompt>[0]) => ({
      sessionId: params.sessionId,
      turnId: `review-turn-${startPrompt.mock.calls.length}`,
    }));
    const { acpClient, registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: parentThreadId,
      sessions,
      startPrompt,
    });

    const directReview = await registry.startReview({
      backend: acpBackendId,
      threadId: parentThreadId,
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    await registry.interruptTurn({
      backend: acpBackendId,
      threadId: parentThreadId,
      turnId: directReview.turnId,
    });
    expect(acpClient.cancelSession).toHaveBeenLastCalledWith(
      directReview.reviewThreadId,
    );
    await registry.close();

    const controlledSessions: AcpSessionMetadata[] = [{
      ...sessions[0]!,
    }];
    const controlledStartPrompt = vi.fn(
      (params: Parameters<KimiStartPrompt>[0]) => ({
        sessionId: params.sessionId,
        turnId: "controlled-review-turn",
      }),
    );
    const controlled = createKimiAcpRegistry({
      acpBackendId,
      sessionId: parentThreadId,
      sessions: controlledSessions,
      startPrompt: controlledStartPrompt,
    });
    const controlledReview = await controlled.registry.startReview({
      backend: acpBackendId,
      threadId: parentThreadId,
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    await expect(controlled.registry.controlActiveTurn({
      operation: "stop",
      backend: acpBackendId,
      threadId: parentThreadId,
      requestId: "stop-kimi-review",
      expectedTurnId: controlledReview.turnId,
    })).resolves.toMatchObject({
      ok: true,
      backend: acpBackendId,
      threadId: parentThreadId,
      turnId: controlledReview.turnId,
      disposition: "interrupted",
    });
    expect(controlled.acpClient.cancelSession).toHaveBeenLastCalledWith(
      controlledReview.reviewThreadId,
    );
    expect(controlled.acpClient.cancelSession).not.toHaveBeenCalledWith(
      parentThreadId,
    );

    await controlled.registry.close();
  });

  it("rejects Codex review start while the thread has an active turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Keep working" }],
    });

    await expect(
      registry.startReview({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      }),
    ).rejects.toThrow("Thread already has an active turn in progress: thread-1");
    expect(codexClient.lastStartReviewParams).toBeUndefined();

    await registry.close();
  });

  it("treats a Codex review as active until its terminal turn notification", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.startReview({
      backend: "codex",
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    await codexClient.emit({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: { type: "idle" },
      },
    });

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "Follow-up while review is running" }],
      }),
    ).rejects.toThrow("A turn is already active for this thread.");
    expect(codexClient.startTurnCallCount).toBe(0);

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-review-1",
        turn: {
          id: "turn-review-1",
          status: "completed",
          completedAt: 1_781_178_272,
          output: [],
        },
      },
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Follow-up after review" }],
    });
    expect(codexClient.startTurnCallCount).toBe(1);

    await registry.close();
  });

  it("persists native review provenance on the existing sub-agent write", async () => {
    const context: AppServerReviewContext = {
      workspacePath: "/repo",
      projectLabel: "PwrAgent",
      gitBranch: "fix/review-provenance",
      baseBranch: "origin/main",
      pullRequest: {
        provider: "github.com",
        org: "pwrdrvr",
        repo: "PwrAgent",
        number: 1939,
        headRefName: "fix/review-provenance",
        baseRefName: "main",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/1939",
      },
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
      startReviewResult: {
        threadId: "thread-1",
        reviewThreadId: "thread-1",
        turnId: "turn-review-1",
      },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    vi.spyOn(registryModules(registry).managedReviewService, "resolveReviewContext").mockResolvedValue(context);

    await registry.startReview({
      backend: "codex",
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "origin/main" },
      delivery: "inline",
    });

    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      subAgents: [
        expect.objectContaining({
          monitorId: "review:turn-review-1",
          reviewContext: context,
        }),
      ],
    });

    await registry.close();
  });

  it("reattaches persisted provenance to native review replay", async () => {
    const context: AppServerReviewContext = {
      workspacePath: "/repo",
      projectLabel: "PwrAgent",
      gitBranch: "fix/review-provenance",
      baseBranch: "origin/main",
      pullRequest: {
        provider: "github.com",
        org: "pwrdrvr",
        repo: "PwrAgent",
        number: 1939,
        url: "https://github.com/pwrdrvr/PwrAgent/pull/1939",
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
              monitorId: "review:turn-review-1",
              task: "Review changes against origin/main",
              status: "success",
              createdAt: 1_000,
              updatedAt: 2_000,
              backend: "codex",
              preferredModel: "gpt-5.6-sol",
              preferredReasoningEffort: "high",
              monitorThreadId: "thread-1",
              monitorTurnId: "turn-review-1",
              reviewContext: context,
            },
          ],
        },
      },
    });
    const codexClient = new MockBackendClient({
      replay: {
        entries: [
          {
            type: "review",
            id: "review-start",
            review: "changes against 'origin/main'",
            displayText: "Review changes against origin/main",
            turn: {
              id: "turn-review-1",
              status: "completed",
            },
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: true,
          hasPreviousPage: false,
        },
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    const response = await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response.replay.entries).toEqual([
      expect.objectContaining({
        type: "review",
        id: "review-start",
        context,
        reviewer: {
          backend: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      }),
    ]);

    await registry.close();
  });

  it("persists Codex reviews as sub-agent summaries on the parent thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
      models: [
        {
          id: "gpt-5.5",
          label: "GPT-5.5",
          current: true,
          supportsFast: true,
          supportsReasoning: true,
        },
      ],
      startReviewResult: {
        threadId: "thread-1",
        reviewThreadId: "thread-1",
        turnId: "turn-review-1",
      },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.startReview({
      backend: "codex",
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });
    expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
      count: 1,
      threadIds: ["codex:thread-1"],
    });

    await expect
      .poll(async () => {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        });
        return overlay?.subAgents?.[0];
      })
      .toMatchObject({
        monitorId: "review:turn-review-1",
        monitorThreadId: "thread-1",
        monitorTurnId: "turn-review-1",
        task: "Review changes against main",
        status: "running",
      });

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-review-1",
        model: "gpt-5.5",
        tokenUsage: {
          // The review inherits 100k input / 5k output from the parent. Only
          // the latest request belongs to this review and may be priced here.
          total: {
            fastMode: true,
            inputTokens: 101_000,
            cachedInputTokens: 90_200,
            outputTokens: 5_050,
            reasoningOutputTokens: 1_010,
            serviceTier: "priority",
          },
          last: {
            inputTokens: 1_000,
            cachedInputTokens: 200,
            outputTokens: 50,
            reasoningOutputTokens: 10,
          },
        },
      },
    });

    await expect
      .poll(async () => {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        });
        return overlay?.subAgents?.[0]?.monitorUsage;
      })
      .toMatchObject({
        fastMode: true,
        serviceTier: "priority",
        summary: expect.stringContaining(
          "800 uncached in · 200 cached · 50 out (10 reasoning)"
        ),
        tokenUsage: {
          cachedInputTokens: 200,
          inputTokens: 1_000,
          outputTokens: 50,
          reasoningOutputTokens: 10,
          totalTokens: 1_060,
          uncachedInputTokens: 800,
        },
      });
    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      fastMode: true,
      model: "gpt-5.5",
      parentThreadId: "thread-1",
      priceStatus: "priced",
      scope: "monitor",
      serviceTier: "priority",
      threadId: "thread-1",
      turnId: "turn-review-1",
    });
    expect(pricing.lines[0]?.totalCostMicros).toBeGreaterThan(0);

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-review-1",
        turn: {
          id: "turn-review-1",
          status: "completed",
          completedAt: 1_781_178_272,
          output: [],
        },
      },
    });

    await expect
      .poll(async () => {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        });
        return overlay?.subAgents?.[0];
      })
      .toMatchObject({
        monitorId: "review:turn-review-1",
        outcome: "success",
        status: "success",
        lastMessage: "Review completed.",
        completedAt: 1_781_178_272_000,
      });

    await registry.close();
  });

  it("patches Codex review sub-agent usage when usage arrives after completion", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
      startReviewResult: {
        threadId: "thread-1",
        reviewThreadId: "thread-1",
        turnId: "turn-review-1",
      },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.startReview({
      backend: "codex",
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-review-1",
        turn: {
          id: "turn-review-1",
          status: "completed",
          output: [],
        },
      },
    });

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-review-1",
        model: "gpt-5.5",
        tokenUsage: {
          total: {
            inputTokens: 1_000,
            cachedInputTokens: 200,
            outputTokens: 50,
            reasoningOutputTokens: 10,
          },
        },
      },
    });

    await expect
      .poll(async () => {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        });
        return overlay?.subAgents?.[0];
      })
      .toMatchObject({
        monitorId: "review:turn-review-1",
        outcome: "success",
        status: "success",
        lastMessage: "Review completed.",
        monitorUsage: {
          summary: expect.stringContaining(
            "800 uncached in · 200 cached · 50 out (10 reasoning)"
          ),
          tokenUsage: {
            cachedInputTokens: 200,
            inputTokens: 1_000,
            outputTokens: 50,
            reasoningOutputTokens: 10,
            totalTokens: 1_060,
            uncachedInputTokens: 800,
          },
        },
      });
    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      model: "gpt-5.5",
      parentThreadId: "thread-1",
      priceStatus: "priced",
      scope: "monitor",
      threadId: "thread-1",
      turnId: "turn-review-1",
    });
    expect(pricing.lines[0]?.totalCostMicros).toBeGreaterThan(0);

    await registry.close();
  });

  it("patches detached Codex review usage on the parent thread after completion", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
      startReviewResult: {
        threadId: "thread-parent",
        reviewThreadId: "thread-review",
        turnId: "turn-review-1",
      },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.startReview({
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "detached",
    });

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-review",
        turnId: "turn-review-1",
        turn: {
          id: "turn-review-1",
          status: "completed",
          output: [],
        },
      },
    });

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-review",
        turnId: "turn-review-1",
        model: "gpt-5.5",
        tokenUsage: {
          total: {
            inputTokens: 1_000,
            cachedInputTokens: 200,
            outputTokens: 50,
            reasoningOutputTokens: 10,
          },
        },
      },
    });

    await expect
      .poll(async () => {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-parent",
        });
        return overlay?.subAgents?.[0];
      })
      .toMatchObject({
        monitorId: "review:turn-review-1",
        monitorThreadId: "thread-review",
        monitorTurnId: "turn-review-1",
        outcome: "success",
        status: "success",
        monitorUsage: {
          summary: expect.stringContaining(
            "800 uncached in · 200 cached · 50 out (10 reasoning)"
          ),
        },
      });
    const reviewOverlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-review",
    });
    expect(reviewOverlay?.subAgents).toBeUndefined();
    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      model: "gpt-5.5",
      parentThreadId: "thread-parent",
      priceStatus: "priced",
      scope: "monitor",
      threadId: "thread-review",
      turnId: "turn-review-1",
    });
    expect(pricing.lines[0]?.totalCostMicros).toBeGreaterThan(0);

    await registry.close();
  });

  it("counts observed context replays on review sub-agent usage lines", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
      startReviewResult: {
        threadId: "thread-parent",
        reviewThreadId: "thread-review",
        turnId: "turn-review-1",
      },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.startReview({
      backend: "codex",
      threadId: "thread-parent",
      target: { type: "baseBranch", branch: "main" },
      delivery: "detached",
    });

    // First request: 160k of input on a cold cache — one cold replay.
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-review",
        turnId: "turn-review-1",
        model: "gpt-5.5",
        tokenUsage: {
          total: { inputTokens: 160_000, cachedInputTokens: 8_000, outputTokens: 500 },
          last: { inputTokens: 160_000, cachedInputTokens: 8_000, outputTokens: 500 },
        },
      },
    });
    // Second request replays the grown context mostly cache-served — one hot
    // replay on the same review turn.
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-review",
        turnId: "turn-review-1",
        model: "gpt-5.5",
        tokenUsage: {
          total: { inputTokens: 325_000, cachedInputTokens: 168_000, outputTokens: 1_200 },
          last: { inputTokens: 165_000, cachedInputTokens: 160_000, outputTokens: 700 },
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
        threadId: "thread-review",
        turnId: "turn-review-1",
        observedColdReplayCount: 1,
        // The review thread's first observed request has no prior context
        // snapshot, so cold attribution falls back to its full uncached amount.
        observedColdReplayUncachedTokens: 152_000,
        observedHotReplayCount: 1,
        observedHotReplayCachedTokens: 160_000,
      });

    await registry.close();
  });

  it.each([
    ["thread-parent", false], ["thread-review", false],
    ["thread-parent", true], ["thread-review", true],
  ] as const)(
    "queues a refused native review steer once (%s, completion during admission: %s)",
    async (reviewThreadId, completesDuringAdmission) => {
      vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
      const temp = createTempStateDb("pwragent-native-review-steer-");
      const db = StateDb.open(temp.dbPath);
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start", "turn/steer", "review/start"] },
        startReviewResult: { threadId: "thread-parent", reviewThreadId, turnId: "review-turn" },
      });
      const registry = createDesktopBackendRegistry({
        codexClient, overlayStore: new SqliteOverlayStore(db), threadTitleGenerationService: null,
      });
      let elapsed = 0;
      let heartbeat: (() => void) | undefined;
      const scheduler = new ScheduledThreadActionService({
        registry, store: new ScheduledThreadActionStore(db), now: () => Date.now() + elapsed,
        setTimer: vi.fn(() => ({}) as ReturnType<typeof setTimeout>), clearTimer: vi.fn(),
        setLeaseTimer: vi.fn((callback: () => void) => {
          heartbeat = callback;
          return {} as ReturnType<typeof setInterval>;
        }), clearLeaseTimer: vi.fn(),
      });
      onTestFinished(async () => {
        scheduler.dispose();
        await registry.close();
        db.close();
        removeTempStateDbDir(temp.tempDir);
        vi.unstubAllEnvs();
      });
      await discoverCodexBackendForTest(registry);
      await registry.startReview({
        backend: "codex", threadId: "thread-parent", target: { type: "uncommittedChanges" },
      });
      scheduler.start();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const start = vi.spyOn(codexClient, "startTurn");
      const steer = vi.spyOn(codexClient, "steerTurn");
      const input = [{ type: "text" as const, text: "Was /etc protected on Linux?" }];
      const request = {
        backend: "codex" as const, threadId: "thread-parent", expectedTurnId: "review-turn",
        requestId: "native-review-steer", input,
        fallback: { displayText: input[0]!.text, turn: { input } },
      };
      const terminal = {
        method: "turn/completed" as const,
        params: { threadId: reviewThreadId, turnId: "review-turn",
          turn: { id: "review-turn", status: "completed" as const, output: [] } },
      };
      const admissionRegistry = completesDuringAdmission ? {
        steerTurn: async (...args: Parameters<DesktopBackendRegistry["steerTurn"]>) => {
          try {
            return await registry.steerTurn(...args);
          } catch (error) {
            await codexClient.emit(terminal);
            throw error;
          }
        },
      } : registry;

      const { result, writes } = await measureSqliteWrites(() => admitSteerTurn(admissionRegistry, scheduler, request));
      if (!completesDuringAdmission) {
        expectSqliteWriteBudget({
          scenario: "native-review-steer-follow-up", writes,
          note: "One refused native review steer persisted and queued: 3 commits, ~45 KB per admission, ~4.5 MB/day at 100 steers/day, plus the existing scheduler's lease renewals while queued. Retries add no commits.",
        });
      }
      expect(result).toMatchObject({
        disposition: completesDuringAdmission ? "started" : "scheduled", fallbackReason: "native-review",
        scheduledAction: { status: completesDuringAdmission ? "started" : "queued", turn: { input } },
      });
      expect(result.scheduledAction?.manualReleaseRequired).not.toBe(true);
      expect(steer).not.toHaveBeenCalled();
      if (!completesDuringAdmission) {
        expect(start).not.toHaveBeenCalled();
        const { result: replay, writes: retryWrites } = await measureSqliteWrites(() =>
          admitSteerTurn(registry, scheduler, request));
        expect(replay).toEqual(result);
        expect(retryWrites.commits).toBe(0);
        const { writes: waitingWrites } = await measureSqliteWrites(async () => {
          for (let tick = 0; tick < 6; tick += 1) {
            elapsed += 10_000;
            heartbeat!();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        });
        expectSqliteWriteBudget({
          scenario: "native-review-steer-follow-up-waiting-minute", writes: waitingWrites,
          note: "Six existing 10-second scheduler lease renewals: 6 commits, ~25 KB per waiting minute. Admission plus one minute of waiting per steer projects ~7 MB/day at 100 steers/day.",
        });
      }

      await codexClient.emit(terminal);
      await expect.poll(() => start.mock.calls.length).toBe(1);
      await codexClient.emit(terminal);
      expect(start).toHaveBeenCalledOnce();
      expect(codexClient.lastStartTurnParams).toMatchObject({ threadId: "thread-parent", input });
      expect(steer).not.toHaveBeenCalled();
      await expect.poll(() => scheduler.get(result.scheduledAction!.id)?.status).toBe("started");
      const { result: lateReplay, writes: lateRetryWrites } = await measureSqliteWrites(() =>
        admitSteerTurn(registry, scheduler, request));
      expect(lateReplay).toMatchObject({ disposition: "started", scheduledAction: { status: "started" } });
      expect(lateRetryWrites.commits).toBe(0);
      expect(start).toHaveBeenCalledOnce();
      expect(steer).not.toHaveBeenCalled();
    },
  );

  it.each(["thread-parent", "thread-review"])(
    "keeps native review ownership and releases the parent queue once (%s)",
    async (reviewThreadId) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start", "turn/interrupt", "turn/steer", "review/start"] },
        startReviewResult: {
          threadId: "thread-parent", reviewThreadId, turnId: "review-turn",
        },
      });
      const registry = createDesktopBackendRegistry({
        codexClient, overlayStore: createOverlayStoreMock(),
      });
      await discoverCodexBackendForTest(registry);
      const start = vi.spyOn(codexClient, "startTurn");
      const steer = vi.spyOn(codexClient, "steerTurn");
      await registry.startReview({
        backend: "codex", threadId: "thread-parent", target: { type: "uncommittedChanges" },
      });
      expect(codexClient.lastStartReviewParams?.delivery).toBe("inline");
      expect(start).not.toHaveBeenCalled();
      expect(registry.getActiveTurnForThread({
        backend: "codex", threadId: "thread-parent",
      })).toEqual({ backend: "codex", threadId: "thread-parent", turnId: "review-turn" });
      expect(registry.isThreadTurnOccupied({ backend: "codex", threadId: "thread-parent" })).toBe(true);
      const queued = await registry.submitTurn({
        backend: "codex", threadId: "thread-parent",
        input: [{ type: "text", text: "Continue after review" }], origin: "messaging",
      });
      expect(queued.status).toBe("queued");
      {
        await expect(registry.steerTurn({
          backend: "codex", threadId: "thread-parent", expectedTurnId: "review-turn",
          requestId: "steer-review", input: [{ type: "text", text: "Steer" }],
        })).rejects.toThrow("Native review steering is unsupported");
        await expect(registry.controlActiveTurn({
          operation: "steer", backend: "codex", threadId: "thread-parent",
          requestId: "control-steer-review", expectedTurnId: "review-turn",
          input: [{ type: "text", text: "Steer" }],
        })).resolves.toMatchObject({ ok: false, error: { code: "unsupported_capability" } });
        expect(steer).not.toHaveBeenCalled();
      }
      await codexClient.emit({
        method: "thread/status/changed",
        params: { threadId: "thread-parent", status: { type: "idle" } },
      });
      expect(start).not.toHaveBeenCalled();
      await expect(registry.controlActiveTurn({
        operation: "stop", backend: "codex", threadId: "thread-parent",
        requestId: "stop-review", expectedTurnId: "review-turn",
      })).resolves.toMatchObject({ ok: true, disposition: "interrupted", turnId: "review-turn" });
      expect(codexClient.lastInterruptTurnParams).toMatchObject({ threadId: reviewThreadId, turnId: "review-turn" });
      expect(registry.isThreadTurnOccupied({ backend: "codex", threadId: "thread-parent" })).toBe(true);
      expect(start).not.toHaveBeenCalled();
      const terminal = {
        method: "turn/cancelled" as const,
        params: { threadId: reviewThreadId, turnId: "review-turn",
          turn: { id: "review-turn", status: "cancelled" as const } },
      };
      await codexClient.emit(terminal);
      await expect.poll(() => start.mock.calls.length).toBe(1);
      await codexClient.emit(terminal);
      expect(start).toHaveBeenCalledTimes(1);
      expect(codexClient.lastStartTurnParams?.threadId).toBe("thread-parent");
      await registry.close();
    },
  );

  it.each(["thread-parent", "thread-review"])(
    "delivers waiting agent guidance as one turn after a native review without holding the queue (%s)",
    async (reviewThreadId) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start", "turn/steer", "review/start"] },
        startReviewResult: { threadId: "thread-parent", reviewThreadId, turnId: "review-turn" },
        startTurnResults: [1, 2, 3].map(index => ({ threadId: "thread-parent", turnId: `guidance-${index}` })),
      });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      onTestFinished(() => registry.close());
      await discoverCodexBackendForTest(registry);
      const steer = vi.spyOn(registry, "steerTurn");
      await registry.startReview({
        backend: "codex", threadId: "thread-parent", target: { type: "uncommittedChanges" },
      });
      const first = await registry.submitTurn({
        backend: "codex", threadId: "thread-parent", input: [{ type: "text", text: "Alice evidence" }],
        messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "alice" } },
      });
      const second = await registry.submitTurn({
        backend: "codex", threadId: "thread-parent", input: [{ type: "text", text: "Bob evidence" }],
        messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } },
      });
      await registry.submitTurn({ backend: "codex", threadId: "thread-parent", queueEntryId: "operator-next",
        input: [{ type: "text", text: "Operator follow-up" }],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(first.status).toBe("queued");
      expect(second.entry.id).not.toBe(first.entry.id);
      expect(steer).not.toHaveBeenCalled();
      expect(codexClient.startTurnCallCount).toBe(0);
      const entries = registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "thread-parent")];
      expect(entries?.map((entry) => entry.queueEntryId)).toEqual([first.entry.id, second.entry.id, "operator-next"]);
      expect(entries?.some((entry) => entry.manualReleaseRequired)).toBe(false);
      await codexClient.emit({ method: "turn/completed", params: {
        threadId: reviewThreadId, turnId: "review-turn", turn: { id: "review-turn", status: "completed", output: [] },
      } });
      await waitForCondition(() => codexClient.startTurnCallCount === 1);
      // Both independent acceptances wait together, so they start one turn.
      const delivered = codexClient.lastStartTurnParams?.input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      expect(delivered).toContain("Alice evidence");
      expect(delivered).toContain("Bob evidence");
      expect(delivered!.indexOf("Alice evidence")).toBeLessThan(delivered!.indexOf("Bob evidence"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(steer).not.toHaveBeenCalled();
      await codexClient.emit({ method: "turn/completed", params: {
        threadId: "thread-parent", turnId: "guidance-1", turn: { id: "guidance-1", status: "completed", output: [] },
      } });
      await waitForCondition(() => codexClient.startTurnCallCount === 2);
      expect(codexClient.lastStartTurnParams?.input).toEqual([{ type: "text", text: "Operator follow-up" }]);
    },
  );

  it("holds the parent queue after a distinct native review fails", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "review/start"] },
      startReviewResult: { threadId: "parent", reviewThreadId: "review", turnId: "review-turn" },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const start = vi.spyOn(codexClient, "startTurn");
    await registry.startReview({ backend: "codex", threadId: "parent", target: { type: "uncommittedChanges" } });
    await registry.submitTurn({
      backend: "codex", threadId: "parent", input: [{ type: "text", text: "Next" }], origin: "messaging",
    });
    await codexClient.emit({
      method: "turn/failed", params: { threadId: "review", turnId: "review-turn",
        turn: { id: "review-turn", status: "failed", error: { message: "Review failed upstream" } } },
    });
    expect(start).not.toHaveBeenCalled();
    expect(registry.isThreadTurnOccupied({ backend: "codex", threadId: "parent" })).toBe(false);
    await expect.poll(() => registry.getQueuedTurnsSnapshot()).toMatchObject({
      [buildThreadIdentityKey("codex", "parent")]: [expect.objectContaining({
        manualReleaseRequired: true, holdReason: "Review failed upstream",
      })],
    });
    await registry.close();
  });

  it.each([true, false])(
    "preserves native inner/outer review lifecycle (started before response: %s)",
    async (startedBeforeResponse) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start", "review/start", "turn/interrupt"] },
        startReviewResult: { threadId: "thread-parent", reviewThreadId: "thread-parent", turnId: "outer" },
      });
      const started = {
        method: "turn/started" as const,
        params: { threadId: "thread-parent", turnId: "inner",
          turn: { id: "inner", status: "in_progress" as const } },
      };
      if (startedBeforeResponse) {
        vi.spyOn(codexClient, "startReview").mockImplementation(async () => {
          await codexClient.emit(started);
          return { threadId: "thread-parent", reviewThreadId: "thread-parent", turnId: "outer" };
        });
      }
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      const start = vi.spyOn(codexClient, "startTurn");
      await registry.startReview({ backend: "codex", threadId: "thread-parent", target: { type: "uncommittedChanges" } });
      if (!startedBeforeResponse) await codexClient.emit(started);
      expect(registry.getActiveTurnForThread({ backend: "codex", threadId: "thread-parent" })?.turnId).toBe("outer");
      await registry.submitTurn({
        backend: "codex", threadId: "thread-parent", input: [{ type: "text", text: "Next" }], origin: "messaging",
      });
      await registry.interruptTurn({ backend: "codex", threadId: "thread-parent", turnId: "outer" });
      expect(codexClient.lastInterruptTurnParams).toMatchObject({ threadId: "thread-parent", turnId: "inner" });
      await codexClient.emit({
        method: "item/completed", params: { threadId: "thread-parent", turnId: "outer",
          item: { id: "review-result", type: "exitedReviewMode", review: "No findings." } },
      });
      expect(start).not.toHaveBeenCalled();
      expect(registry.isThreadTurnOccupied({ backend: "codex", threadId: "thread-parent" })).toBe(true);
      await codexClient.emit({
        method: "turn/completed", params: { threadId: "thread-parent", turnId: "outer",
          turn: { id: "outer", status: "completed", output: [] } },
      });
      await expect.poll(() => start.mock.calls.length).toBe(1);
      await registry.close();
    },
  );

  it.each(["cancelled", "failed", "completed"] as const)(
    "settles scheduled inline reviews when the inner turn is %s",
    async (status) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["review/start"] },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
      });
      const events: AgentEvent[] = [];
      registry.onEvent((event) => { events.push(event); });
      const start = vi.spyOn(codexClient, "startReview")
        .mockImplementationOnce(async () => {
          await codexClient.emit({
            method: "turn/started",
            params: {
              threadId: "thread-parent",
              turnId: "inner",
              turn: { id: "inner", status: "in_progress" },
            },
          });
          return { threadId: "thread-parent", reviewThreadId: "thread-parent", turnId: "outer" };
        })
        .mockResolvedValue({ threadId: "thread-parent", reviewThreadId: "thread-parent", turnId: "next-review" });
      const request = {
        backend: "codex" as const,
        threadId: "thread-parent",
        target: { type: "uncommittedChanges" as const },
      };
      try {
        await registry.startReview(request);
        const scheduled = await registry.submitReview(request);
        expect(scheduled).toMatchObject({ status: "scheduled", invokingTurnId: "outer" });
        if (scheduled.status !== "scheduled") throw new Error("Expected a scheduled review");
        const params = { threadId: "thread-parent", turnId: "inner" };
        const terminal: AppServerNotification = status === "failed"
          ? {
              method: "turn/failed",
              params: { ...params, turn: { id: "inner", status, error: { message: "Review failed" } } },
            }
          : status === "cancelled"
            ? {
                method: "turn/cancelled",
                params: { ...params, turn: { id: "inner", status } },
              }
            : {
                method: "turn/completed",
                params: { ...params, turn: { id: "inner", status, output: [] } },
              };
        await codexClient.emit(terminal);
        await codexClient.emit(terminal);
        const updates = events.filter((event) =>
          event.notification.method === "thread/reviewStart/updated"
          && event.notification.params.pendingReviewId === scheduled.pendingReviewId
          && event.notification.params.status !== "scheduled"
        );
        expect(updates).toEqual([{
          backend: "codex",
          notification: {
            method: "thread/reviewStart/updated",
            params: expect.objectContaining({
              threadId: "thread-parent",
              pendingReviewId: scheduled.pendingReviewId,
              status: status === "completed" ? "started" : "cancelled",
            }),
          },
        }]);
        expect(start).toHaveBeenCalledTimes(status === "completed" ? 2 : 1);
        expect(registry.cancelPendingReview(scheduled.pendingReviewId, "Must already be settled")).toBe(false);
      } finally {
        await registry.close();
      }
    },
  );

  it.each(["thread-parent", "thread-review"])(
    "does not resurrect a native review completed before its response (%s)",
    async (reviewThreadId) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start", "review/start"] },
      });
      const overlayStore = createOverlayStoreMock();
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      vi.spyOn(codexClient, "startReview").mockImplementation(async () => {
        await codexClient.emit({
          method: "turn/started",
          params: { threadId: reviewThreadId, turnId: "inner",
            turn: { id: "inner", status: "in_progress" } },
        });
        await codexClient.emit({
          method: "turn/completed",
          params: { threadId: reviewThreadId, turnId: "review-turn",
            turn: { id: "review-turn", status: "completed", output: [] } },
        });
        return { threadId: "thread-parent", reviewThreadId, turnId: "review-turn" };
      });
      await registry.startReview({
        backend: "codex", threadId: "thread-parent", target: { type: "uncommittedChanges" },
      });
      expect(registry.isThreadTurnOccupied({ backend: "codex", threadId: "thread-parent" })).toBe(false);
      expect(registry.isThreadTurnOccupied({ backend: "codex", threadId: reviewThreadId })).toBe(false);
      expect(registry.getActiveTurnForThread({ backend: "codex", threadId: "thread-parent" })).toBeUndefined();
      expect((await overlayStore.getThreadOverlayState({
        backend: "codex", threadId: "thread-parent",
      }))?.subAgents?.[0]).toMatchObject({ status: "success" });
      await registry.close();
    },
  );

  it("interrupts Codex reviews with the backend active turn id", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/interrupt", "review/start"] },
      startReviewResult: {
        threadId: "thread-1",
        reviewThreadId: "thread-1",
        turnId: "turn-review-1",
      },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.startReview({
      backend: "codex",
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });
    await codexClient.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-interrupt-1",
        turn: {
          id: "turn-interrupt-1",
          status: "in_progress",
          startedAt: 1_000,
        },
      },
    });

    await registry.interruptTurn({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-review-1",
    });

    expect(codexClient.lastInterruptTurnParams).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-interrupt-1",
    });

    await codexClient.emit({
      method: "turn/cancelled",
      params: {
        threadId: "thread-1",
        turnId: "turn-interrupt-1",
        turn: {
          id: "turn-interrupt-1",
          status: "cancelled",
          completedAt: 1_781_178_300,
        },
      },
    });

    await expect
      .poll(async () => {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        });
        return overlay?.subAgents?.[0];
      })
      .toMatchObject({
        monitorId: "review:turn-review-1",
        outcome: "cancelled",
        status: "cancelled",
        lastMessage: "Review cancelled.",
        completedAt: 1_781_178_300_000,
      });

    await registry.close();
  });

  it("schedules a dynamic-tool review until the invoking turn completes", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/start", "turn/start", "review/start", "thread/resume"],
      },
    });
    const readTurnRoot = vi.fn(async () => "review-root");
    Object.assign(codexClient, { readTurnRoot });
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
        callId: "call-review-1",
        requestId: "call-review-1",
        namespace: "pwragent",
        tool: "start_review",
        arguments: {
          target: {
            type: "baseBranch",
            branch: "main",
          },
          cwd: "/repo/pwragent",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    expect(codexClient.lastStartReviewParams).toBeUndefined();

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed", output: [] },
      },
    });

    expect(codexClient.lastStartReviewParams).toBeUndefined();
    expect(codexClient.lastStartThreadParams).toMatchObject({
      cwd: "/repo/pwragent",
      ephemeral: true,
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      parentTurnId: "turn-1", rootTurnId: "review-root",
      cwd: "/repo/pwragent",
    });

    await registry.close();
  });

  it("tells the thread when a scheduled review fails to start, once per failure", async () => {
    // A scheduled start that failed reached only the log. The agent had been
    // told the review was scheduled and kept reporting it as pending.
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/interrupt", "thread/resume"] },
      startTurnResults: [
        { threadId: "parent-thread", turnId: "notice-turn-1" },
        { threadId: "parent-thread", turnId: "notice-turn-2" },
      ],
      interruptEndsTurn: true,
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    try {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: { threadId: "parent-thread", turnId: "turn-1", turn: { id: "turn-1" } },
        },
      });
      await expect(registry.submitReview({
        backend: "codex",
        threadId: "parent-thread",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      })).resolves.toMatchObject({ status: "scheduled" });

      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      });

      await vi.waitFor(() => {
        expect(codexClient.startTurnCallCount).toBe(1);
      });
      const notice = (codexClient.lastStartTurnParams?.input[0] as { text?: string } | undefined)
        ?.text ?? "";
      expect(codexClient.lastStartTurnParams?.threadId).toBe("parent-thread");
      expect(notice).toContain("could not start the review");
      expect(notice).toContain("- Target: changes against main");
      expect(notice).toContain("Error: Selected backend does not support review/start");

      // The agent retries from the notice turn and fails the same way. A
      // second notice would start a turn that retries again, without end.
      await expect(registry.submitReview({
        backend: "codex",
        threadId: "parent-thread",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      })).resolves.toMatchObject({ status: "scheduled", invokingTurnId: "notice-turn-1" });
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "parent-thread",
          turnId: "notice-turn-1",
          turn: { id: "notice-turn-1", status: "completed", output: [] },
        },
      });
      await flushAsync();
      expect(codexClient.startTurnCallCount).toBe(1);

      // A turn that ends without a failed start means the thread moved on, so
      // the same failure later is news again.
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: { threadId: "parent-thread", turnId: "turn-3", turn: { id: "turn-3" } },
        },
      });
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "parent-thread",
          turnId: "turn-3",
          turn: { id: "turn-3", status: "completed", output: [] },
        },
      });
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: { threadId: "parent-thread", turnId: "turn-4", turn: { id: "turn-4" } },
        },
      });
      await expect(registry.submitReview({
        backend: "codex",
        threadId: "parent-thread",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      })).resolves.toMatchObject({ status: "scheduled", invokingTurnId: "turn-4" });
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "parent-thread",
          turnId: "turn-4",
          turn: { id: "turn-4", status: "completed", output: [] },
        },
      });
      await vi.waitFor(() => {
        expect(codexClient.startTurnCallCount).toBe(2);
      });
    } finally {
      await registry.close();
    }
  });

  it("fingerprints failed review starts by target and error, not snapshot time", () => {
    // Each scheduled pull request review captures a new snapshot. Comparing
    // whole targets let every retry of a failing PR review send a new notice.
    const pullRequest = (capturedAt: number) => ({
      type: "pullRequest" as const,
      url: "https://github.com/acme/widgets/pull/42",
      snapshot: {
        pullRequest: {
          provider: "github.com",
          org: "acme",
          repo: "widgets",
          number: 42,
          url: "https://github.com/acme/widgets/pull/42",
          title: "Fix widgets",
          baseRefName: "main",
          headRefName: "fix/widgets",
        },
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        mergeBaseCommit: "a".repeat(40),
        capturedAt,
      },
    });
    const error = "Selected review provider cannot run reviews: claude";
    expect(reviewStartFailureFingerprint([{ error, target: pullRequest(1) }]))
      .toBe(reviewStartFailureFingerprint([{ error, target: pullRequest(2) }]));
    expect(reviewStartFailureFingerprint([{ error, target: pullRequest(1) }]))
      .not.toBe(reviewStartFailureFingerprint([{ error: "Other", target: pullRequest(1) }]));
  });

  it("queues review submission while the invoking turn start is pending", async () => {
    const startTurnDelay = createDeferred<void>();
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["turn/start", "review/start", "thread/resume"],
      },
      startTurnDelay: startTurnDelay.promise,
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });

    const turnPromise = registry.startTurn({
      backend: "codex",
      threadId: "parent-thread",
      input: [{ type: "text", text: "Keep working" }],
    });
    await flushAsync();

    await expect(
      registry.submitReview({
        backend: "codex",
        threadId: "parent-thread",
        target: { type: "uncommittedChanges" },
        delivery: "inline",
      }),
    ).resolves.toMatchObject({
      status: "scheduled",
      invokingTurnId: "pending:parent-thread",
    });
    expect(codexClient.lastStartReviewParams).toBeUndefined();

    startTurnDelay.resolve();
    await turnPromise;
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed", output: [] },
      },
    });

    expect(codexClient.lastStartReviewParams).toEqual({
      threadId: "parent-thread",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });

    await registry.close();
  });

  it("rejects cancellation once a deferred review has begun backend admission", async () => {
    const startReviewDelay = createDeferred<void>();
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["turn/start", "review/start", "thread/resume"],
      },
      startReviewDelay: startReviewDelay.promise,
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
          threadId: "parent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    const scheduled = await registry.submitReview({
      backend: "codex",
      threadId: "parent-thread",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    expect(scheduled.status).toBe("scheduled");
    if (scheduled.status !== "scheduled") throw new Error("Expected deferred review.");

    const completion = codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed", output: [] },
      },
    });
    await vi.waitFor(() => {
      expect(codexClient.lastStartReviewParams).toBeDefined();
    });

    expect(registry.cancelPendingReview(
      scheduled.pendingReviewId,
      "Too late",
    )).toBe(false);

    startReviewDelay.resolve();
    await completion;
    await registry.close();
  });

  it("keeps independently scheduled reviews distinct behind one active turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["turn/start", "review/start", "thread/resume"],
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
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

    const first = await registry.submitReview({
      backend: "codex",
      threadId: "parent-thread",
      idempotencyKey: "scheduled-action:first",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });
    const second = await registry.submitReview({
      backend: "codex",
      threadId: "parent-thread",
      idempotencyKey: "scheduled-action:second",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    const third = await registry.submitReview({
      backend: "codex",
      threadId: "parent-thread",
      idempotencyKey: "scheduled-action:third",
      target: { type: "baseBranch", branch: "develop" },
      delivery: "inline",
    });
    expect(first.status).toBe("scheduled");
    expect(second.status).toBe("scheduled");
    expect(third.status).toBe("scheduled");
    if (
      first.status !== "scheduled"
      || second.status !== "scheduled"
      || third.status !== "scheduled"
    ) {
      throw new Error("Expected all reviews to wait behind the active turn.");
    }
    expect(first.pendingReviewId).not.toBe(second.pendingReviewId);
    expect(second.pendingReviewId).not.toBe(third.pendingReviewId);
    expect(registry.cancelPendingReview(
      first.pendingReviewId,
      "Cancelled first scheduled review.",
    )).toBe(true);

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed", output: [] },
      },
    });

    expect(codexClient.lastStartReviewParams).toEqual({
      threadId: "parent-thread",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    expect(events).toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/reviewStart/updated",
        params: expect.objectContaining({
          pendingReviewId: second.pendingReviewId,
          status: "started",
        }),
      },
    });
    expect(events).not.toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/reviewStart/updated",
        params: expect.objectContaining({
          pendingReviewId: first.pendingReviewId,
          status: "started",
        }),
      },
    });
    expect(events).not.toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/reviewStart/updated",
        params: expect.objectContaining({
          pendingReviewId: third.pendingReviewId,
          status: "started",
        }),
      },
    });

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-review-1",
        turn: { id: "turn-review-1", status: "completed", output: [] },
      },
    });

    expect(codexClient.lastStartReviewParams).toEqual({
      threadId: "parent-thread",
      target: { type: "baseBranch", branch: "develop" },
      delivery: "inline",
    });
    expect(events).toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/reviewStart/updated",
        params: expect.objectContaining({
          pendingReviewId: third.pendingReviewId,
          status: "started",
        }),
      },
    });

    await registry.close();
  });

  it("emits a terminal outcome when a deferred review cannot start", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["turn/start", "review/start", "thread/resume"],
      },
      startReviewError: new Error("Codex disconnected"),
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
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
    await registry.submitReview({
      backend: "codex",
      threadId: "parent-thread",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed", output: [] },
      },
    });

    expect(events).toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/reviewStart/updated",
        params: expect.objectContaining({
          threadId: "parent-thread",
          status: "failed",
          error: "Codex disconnected",
        }),
      },
    });

    await registry.close();
  });

  it("exposes start_review through the MCP tool catalog", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["turn/start", "review/start", "thread/resume"],
      },
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
      tool: "start_review",
      args: {
        target: { type: "uncommittedChanges" },
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        backend: "codex",
        threadId: "parent-thread",
        status: "scheduled",
        target: { type: "uncommittedChanges" },
        invokingTurnId: "turn-1",
      },
    });
    expect(codexClient.lastStartReviewParams).toBeUndefined();

    await registry.close();
  });

  it("names a Claude review card by the pull requests its /code-review targeted", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
    });
    const internals = registry as unknown as {
      claudeBackend: {
        options: {
          resolveReviewContext: (params: {
            threadId: string;
            cwd: string;
            pullRequests?: Array<{ number: number }>;
          }) => Promise<AppServerReviewContext | undefined>;
        };
      };
    };
    const resolveReviewContext = vi.spyOn(registryModules(registry).managedReviewService, "resolveReviewContext")
      .mockResolvedValue(undefined);

    await internals.claudeBackend.options.resolveReviewContext({
      threadId: "claude-1",
      cwd: "/repo",
      pullRequests: [{ number: 2947 }, { number: 2948 }],
    });

    expect(resolveReviewContext).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude",
      cwd: "/repo",
      threadId: "claude-1",
      namedPullRequests: [{ number: 2947 }, { number: 2948 }],
    }));
    await registry.close();
  });

  describe("Claude code-review findings", () => {
    async function fixture(combined = false) {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-review-"));
      const repo = path.join(root, "repo");
      const cwd = path.join(root, ".pwragent", "worktrees", "fixture", "repo");
      await mkdir(repo, { recursive: true });
      await git(repo, ["init", "-b", "main"]);
      await git(repo, ["commit", "--allow-empty", "-m", "init"]);
      await git(repo, ["worktree", "add", "-b", "feature/review", cwd]);
      const threadId = "b2222222-2222-4222-8222-222222222222";
      const directory: LinkedDirectorySummary = { id: repo, path: repo, worktreePath: cwd, label: "repo", kind: "worktree" };
      const pr = {
        provider: "github.com", org: "example", repo: "repo", number: 41, state: "passing",
        lifecycleState: "open", headRefName: "feature/review", url: "https://github.com/example/repo/pull/41",
      } as const;
      const secondPr = { ...pr, number: 42, url: "https://github.com/example/repo/pull/42" };
      const overlayStore = createOverlayStoreMock({ overlays: {
        [`claude:${threadId}`]: {
          backend: "claude", threadId, executionMode: "default", extraLinkedDirectories: [directory],
          prs: combined ? [pr, secondPr] : [pr],
        },
      } });
      const store = new ClaudeSessionStore(path.join(root, "sessions"));
      await store.save({ cwd, thread: {
        id: threadId, source: "claude", title: "Review fixture", titleSource: "explicit", projectKey: cwd,
        linkedDirectories: [directory],
      } });
      const registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({ threads: [] }), overlayStore,
        claudeBackendOptions: {
          store,
          getSessionInfo: vi.fn().mockResolvedValue(undefined),
          inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
          discoverModels: async () => [],
          query: () => {
            async function* messages(): AsyncGenerator<ClaudeMessage> {
              yield { type: "assistant", parent_tool_use_id: null, message: {
                id: "review-message", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_review",
                  name: "ReportFindings", input: { level: "high", findings: [
                    { file: "src/a.ts", line: 4, summary: "Drops the error.", failure_scenario: "A failed write reports success." },
                  ] } }],
              } } as ClaudeMessage;
              // The card waits for the CLI to accept the call.
              yield { type: "user", message: { content: [{
                type: "tool_result", tool_use_id: "toolu_review", content: "1 finding reported.",
              }] } } as ClaudeMessage;
              yield { type: "result", subtype: "success", is_error: false, result: "" } as ClaudeMessage;
            }
            return Object.assign(messages(), { close: vi.fn(), setPermissionMode: vi.fn() }) as unknown as ClaudeQuery;
          },
        },
      });
      onTestFinished(async () => {
        await registry.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });
      return { registry, threadId, cwd, repo, pr, secondPr, store };
    }

    it("runs the agent tool's combined review as one Claude Code command after the parent turn completes", async () => {
      const { registry, threadId, repo, pr, secondPr } = await fixture(true);
      await git(repo, ["remote", "add", "origin", "https://github.com/example/repo.git"]);
      await registry.listBackends({ refreshModels: "claude", includeUnavailable: true },
        issueProviderDiscoveryPermit("settings-user-action"));
      const turnId = "invoking-turn";
      await registry.publishLocalEvent({ backend: "claude", notification: {
        method: "turn/started", params: { threadId, turnId, turn: { id: turnId } },
      } });
      const call = (urls: string[]) => callRegistryMcpTool({
        registry, backend: "claude", threadId, turnId, tool: "start_review",
        args: { target: { type: "pullRequests", pullRequests: urls.map(url => ({ url })) } },
      });
      const unattached = await call([pr.url, "https://github.com/example/repo/pull/43"]);
      expect(unattached).toMatchObject({ isError: true });
      expect(JSON.stringify(unattached)).toContain("attached to this thread");

      const target = { type: "pullRequests", pullRequests: [{ url: pr.url }, { url: secondPr.url }] };
      expect(await call([pr.url, secondPr.url])).toMatchObject({
        structuredContent: { status: "scheduled", target },
      });
      const reviewMessages = async () => (await registry.readThread({ backend: "claude", threadId })).replay.entries
        .filter(entry => entry.type === "message" && entry.text.startsWith("/code-review"));
      expect(await reviewMessages()).toEqual([]);
      await registry.publishLocalEvent({ backend: "claude", notification: {
        method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed", output: [] } },
      } });
      await vi.waitFor(async () => expect(await reviewMessages()).toEqual([
        expect.objectContaining({ text: "/code-review high 41,42" }),
      ]));
    });

    it("publishes a review card naming the workspace, branch, and attached pull request", async () => {
      const { registry, threadId, cwd, repo, pr } = await fixture();
      const events: AgentEvent[] = [];
      registry.onEvent((event) => { events.push(event); });
      const ended = nextTurnEnd(registry);
      await registry.listBackends({ refreshModels: "claude", includeUnavailable: true },
        issueProviderDiscoveryPermit("settings-user-action"));
      await registry.startTurn({ backend: "claude", threadId, input: [{ type: "text", text: "/code-review high" }] });
      expect(await ended).toBe("turn/completed");

      const review = events.find((event) => event.notification.method === "item/completed"
        && (event.notification.params.item as { type?: string }).type === "exitedReviewMode");
      if (!review) throw new Error("Expected a review card event");
      expect(review.backend).toBe("claude");
      const data = (review.notification.params as { item: { data: { context: AppServerReviewContext } } }).item.data;
      expect(data.context).toMatchObject({
        workspacePath: cwd, projectLabel: "repo", repositoryPath: repo, gitBranch: "feature/review",
        pullRequest: { provider: pr.provider, org: pr.org, repo: pr.repo, number: pr.number, url: pr.url },
      });
      expect(data.context.headCommit).toMatch(/^[0-9a-f]{40}$/);
    });

    it("hands the thread's review entries to tracking when the thread is read", async () => {
      const { registry, threadId } = await fixture();
      const importReviews = vi.fn();
      registry.setPwrAgentThreadTodoHandler({ importReviews } as unknown as PwrAgentThreadTodoHandler);
      const ended = nextTurnEnd(registry);
      await registry.listBackends({ refreshModels: "claude", includeUnavailable: true },
        issueProviderDiscoveryPermit("settings-user-action"));
      await registry.startTurn({ backend: "claude", threadId, input: [{ type: "text", text: "/code-review" }] });
      expect(await ended).toBe("turn/completed");
      importReviews.mockClear();

      await registry.readThread({ backend: "claude", threadId });
      expect(importReviews).toHaveBeenCalledExactlyOnceWith({ backend: "claude", threadId }, [
        expect.objectContaining({ type: "review", id: "toolu_review", turn: expect.objectContaining({ status: "completed" }) }),
      ]);
    });

    it("pages a Claude transcript newest turn first and still imports older reviews", async () => {
      const { registry, threadId, store } = await fixture();
      const importReviews = vi.fn();
      registry.setPwrAgentThreadTodoHandler({ importReviews } as unknown as PwrAgentThreadTodoHandler);
      const review: AppServerThreadEntry = {
        type: "review", id: "toolu_old_review", review: "1 finding", createdAt: 2,
        turn: { id: "turn-1", status: "completed" },
      };
      await store.append(threadId, [
        { type: "message", id: "user:turn-1", role: "user", text: "Review it", createdAt: 1, turn: { id: "turn-1" } },
        review,
        { type: "message", id: "user:turn-2", role: "user", text: "Fix it", createdAt: 3, turn: { id: "turn-2" } },
        { type: "message", id: "msg-2", role: "assistant", text: "Fixed", createdAt: 4, turn: { id: "turn-2" } },
        { type: "message", id: "user:turn-3", role: "user", text: "Ship it", createdAt: 5, turn: { id: "turn-3" } },
        { type: "message", id: "msg-3", role: "assistant", text: "Shipped", createdAt: 6, turn: { id: "turn-3" } },
      ]);

      const newest = await registry.readThread({ backend: "claude", threadId, limit: 1 });
      expect(newest.replay.entries.map((entry) => entry.id)).toEqual(["user:turn-3", "msg-3"]);
      expect(newest.replay.pagination).toEqual({
        supportsPagination: true, hasPreviousPage: true, previousCursor: "user:turn-3",
      });
      // The review is two pages back and must reach To-dos anyway.
      expect(importReviews).toHaveBeenCalledExactlyOnceWith({ backend: "claude", threadId }, [
        expect.objectContaining({ id: "toolu_old_review" }),
      ]);

      const middle = await registry.readThread({ backend: "claude", threadId, limit: 1, before: "user:turn-3" });
      expect(middle.replay.entries.map((entry) => entry.id)).toEqual(["user:turn-2", "msg-2"]);
      const oldest = await registry.readThread({
        backend: "claude", threadId, limit: 1, before: middle.replay.pagination.previousCursor,
      });
      expect(oldest.replay.entries.map((entry) => entry.id)).toEqual(["user:turn-1", "toolu_old_review"]);
      expect(oldest.replay.pagination.hasPreviousPage).toBe(false);

      // A read without a page size is the whole thread, as before.
      const whole = await registry.readThread({ backend: "claude", threadId });
      expect(whole.replay.entries).toHaveLength(6);
    });
  });
});
