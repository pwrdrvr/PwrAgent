import {
  localAcpDiscoveryMock,
  createDeferred,
  createOverlayStoreMock,
  MockBackendClient,
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAcpRegistry,
  toTestRepositoryPath,
  createAcpAvailableCommandsStoreMock,
  emitCompletedTurn,
  discoverCodexBackendForTest,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { AcpBackendAdapter } from "../app-server/acp-backend-adapter";
import fc from "fast-check";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
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
import type {
  AcpBackendId,
  AppServerBackendKind,
  AppServerNotification,
  AppServerAvailableCommandSummary,
  AppServerThreadReplay,
  AppServerThreadSummary,
  LinkedDirectorySummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  BackendAccountSummary,
  BackendAcpSessionRuntimeState,
  BackendSummary,
  BackendRateLimitSummary,
} from "@pwragent/shared/contracts/backend";
import type { ManagedCodexSelectionChange } from "../settings/desktop-settings-service";
import { managedCodexRoot } from "../codex-build-channel";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import type { ProviderThreadSnapshot } from "@pwragent/owner-core/provider-thread-snapshot-storage";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import { AcpSessionStore } from "../storage/acp-session-store";

describe("DesktopBackendRegistry", () => {
  it("requires explicit Antigravity usage intent independently of background or generic quota refresh", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
    });
    const describeAcp = vi.spyOn(AcpBackendAdapter.prototype, "describeInstalledBackends").mockResolvedValue([]);
    onTestFinished(async () => {
      describeAcp.mockRestore();
      await registry.close();
    });
    await registry.listBackends();
    await registry.listBackends({ refreshRateLimits: true });
    await registry.listBackends({ refreshAntigravityQuota: true });
    expect(describeAcp.mock.calls).toEqual([[false], [false], [true]]);
  });

  it("serves cached ACP provider commands to a launchpad draft with no thread", async () => {
    const repositoryPath = toTestRepositoryPath("/repo");
    const commands: AppServerAvailableCommandSummary[] = [
      {
        name: "compact",
        description: "Compact this thread's context.",
        backend: "acp:grok",
        scope: "session",
        source: "provider",
      },
    ];
    const acpAvailableCommandsStore = createAcpAvailableCommandsStoreMock([
      {
        backendId: "acp:grok",
        repositoryPath,
        commands,
        observedAt: 1000,
      },
    ]);
    const { registry, acpClient } = createKimiAcpRegistry({
      acpBackendId: "acp:grok" as AcpBackendId,
      acpAvailableCommandsStore,
    });

    await expect(
      registry.listSkills({
        backend: "acp:grok" as AppServerBackendKind,
        cwd: "/repo",
        cwds: ["/repo"],
      }),
    ).resolves.toEqual({
      data: [{ skills: [], commands }],
    });
    // Cache hit — no throwaway session, so no agent process spawn.
    expect(acpClient.startSession).not.toHaveBeenCalled();
  });

  it("keys ACP launchpad commands on the repository behind a worktree cwd", async () => {
    // A born thread running in a worktree and a draft sitting on the checkout
    // must resolve to the same cache row: commands belong to the repo, and a
    // `workMode: "worktree"` draft's directoryPath is the source checkout the
    // worktree has not been cut from yet.
    const repositoryPath = toTestRepositoryPath("/repo");
    const worktreePath = toTestRepositoryPath("/worktrees/ab12/repo");
    const commands: AppServerAvailableCommandSummary[] = [
      {
        name: "review",
        backend: "acp:grok",
        scope: "session",
        source: "provider",
      },
    ];
    const acpAvailableCommandsStore = createAcpAvailableCommandsStoreMock([
      {
        backendId: "acp:grok",
        repositoryPath,
        commands,
        observedAt: 1000,
      },
    ]);
    const { registry, acpClient } = createKimiAcpRegistry({
      acpBackendId: "acp:grok" as AcpBackendId,
      acpAvailableCommandsStore,
      acpWorktreeRepositoryResolver: async (cwd) =>
        path.resolve(cwd) === path.resolve(worktreePath)
          ? {
              id: repositoryPath,
              path: repositoryPath,
              worktreePath,
              label: "repo",
              kind: "worktree",
            }
          : undefined,
    });

    await expect(
      registry.listSkills({
        backend: "acp:grok" as AppServerBackendKind,
        cwd: worktreePath,
        cwds: [worktreePath],
      }),
    ).resolves.toEqual({
      data: [{ skills: [], commands }],
    });
    expect(acpClient.startSession).not.toHaveBeenCalled();
  });

  it("probes once for an ACP repo it has never observed commands for", async () => {
    const repositoryPath = toTestRepositoryPath("/repo");
    const availableCommands: AppServerAvailableCommandSummary[] = [
      {
        name: "compact",
        backend: "acp:grok",
        scope: "session",
        source: "provider",
      },
    ];
    const acpAvailableCommandsStore = createAcpAvailableCommandsStoreMock();
    const { registry, acpClient, sessions } = createKimiAcpRegistry({
      acpBackendId: "acp:grok" as AcpBackendId,
      acpAvailableCommandsStore,
      availableCommandsOnSessionStart: availableCommands,
    });

    // A burst of composer keystrokes, all before the first probe resolves.
    const responses = await Promise.all([
      registry.listSkills({
        backend: "acp:grok" as AppServerBackendKind,
        cwd: "/repo",
        cwds: ["/repo"],
      }),
      registry.listSkills({
        backend: "acp:grok" as AppServerBackendKind,
        cwd: "/repo",
        cwds: ["/repo"],
      }),
    ]);

    for (const response of responses) {
      expect(response).toEqual({
        data: [{ skills: [], commands: availableCommands }],
      });
    }
    expect(acpClient.startSession).toHaveBeenCalledTimes(1);
    expect(acpClient.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: repositoryPath,
        hidden: true,
        mcpServers: "none",
      }),
    );
    // The throwaway session stays out of every thread list.
    expect(sessions.every((session) => session.hidden)).toBe(true);

    // Cached now, so a later draft in the same repo costs nothing.
    await expect(
      registry.listSkills({
        backend: "acp:grok" as AppServerBackendKind,
        cwd: "/repo",
        cwds: ["/repo"],
      }),
    ).resolves.toEqual({
      data: [{ skills: [], commands: availableCommands }],
    });
    expect(acpClient.startSession).toHaveBeenCalledTimes(1);
    expect(acpAvailableCommandsStore.records).toEqual([
      expect.objectContaining({
        backendId: "acp:grok",
        repositoryPath,
        commands: availableCommands,
      }),
    ]);
  });

  it("never persists an empty ACP command probe result", async () => {
    // A probe that came up empty because the agent was slow is
    // indistinguishable from one whose agent has no commands. Storing that
    // guess is what left an operator with a permanently empty `/` menu.
    const acpAvailableCommandsStore = createAcpAvailableCommandsStoreMock();
    const { registry, acpClient } = createKimiAcpRegistry({
      acpBackendId: "acp:grok" as AcpBackendId,
      acpAvailableCommandsStore,
      acpAvailableCommandProbeBudgetMs: 5,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        registry.listSkills({
          backend: "acp:grok" as AppServerBackendKind,
          cwd: "/repo",
          cwds: ["/repo"],
        }),
      ).resolves.toEqual({ data: [{ skills: [], commands: [] }] });
    }

    // Backed off in memory rather than written down.
    expect(acpClient.startSession).toHaveBeenCalledTimes(1);
    expect(acpAvailableCommandsStore.records).toEqual([]);
    expect(acpAvailableCommandsStore.upsert).not.toHaveBeenCalled();
  });

  it("re-probes past an empty ACP cache row left by an older build", async () => {
    // Regression: builds before this fix persisted `[]` for a probe that timed
    // out, and that row then suppressed every future probe. Profiles carrying
    // one must heal on the next request rather than stay empty forever.
    const repositoryPath = toTestRepositoryPath("/repo");
    const availableCommands: AppServerAvailableCommandSummary[] = [
      {
        name: "compact",
        backend: "acp:grok",
        scope: "session",
        source: "provider",
      },
    ];
    const acpAvailableCommandsStore = createAcpAvailableCommandsStoreMock([
      {
        backendId: "acp:grok",
        repositoryPath,
        commands: [],
        observedAt: 1000,
      },
    ]);
    const { registry, acpClient } = createKimiAcpRegistry({
      acpBackendId: "acp:grok" as AcpBackendId,
      acpAvailableCommandsStore,
      availableCommandsOnSessionStart: availableCommands,
    });

    await expect(
      registry.listSkills({
        backend: "acp:grok" as AppServerBackendKind,
        cwd: "/repo",
        cwds: ["/repo"],
      }),
    ).resolves.toEqual({ data: [{ skills: [], commands: availableCommands }] });
    expect(acpClient.startSession).toHaveBeenCalledTimes(1);
    // The poisoned row is replaced by the real observation.
    expect(acpAvailableCommandsStore.records).toEqual([
      expect.objectContaining({ repositoryPath, commands: availableCommands }),
    ]);
  });

  it("gives up on an ACP probe whose session never opens", async () => {
    // `session/new` inherits the transport's ten-minute default request
    // timeout and `getClient` awaits an unbounded `initialize()`, so a wedged
    // agent must not be able to hold `listSkills` open: the renderer skips any
    // request while one is in flight, which would strand the `/` menu on
    // PwrAgent's own commands with no way to retry.
    const { registry, acpClient } = createKimiAcpRegistry({
      acpBackendId: "acp:grok" as AcpBackendId,
      acpAvailableCommandsStore: null,
      acpAvailableCommandProbeBudgetMs: 5,
      startSession: () => new Promise<AcpSessionMetadata>(() => {}),
    });

    await expect(
      registry.listSkills({
        backend: "acp:grok" as AppServerBackendKind,
        cwd: "/repo",
        cwds: ["/repo"],
      }),
    ).resolves.toEqual({ data: [{ skills: [], commands: [] }] });

    // The stuck attempt is still running; the next request must resolve from
    // it rather than start a second probe alongside it.
    await expect(
      registry.listSkills({
        backend: "acp:grok" as AppServerBackendKind,
        cwd: "/repo",
        cwds: ["/repo"],
      }),
    ).resolves.toEqual({ data: [{ skills: [], commands: [] }] });
    expect(acpClient.startSession).toHaveBeenCalledTimes(1);
  });

  it("backs off ACP command probes with no cache to remember the miss", async () => {
    const { registry, acpClient } = createKimiAcpRegistry({
      acpBackendId: "acp:grok" as AcpBackendId,
      acpAvailableCommandsStore: null,
      acpAvailableCommandProbeBudgetMs: 5,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        registry.listSkills({
          backend: "acp:grok" as AppServerBackendKind,
          cwd: "/repo",
          cwds: ["/repo"],
        }),
      ).resolves.toEqual({ data: [{ skills: [], commands: [] }] });
    }

    expect(acpClient.startSession).toHaveBeenCalledTimes(1);
  });

  it("caches ACP commands reported by a live session under its repository", async () => {
    const repositoryPath = toTestRepositoryPath("/repo");
    const worktreePath = toTestRepositoryPath("/worktrees/ab12/repo");
    const commands: AppServerAvailableCommandSummary[] = [
      {
        name: "compact",
        backend: "acp:grok",
        scope: "session",
        source: "provider",
      },
    ];
    const acpAvailableCommandsStore = createAcpAvailableCommandsStoreMock();
    const { registry } = createKimiAcpRegistry({
      acpBackendId: "acp:grok" as AcpBackendId,
      acpAvailableCommandsStore,
      sessionId: "grok-session-1",
      sessions: [
        {
          backendId: "acp:grok" as AcpBackendId,
          sessionId: "grok-session-1",
          title: "Grok session",
          cwd: worktreePath,
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
        },
      ],
      acpWorktreeRepositoryResolver: async (cwd) =>
        path.resolve(cwd) === path.resolve(worktreePath)
          ? {
              id: repositoryPath,
              path: repositoryPath,
              worktreePath,
              label: "repo",
              kind: "worktree",
            }
          : undefined,
    });

    (
      registry as unknown as {
        rememberAcpAvailableCommands(event: AgentEvent): void;
      }
    ).rememberAcpAvailableCommands({
      backend: "acp:grok" as AppServerBackendKind,
      notification: {
        method: "thread/availableCommands/updated",
        params: { threadId: "grok-session-1", commands },
      },
    });
    await vi.waitFor(() => {
      expect(acpAvailableCommandsStore.records).toEqual([
        expect.objectContaining({ repositoryPath, commands }),
      ]);
    });

    // The draft on the checkout now answers from what the worktree session saw.
    await expect(
      registry.listSkills({
        backend: "acp:grok" as AppServerBackendKind,
        cwd: "/repo",
        cwds: ["/repo"],
      }),
    ).resolves.toEqual({ data: [{ skills: [], commands }] });
  });

  it("leaves Codex launchpad skill requests on the Codex client path", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["skills/list"] },
      skills: [{ cwd: "/repo", skills: [] }],
    });
    const acpAvailableCommandsStore = createAcpAvailableCommandsStoreMock();
    const { registry, acpClient } = createKimiAcpRegistry({
      codexClient,
      acpAvailableCommandsStore,
    });

    await expect(
      registry.listSkills({ backend: "codex", cwd: "/repo", cwds: ["/repo"] }),
    ).resolves.toEqual({ data: [{ cwd: "/repo", skills: [] }] });
    expect(acpClient.startSession).not.toHaveBeenCalled();
    expect(acpAvailableCommandsStore.get).not.toHaveBeenCalled();
  });

  it("adds Codex compact app-server command to listSkills", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: {
          methods: ["skills/list", "review/start", "thread/compact/start"],
        },
        skills: [
          {
            cwd: "/repo",
            skills: [],
          },
        ],
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.listSkills({
        backend: "codex",
        cwd: "/repo",
      }),
    ).resolves.toEqual({
      data: [
        {
          cwd: "/repo",
          skills: [],
          commands: [
            {
              name: "compact",
              description: "Compact this thread's context.",
              backend: "codex",
              scope: "backend",
              source: "provider",
            },
          ],
        },
      ],
    });
  });

  it("rejects retired persisted backend ids instead of routing them to Codex", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.listSkills({
        backend: "grok" as AppServerBackendKind,
      }),
    ).rejects.toThrow(
      "Backend grok is not available through the built-in client router",
    );

    await registry.close();
  });

  it("reports backend availability and capabilities", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
        requiresOpenaiAuth: false,
      },
      rateLimits: [
        {
          name: "5h limit",
          usedPercent: 15,
          remaining: 85,
          resetAt: new Date("2099-04-29T14:00:00-04:00").getTime(),
          windowSeconds: 18_000,
          windowMinutes: 300,
        },
        {
          name: "Weekly limit",
          usedPercent: 9,
          remaining: 91,
          resetAt: new Date("2099-05-01T14:00:00-04:00").getTime(),
          windowSeconds: 604_800,
          windowMinutes: 10_080,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    const response = await registry.listBackends({ includeUnavailable: true });

    expect(codexClient.listModelsCallCount).toBe(1);

    expect(response.backends).toMatchObject([
      {
        kind: "codex",
        label: "OpenAI",
        available: true,
        account: {
          type: "chatgpt",
          email: "user@example.com",
          planType: "pro",
          requiresOpenaiAuth: false,
        },
        rateLimits: [
          {
            name: "5h limit",
            usedPercent: 15,
            remaining: 85,
          },
          {
            name: "Weekly limit",
            usedPercent: 9,
            remaining: 91,
          },
        ],
        serverName: "Codex App Server",
        serverVersion: "1.0.0",
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
        capabilities: {
          listThreads: true,
          createThread: true,
          resumeThread: false,
          renameThread: false,
          readThread: true,
          startTurn: true,
          interruptTurn: false,
          steerTurn: true,
          transcriptPagination: false,
          toolUse: false,
          approvalRequests: true,
          multiDirectoryThreads: true,
        },
        executionModes: [
          {
            mode: "default",
            label: "Default Access",
            available: true,
            isDefault: true,
          },
          {
            mode: "auto",
            label: "Auto",
            available: true,
          },
          {
            mode: "full-access",
            label: "Full Access",
            available: true,
          },
        ],
        launchpadOptions: {
          models: [
            {
              id: "gpt-6-astra",
              label: "GPT-6-Astra",
              supportsReasoning: true,
              supportsFast: true,
            },
            {
              id: "gpt-6.1-sol",
              label: "GPT-6.1-Sol",
              defaultReasoningEffort: "medium",
              reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
              supportsReasoning: true,
              supportsFast: true,
              supportsSteering: true,
            },
            {
              id: "gpt-6.1-terra",
              label: "GPT-6.1-Terra",
              current: true,
              defaultReasoningEffort: "medium",
              supportsReasoning: true,
              supportsFast: true,
            },
            {
              id: "gpt-6-sol",
              label: "GPT-6-Sol",
              defaultReasoningEffort: "medium",
              reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
              supportsReasoning: true,
              supportsFast: true,
              supportsSteering: true,
            },
            {
              id: "gpt-6-luna",
              label: "GPT-6-Luna",
              defaultReasoningEffort: "medium",
              reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
              supportsReasoning: true,
              supportsFast: true,
              supportsSteering: true,
            },
            {
              id: "gpt-5.6-sol",
              label: "GPT-5.6-Sol",
              supportsReasoning: true,
              supportsFast: true,
            },
            {
              id: "gpt-5.6-terra",
              label: "GPT-5.6-Terra",
              supportsReasoning: true,
              supportsFast: true,
            },
            {
              id: "gpt-5.6-luna",
              label: "GPT-5.6-Luna",
              supportsReasoning: true,
              supportsFast: true,
            },
            {
              id: "gpt-5.5",
              label: "GPT-5.5",
              current: false,
              supportsReasoning: true,
              supportsFast: true,
            },
            {
              id: "gpt-5.4",
              label: "GPT-5.4",
              supportsReasoning: true,
              supportsFast: true,
            },
            {
              id: "gpt-5.4-mini",
              label: "GPT-5.4-Mini",
              supportsReasoning: true,
            },
            {
              id: "gpt-5.2",
              label: "GPT-5.2",
              supportsReasoning: true,
            },
          ],
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
          supportsFastMode: true,
        },
      },      { kind: "claude", label: "Claude", available: false, source: "builtin" },
    ]);

    await registry.close();
  });

  it("skips OpenAI quotas but names threads for a no-auth local Codex provider", async () => {
    const titleHelperCompleted = createDeferred<string>();
    const codexClient = new MockBackendClient({
      account: { requiresOpenaiAuth: false },
      initializeResult: { methods: ["thread/start", "turn/start", "thread/name/set"] },
      models: [{ id: "local-model", label: "Local model", current: true, supportsReasoning: false, reasoningEfforts: [] }],
      threads: [],
    });
    const titleService = {
      generateTitle: vi.fn(async () => ({ status: "generated" as const, title: "Local title" })),
    };
    const overlayStore = createOverlayStoreMock();
    const upsertThreadSubAgent = overlayStore.upsertThreadSubAgent.bind(overlayStore);
    const upsertSubAgentSpy = vi.spyOn(overlayStore, "upsertThreadSubAgent").mockImplementation(async (params) => {
      const result = await upsertThreadSubAgent(params);
      if (["success", "failed", "cancelled"].includes(params.subAgent.status)) {
        titleHelperCompleted.resolve(params.subAgent.status);
      }
      return result;
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: titleService,
    });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    await registry.listBackends({ refreshRateLimits: true });
    expect(codexClient.readRateLimitsCallCount).toBe(0);
    await registry.startThread({ backend: "codex", cwd: "/repo-a" });
    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Test the local provider" }],
    });
    // Title generation owns background thread lookups; a timer tick does not
    // establish their completion, particularly with Windows filesystem I/O.
    expect(await titleHelperCompleted.promise).toBe("success");
    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      userPrompt: "Test the local provider",
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-1",
      name: "Local title",
    });
    const running = upsertSubAgentSpy.mock.calls.find(([call]) => call.subAgent.status === "running");
    expect(running?.[0].subAgent.preferredModel).toBe("local-model");
    expect(running?.[0].subAgent.preferredReasoningEffort).toBeUndefined();
    await registry.close();
  });

  it("recovers account and quotas after startup thread refresh fails", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-account-recovery-"));
    const configStore = new DesktopConfigStore({ configPath: path.join(tempRoot, "config.toml") });
    const command = path.join(tempRoot, "codex");
    configStore.recordProviderDiscovery("codex", {
      candidates: [{ command, source: "path", version: "0.160.0" }],
      selectedCommand: command,
      selectedVersion: "0.160.0",
    });
    const codexClient = new MockBackendClient({
      listThreadsError: new Error("codex app server client closed"),
      account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
      rateLimits: [{ name: "Weekly limit", usedPercent: 22 }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, configStore, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => {
      await registry.close();
      configStore.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    expect((await registry.listBackends()).backends[0].account).toBeUndefined();
    const response = await registry.listBackends({ refreshRateLimits: true });
    expect(response.backends[0]).toMatchObject({
      account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
      rateLimits: [{ name: "Weekly limit", usedPercent: 22 }],
    });
    expect(codexClient.listModelsCallCount).toBe(0);
  });

  it("recovers a failed account read and retains it when a later read fails", async () => {
    const codexClient = new MockBackendClient({ rateLimits: [{ name: "Weekly limit", usedPercent: 22 }] });
    const accountRead = vi.spyOn(codexClient, "readAccount").mockRejectedValueOnce(new Error("temporary failure"));
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    accountRead.mockResolvedValue({ type: "chatgpt", email: "user@example.com", planType: "pro" });
    const recovered = await registry.listBackends({ refreshRateLimits: true });
    expect(recovered.backends[0].account?.planType).toBe("pro");
    await registry.listBackends({ refreshRateLimits: true });
    expect(accountRead).toHaveBeenCalledTimes(2);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    onTestFinished(() => { clock.mockRestore(); });
    accountRead.mockRejectedValueOnce(new Error("temporary failure"));
    const retained = await registry.listBackends({ refreshRateLimits: true });
    expect(retained.backends[0].account).toEqual(recovered.backends[0].account);
  });

  it("clears old quotas when the account becomes signed out", async () => {
    const codexClient = new MockBackendClient({
      account: { type: "chatgpt", email: "user@example.com", planType: "pro", requiresOpenaiAuth: true },
      rateLimits: [{ name: "Weekly limit", usedPercent: 54 }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    vi.spyOn(codexClient, "readAccount").mockResolvedValue({ requiresOpenaiAuth: true });
    const quotaRead = vi.spyOn(codexClient, "readRateLimits");
    const response = await registry.listBackends({ refreshRateLimits: true });
    expect(response.backends[0].account).toEqual({ requiresOpenaiAuth: true });
    expect(response.backends[0].rateLimits).toEqual([]);
    expect(quotaRead).not.toHaveBeenCalled();
  });

  it("does not relabel old quotas when a new account's quota read fails", async () => {
    const codexClient = new MockBackendClient({
      account: { type: "chatgpt", email: "previous@example.com", planType: "pro" },
      rateLimits: [{ name: "Weekly limit", usedPercent: 54 }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    vi.spyOn(codexClient, "readAccount").mockResolvedValue({ type: "chatgpt", email: "current@example.com", planType: "free" });
    vi.spyOn(codexClient, "readRateLimits").mockRejectedValueOnce(new Error("temporary failure"));
    const response = await registry.listBackends({ refreshRateLimits: true });
    expect(response.backends[0].account?.planType).toBe("free");
    expect(response.backends[0].rateLimits).toEqual([]);
  });

  it.each([
    {
      transition: "account switch",
      account: { type: "chatgpt", email: "current@example.com", planType: "pro" } as BackendAccountSummary,
      limits: [{ name: "Weekly limit", usedPercent: 22 }],
    },
    {
      transition: "sign-out",
      account: { requiresOpenaiAuth: true } as BackendAccountSummary,
      limits: [],
    },
    {
      transition: "plan change",
      account: { type: "chatgpt", email: "previous@example.com", planType: "free" } as BackendAccountSummary,
      limits: [],
    },
  ])("discards a pending quota notification refetch after $transition", async ({ account, limits }) => {
    const codexClient = new MockBackendClient({
      account: { type: "chatgpt", email: "previous@example.com", planType: "pro" },
      rateLimits: [{ name: "Weekly limit", usedPercent: 54 }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const pending = createDeferred<BackendRateLimitSummary[]>();
    onTestFinished(async () => { pending.resolve([]); await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const read = vi.spyOn(codexClient, "readRateLimits")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(limits);
    const notification = codexClient.emit({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: null,
          limitName: "Codex",
          primary: { usedPercent: 55, windowDurationMins: null, resetsAt: null },
          secondary: null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    vi.spyOn(codexClient, "readAccount").mockResolvedValue(account);
    await registry.listBackends({ refreshRateLimits: true });
    pending.resolve([{ name: "Weekly limit", usedPercent: 55 }]);
    await notification;
    const response = await registry.listBackends();
    expect(response.backends[0].account).toEqual(account);
    expect(response.backends[0].rateLimits).toEqual(limits);
  });

  it.each(["failed", "empty"])("clears old plan quotas when the new quota read is %s", async (result) => {
    const codexClient = new MockBackendClient({
      account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
      rateLimits: [{ name: "Weekly limit", usedPercent: 54 }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    vi.spyOn(codexClient, "readAccount").mockResolvedValue({ type: "chatgpt", email: "user@example.com", planType: "free" });
    const read = vi.spyOn(codexClient, "readRateLimits");
    if (result === "failed") read.mockRejectedValueOnce(new Error("temporary failure"));
    else read.mockResolvedValueOnce([]);
    const response = await registry.listBackends({ refreshRateLimits: true });
    expect(response.backends[0].account?.planType).toBe("free");
    expect(response.backends[0].rateLimits).toEqual([]);
  });

  it("discards quota discovery started before a plan change", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
      rateLimits: [{ name: "Weekly limit", usedPercent: 54 }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const pending = createDeferred<BackendRateLimitSummary[]>();
    onTestFinished(async () => { pending.resolve([]); await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const read = vi.spyOn(codexClient, "readRateLimits").mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    vi.spyOn(codexClient, "getInitializeResult").mockResolvedValue({ methods: ["thread/start"] });
    const discovery = discoverCodexBackendForTest(registry);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    vi.spyOn(codexClient, "readAccount").mockResolvedValue({ type: "chatgpt", email: "user@example.com", planType: "free" });
    await registry.listBackends({ refreshRateLimits: true });
    pending.resolve([{ name: "Weekly limit", usedPercent: 55 }]);
    await discovery;
    const response = await registry.listBackends();
    expect(response.backends[0].account?.planType).toBe("free");
    expect(response.backends[0].rateLimits).toEqual([]);
    expect(response.backends[0].capabilities.createThread).toBe(true);
  });

  it("discards an account refresh from an invalidated runtime", async () => {
    const codexClient = new MockBackendClient({ account: { type: "chatgpt", planType: "pro" } });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const pending = createDeferred<BackendAccountSummary>();
    const read = vi.spyOn(codexClient, "readAccount").mockReturnValueOnce(pending.promise);
    const refresh = registry.listBackends({ includeUnavailable: true, refreshRateLimits: true });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await registry.invalidateProviderRuntimeSelections({ codex: true, acp: false });
    pending.resolve({ type: "chatgpt", email: "obsolete@example.com", planType: "free" });
    const response = await refresh;
    expect(response.backends[0].account).toBeUndefined();
    expect(response.backends[0].rateLimits).toBeUndefined();
  });

  it("refreshes idle Codex quotas without rediscovery and coalesces repeated reads", async () => {
    const codexClient = new MockBackendClient({
      rateLimits: [{ name: "Weekly limit", remaining: 91 }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    // A hover before startup discovery must not start the provider.
    await registry.listBackends({ refreshRateLimits: true });
    expect(codexClient.readRateLimitsCallCount).toBe(0);
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const initialReads = codexClient.readRateLimitsCallCount;
    const initialModelReads = codexClient.listModelsCallCount;
    const read = vi.spyOn(codexClient, "readRateLimits").mockResolvedValue([
      { name: "Weekly limit", remaining: 42 },
    ]);
    const response = await registry.listBackends({ refreshRateLimits: true });
    expect(response.backends.find((backend) => backend.kind === "codex")?.rateLimits)
      .toEqual([{ name: "Weekly limit", remaining: 42 }]);
    await registry.listBackends({ refreshRateLimits: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(initialReads).toBe(1);
    expect(codexClient.listModelsCallCount).toBe(initialModelReads);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6_000);
    read.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const retained = await registry.listBackends({ refreshRateLimits: true });
    expect(retained.backends.find((backend) => backend.kind === "codex")?.rateLimits)
      .toEqual([{ name: "Weekly limit", remaining: 42 }]);
    clock.mockRestore();
    await registry.close();
  });

  it("updates cached Codex rate limits from notifications without rewriting unchanged state", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
      },
      rateLimits: [
        {
          name: "5h limit",
          limitId: "codex",
          limitName: "Codex",
          windowKey: "primary",
          usedPercent: 77,
          remaining: 23,
          resetAt: 4_088_748_108_000,
          windowSeconds: 18_000,
          windowMinutes: 300,
        },
        {
          name: "Weekly limit",
          limitId: "codex",
          limitName: "Codex",
          windowKey: "secondary",
          usedPercent: 9,
          remaining: 91,
          resetAt: 4_088_888_108_000,
          windowSeconds: 604_800,
          windowMinutes: 10_080,
        },
        {
          name: "GPT-5.3-Codex-Spark Weekly limit",
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          windowKey: "secondary",
          usedPercent: 0,
          remaining: 100,
          resetAt: 4_089_090_523_000,
          windowSeconds: 604_800,
          windowMinutes: 10_080,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    const initialSummary = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends[0];
    let summarySeenByListener: BackendSummary | undefined;
    let rateLimitEventCount = 0;
    const unsubscribe = registry.onEvent(async (event) => {
      if (event.notification.method !== "account/rateLimits/updated") {
        return;
      }
      rateLimitEventCount += 1;
      summarySeenByListener = (
        await registry.listBackends({ includeUnavailable: true })
      ).backends[0];
    });
    const buildNotification = (usedPercent: number): AppServerNotification => ({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent,
            windowDurationMins: null,
            resetsAt: null,
          },
          secondary: null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });

    await codexClient.emit(buildNotification(77));

    const initiallyUnchangedSummary = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends[0];
    expect(initiallyUnchangedSummary).toBe(initialSummary);
    expect(rateLimitEventCount).toBe(0);

    await codexClient.emit(buildNotification(85));

    const updatedSummary = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends[0];
    expect(updatedSummary).not.toBe(initialSummary);
    expect(summarySeenByListener).toBe(updatedSummary);
    expect(rateLimitEventCount).toBe(1);
    expect(updatedSummary?.rateLimits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "5h limit",
          limitId: "codex",
          windowKey: "primary",
          usedPercent: 85,
          remaining: 15,
          resetAt: 4_088_748_108_000,
          windowMinutes: 300,
        }),
        expect.objectContaining({
          name: "Weekly limit",
          limitId: "codex",
          windowKey: "secondary",
          usedPercent: 9,
          remaining: 91,
        }),
        expect.objectContaining({
          name: "GPT-5.3-Codex-Spark Weekly limit",
          limitId: "codex_bengalfox",
          remaining: 100,
        }),
      ]),
    );

    await codexClient.emit(buildNotification(85));

    const unchangedSummary = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends[0];
    expect(unchangedSummary).toBe(updatedSummary);
    expect(rateLimitEventCount).toBe(1);

    unsubscribe();
    await registry.close();
  });

  it("moves Codex limits only forward across out-of-order, sparse and next-window updates", async () => {
    const hour = 3_600_000;
    // Codex reports resets in whole seconds.
    const fiveHourReset = Math.floor((Date.now() + 3 * hour) / 1000) * 1000;
    const weeklyReset = Math.floor((Date.now() + 72 * hour) / 1000) * 1000;
    const window = (windowKey: "primary" | "secondary", usedPercent: number, resetAt: number) => ({
      name: windowKey === "primary" ? "5h limit" : "Weekly limit",
      limitId: "codex",
      limitName: "Codex",
      windowKey,
      usedPercent,
      remaining: 100 - usedPercent,
      resetAt,
      windowSeconds: windowKey === "primary" ? 18_000 : 604_800,
      windowMinutes: windowKey === "primary" ? 300 : 10_080,
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read", "thread/start", "turn/start"] },
      account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
      rateLimits: [window("primary", 40, fiveHourReset), window("secondary", 10, weeklyReset)],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const update = (
      windowKey: "primary" | "secondary",
      usedPercent: number,
      resetAt: number,
    ): AppServerNotification => ({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          [windowKey]: { usedPercent, windowDurationMins: null, resetsAt: resetAt / 1000 },
          ...(windowKey === "primary" ? { secondary: null } : { primary: null }),
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        } as never,
      },
    });
    const shown = async () => (await registry.listBackends()).backends[0];

    await codexClient.emit(update("primary", 50, fiveHourReset));
    const atFifty = await shown();
    expect(atFifty.rateLimits).toEqual([window("primary", 50, fiveHourReset), window("secondary", 10, weeklyReset)]);
    // A turn whose request started earlier reports after the 50%.
    await codexClient.emit(update("primary", 49, fiveHourReset));
    expect(await shown()).toBe(atFifty);

    // A sparse update keeps the window it leaves out, and its name.
    await codexClient.emit(update("secondary", 12, weeklyReset));
    expect((await shown()).rateLimits).toEqual([
      window("primary", 50, fiveHourReset), window("secondary", 12, weeklyReset),
    ]);

    // The window reset early and a new one began; a late report from the
    // window before it cannot bring the old usage back.
    const nextReset = fiveHourReset + 4 * hour;
    await codexClient.emit(update("primary", 2, nextReset));
    await codexClient.emit(update("primary", 60, fiveHourReset));
    expect((await shown()).rateLimits?.[0]).toEqual(window("primary", 2, nextReset));

    // A plan change has a new allowance: limits start over from a fresh read.
    vi.spyOn(codexClient, "readAccount").mockResolvedValue(
      { type: "chatgpt", email: "user@example.com", planType: "plus" },
    );
    vi.spyOn(codexClient, "readRateLimits").mockResolvedValueOnce([window("primary", 30, nextReset)]);
    const replanned = await registry.listBackends({ refreshRateLimits: true });
    expect(replanned.backends[0].account?.planType).toBe("plus");
    expect(replanned.backends[0].rateLimits).toEqual([window("primary", 30, nextReset)]);
  });

  it("lets the newest Codex quota read lower a window, as a reset credit does", async () => {
    const resetAt = Math.floor((Date.now() + 3 * 3_600_000) / 1000) * 1000;
    const fiveHour = (usedPercent: number): BackendRateLimitSummary => ({
      name: "5h limit", limitId: "codex", limitName: "Codex", windowKey: "primary",
      usedPercent, remaining: 100 - usedPercent, resetAt, windowSeconds: 18_000, windowMinutes: 300,
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
      rateLimits: [fiveHour(98)],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    vi.spyOn(codexClient, "readRateLimits").mockResolvedValue([fiveHour(0)]);
    const response = await registry.listBackends({ refreshRateLimits: true });
    expect(response.backends[0].rateLimits).toEqual([fiveHour(0)]);
  });

  it("applies each sparse Codex rate-limit update that arrives during an account read", async () => {
    const account: BackendAccountSummary = {
      type: "chatgpt",
      email: "user@example.com",
      planType: "pro",
    };
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
      },
      account,
      rateLimits: [
        {
          name: "5h limit",
          limitId: "codex",
          limitName: "Codex",
          windowKey: "primary",
          usedPercent: 10,
          remaining: 90,
          windowMinutes: 300,
        },
        {
          name: "Weekly limit",
          limitId: "codex",
          limitName: "Codex",
          windowKey: "secondary",
          usedPercent: 20,
          remaining: 80,
          windowMinutes: 10_080,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    onTestFinished(async () => { await registry.close(); });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const pendingAccount = createDeferred<BackendAccountSummary>();
    const accountRead = vi.spyOn(codexClient, "readAccount")
      .mockReturnValueOnce(pendingAccount.promise);
    const sparseUpdate = (
      window: "primary" | "secondary",
      usedPercent: number,
    ): AppServerNotification => ({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: window === "primary"
            ? { usedPercent, windowDurationMins: 300, resetsAt: null }
            : null,
          secondary: window === "secondary"
            ? { usedPercent, windowDurationMins: 10_080, resetsAt: null }
            : null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });

    // The transport dispatches each notification without waiting for the
    // previous one, so the second arrives while the first reads the account.
    const primaryUpdate = codexClient.emit(sparseUpdate("primary", 40));
    await vi.waitFor(() => expect(accountRead).toHaveBeenCalledOnce());
    const secondaryUpdate = codexClient.emit(sparseUpdate("secondary", 60));
    pendingAccount.resolve(account);
    await Promise.all([primaryUpdate, secondaryUpdate]);

    const codex = (await registry.listBackends()).backends[0];
    expect(codex.rateLimits).toEqual([
      expect.objectContaining({ windowKey: "primary", usedPercent: 40 }),
      expect.objectContaining({ windowKey: "secondary", usedPercent: 60 }),
    ]);
  });

  describe("a Codex quota read overtaken by a rate-limit notification", () => {
    const limit = (window: "primary" | "secondary", usedPercent: number): BackendRateLimitSummary => ({
      name: window === "primary" ? "5h limit" : "Weekly limit",
      limitId: "codex",
      limitName: "Codex",
      windowKey: window,
      usedPercent,
      remaining: 100 - usedPercent,
      windowMinutes: window === "primary" ? 300 : 10_080,
    });
    const update = (
      window: "primary" | "secondary",
      usedPercent: number,
      limitId: string | null = "codex",
    ): AppServerNotification => ({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId,
          limitName: "Codex",
          primary: window === "primary"
            ? { usedPercent, windowDurationMins: 300, resetsAt: null }
            : null,
          secondary: window === "secondary"
            ? { usedPercent, windowDurationMins: 10_080, resetsAt: null }
            : null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });
    const startRegistry = async () => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list", "thread/read", "thread/start", "turn/start"] },
        account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
        rateLimits: [limit("primary", 10), limit("secondary", 20)],
      });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      const pending = createDeferred<BackendRateLimitSummary[]>();
      onTestFinished(async () => { pending.resolve([]); await registry.close(); });
      await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
      const read = vi.spyOn(codexClient, "readRateLimits").mockReturnValueOnce(pending.promise);
      return { codexClient, registry, pending, read };
    };

    it("still merges forward when the notification lands during the read", async () => {
      const { codexClient, registry, pending, read } = await startRegistry();
      const refresh = registry.listBackends({ refreshRateLimits: true });
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      // A held window: the notification records at once, during the read.
      await codexClient.emit(update("primary", 40));
      pending.resolve([limit("primary", 30), limit("secondary", 25)]);
      await refresh;

      const codex = (await registry.listBackends()).backends[0];
      // The read is no longer the newest: it raises the window it alone
      // moved, and cannot lower the one the notification moved past it.
      expect(codex.rateLimits).toEqual([
        expect.objectContaining({ windowKey: "primary", usedPercent: 40 }),
        expect.objectContaining({ windowKey: "secondary", usedPercent: 25 }),
      ]);
    });

    it("still merges a sparse notification's refetch when the next notification arrives", async () => {
      const { codexClient, registry, pending, read } = await startRegistry();
      // No family ID: the notification has no merge base and refetches.
      const unnamed = codexClient.emit(update("primary", 15, null));
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      // Arrives during the refetch and queues behind it.
      const queued = codexClient.emit(update("secondary", 60));
      pending.resolve([limit("primary", 30), limit("secondary", 25)]);
      await Promise.all([unnamed, queued]);

      const codex = (await registry.listBackends()).backends[0];
      expect(read).toHaveBeenCalledOnce();
      expect(codex.rateLimits).toEqual([
        expect.objectContaining({ windowKey: "primary", usedPercent: 30 }),
        expect.objectContaining({ windowKey: "secondary", usedPercent: 60 }),
      ]);
    });
  });

  it("replaces a credits balance when a later snapshot omits the amount", async () => {
    const creditsLimit: BackendRateLimitSummary = {
      name: "Credits",
      limitId: "credits",
      windowKey: "credits",
      hasCredits: true,
      unlimited: false,
      remaining: 100,
    };
    const fiveHourLimit: BackendRateLimitSummary = {
      name: "5h limit",
      limitId: "codex",
      limitName: "Codex",
      windowKey: "primary",
      usedPercent: 77,
      remaining: 23,
      windowMinutes: 300,
    };
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
      },
      rateLimits: [fiveHourLimit, creditsLimit],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );

    await codexClient.emit({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 77,
            windowDurationMins: 300,
            resetsAt: null,
          },
          secondary: null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });

    expect(
      (await registry.listBackends({ includeUnavailable: true })).backends[0]
        ?.rateLimits,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Credits",
          remaining: 100,
          hasCredits: true,
        }),
      ]),
    );

    await codexClient.emit({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 77,
            windowDurationMins: 300,
            resetsAt: null,
          },
          secondary: null,
          individualLimit: null,
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: null,
          },
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });

    const credits = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends[0]?.rateLimits?.find((limit) => limit.name === "Credits");
    expect(credits).toMatchObject({
      name: "Credits",
      hasCredits: true,
      unlimited: false,
    });
    expect(credits?.remaining).toBeUndefined();

    await registry.close();
  });

  it("coalesces changed Codex rate-limit broadcasts into a 20-second window", async () => {
    vi.useFakeTimers();
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
      },
      rateLimits: [
        {
          name: "5h limit",
          limitId: "codex",
          limitName: "Codex",
          windowKey: "primary",
          usedPercent: 77,
          remaining: 23,
          windowMinutes: 300,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    try {
      await registry.refreshProvidersAtStartup(
        issueProviderDiscoveryPermit("startup"),
      );
      const broadcastValues: Array<number | undefined> = [];
      registry.onEvent(async (event) => {
        if (event.notification.method !== "account/rateLimits/updated") {
          return;
        }
        const summary = (
          await registry.listBackends({ includeUnavailable: true })
        ).backends[0];
        broadcastValues.push(summary.rateLimits?.[0]?.usedPercent);
      });
      const emitRateLimit = async (usedPercent: number): Promise<void> => {
        await codexClient.emit({
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "codex",
              limitName: null,
              primary: {
                usedPercent,
                windowDurationMins: null,
                resetsAt: null,
              },
              secondary: null,
              individualLimit: null,
              credits: null,
              planType: null,
              rateLimitReachedType: null,
            },
          },
        });
      };

      await emitRateLimit(80);
      await emitRateLimit(81);
      await emitRateLimit(82);

      expect(broadcastValues).toEqual([80]);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(broadcastValues).toEqual([80]);
      await vi.advanceTimersByTimeAsync(1);
      expect(broadcastValues).toEqual([80, 82]);
      expect(codexClient.readRateLimitsCallCount).toBe(1);
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("refetches Codex rate limits when a sparse notification omits its family ID", async () => {
    const initialRateLimits: BackendRateLimitSummary[] = [
      {
        name: "5h limit",
        limitId: "codex",
        limitName: "Codex",
        windowKey: "primary",
        usedPercent: 77,
        remaining: 23,
        windowMinutes: 300,
      },
      {
        name: "Weekly limit",
        limitId: "codex",
        limitName: "Codex",
        windowKey: "secondary",
        usedPercent: 9,
        remaining: 91,
        windowMinutes: 10_080,
      },
    ];
    const refetchedRateLimits: BackendRateLimitSummary[] = [
      {
        ...initialRateLimits[0],
        usedPercent: 85,
        remaining: 15,
      },
      initialRateLimits[1],
    ];
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
      },
      rateLimitReads: [initialRateLimits, refetchedRateLimits],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    await codexClient.emit({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: null,
          limitName: "Codex",
          primary: {
            usedPercent: 85,
            windowDurationMins: null,
            resetsAt: null,
          },
          secondary: null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });

    const summary = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends[0];
    expect(codexClient.readRateLimitsCallCount).toBe(2);
    expect(summary.rateLimits).toEqual(refetchedRateLimits);
    expect(summary.rateLimits).toHaveLength(2);
    expect(summary.rateLimits).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Primary limit" }),
      ]),
    );

    await registry.close();
  });

  it("refetches when a sparse Codex rate-limit window has no cached merge base", async () => {
    const weeklyLimit: BackendRateLimitSummary = {
      name: "Weekly limit",
      limitId: "codex",
      limitName: "Codex",
      windowKey: "secondary",
      usedPercent: 9,
      remaining: 91,
      windowMinutes: 10_080,
    };
    const refetchedRateLimits: BackendRateLimitSummary[] = [
      {
        name: "5h limit",
        limitId: "codex",
        limitName: "Codex",
        windowKey: "primary",
        usedPercent: 85,
        remaining: 15,
        windowMinutes: 300,
      },
      weeklyLimit,
    ];
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      rateLimitReads: [[weeklyLimit], refetchedRateLimits],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    await codexClient.emit({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 85,
            windowDurationMins: null,
            resetsAt: null,
          },
          secondary: null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });

    const summary = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends[0];
    expect(codexClient.readRateLimitsCallCount).toBe(2);
    expect(summary.rateLimits).toEqual(refetchedRateLimits);
    expect(summary.rateLimits).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Primary limit" }),
      ]),
    );

    await registry.close();
  });

  it("retains a rate-limit notification that overtakes initial discovery", async () => {
    const discoveryRelease = createDeferred<void>();
    const initialRateLimits: BackendRateLimitSummary[] = [
      {
        name: "5h limit",
        limitId: "codex",
        limitName: "Codex",
        windowKey: "primary",
        usedPercent: 77,
        remaining: 23,
        windowMinutes: 300,
      },
    ];
    const refetchedRateLimits: BackendRateLimitSummary[] = [
      {
        ...initialRateLimits[0],
        usedPercent: 85,
        remaining: 15,
      },
    ];
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      rateLimitReads: [initialRateLimits, refetchedRateLimits],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      resolveCodexRuntimeCommand: async () => {
        await discoveryRelease.promise;
        return {
          command: path.join("/opt", "homebrew", "bin", "codex"),
          version: "1.0.0",
        };
      },
    });

    const discovery = registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    await vi.waitFor(() => {
      expect(codexClient.readRateLimitsCallCount).toBe(1);
    });
    await codexClient.emit({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 85,
            windowDurationMins: null,
            resetsAt: null,
          },
          secondary: null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });
    expect(codexClient.readRateLimitsCallCount).toBe(2);
    discoveryRelease.resolve();
    await discovery;

    const summary = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends[0];
    expect(summary.rateLimits).toEqual(refetchedRateLimits);

    await registry.close();
  });

  it("discards a sparse refetch when provider invalidation clears its summary", async () => {
    const refetchRelease = createDeferred<void>();
    const initialRateLimits: BackendRateLimitSummary[] = [
      {
        name: "5h limit",
        limitId: "codex",
        limitName: "Codex",
        windowKey: "primary",
        usedPercent: 77,
        remaining: 23,
        windowMinutes: 300,
      },
    ];
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      rateLimitReadDelays: [undefined, refetchRelease.promise],
      rateLimitReads: [
        initialRateLimits,
        [
          {
            ...initialRateLimits[0],
            usedPercent: 85,
            remaining: 15,
          },
        ],
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    const notification = codexClient.emit({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: null,
          limitName: "Codex",
          primary: {
            usedPercent: 85,
            windowDurationMins: null,
            resetsAt: null,
          },
          secondary: null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });
    await vi.waitFor(() => {
      expect(codexClient.readRateLimitsCallCount).toBe(2);
    });
    await registry.invalidateProviderRuntimeSelections({
      acp: false,
      codex: true,
    });
    refetchRelease.resolve();

    await expect(notification).resolves.toBeUndefined();
    expect(
      (await registry.listBackends({ includeUnavailable: true })).backends[0]
        .rateLimits,
    ).toBeUndefined();

    await registry.close();
  });

  it("preserves notification rate limits when concurrent discovery finishes later", async () => {
    const discoveryRelease = createDeferred<void>();
    let blockRuntimeResolution = false;
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
      },
      rateLimits: [
        {
          name: "5h limit",
          limitId: "codex",
          limitName: "Codex",
          windowKey: "primary",
          usedPercent: 77,
          remaining: 23,
          windowMinutes: 300,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      resolveCodexRuntimeCommand: async () => {
        if (blockRuntimeResolution) {
          await discoveryRelease.promise;
        }
        return {
          command: path.join("/opt", "homebrew", "bin", "codex"),
          version: "1.0.0",
        };
      },
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    blockRuntimeResolution = true;
    const discovery = discoverCodexBackendForTest(registry);
    await vi.waitFor(() => {
      expect(codexClient.readRateLimitsCallCount).toBe(2);
    });
    await codexClient.emit({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 85,
            windowDurationMins: null,
            resetsAt: null,
          },
          secondary: null,
          individualLimit: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });
    discoveryRelease.resolve();
    await discovery;

    const summary = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends[0];
    expect(summary.rateLimits).toEqual([
      expect.objectContaining({
        name: "5h limit",
        limitId: "codex",
        usedPercent: 85,
        remaining: 15,
      }),
    ]);

    await registry.close();
  });

  it("prefers the running App Server's version over the next launch's", async () => {
    // The two disagree while a managed switch is pending: the connection is
    // still answering from the old build while resolution already names the
    // one a fresh launch would pick. The running server owns its own version.
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: {
          methods: ["thread/list"],
          userAgent: "pwragent-desktop/0.149.1 (Mac OS 26.6.2; arm64) unknown",
        },
      }),
      overlayStore: createOverlayStoreMock(),
      resolveCodexRuntimeCommand: async () => ({
        command: path.join("/opt", "homebrew", "bin", "codex"),
        version: "0.150.0",
      }),
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends[0]).toMatchObject({ serverVersion: "0.149.1" });

    await registry.close();
  });

  it("re-describes the cached runtime when the managed build turns over", async () => {
    // Nothing else invalidates the cached summary on this path, so without the
    // re-description the panel keeps naming the replaced build.
    let notify:
      | ((change: ManagedCodexSelectionChange) => Promise<unknown> | unknown)
      | undefined;
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      overlayStore: createOverlayStoreMock(),
      resolveCodexRuntimeCommand: async () => ({
        command: path.join(
          managedCodexRoot(),
          "versions",
          "pwragent-v0.149.0-pwragent.2",
          "codex",
        ),
        version: "0.149.0-pwragent.2",
      }),
      watchManagedCodexRuntime: (listener) => {
        notify = listener;
        return () => {};
      },
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    expect(
      (await registry.listBackends({ includeUnavailable: true })).backends[0],
    ).toMatchObject({
      runtimeBuild: { channel: "pwragent", publisher: "PwrDrvr" },
      serverVersion: "0.149.0-pwragent.2",
    });

    await notify?.({ enabled: false, reason: "availability" });

    // No managed runtime left: the fields go quiet rather than naming a
    // publisher nothing has resolved yet.
    const afterDisable =
      (await registry.listBackends({ includeUnavailable: true })).backends[0];
    expect(afterDisable.runtimeBuild).toBeUndefined();
    expect(afterDisable.serverVersion).toBeUndefined();

    await registry.close();
  });

  it.each([
    {
      command: path.join("/opt", "homebrew", "bin", "codex"),
      provenance: "an OpenAI release",
      runtimeBuild: { channel: "vendor", publisher: "OpenAI" },
      version: "0.149.1",
    },
    {
      command: path.join(
        managedCodexRoot(),
        "versions",
        "pwragent-v0.149.0-pwragent.2",
        "codex",
      ),
      provenance: "a PwrDrvr build",
      runtimeBuild: { channel: "pwragent", publisher: "PwrDrvr" },
      version: "0.149.0-pwragent.2",
    },
  ])(
    "reports the running Codex version and names it $provenance",
    async ({ command, runtimeBuild, version }) => {
      const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), "pwragent-codex-runtime-build-"),
      );
      const configStore = new DesktopConfigStore({
        configPath: path.join(tempRoot, "config.toml"),
      });
      configStore.recordProviderDiscovery("codex", {
        candidates: [{ command, source: "path", version }],
        selectedCommand: command,
        selectedVersion: version,
      });
      const registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({
          initializeResult: {
            methods: ["thread/list"],
            // `initialize` carries no server version of its own — only the
            // `userAgent`, whose first token names the client and the version
            // of the App Server answering it.
            userAgent: `pwragent/${version} (Mac OS 26.6.2; arm64) unknown`,
          },
        }),
        configStore,
        overlayStore: createOverlayStoreMock(),
      });

      await registry.refreshProvidersAtStartup(
        issueProviderDiscoveryPermit("startup"),
      );
      const response = await registry.listBackends({ includeUnavailable: true });

      expect(response.backends[0]).toMatchObject({
        kind: "codex",
        runtimeBuild,
        serverVersion: version,
      });

      await registry.close();
      configStore.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    },
  );

  it("names a managed Codex build discovery never recorded", async () => {
    // A profile on the PwrAgent channel reaches the App Server through the
    // managed runtime without a provider observation ever being written, so
    // the durable projection cannot answer who built the running Codex.
    const command = path.join(
      managedCodexRoot(),
      "versions",
      "pwragent-v0.149.0-pwragent.2",
      "codex",
    );
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      overlayStore: createOverlayStoreMock(),
      resolveCodexRuntimeCommand: async () => ({
        command,
        version: "0.149.0-pwragent.2",
      }),
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends[0]).toMatchObject({
      kind: "codex",
      runtimeBuild: { channel: "pwragent", publisher: "PwrDrvr" },
      serverVersion: "0.149.0-pwragent.2",
    });

    await registry.close();
  });

  it("delegates Codex project trust to the Codex client", async () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    const response = await registry.trustCodexProject({
      projectPath: "/Users/fixture-user/github/PwrAgnt",
      configPath: "/Users/fixture-user/.codex/profiles/acp-smoke/config.toml",
    });

    expect(response).toEqual({
      projectPath: "/Users/fixture-user/github/PwrAgnt",
      configPath: "/Users/fixture-user/.codex/profiles/acp-smoke/config.toml",
      trusted: true,
    });
    expect(codexClient.lastTrustProjectParams).toEqual({
      projectPath: "/Users/fixture-user/github/PwrAgnt",
      configPath: "/Users/fixture-user/.codex/profiles/acp-smoke/config.toml",
    });

    await registry.close();
  });

  it("marks the durable Codex summary pending while startup discovery runs", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      resolveCodexDiscoveryPending: () => true,
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    // "Not selected yet" and "not configured" both read as `available: false`
    // here, and a startup surface that cannot tell them apart sends a working
    // profile through provider setup. Only the pending flag separates them.
    expect(
      response.backends.find((backend) => backend.kind === "codex"),
    ).toMatchObject({
      available: false,
      discoveryPending: true,
    });

    await registry.close();
  });

  it("keeps a cached Codex summary pending while discovery is outstanding", async () => {
    let pending = true;
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      resolveCodexDiscoveryPending: () => pending,
    });
    const internals = registry as unknown as {
      codexBackendSummary?: BackendSummary;
    };

    // What a Settings "Re-check" or `completeOnboardingCodexBootstrap` caches
    // when it lands mid-discovery. `discoverCodexBackend` writes no pending
    // flag, and a failing summary is invalidated only by a provider
    // fingerprint change, so returning it verbatim made the renderer read a
    // mid-discovery cache as a settled "no provider" for the whole process.
    const {
      discoveryPending: _unflagged,
      ...cachedSummary
    } = (await registry.listBackends({ includeUnavailable: true })).backends
      .find((backend) => backend.kind === "codex") as BackendSummary;
    internals.codexBackendSummary = cachedSummary;

    const whilePending = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends.find((backend) => backend.kind === "codex");
    expect(whilePending).toMatchObject({ discoveryPending: true });

    pending = false;
    const afterAnswer = (
      await registry.listBackends({ includeUnavailable: true })
    ).backends.find((backend) => backend.kind === "codex");
    expect(afterAnswer).not.toHaveProperty("discoveryPending");

    await registry.close();
  });

  it("leaves the Codex summary unpending once discovery has answered", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      resolveCodexDiscoveryPending: () => false,
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(
      response.backends.find((backend) => backend.kind === "codex"),
    ).toMatchObject({ available: false });
    expect(
      response.backends.find((backend) => backend.kind === "codex"),
    ).not.toHaveProperty("discoveryPending");

    await registry.close();
  });

  it("does not report banned ACP adapters as backend summaries", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: "acp:codex-acp",
          registryId: "codex-acp",
          name: "Codex CLI",
          distributionKind: "npx",
          distributionSource: "@zed-industries/codex-acp@0.14.0",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "codex-rule",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends.some((backend) => backend.kind === "acp:codex-acp"))
      .toBe(false);

    await registry.close();
  });

  it("reports locally discovered ACP agents as backend summaries", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      isAcpAgentEnabled: () => true,
      discoverLocalAcpAgents: async () => [
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini CLI",
          version: "0.42.0",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 1000,
          launchDescriptor: {
            backendId: "acp:gemini",
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ],
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "acp:gemini",
          source: "acp",
          label: "Gemini",
          available: true,
          acp: expect.objectContaining({
            registryId: "gemini",
            distributionKinds: ["local"],
            installStatus: "installed",
            allowlistRuleId: "local-gemini-cli",
          }),
        }),
      ]),
    );

    await registry.close();
  });

  it.each(["queued", "closed"] as const)("startup registry ownership oracle: no discovery after %s close", async (boundary) => {
    const discoverLocalAcpAgents = vi.fn(async () => []);
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      discoverLocalAcpAgents,
    });
    const refresh = boundary === "queued"
      ? registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"))
      : undefined;
    await registry.close();
    await (refresh ?? registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup")));
    expect(discoverLocalAcpAgents).not.toHaveBeenCalled();
  });

  it("never reaches ACP discovery from ordinary backend summaries", async () => {
    const codexClient = new MockBackendClient({});
    const closeSpy = vi.spyOn(codexClient, "close");
    const discoverLocalAcpAgents = vi.fn(async () => []);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      discoverLocalAcpAgents,
    });

    await registry.listBackends({ includeUnavailable: true });
    await registry.listBackends({ includeUnavailable: true });
    expect(discoverLocalAcpAgents).not.toHaveBeenCalled();

    expect(closeSpy).not.toHaveBeenCalled();
    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    expect(discoverLocalAcpAgents).toHaveBeenCalledTimes(1);
    await registry.listBackends({ includeUnavailable: true });
    expect(discoverLocalAcpAgents).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();

    await registry.close();
  });

  // Machine discovery reads the operator's config, may fetch a GitHub release
  // list, install a managed Grok build under the PwrAgent root, and then probe
  // that binary — 5-16s per lookup. A registry test must never reach it, and
  // must not have to remember to opt out. These two cases pin both directions
  // of the gate: default off, and still wired when production asks for it.
  it("does not reach machine ACP discovery without an explicit opt-in", async () => {
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockClear();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
    });

    await registry.listBackends({ includeUnavailable: true });

    expect(
      localAcpDiscoveryMock.discoverLocalAcpAgentRecords,
    ).not.toHaveBeenCalled();

    await registry.close();
  });

  it("reaches machine ACP discovery when the caller opts in", async () => {
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockClear();
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-backend-registry-"),
    );
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      configStore: new DesktopConfigStore({
        configPath: path.join(tempRoot, "config.toml"),
      }),
      useMachineAcpDiscovery: true,
    });

    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );

    expect(
      localAcpDiscoveryMock.discoverLocalAcpAgentRecords,
    ).toHaveBeenCalled();

    await registry.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("filters disabled ACP agents before default backend discovery", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-backend-registry-"),
    );
    const previousHome = process.env.PWRAGENT_HOME;
    const profileDir = path.join(tempRoot, "profiles", "default");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, "config.toml"),
      [
        "[acp_agents.gemini]",
        "enabled = false",
        "",
        "[acp_agents.kimi]",
        "cli_path = \"/opt/pwragent/bin/kimi\"",
        "",
      ].join("\n"),
    );
    process.env.PWRAGENT_HOME = tempRoot;
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockReset();
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockResolvedValue([]);
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      configStore: new DesktopConfigStore({
        configPath: path.join(profileDir, "config.toml"),
      }),
      // This case asserts on what machine discovery is asked for, so it opts in
      // deliberately. `../acp/acp-instance-discovery` is mocked file-wide, so
      // opting in here stays inside the process.
      useMachineAcpDiscovery: true,
    });

    try {
      await registry.refreshProvidersAtStartup(
        issueProviderDiscoveryPermit("startup"),
      );

      expect(
        localAcpDiscoveryMock.discoverLocalAcpAgentRecords,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledRegistryIds: ["kimi", "grok", "qwen", "antigravity"],
          preferences: {
            kimi: { overridePath: "/opt/pwragent/bin/kimi" },
          },
        }),
      );
    } finally {
      await registry.close();
      localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockReset();
      localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockResolvedValue([]);
      if (previousHome === undefined) {
        delete process.env.PWRAGENT_HOME;
      } else {
        process.env.PWRAGENT_HOME = previousHome;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("lists persisted ACP sessions as thread summaries", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "gemini-local",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([
        {
          backendId: "acp:gemini",
          sessionId: "session-1",
          title: "ACP Thread",
          cwd: "/repo/project",
          createdAt: 1000,
          updatedAt: 3000,
          executionMode: "full-access",
          status: "idle",
        },
      ]),
    });

    await expect(
      registry.listThreads({ backend: "acp:gemini" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        source: "acp:gemini",
        title: "ACP Thread",
        executionMode: "full-access",
        linkedDirectories: [
          {
            id: "/repo/project",
            label: "project",
            path: "/repo/project",
            kind: "local",
          },
        ],
      }),
    ]);
    await expect(registry.listThreads()).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        source: "acp:gemini",
      }),
    ]);

    await registry.close();
  });

  it.each([false, true])("isolates unavailable Codex in aggregate search candidates (archived: %s)", async (archived) => {
    const failure = new Error("Codex unavailable");
    const codexClient = new MockBackendClient({ listThreadsError: failure });
    const { registry } = createKimiAcpRegistry({
      codexClient,
      sessions: [{
        backendId: "acp:kimi", sessionId: "healthy-acp", title: "Healthy ACP",
        createdAt: 1000, updatedAt: 2000, executionMode: "default", status: "idle",
        ...(archived ? { archivedAt: 3000 } : {}),
      }],
    });
    onTestFinished(() => registry.close());

    await expect(registry.listThreadSearchCandidates({ archived })).resolves.toEqual([
      expect.objectContaining({ id: "healthy-acp", source: "acp:kimi" }),
    ]);
    // An aggregate partial result must not mask an explicitly requested error.
    await expect(registry.listThreadSearchCandidates({ backend: "codex", archived })).rejects.toBe(failure);
    // Nor should caching a partial aggregate hide a recovered provider.
    vi.spyOn(codexClient, "listThreads").mockResolvedValue([{
      id: "recovered-codex", source: "codex", title: "Recovered", titleSource: "explicit", linkedDirectories: [],
    }]);
    await expect(registry.listThreadSearchCandidates({ archived })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "recovered-codex" }),
      expect.objectContaining({ id: "healthy-acp" }),
    ]));
  });

  it("serves durable startup threads before provider refresh completes", async () => {
    const providerRefresh = createDeferred<void>();
    const codexClient = new MockBackendClient({
      listThreadsDelay: providerRefresh.promise,
      threads: [
        {
          id: "live-thread",
          source: "codex",
          title: "Live provider thread",
          titleSource: "explicit",
          summary: "Live prompt preview",
          linkedDirectories: [],
          updatedAt: 200,
        },
      ],
    });
    let storedSnapshots: ProviderThreadSnapshot[] = [
      {
        backend: "codex" as const,
        observedAt: 100,
        threads: [
          {
            id: "durable-thread",
            source: "codex" as const,
            title: "Durable provider thread",
            titleSource: "explicit" as const,
            linkedDirectories: [],
            updatedAt: 100,
          },
        ],
      },
    ];
    const replace = vi.fn((snapshot: ProviderThreadSnapshot) => {
      storedSnapshots = [{
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          summary: undefined,
        })),
      }];
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      discoverLocalAcpAgents: async () => [],
      providerThreadSnapshotStore: {
        list: () => storedSnapshots,
        replace,
      },
    });

    await expect(registry.listThreads({
      callerReason: "navigation-snapshot",
    })).resolves.toEqual([
      expect.objectContaining({
        id: "durable-thread",
        title: "Durable provider thread",
      }),
    ]);
    const startupRefresh = registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    await vi.waitFor(() => {
      expect(codexClient.listThreadsCallCount).toBe(1);
    });
    expect(replace).not.toHaveBeenCalled();

    providerRefresh.resolve();
    await startupRefresh;
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith({
        backend: "codex",
        observedAt: expect.any(Number),
        threads: [expect.objectContaining({ id: "live-thread" })],
      });
    });
    await expect(registry.listThreads({
      callerReason: "navigation-snapshot",
    })).resolves.toEqual([
      expect.objectContaining({
        id: "live-thread",
        summary: "Live prompt preview",
      }),
    ]);
    expect(codexClient.listThreadsCallCount).toBe(1);
    await registry.close();
  });

  it("serves every retained navigation row after a bounded startup prewarm", async () => {
    const provider = createDeferred<void>();
    const acpDiscovery = createDeferred<void>();
    const codexClient = new MockBackendClient({ listThreadsDelay: provider.promise });
    const threads = Array.from({ length: 70 }, (_, index) => ({
      id: `saved-${index}`, source: "codex" as const, title: `Saved ${index}`,
      titleSource: "explicit" as const, linkedDirectories: [], updatedAt: 100 - index,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore: createOverlayStoreMock(), discoverLocalAcpAgents: async () => {
        await acpDiscovery.promise;
        return [];
      },
      providerThreadSnapshotStore: {
        list: () => [{ backend: "codex", observedAt: 100, threads }], replace: vi.fn(),
      },
    });
    await registry.listThreads({ callerReason: "startup-prewarm", limit: 50, maxPages: 1 });
    expect(registry.readStartupNavigationThreads()).toBeUndefined();
    registry.markStartupProviderRefreshPending();
    const refresh = registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const sidebar = registry.readStartupNavigationThreads();
    try {
      // A display read must finish with complete saved membership while a live
      // provider read cannot make progress.
      await vi.waitFor(() => expect(codexClient.listThreadsCallCount).toBe(1));
      expect((await sidebar)?.map(({ id }) => id)).toEqual(threads.map(({ id }) => id));
    } finally {
      provider.resolve();
      acpDiscovery.resolve();
      await Promise.allSettled([refresh, sidebar]);
      await registry.close();
    }
  });

  it("excludes saved Codex rows archived after the provider observation", async () => {
    const db = openInMemoryStateDb();
    const overlayStore = new SqliteOverlayStore(db);
    const snapshots = new ProviderThreadSnapshotStore(db);
    const rows = ["visible", "retention", "tombstone", "restored"].map((id): AppServerThreadSummary => ({
      id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [],
    }));
    snapshots.replace({ backend: "codex", observedAt: 100, threads: rows });
    await overlayStore.observeArchivedThreads(["retention", "restored"].map((threadId) => ({ backend: "codex", threadId })), 200);
    await overlayStore.setThreadArchiveTombstone({ backend: "codex", threadId: "tombstone", archivedAt: 300 });
    await overlayStore.setThreadArchiveTombstone({ backend: "codex", threadId: "restored", restoredAt: 400 });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}), overlayStore, providerThreadSnapshotStore: snapshots,
    });
    try {
      registry.markStartupProviderRefreshPending();
      const saved = await registry.readStartupNavigationThreads();
      expect(saved?.map(({ id }) => id)).toEqual(["visible", "restored"]);
    } finally {
      await registry.close();
      db.close();
    }
  });

  it.each([false, true])("reports startup listing completeness when Codex is installed: %s", async (installed) => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ listThreadsError: new Error("Codex did not list") }),
      overlayStore: createOverlayStoreMock(), discoverLocalAcpAgents: async () => [],
      providerThreadSnapshotStore: { list: () => [], replace: vi.fn() },
      resolveCodexRuntimeCommand: async () => {
        if (!installed) throw new Error("Codex is absent");
        return { command: "/fixture/codex" };
      },
    });
    try {
      await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
      const published = await registry.listThreads({ enrichDirectories: false });
      expect(registry.isIncompleteThreadList(published)).toBe(installed);
    } finally {
      await registry.close();
    }
  });

  it.each([[16, 4], [32, 4], [64, 4], [16, 8], [16, 16], [64, 16]])(
    "reads live review records once for %i saved rows and %i active reviews", async (rowCount, reviewCount) => {
      const threads = Array.from({ length: rowCount }, (_, index): AppServerThreadSummary => ({
        id: `row-${index}`, source: "codex", title: "Saved thread", titleSource: "explicit",
        threadStatus: "idle", linkedDirectories: [],
      }));
      const registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock(),
        providerThreadSnapshotStore: { list: () => [{ backend: "codex", observedAt: 100, threads }], replace: vi.fn() },
      });
      try {
        registry.markStartupProviderRefreshPending();
        const turnState = registry.context.turnState;
        const active = threads.slice(0, reviewCount).map(({ id }) => id);
        for (const parentThreadId of active) turnState.activateReview({
          backend: "codex", parentBackend: "codex", parentThreadId, mode: "managed", reviewThreadId: `review-${parentThreadId}`,
          turnId: "review-turn", task: "Review", displayText: "Review", createdAt: 101,
        });
        const reads = vi.spyOn(turnState, "liveReviewRecords");
        const rows = await registry.readStartupNavigationThreads();
        expect(rows?.filter(({ threadStatus }) => threadStatus === "active").map(({ id }) => id)).toEqual(active);
        expect(reads).toHaveBeenCalledOnce();
      } finally { await registry.close(); }
    },
  );

  it.each(["before", "after"] as const)("keeps the live inventory when startup publishes %s the first live read", async (publication) => {
    const listed = createDeferred<void>();
    const publish = createDeferred<void>();
    const thread: AppServerThreadSummary = {
      id: "thread-1", source: "codex", title: "Fixture thread", titleSource: "explicit",
      linkedDirectories: [], threadStatus: "idle",
    };
    const codexClient = new MockBackendClient({ threads: [thread] });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      discoverLocalAcpAgents: async () => [],
      providerThreadSnapshotStore: { list: () => [], replace: vi.fn() },
      resolveCodexRuntimeCommand: async () => {
        // Discovery reaches this port after taking its provider inventory.
        listed.resolve();
        await publish.promise;
        return { command: "/fixture/codex" };
      },
    });
    const list = () => registry.listThreads({ callerReason: "navigation-snapshot", enrichDirectories: false });
    await list(); // Consume durable startup hydration before the live reads.
    const startup = registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const assertLive = async () => expect(await list()).toEqual([
      expect.objectContaining({ id: thread.id, threadStatus: "active" }),
    ]);
    try {
      await listed.promise;
      codexClient.setThreads([{ ...thread, threadStatus: "active" }]);
      await codexClient.emit({ method: "turn/started", params: { threadId: thread.id, turnId: "turn-1", turn: { id: "turn-1" } } });
      if (publication === "after") await assertLive();
      const walks = codexClient.listThreadsCallCount;
      publish.resolve();
      await startup;
      await assertLive();
      // Startup's older inventory cannot displace a reusable live listing.
      expect(codexClient.listThreadsCallCount).toBe(walks + Number(publication === "before"));
      await assertLive();
      expect(codexClient.listThreadsCallCount).toBe(walks + Number(publication === "before"));
    } finally {
      publish.resolve();
      try { await startup; }
      finally { await registry.close(); }
    }
  });

  it("ACP cache publication preserves the ordinary listing's worktree and environment enrichment", async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Za-z]{1,10}$/),
      fc.array(fc.constantFrom("startup", "authentication", "delete", "hide", "rename"), { maxLength: 5 }), async (name, commands) => {
        const temp = createTempStateDb("acp-cache-enrichment-");
        const db = StateDb.open(temp.dbPath);
        const sessions = new AcpSessionStore(db);
        const inventory = new ProviderThreadSnapshotStore(db);
        const backend = "acp:uninstalled" as const;
        const cwd = path.join(temp.tempDir, ".worktrees", "member", "repo");
        const repo = path.join(temp.tempDir, "repo");
        const directory: LinkedDirectorySummary = { id: repo, path: repo, worktreePath: cwd, kind: "worktree", label: "repo" };
        await mkdir(path.join(cwd, ".codex", "environments"), { recursive: true });
        await writeFile(path.join(cwd, ".codex", "environments", "environment.toml"), `version = 1\nname = "${name}"\n`);
        const native: AcpSessionMetadata = { backendId: backend, sessionId: "same-id", title: name, titleSource: "derived",
          cwd, createdAt: 1, updatedAt: 2, executionMode: "default", status: "idle" };
        sessions.upsertSession(native);
        sessions.upsertSession({ ...native, backendId: "acp:other", title: "Other", cwd: repo });
        const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({ threads: [] }),
          overlayStore: new SqliteOverlayStore(db), acpSessionStore: sessions, providerThreadSnapshotStore: inventory,
          discoverLocalAcpAgents: async () => [], acpWorktreeRepositoryResolver: async () => directory });
        try {
          const ordinary = (await registry.listThreads({ backend, forceRefresh: true }))[0]!;
          expect(ordinary.linkedDirectories).toEqual([directory]);
          expect(ordinary).toMatchObject({ codexEnvironmentOptions: [{ name }] });
          let present = true;
          for (const [index, command] of ["hydrate", ...commands].entries()) {
            if (command === "delete") { sessions.deleteSession(backend, native.sessionId); present = false; }
            if (command === "hide") { sessions.upsertSession({ ...native, hidden: true }); present = false; }
            if (command === "rename") { sessions.upsertSession({ ...native, title: `${name}${index}` }); present = true; }
            if (command === "startup") await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
            if (command === "authentication") await registry.refreshCodexAfterAuthentication(issueProviderDiscoveryPermit("settings-user-action"));
            // A completed older inventory must not restore membership or titles.
            const publish = registry as unknown as { publishRefreshedProviderThreadsToCache(refreshes: Array<{ backends: AppServerBackendKind[]; threads: AppServerThreadSummary[] }>): Promise<void> };
            if (command !== "hydrate") await publish.publishRefreshedProviderThreadsToCache([{ backends: [backend], threads: [ordinary] }]);
            const rows = await registry.listThreads({ callerReason: "navigation-snapshot" });
            const row = rows.find(thread => thread.source === backend);
            expect(rows.find(thread => thread.source === "acp:other")?.linkedDirectories)
              .toEqual([{ id: repo, path: repo, kind: "local", label: "repo" }]);
            expect(row !== undefined).toBe(present);
            if (present) {
              expect(row).toMatchObject({ title: sessions.getSession(backend, native.sessionId)!.title,
                linkedDirectories: ordinary.linkedDirectories, codexEnvironmentOptions: [{ name }] });
            }
          }
        } finally { await registry.close(); db.close(); removeTempStateDbDir(temp.tempDir); }
      }), { numRuns: 10, examples: [["Env", ["startup", "authentication", "delete"]]] });
  });

  it.each(["hydrate", "publish"] as const)("ACP cache %s rechecks native membership after directory IO", async boundary => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("delete", "hide", "rename"), async change => {
      const temp = createTempStateDb("acp-cache-race-");
      const db = StateDb.open(temp.dbPath);
      const sessions = new AcpSessionStore(db);
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      const cwd = path.join(temp.tempDir, ".worktrees", "member");
      const native: AcpSessionMetadata = { backendId: "acp:uninstalled", sessionId: "member", title: "Before",
        cwd, createdAt: 1, updatedAt: 2, executionMode: "default", status: "idle" };
      sessions.upsertSession(native);
      const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({ threads: [] }),
        overlayStore: new SqliteOverlayStore(db), acpSessionStore: sessions, providerThreadSnapshotStore: new ProviderThreadSnapshotStore(db),
        discoverLocalAcpAgents: async () => [], acpWorktreeRepositoryResolver: async () => {
          entered.resolve(); await resume.promise;
          return { id: temp.tempDir, path: temp.tempDir, worktreePath: cwd, kind: "worktree", label: "repo" };
        } });
      const publisher = registry as unknown as { publishRefreshedProviderThreadsToCache(refreshes: []): Promise<void> };
      const listing = boundary === "hydrate" ? registry.listThreads({ callerReason: "navigation-snapshot" })
        : Promise.resolve(publisher.publishRefreshedProviderThreadsToCache([])).then(() => registry.listThreads({ callerReason: "navigation-snapshot" }));
      try {
        expect(await Promise.race([entered.promise.then(() => true), listing.then(() => false)])).toBe(true);
        if (change === "delete") sessions.deleteSession(native.backendId, native.sessionId);
        else sessions.upsertSession({ ...native, hidden: change === "hide", title: "After" });
        resume.resolve();
        const rows = await listing;
        expect(rows).toHaveLength(change === "rename" ? 1 : 0);
        if (change === "rename") expect(rows[0]?.title).toBe("After");
      } finally { resume.resolve(); await listing; await registry.close(); db.close(); removeTempStateDbDir(temp.tempDir); }
    }), { numRuns: 6, examples: [["delete"], ["hide"], ["rename"]] });
  });

  it("returns a cold-start empty snapshot while provider discovery runs", async () => {
    const providerRefresh = createDeferred<void>();
    const codexClient = new MockBackendClient({
      listThreadsDelay: providerRefresh.promise,
      threads: [
        {
          id: "first-thread",
          source: "codex",
          title: "First provider thread",
          titleSource: "explicit",
          linkedDirectories: [],
          updatedAt: 200,
        },
      ],
    });
    const replace = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      discoverLocalAcpAgents: async () => [],
      providerThreadSnapshotStore: {
        list: () => [],
        replace,
      },
    });

    await expect(registry.listThreads({
      callerReason: "startup-prewarm",
    })).resolves.toEqual([]);
    const startupRefresh = registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    expect(registry.getStartupProviderRefreshStatus()).toEqual({
      state: "checking",
    });
    await vi.waitFor(() => {
      expect(codexClient.listThreadsCallCount).toBe(1);
    });

    providerRefresh.resolve();
    await startupRefresh;
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith({
        backend: "codex",
        observedAt: expect.any(Number),
        threads: [expect.objectContaining({ id: "first-thread" })],
      });
    });
    await vi.waitFor(() => {
      expect(registry.getStartupProviderRefreshStatus()).toEqual({
        state: "ready",
      });
    });
    await registry.close();
  });

  it("reports the startup provider refresh through listBackends at every stage and before its refreshed event", async () => {
    for (const outcome of ["ready", "degraded"] as const) {
      const providerRefresh = createDeferred<void>();
      const codexClient = new MockBackendClient({ listThreadsDelay: providerRefresh.promise });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        discoverLocalAcpAgents: async () => [],
        providerThreadSnapshotStore: { list: () => [], replace: vi.fn() },
      });
      // A viewer re-reads the owner's backends when it hears the refresh end,
      // so the outcome must already be readable when that event goes out.
      const atRefreshedEvent: unknown[] = [];
      const stop = registry.onEvent((event) => {
        if (event.notification.method === "navigation/providerThreads/refreshed") {
          atRefreshedEvent.push(registry.listBackends({}).then((response) => response.providerRefresh));
        }
      });
      const observed = async () => (await registry.listBackends({})).providerRefresh;
      try {
        expect(await observed()).toBeUndefined();
        const startupRefresh = registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
        expect(await observed()).toEqual({ state: "checking" });
        expect(await observed()).toEqual(registry.getStartupProviderRefreshStatus());
        if (outcome === "ready") providerRefresh.resolve();
        else providerRefresh.reject(new Error("provider unavailable"));
        await startupRefresh;
        const expected = outcome === "ready" ? { state: "ready" } : { state: "degraded", failedProviders: 1 };
        expect(await observed()).toEqual(expected);
        expect(await observed()).toEqual(registry.getStartupProviderRefreshStatus());
        expect(await Promise.all(atRefreshedEvent)).toEqual([expected]);
      } finally {
        stop();
        await registry.close();
      }
    }
  });

  it("does not erase durable startup threads when provider refresh fails", async () => {
    const replace = vi.fn();
    const codexClient = new MockBackendClient({
      listThreadsError: new Error("provider unavailable"),
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      discoverLocalAcpAgents: async () => [],
      providerThreadSnapshotStore: {
        list: () => [
          {
            backend: "codex" as const,
            observedAt: 100,
            threads: [
              {
                id: "last-good-thread",
                source: "codex" as const,
                title: "Last known good",
                titleSource: "explicit" as const,
                linkedDirectories: [],
                updatedAt: 100,
              },
            ],
          },
        ],
        replace,
      },
    });

    await expect(registry.listThreads({
      callerReason: "navigation-snapshot",
    })).resolves.toEqual([
      expect.objectContaining({ id: "last-good-thread" }),
    ]);
    await registry.refreshProvidersAtStartup(
      issueProviderDiscoveryPermit("startup"),
    );
    await vi.waitFor(() => {
      expect(codexClient.listThreadsCallCount).toBe(1);
    });
    await vi.waitFor(() => {
      expect(registry.getStartupProviderRefreshStatus()).toEqual({
        state: "degraded",
        failedProviders: 1,
      });
    });
    expect(replace).not.toHaveBeenCalled();
    await registry.close();
  });

  async function createSelectedCodexRegistry(codexClient: MockBackendClient) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-incomplete-listing-"));
    const configStore = new DesktopConfigStore({ configPath: path.join(tempRoot, "config.toml") });
    const command = path.join(tempRoot, "codex");
    configStore.recordProviderDiscovery("codex", {
      candidates: [{ command, source: "path", version: "0.160.0" }],
      selectedCommand: command,
      selectedVersion: "0.160.0",
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      configStore,
      overlayStore: createOverlayStoreMock(),
      discoverLocalAcpAgents: async () => [],
    });
    onTestFinished(async () => {
      await registry.close();
      configStore.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    });
    return registry;
  }

  it("marks a navigation listing incomplete when a selected Codex fails, then completes once Codex answers", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = await createSelectedCodexRegistry(codexClient);
    const listing = vi.spyOn(codexClient, "listThreads")
      .mockRejectedValueOnce(new Error("codex app server client closed"));

    const failed = await registry.listThreads({ callerReason: "navigation-snapshot" });
    expect(failed).toEqual([]);
    expect(registry.isIncompleteThreadList(failed)).toBe(true);
    // The Codex-only listing the aggregate reused carries the same mark.
    const codexOnly = await registry.listThreads({ backend: "codex", callerReason: "navigation-snapshot" });
    expect(registry.isIncompleteThreadList(codexOnly)).toBe(true);
    expect(listing).toHaveBeenCalledTimes(1);

    codexClient.setThreads([{
      id: "recovered-thread",
      source: "codex",
      title: "Recovered",
      titleSource: "explicit",
      linkedDirectories: [],
      updatedAt: 200,
    }]);
    // An incomplete listing is not reused for the whole five-minute window.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    onTestFinished(() => { clock.mockRestore(); });
    const recovered = await registry.listThreads({ callerReason: "navigation-snapshot" });
    expect(recovered).toEqual([expect.objectContaining({ id: "recovered-thread" })]);
    expect(registry.isIncompleteThreadList(recovered)).toBe(false);
  });

  it("marks a navigation listing incomplete when native Codex sub-agent discovery fails", async () => {
    const codexClient = new MockBackendClient({ threads: [{
      id: "parent-thread",
      source: "codex",
      title: "Parent",
      titleSource: "explicit",
      linkedDirectories: [],
      updatedAt: 100,
    }] });
    vi.spyOn(codexClient, "listNativeSubAgentThreads")
      .mockRejectedValueOnce(new Error("native discovery failed"));
    const registry = await createSelectedCodexRegistry(codexClient);

    const listed = await registry.listThreads({ callerReason: "navigation-snapshot" });
    expect(listed).toEqual([expect.objectContaining({ id: "parent-thread" })]);
    expect(registry.isIncompleteThreadList(listed)).toBe(true);
  });

  it("marks a navigation listing incomplete when a managed Codex runtime fails without a recorded selection", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ listThreadsError: new Error("codex app server client closed") }),
      overlayStore: createOverlayStoreMock(),
      discoverLocalAcpAgents: async () => [],
      resolveCodexRuntimeCommand: async () => ({ command: "/managed/codex", version: "0.160.0" }),
    });
    onTestFinished(async () => { await registry.close(); });

    const listed = await registry.listThreads({ callerReason: "navigation-snapshot" });
    expect(listed).toEqual([]);
    expect(registry.isIncompleteThreadList(listed)).toBe(true);
  });

  it("does not mark a listing incomplete when no Codex executable is selected", async () => {
    const noExecutable = new Error("Codex discovery has not selected an executable. Select Check again under Setup in Settings → Codex.");
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ listThreadsError: noExecutable }),
      overlayStore: createOverlayStoreMock(),
      discoverLocalAcpAgents: async () => [],
      resolveCodexRuntimeCommand: async () => { throw noExecutable; },
    });
    onTestFinished(async () => { await registry.close(); });

    const listed = await registry.listThreads({ callerReason: "navigation-snapshot" });
    expect(listed).toEqual([]);
    expect(registry.isIncompleteThreadList(listed)).toBe(false);
  });

  it("invalidates cached ACP thread summaries when runtime mode changes", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "Untitled thread",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        acpRuntime: {
          currentModeId: "default",
          updatedAt: 1000,
        },
        status: "idle",
      },
    ];
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(),
      startPrompt: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
      setRuntimeOption: vi.fn(
        async (): Promise<BackendAcpSessionRuntimeState> => ({
          currentModeId: "yolo",
          updatedAt: 2000,
        }),
      ),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 1000,
          runtimeCapabilities: {
            schemaVersion: 1,
            status: "discovered",
            source: "session-load",
            discoveredAt: 1000,
            checkedAt: 1000,
            modes: {
              currentModeId: "default",
              availableModes: [
                { id: "default", label: "Default" },
                { id: "yolo", label: "YOLO" },
              ],
            },
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        acpRuntime: expect.objectContaining({ currentModeId: "default" }),
      }),
    ]);

    await registry.setAcpSessionRuntimeOption({
      backend: acpBackendId,
      threadId: "session-1",
      source: "mode",
      optionId: "mode",
      value: "yolo",
    });

    // Selected detail reads remembered summaries before the next full listing.
    expect(registry.getCachedThreadSummary({ backend: acpBackendId, threadId: "session-1" }))
      .toMatchObject({ executionMode: "full-access", acpRuntime: { currentModeId: "yolo" } });

    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        acpRuntime: expect.objectContaining({ currentModeId: "yolo" }),
      }),
    ]);

    await registry.close();
  });

  it("asks each ACP process to close idle sessions, keeping a thread with a live turn", async () => {
    const { acpBackendId, acpClient, registry } = createKimiAcpRegistry({
      sessions: [{
        backendId: "acp:kimi" as AcpBackendId,
        sessionId: "kimi-session-1",
        title: "Untitled thread",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      }],
    });
    const closeIdleSessions = vi.fn(async (_params: {
      idleMs: number;
      isSessionBusy?: (sessionId: string) => boolean;
    }) => [] as string[]);
    Object.assign(acpClient, { closeIdleSessions });
    const busyDuringSweep = (sessionId: string) =>
      closeIdleSessions.mock.lastCall?.[0].isSessionBusy?.(sessionId);

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      input: [{ type: "text", text: "work" }],
    });
    await registry.closeIdleAcpSessions();

    expect(closeIdleSessions).toHaveBeenCalledTimes(1);
    expect(closeIdleSessions.mock.lastCall?.[0].idleMs).toBe(10 * 60_000);
    expect(busyDuringSweep("kimi-session-1")).toBe(true);
    expect(busyDuringSweep("kimi-session-2")).toBe(false);

    await emitCompletedTurn(registry, acpBackendId, "kimi-session-1");
    await registry.closeIdleAcpSessions();

    expect(closeIdleSessions).toHaveBeenCalledTimes(2);
    expect(busyDuringSweep("kimi-session-1")).toBe(false);

    await registry.close();
    // A closed registry starts no sweep.
    await registry.closeIdleAcpSessions();
    expect(closeIdleSessions).toHaveBeenCalledTimes(2);
  });

  it("reads persisted ACP sessions locally and refreshes the agent in the background", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const localReplay: AppServerThreadReplay = {
      entries: [
        {
          type: "message",
          id: "assistant:cached",
          role: "assistant",
          text: "Cached ACP transcript",
          createdAt: 1002,
        },
      ],
      messages: [
        {
          id: "assistant:cached",
          role: "assistant",
          text: "Cached ACP transcript",
          createdAt: 1002,
        },
      ],
      lastAssistantMessage: "Cached ACP transcript",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: "idle",
    };
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      startSession: vi.fn(),
      startPrompt: vi.fn(),
      cancelSession: vi.fn(),
      ensureSession: vi.fn(async () => undefined),
      readReplay: vi.fn(() => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      })),
      loadSession: vi.fn(async () => localReplay),
      refreshSession: vi.fn(async () => undefined),
    };
    const session: AcpSessionMetadata = {
      backendId: acpBackendId,
      sessionId: "session-1",
      title: "Stored ACP Thread",
      cwd: "/repo/project",
      createdAt: 1000,
      updatedAt: 3000,
      executionMode: "default",
      status: "idle",
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
          launchDescriptor: {
            backendId: acpBackendId,
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock([session]),
      createAcpClient: () => acpClient,
    });

    await expect(
      registry.readThread({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
      replay: {
        lastAssistantMessage: "Cached ACP transcript",
      },
    });
    expect(acpClient.initialize).toHaveBeenCalledTimes(1);
    expect(acpClient.loadSession).toHaveBeenCalledWith(session);
    expect(acpClient.refreshSession).toHaveBeenCalledWith(session);

    await registry.close();
  });

  it("reports Codex connected once initialize answers during a model refresh", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      models: [],
    });
    const initialize = createDeferred<void>();
    const answerInitialize = codexClient.getInitializeResult.bind(codexClient);
    codexClient.getInitializeResult = async () => {
      await initialize.promise;
      return await answerInitialize();
    };
    const onCodexConnected = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    const listing = registry.listBackends(
      { includeUnavailable: true, refreshModels: "codex" },
      issueProviderDiscoveryPermit("settings-user-action"),
      { onCodexConnected },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCodexConnected).not.toHaveBeenCalled();

    initialize.resolve();
    const response = await listing;

    expect(onCodexConnected).toHaveBeenCalledOnce();
    expect(response.backends[0]?.available).toBe(true);
    await registry.close();
  });

  it("never reports Codex connected when initialize fails", async () => {
    const codexClient = new MockBackendClient({
      initializeError: new Error("codex unavailable"),
      models: [],
    });
    const onCodexConnected = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    const response = await registry.listBackends(
      { includeUnavailable: true, refreshModels: "codex" },
      issueProviderDiscoveryPermit("settings-user-action"),
      { onCodexConnected },
    );

    expect(response.backends[0]?.available).toBe(false);
    expect(onCodexConnected).not.toHaveBeenCalled();
    await registry.close();
  });

  it("keeps fallback backend summary and thread-start defaults aligned", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      models: [],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    const response = await registry.listBackends(
      { includeUnavailable: true, refreshModels: "codex" },
      issueProviderDiscoveryPermit("settings-user-action"),
    );
    await registry.startThread({ backend: "codex" });

    const models = response.backends[0]?.launchpadOptions?.models ?? [];
    expect(models.find((model) => model.id === "gpt-5.6-sol")?.current).toBe(false);
    expect(models.find((model) => model.id === "gpt-5.6-terra")?.current).toBe(false);
    expect(models.find((model) => model.id === "gpt-5.6-luna")?.current).toBe(false);
    expect(models.find((model) => model.id === "gpt-5.5")?.current).toBe(false);
    expect(models.find((model) => model.id === "gpt-6.1-terra")?.current).toBe(true);
    expect(codexClient.lastStartThreadParams?.model).toBe("gpt-6.1-terra");

    await registry.close();
  });

  it("keeps a working Codex catalog after an explicit refresh fails", async () => {
    const modelListErrors: Error[] = [];
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      modelListErrors,
      models: [
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6-Sol",
          supportsReasoning: true,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const permit = issueProviderDiscoveryPermit("settings-user-action");

    const first = await registry.listBackends(
      { includeUnavailable: true, refreshModels: "codex" },
      permit,
    );
    modelListErrors.push(new Error("temporary model refresh failure"));

    await expect(
      registry.listBackends(
        { includeUnavailable: true, refreshModels: "codex" },
        permit,
      ),
    ).rejects.toThrow("temporary model refresh failure");
    const cached = await registry.listBackends({ includeUnavailable: true });

    expect(cached.backends[0]).toEqual(first.backends[0]);
    expect(cached.backends[0]?.available).toBe(true);
    expect(cached.backends[0]?.launchpadOptions?.models).toEqual([
      expect.objectContaining({ id: "gpt-5.6-sol" }),
    ]);

    await registry.close();
  });

  it("arms the automatic retry when a Settings Refresh finds a provider down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let down = false;
    const providerFetch = vi.fn(async () => down
      ? new Response(JSON.stringify({ error: { message: "maintenance" } }), { status: 503 })
      : new Response(JSON.stringify({ data: [{ id: "kimi-k3.1-pro" }] })));
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ models: [{ id: "gpt-5.4", label: "GPT-5.4", supportsReasoning: true }] }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
      resolveCodexModelProviders: () => [{ id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1" }],
      resolveCodexModelProviderKeys: async () => ({}),
      codexModelProviderFetch: providerFetch,
    });
    try {
      await registry.listBackends(
        { includeUnavailable: true, refreshModels: "codex" },
        issueProviderDiscoveryPermit("settings-user-action"),
      );
      expect(providerFetch).toHaveBeenCalledTimes(1);
      down = true;
      await registry.constructionPorts().refreshCodexProviderCatalogs({ rereadProviders: true });
      expect(providerFetch).toHaveBeenCalledTimes(2);
      // Nothing else reads the summary, yet the retry reads it again.
      down = false;
      await vi.advanceTimersByTimeAsync(70_000);
      expect(providerFetch).toHaveBeenCalledTimes(3);
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  // Bootstrap-mode hard gate: when the registry runs inside the
  // throwaway `.bootstrap/` profile (any post-wizard dev window that
  // stays alive while the new profile spawns), listThreads must
  // ALWAYS return empty — independent of `isCodexBootstrapDeferred`
  // and the persisted `onboarding.completed` flag. Otherwise, the
  // bootstrap profile's empty `codex.profile` would resolve to the
  // operator's real Codex install and surface their real thread
  // list as soon as they focused the bootstrap window.
  describe("bootstrap mode short-circuit for listThreads", () => {
    it("returns empty for codex-only queries in bootstrap mode", async () => {
      const codexClient = new MockBackendClient({
        threads: [
          {
            id: "thread-codex",
            title: "Codex thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        isBootstrapMode: () => true,
        // Even with the secondary gate explicitly OFF, bootstrap-mode
        // hard gate must still short-circuit. This is the key
        // invariant the user surfaced: the dev-mode post-wizard
        // window had `onboarding.completed = true` from a stale
        // run, so `isCodexBootstrapDeferred` returned false — but
        // the renderer focusing the window still triggered a thread
        // load against the user's real Codex install. The bootstrap
        // gate is what catches that.
        isCodexBootstrapDeferred: () => false,
      });

      const result = await registry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
      });

      expect(result).toEqual([]);
      expect(codexClient.listThreadsCallCount).toBe(0);

      await registry.close();
    });
    it("throws on readThread in bootstrap mode", async () => {
      // Defense in depth: even if a renderer has a stale Codex
      // threadId in memory and tries to read it, the registry
      // refuses. The error surfaces as a thrown IPC reject; the
      // wizard's only-window-is-the-wizard invariant means no
      // operator-visible path leads here, so failing loud is the
      // right signal that something is wrong.
      const codexClient = new MockBackendClient({});
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        isBootstrapMode: () => true,
        isCodexBootstrapDeferred: () => false,
      });

      await expect(
        registry.readThread({
          backend: "codex",
          threadId: "thread-abc",
        }),
      ).rejects.toThrow(/readThread is forbidden in bootstrap mode/);

      await registry.close();
    });

    it("throws on startThread in bootstrap mode", async () => {
      const codexClient = new MockBackendClient({});
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        isBootstrapMode: () => true,
        isCodexBootstrapDeferred: () => false,
      });

      await expect(
        registry.startThread({
          backend: "codex",
          executionMode: "default",
          cwd: "/tmp/example",
        }),
      ).rejects.toThrow(/startThread is forbidden in bootstrap mode/);

      await registry.close();
    });

    it("hits the backends normally when isBootstrapMode is false", async () => {
      // Sanity: the gate is a NO-OP outside bootstrap mode. Production
      // boots into active-profile mode and the registry behaves
      // exactly as it did pre-#524.
      const codexClient = new MockBackendClient({
        threads: [
          {
            id: "thread-codex",
            title: "Codex thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        isBootstrapMode: () => false,
        isCodexBootstrapDeferred: () => false,
      });

      const result = await registry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
      });

      expect(result.map((t) => t.id)).toEqual(["thread-codex"]);
      expect(codexClient.listThreadsCallCount).toBe(1);

      await registry.close();
    });
  });

  // Deferred Codex `listThreads` probe for brand-new PwrAgent profiles.
  // The wizard flips `resolveOnboardingCompleted` to `true` after the
  // operator picks a Codex profile model; until then we must not hit the
  // Codex backend for thread-list reads.
  describe("onboarding gate for Codex listThreads", () => {
    it("returns empty for explicit codex queries when onboarding is incomplete", async () => {
      const codexClient = new MockBackendClient({
        threads: [
          {
            id: "thread-codex",
            title: "Codex thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        isCodexBootstrapDeferred: () => true,
      });

      const result = await registry.listThreads({
        backend: "codex",
        callerReason: "startup-prewarm",
      });

      expect(result).toEqual([]);
      expect(codexClient.listThreadsCallCount).toBe(0);

      await registry.close();
    });
    it("hits Codex once onboarding is complete", async () => {
      const codexClient = new MockBackendClient({
        threads: [
          {
            id: "thread-codex",
            title: "Codex thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        isCodexBootstrapDeferred: () => false,
      });

      const result = await registry.listThreads({
        backend: "codex",
        callerReason: "startup-prewarm",
      });

      expect(result.map((thread) => thread.id)).toEqual(["thread-codex"]);
      expect(codexClient.listThreadsCallCount).toBe(1);

      await registry.close();
    });
  });
});
