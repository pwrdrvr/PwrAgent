import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadSummary,
  AppServerReviewTarget,
  AppServerTurnInputItem,
  BackendAccountSummary,
  BackendRateLimitSummary,
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
  ThreadOverlayState,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { WorktreeArchiveService } from "../app-server/worktree-archive-service";

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) {
      return;
    }
    await flushAsync();
  }
}

function createOverlayStoreMock(params?: {
  executionMode?: "default" | "full-access";
  launchpadDefaults?: NavigationLaunchpadDefaults;
  overlays?: Record<string, ThreadOverlayState>;
}) {
  const initialOverlay = params?.executionMode
    ? {
        backend: "codex" as const,
        threadId: "thread-1",
        executionMode: params.executionMode,
        extraLinkedDirectories: [],
      }
    : undefined;
  const overlays = new Map<string, ThreadOverlayState>(
    Object.entries(params?.overlays ?? {})
  );
  let launchpadDefaults: NavigationLaunchpadDefaults = {
    backend: "codex",
    executionMode: "default",
    workMode: "local",
    ...params?.launchpadDefaults,
  };
  const launchpads = new Map<string, NavigationLaunchpadDraft>();
  if (initialOverlay) {
    overlays.set("codex:thread-1", initialOverlay);
  }

  return {
    getThreadOverlayState: async ({
      backend,
      threadId,
    }: {
      backend: "codex" | "grok";
      threadId: string;
    }) => overlays.get(`${backend}:${threadId}`),
    getThreadOverlayStates: async ({ threadIds }: { threadIds: string[] }) =>
      Object.fromEntries(threadIds.map((threadId) => [threadId, overlays.get(`codex:${threadId}`)])),
    setThreadExecutionMode: async ({
      backend,
      threadId,
      executionMode,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      executionMode: "default" | "full-access";
    }) => {
      const key = `${backend}:${threadId}`;
      const next = {
        ...overlays.get(key),
        backend,
        threadId,
        executionMode,
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadModelSettings: async (settings: {
      backend: "codex" | "grok";
      threadId: string;
      model?: string;
      reasoningEffort?: string;
      serviceTier?: string;
      fastMode?: boolean;
    }) => {
      const key = `${settings.backend}:${settings.threadId}`;
      const next = {
        ...overlays.get(key),
        ...settings,
        extraLinkedDirectories: overlays.get(key)?.extraLinkedDirectories ?? [],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadExpectedBranch: async ({
      backend,
      threadId,
      branch,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      branch: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        gitBranch: branch,
        observedGitBranch: branch,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    setThreadObservedBranch: async ({
      backend,
      threadId,
      branch,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      branch?: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        observedGitBranch: branch,
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    retainThreadBranchDrift: async ({
      backend,
      threadId,
      expectedBranch,
      observedBranch,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      expectedBranch: string;
      observedBranch: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        retainedBranchDriftPairs: [
          ...(current.retainedBranchDriftPairs ?? []),
          {
            expectedBranch,
            observedBranch,
            retainedAt: Date.now(),
          },
        ],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    getLaunchpadDefaults: async () => launchpadDefaults,
    setLaunchpadDefaults: async (patch: Partial<NavigationLaunchpadDefaults>) => {
      launchpadDefaults = {
        ...launchpadDefaults,
        ...patch,
      };
      return launchpadDefaults;
    },
    getDirectoryLaunchpad: async ({ directoryKey }: { directoryKey: string }) =>
      launchpads.get(directoryKey),
    upsertDirectoryLaunchpad: async (launchpad: NavigationLaunchpadDraft) => {
      const nextLaunchpad = {
        ...launchpads.get(launchpad.directoryKey),
        ...launchpad,
      };
      launchpads.set(launchpad.directoryKey, nextLaunchpad);
      return nextLaunchpad;
    },
    resetDirectoryLaunchpad: async ({ directoryKey }: { directoryKey: string }) => {
      launchpads.delete(directoryKey);
    },
    replaceWorkspaceLinkedDirectory: async ({
      backend,
      threadId,
      directory,
      gitBranch,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      directory: ThreadOverlayState["extraLinkedDirectories"][number];
      gitBranch?: string;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        gitBranch: gitBranch ?? current.gitBranch,
        observedGitBranch: gitBranch ?? current.observedGitBranch,
        extraLinkedDirectories: [directory],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
    upsertWorktreeSnapshot: async ({
      backend,
      threadId,
      snapshot,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      snapshot: WorktreeSnapshotSummary;
    }) => {
      const key = `${backend}:${threadId}`;
      const current = overlays.get(key) ?? {
        backend,
        threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const next = {
        ...current,
        worktreeSnapshots: [
          ...(current.worktreeSnapshots ?? []).filter(
            (candidate) => candidate.id !== snapshot.id
          ),
          snapshot,
        ],
      } as ThreadOverlayState;
      overlays.set(key, next);
      return next;
    },
  } as unknown as InstanceType<typeof import("@pwragent/agent-core").OverlayStore>;
}

class MockBackendClient {
  private readonly listeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();
  private readonly requestListeners = new Set<
    (request: AppServerPendingRequestNotification) => Promise<unknown> | unknown
  >();
  lastReadThreadParams?: {
    threadId: string;
    before?: string;
    limit?: number;
  };
  lastStartThreadParams?: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  lastStartTurnParams?: {
    backend?: "codex" | "grok";
    threadId: string;
    input: AppServerTurnInputItem[];
    executionMode?: "default" | "full-access";
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  lastSteerTurnParams?: {
    threadId: string;
    input: AppServerTurnInputItem[];
    expectedTurnId: string;
  };
  lastStartReviewParams?: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: "inline" | "detached";
  };
  lastCompactThreadParams?: {
    threadId: string;
  };
  lastArchiveThreadParams?: {
    threadId: string;
  };
  lastRestoreThreadParams?: {
    threadId: string;
  };
  lastRenameThreadParams?: {
    threadId: string;
    name: string;
  };
  lastUpdateThreadMetadataParams?: {
    threadId: string;
    gitInfo?: {
      branch?: string | null;
      originUrl?: string | null;
      sha?: string | null;
    } | null;
  };
  lastSetThreadPermissionsParams?: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  listThreadsCallCount = 0;
  listModelsCallCount = 0;
  steerTurnCallCount = 0;
  lastListModelsDiagnostics?: {
    callerReason?: string;
    ownerId?: string;
  };
  lastListThreadsDiagnostics?: {
    callerReason?: string;
    ownerId?: string;
  };
  lastListThreadsParams?: {
    filter?: string;
  };

  constructor(
    private readonly options: {
      initializeResult?: {
        serverInfo?: {
          name?: string;
          version?: string;
        };
        methods?: string[];
      };
      initializeError?: Error;
      threads?: AppServerThreadSummary[];
      replay?: AppServerThreadReplay;
      skills?: Array<{ cwd?: string; skills: AppServerSkillSummary[] }>;
      models?: Array<{
        id: string;
        label?: string;
        current?: boolean;
        supportsReasoning?: boolean;
        supportsFast?: boolean;
      }>;
      modelListErrors?: Error[];
      account?: BackendAccountSummary;
      rateLimits?: BackendRateLimitSummary[];
      steerTurnError?: Error;
      setThreadPermissionsError?: Error;
    }
  ) {}

  async close(): Promise<void> {
    return;
  }

  async getInitializeResult() {
    if (this.options.initializeError) {
      throw this.options.initializeError;
    }

    return this.options.initializeResult ?? {};
  }

  async listThreads(params?: {
    archived?: boolean;
    filter?: string;
  }, diagnostics?: { callerReason?: string; ownerId?: string }): Promise<AppServerThreadSummary[]> {
    this.listThreadsCallCount += 1;
    this.lastListThreadsDiagnostics = diagnostics;
    this.lastListThreadsParams = params;
    return this.options.threads ?? [];
  }

  async archiveThread(params: { threadId: string }): Promise<{ threadId: string }> {
    this.lastArchiveThreadParams = params;
    return { threadId: params.threadId };
  }

  async restoreThread(params: { threadId: string }): Promise<{ threadId: string }> {
    this.lastRestoreThreadParams = params;
    return { threadId: params.threadId };
  }

  async renameThread(params: { threadId: string; name: string }): Promise<{ threadId: string }> {
    this.lastRenameThreadParams = params;
    return { threadId: params.threadId };
  }

  async updateThreadMetadata(params: {
    threadId: string;
    gitInfo?: {
      branch?: string | null;
      originUrl?: string | null;
      sha?: string | null;
    } | null;
  }): Promise<{ threadId: string }> {
    this.lastUpdateThreadMetadataParams = params;
    return { threadId: params.threadId };
  }

  async listSkills(): Promise<Array<{ cwd?: string; skills: AppServerSkillSummary[] }>> {
    return this.options.skills ?? [];
  }

  async listModels(diagnostics?: { callerReason?: string; ownerId?: string }) {
    this.listModelsCallCount += 1;
    this.lastListModelsDiagnostics = diagnostics;
    const error = this.options.modelListErrors?.shift();
    if (error) {
      throw error;
    }
    return this.options.models ?? [];
  }

  async readAccount(): Promise<BackendAccountSummary> {
    return this.options.account ?? {};
  }

  async readRateLimits(): Promise<BackendRateLimitSummary[]> {
    return this.options.rateLimits ?? [];
  }

  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onRequest(
    listener: (request: AppServerPendingRequestNotification) => Promise<unknown> | unknown
  ): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  async readThread(_params?: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerThreadReplay> {
    this.lastReadThreadParams = _params;
    return this.options.replay ?? {
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    };
  }

  async startThread(params?: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }> {
    this.lastStartThreadParams = params;
    return { threadId: "thread-1" };
  }

  async startTurn(params: {
    backend?: "codex" | "grok";
    threadId: string;
    input: AppServerTurnInputItem[];
    executionMode?: "default" | "full-access";
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: unknown;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; turnId: string }> {
    this.lastStartTurnParams = params;
    return { threadId: params.threadId, turnId: "turn-1" };
  }

  async startReview(params: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: "inline" | "detached";
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> {
    this.lastStartReviewParams = params;
    return {
      threadId: params.threadId,
      reviewThreadId: params.threadId,
      turnId: "turn-review-1",
    };
  }

  async setThreadPermissions(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
  }): Promise<{ threadId: string }> {
    this.lastSetThreadPermissionsParams = params;
    if (this.options.setThreadPermissionsError) {
      throw this.options.setThreadPermissionsError;
    }

    return { threadId: params.threadId };
  }

  async interruptTurn(): Promise<{ threadId: string; turnId: string }> {
    return { threadId: "thread-1", turnId: "turn-1" };
  }

  async steerTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    expectedTurnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    this.steerTurnCallCount += 1;
    this.lastSteerTurnParams = params;
    if (this.options.steerTurnError) {
      throw this.options.steerTurnError;
    }

    return { threadId: params.threadId, turnId: params.expectedTurnId };
  }

  async compactThread(params: {
    threadId: string;
  }): Promise<{ threadId: string; turnId: string; itemId: string }> {
    this.lastCompactThreadParams = params;
    return {
      threadId: params.threadId,
      turnId: "compact-turn-1",
      itemId: "compact-item-1",
    };
  }

  async emit(notification: AppServerNotification): Promise<void> {
    for (const listener of this.listeners) {
      await listener(notification);
    }
  }

  async emitRequest(request: AppServerPendingRequestNotification): Promise<unknown> {
    const listener = this.requestListeners.values().next().value;
    if (!listener) {
      throw new Error("No request listener registered");
    }
    return await listener(request);
  }
}

describe("DesktopBackendRegistry", () => {
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
          resetAt: new Date("2026-04-29T14:00:00-04:00").getTime(),
          windowSeconds: 18_000,
          windowMinutes: 300,
        },
        {
          name: "Weekly limit",
          usedPercent: 9,
          remaining: 91,
          resetAt: new Date("2026-05-01T14:00:00-04:00").getTime(),
          windowSeconds: 604_800,
          windowMinutes: 10_080,
        },
      ],
    });
    const codexFullAccessClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(codexClient.listModelsCallCount).toBe(1);
    expect(codexFullAccessClient.listModelsCallCount).toBe(0);

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
            mode: "full-access",
            label: "Full Access",
            available: true,
          },
        ],
        launchpadOptions: {
          models: [
            {
              id: "gpt-5.5",
              label: "GPT-5.5",
              current: true,
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
              id: "gpt-5.3-codex",
              label: "GPT-5.3-Codex",
              supportsReasoning: true,
            },
            {
              id: "gpt-5.2",
              label: "GPT-5.2",
              supportsReasoning: true,
            },
          ],
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          supportsFastMode: true,
        },
      },
      {
        kind: "grok",
        label: "Grok",
        available: false,
        methods: [],
        capabilities: {
          listThreads: false,
          createThread: false,
          resumeThread: false,
          renameThread: false,
          readThread: false,
          startTurn: false,
          interruptTurn: false,
          steerTurn: false,
          transcriptPagination: false,
          toolUse: false,
          approvalRequests: true,
          multiDirectoryThreads: false,
        },
        executionModes: [
          {
            mode: "default",
            label: "Default Access",
            available: false,
            isDefault: true,
            unavailableReason: "grok app server unavailable: XAI_API_KEY is not set",
          },
        ],
        unavailableReason: "grok app server unavailable: XAI_API_KEY is not set",
      },
    ]);

    await registry.close();
  });

  it("reads Codex models once from the default client and reuses them", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          supportsReasoning: true,
        },
      ],
    });
    const codexFullAccessClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      models: [
        {
          id: "gpt-full-access-only",
          label: "Full Access Only",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    const firstResponse = await registry.listBackends({ includeUnavailable: true });
    const secondResponse = await registry.listBackends({ includeUnavailable: true });
    await registry.startThread({ backend: "codex" });

    expect(codexClient.listModelsCallCount).toBe(1);
    expect(codexFullAccessClient.listModelsCallCount).toBe(0);
    expect(codexClient.lastListModelsDiagnostics).toMatchObject({
      callerReason: "backend-summary",
    });
    expect(codexClient.lastListModelsDiagnostics?.ownerId).toMatch(
      /^backend-model-catalog-/,
    );
    expect(firstResponse.backends[0]?.launchpadOptions?.models).toMatchObject([
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
      },
    ]);
    expect(secondResponse.backends[0]?.launchpadOptions?.models).toMatchObject([
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
      },
    ]);
    expect(codexClient.lastStartThreadParams?.model).toBe("gpt-5.4");

    await registry.close();
  });

  it("reads Grok models once from the default client and reuses them", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const grokClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Grok App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      models: [
        {
          id: "grok-custom-reasoning",
          label: "Grok Custom Reasoning",
          supportsReasoning: true,
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: {
          serverInfo: { name: "Codex App Server", version: "1.0.0" },
          methods: ["thread/start", "turn/start"],
        },
      }),
      grokClient,
      overlayStore: createOverlayStoreMock({
        launchpadDefaults: {
          backend: "grok",
          executionMode: "default",
          workMode: "local",
        },
      }),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    const firstResponse = await registry.listBackends({ includeUnavailable: true });
    const secondResponse = await registry.listBackends({ includeUnavailable: true });
    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      preferredBackend: "grok",
    });
    await registry.startThread({ backend: "grok" });

    expect(grokClient.listModelsCallCount).toBe(1);
    expect(grokClient.lastListModelsDiagnostics).toMatchObject({
      callerReason: "backend-summary",
    });
    expect(grokClient.lastListModelsDiagnostics?.ownerId).toMatch(
      /^backend-model-catalog-/,
    );
    expect(firstResponse.backends[1]?.launchpadOptions?.models).toMatchObject([
      {
        id: "grok-custom-reasoning",
        label: "Grok Custom Reasoning",
      },
    ]);
    expect(secondResponse.backends[1]?.launchpadOptions?.models).toMatchObject([
      {
        id: "grok-custom-reasoning",
        label: "Grok Custom Reasoning",
      },
    ]);
    expect(grokClient.lastStartThreadParams?.model).toBe("grok-custom-reasoning");

    await registry.close();
  });

  it("does not warm model lists during registry construction", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const codexFullAccessClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const grokClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Grok App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });

    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient,
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    expect(codexClient.listModelsCallCount).toBe(0);
    expect(codexFullAccessClient.listModelsCallCount).toBe(0);
    expect(grokClient.listModelsCallCount).toBe(0);

    await registry.startThread({ backend: "grok" });

    expect(codexClient.listModelsCallCount).toBe(0);
    expect(codexFullAccessClient.listModelsCallCount).toBe(0);
    expect(grokClient.listModelsCallCount).toBe(1);
    expect(grokClient.lastListModelsDiagnostics).toMatchObject({
      callerReason: "thread-start-defaults",
    });

    await registry.close();
  });

  it("coalesces repeated Grok thread list requests in the startup refresh window", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Grok App Server", version: "1.0.0" },
        methods: ["thread/list"],
      },
      threads: [
        {
          id: "thread-grok",
          title: "Grok thread",
          titleSource: "explicit",
          source: "grok",
          linkedDirectories: [],
        },
      ],
    });
    const codexClient = new MockBackendClient({});
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({}),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.listThreads({
      callerReason: "navigation-snapshot",
    });
    await registry.listThreads({
      backend: "grok",
      callerReason: "branch-drift",
    });

    expect(codexClient.listThreadsCallCount).toBe(1);
    expect(grokClient.listThreadsCallCount).toBe(1);
    expect(grokClient.lastListThreadsDiagnostics).toMatchObject({
      callerReason: "navigation-snapshot",
    });
    expect(grokClient.lastListThreadsDiagnostics?.ownerId).toMatch(
      /^backend-thread-list-cache-/,
    );

    await registry.close();
  });

  it("invalidates cached backend thread lists after starting a thread", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Grok App Server", version: "1.0.0" },
        methods: ["thread/list", "thread/start"],
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      codexFullAccessClient: new MockBackendClient({}),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.listThreads({ backend: "grok" });
    await registry.startThread({ backend: "grok" });
    await registry.listThreads({ backend: "grok" });

    expect(grokClient.listThreadsCallCount).toBe(2);

    await registry.close();
  });

  it("retries Codex model discovery after a transient model-list failure", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
      modelListErrors: [new Error("Codex is still starting")],
      models: [
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          supportsReasoning: true,
        },
      ],
    });
    const codexFullAccessClient = new MockBackendClient({
      initializeResult: {
        serverInfo: { name: "Codex App Server", version: "1.0.0" },
        methods: ["thread/start", "turn/start"],
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    const response = await registry.listBackends({ includeUnavailable: true });
    await registry.startThread({ backend: "codex" });

    expect(codexClient.listModelsCallCount).toBe(2);
    expect(codexFullAccessClient.listModelsCallCount).toBe(0);
    expect(response.backends[0]?.launchpadOptions?.models?.[0]).toMatchObject({
      id: "gpt-5.5",
      label: "GPT-5.5",
    });
    expect(codexClient.lastStartThreadParams?.model).toBe("gpt-5.4");

    await registry.close();
  });

  it("assumes Codex can create threads when initialize omits methods", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: {
          serverInfo: { name: "Codex App Server", version: "0.120.0" },
        },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: {
          serverInfo: { name: "Codex App Server", version: "0.120.0" },
        },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends[0]).toMatchObject({
      kind: "codex",
      available: true,
      methods: [],
      capabilities: {
        createThread: true,
        renameThread: true,
        startTurn: true,
      },
    });

    await registry.close();
  });

  it("remembers launchpad work mode for future directory drafts", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });
    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { workMode: "worktree" },
      stickySettingsChanged: true,
    });
    const next = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-b",
      directoryKind: "directory",
      directoryLabel: "Repo B",
      directoryPath: "/repo-b",
    });

    expect(updated.defaults.workMode).toBe("worktree");
    expect(next.launchpad.workMode).toBe("worktree");

    await registry.close();
  });

  it("refreshes empty saved directory drafts from current launchpad work mode defaults", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });
    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-b",
      patch: { workMode: "worktree" },
      stickySettingsChanged: true,
    });

    const reopened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });

    expect(reopened.defaults.workMode).toBe("worktree");
    expect(reopened.launchpad.workMode).toBe("worktree");
    expect(reopened.launchpad.branchName).toBe("main");

    await registry.close();
  });

  it("keeps workspace launchpads in workspace mode even when directory drafts prefer worktrees", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { workMode: "worktree" },
      stickySettingsChanged: true,
    });

    const workspace = await registry.ensureDirectoryLaunchpad({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: "/Users/test/.pwragent/projects",
    });

    expect(workspace.defaults.workMode).toBe("worktree");
    expect(workspace.launchpad.directoryKind).toBe("workspace");
    expect(workspace.launchpad.directoryLabel).toBe("Workspaces");
    expect(workspace.launchpad.workMode).toBe("local");
    expect(workspace.launchpad.branchName).toBeUndefined();

    await registry.close();
  });

  it("persists directory launchpad identity when opening it", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const opened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    expect(opened.launchpad.prompt).toBe("");
    await expect(
      overlayStore.getDirectoryLaunchpad({ directoryKey: "directory:/repo-a" }),
    ).resolves.toMatchObject({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      prompt: "",
    });

    await registry.close();
  });

  it("keeps launchpad directory metadata when the first draft update arrives", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });

    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { prompt: "Fix the app" },
    });

    expect(updated.launchpad.directoryLabel).toBe("Repo A");
    expect(updated.launchpad.directoryPath).toBe("/repo-a");
    expect(updated.launchpad.branchName).toBe("main");

    await registry.close();
  });

  it("repairs stale non-empty launchpad directory metadata when reopened", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { prompt: "Already drafted" },
    });

    const reopened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });

    expect(reopened.launchpad).toMatchObject({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      prompt: "Already drafted",
    });
    await expect(
      overlayStore.getDirectoryLaunchpad({ directoryKey: "directory:/repo-a" }),
    ).resolves.toMatchObject({
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    await registry.close();
  });

  it("does not rewrite sticky defaults when only pending prompt data is saved", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({
        launchpadDefaults: {
          backend: "codex",
          executionMode: "full-access",
          workMode: "local",
        },
      }),
    });

    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: {
        prompt: "Draft work",
        executionMode: "default",
      },
    });

    expect(updated.launchpad.executionMode).toBe("default");
    expect(updated.defaults.executionMode).toBe("full-access");

    await registry.close();
  });

  it("falls back to OpenAI launchpad state when sticky Grok defaults are unavailable", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
        models: [
          {
            id: "gpt-5.4",
            label: "GPT-5.4",
            supportsReasoning: true,
          },
        ],
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({
        launchpadDefaults: {
          backend: "grok",
          executionMode: "default",
          model: "grok-4.20-reasoning",
          reasoningEffort: "medium",
          workMode: "local",
        },
      }),
    });

    const launchpad = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    expect(launchpad.defaults).toMatchObject({
      backend: "codex",
      executionMode: "default",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });
    expect(launchpad.launchpad).toMatchObject({
      backend: "codex",
      executionMode: "default",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });

    await registry.close();
  });

  it("creates a scratch workspace for Codex thread creation when cwd is omitted", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/Users/test/.pwragent/projects/2026-04-16-a1b2c3",
    });

    const response = await registry.startThread({
      backend: "codex",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
    });
    expect(codexClient.lastStartThreadParams).toEqual({
      cwd: "/Users/test/.pwragent/projects/2026-04-16-a1b2c3",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      serviceTier: undefined,
      fastMode: undefined,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });

    await registry.close();
  });

  it("keeps an idle newly started thread visible until the backend list includes it", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/start"] },
      threads: [],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.startThread({
      backend: "codex",
      cwd: "/repo-a",
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Untitled thread",
        titleSource: "fallback",
        projectKey: "/repo-a",
        linkedDirectories: [
          {
            id: "/repo-a",
            kind: "local",
            label: "repo-a",
            path: "/repo-a",
          },
        ],
      }),
    ]);

    await registry.close();
  });

  it("materializes workspace launchpads into a scratch directory instead of the workspace root", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/Users/test/.pwragent/projects/2026-05-02-a1b2c3",
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      launchpad: {
        directoryKey: "workspace:/Users/test/.pwragent/projects",
        directoryKind: "workspace",
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "local",
        model: "gpt-5.5",
        reasoningEffort: "high",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    expect(codexClient.lastStartThreadParams?.cwd).toBe(
      "/Users/test/.pwragent/projects/2026-05-02-a1b2c3",
    );

    await registry.close();
  });

  it("records Codex owner metadata when materializing a worktree launchpad", async () => {
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: "/repo/app/.worktrees/thread-1/app",
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread,
      } as never,
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/app",
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "worktree",
        model: "gpt-5.5",
        reasoningEffort: "high",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
      worktreePath: "/repo/app/.worktrees/thread-1/app",
      threadId: "thread-1",
    });

    await registry.close();
  });

  it("keeps materialized worktree threads linked as worktrees before the backend list catches up", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/start"] },
      threads: [],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list", "thread/start"] },
        threads: [],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: "/repo/app/.worktrees/thread-1/app",
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/app",
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "worktree",
        model: "gpt-5.5",
        reasoningEffort: "high",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        projectKey: "/repo/app/.worktrees/thread-1/app",
        linkedDirectories: [
          {
            id: "/repo/app",
            kind: "worktree",
            label: "app",
            path: "/repo/app",
            worktreePath: "/repo/app/.worktrees/thread-1/app",
          },
        ],
      }),
    ]);

    await registry.close();
  });

  it("materializes Grok workspace launchpads into a scratch directory", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/Users/test/.pwragent/projects/2026-05-02-d4e5f6",
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      launchpad: {
        directoryKey: "workspace:/Users/test/.pwragent/projects",
        directoryKind: "workspace",
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
        backend: "grok",
        executionMode: "default",
        prompt: "",
        workMode: "local",
        model: "grok-4.20-reasoning",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    expect(grokClient.lastStartThreadParams?.cwd).toBe(
      "/Users/test/.pwragent/projects/2026-05-02-d4e5f6",
    );

    await registry.close();
  });

  it("applies model settings from the selected thread overlay when starting turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["turn/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-modelled": {
            backend: "codex",
            threadId: "thread-modelled",
            executionMode: "default",
            model: "gpt-5.5",
            reasoningEffort: "high",
            serviceTier: "priority",
            fastMode: true,
            extraLinkedDirectories: [],
          },
          "codex:thread-other": {
            backend: "codex",
            threadId: "thread-other",
            executionMode: "default",
            model: "gpt-5.5-pro",
            reasoningEffort: "low",
            serviceTier: "standard",
            fastMode: false,
            extraLinkedDirectories: [],
          },
        },
      }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-modelled",
      input: [{ type: "text", text: "Use this thread's model settings" }],
    });

    expect(codexClient.lastStartTurnParams).toEqual({
      threadId: "thread-modelled",
      input: [{ type: "text", text: "Use this thread's model settings" }],
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5.5",
      serviceTier: "priority",
      reasoningEffort: "high",
      fastMode: true,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-plain",
      input: [{ type: "text", text: "Do not inherit another thread's settings" }],
    });

    expect(codexClient.lastStartTurnParams).toEqual({
      threadId: "thread-plain",
      input: [{ type: "text", text: "Do not inherit another thread's settings" }],
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5.5",
      serviceTier: undefined,
      reasoningEffort: "medium",
      fastMode: undefined,
    });

    await registry.close();
  });

  it("resumes Codex turns in the current handoff worktree cwd", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["turn/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [
              {
                id: "pwragent-handoff:codex:thread-1",
                label: "app",
                path: "/repo/app",
                worktreePath: "/repo/app/.worktrees/thread-1/app",
                kind: "worktree",
              },
            ],
          },
        },
      }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "What is the CWD?" }],
    });

    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-1",
      cwd: "/repo/app/.worktrees/thread-1/app",
    });

    await registry.close();
  });

  it("applies requested full-access execution settings when starting Codex turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const codexFullAccessClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const overlayStore = createOverlayStoreMock({
      executionMode: "default",
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
      input: [{ type: "text", text: "Run npm view dive" }],
    });

    expect(codexClient.lastStartTurnParams).toBeUndefined();
    expect(codexFullAccessClient.lastStartTurnParams).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Run npm view dive" }],
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-5.5",
      serviceTier: undefined,
      reasoningEffort: "medium",
      fastMode: undefined,
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      executionMode: "full-access",
    });

    await registry.close();
  });

  it("applies generated Codex thread titles after starting turns", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Leopard tea button",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["turn/start", "thread/name/set"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-title",
        input: [{ type: "text", text: "Make button" }],
      })
    ).resolves.toEqual({
      backend: "codex",
      threadId: "thread-title",
      turnId: "turn-1",
    });

    expect(codexClient.lastRenameThreadParams).toBeUndefined();
    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      userPrompt: "Make button",
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Leopard tea button",
    });

    await registry.close();
  });

  it("steers Codex turns through the active execution mode for the thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer"] },
      steerTurnError: new Error("json-rpc error (-32600): no active turn to steer"),
    });
    const codexFullAccessClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer"] },
      steerTurnError: new Error(
        "json-rpc error (-32600): expected active turn id `turn-0` but found `turn-1`",
      ),
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "full-access" }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Start active work" }],
    });

    await expect(
      registry.steerTurn({
        backend: "codex",
        threadId: "thread-1",
        expectedTurnId: "turn-0",
        input: [{ type: "text", text: "Course correct" }],
      }),
    ).rejects.toThrow("expected active turn id `turn-0` but found `turn-1`");

    expect(codexFullAccessClient.steerTurnCallCount).toBe(1);
    expect(codexClient.steerTurnCallCount).toBe(0);

    await registry.close();
  });

  it("does not retry Codex title generation for a thread after one generated attempt", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Leopard tea button",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["turn/start", "thread/name/set"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: "Make button" }],
    });
    await waitForCondition(() => titleService.generateTitle.mock.calls.length === 1);

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: "Make button" }],
    });
    await flushAsync();
    await flushAsync();

    expect(titleService.generateTitle).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("applies generated titles when Codex exposes the prompt as an explicit title", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Jaguar tea button",
      })),
    };
    const prompt =
      "Let's make a button with an animated jaguar sipping tea. Just for grins.";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: prompt,
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["turn/start", "thread/name/set"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: prompt }],
    });
    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      userPrompt: prompt,
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Jaguar tea button",
    });

    await registry.close();
  });

  it("applies generated titles when Codex derives the current title from injected AGENTS context", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Jaguar tea button",
      })),
    };
    const prompt =
      "Let's make a button with an animated jaguar sipping tea. Just for grins.";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title:
            "# AGENTS.md instructions for /Users/huntharo/github/PwrAgent/.worktrees/launchpad-pwragent-main-moj56ty6",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["turn/start", "thread/name/set"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: prompt }],
    });
    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      userPrompt: prompt,
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Jaguar tea button",
    });

    await registry.close();
  });

  it("applies generated Grok thread titles after starting turns", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Issue 123 rename",
      })),
    };
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "Issue 123 rename",
          titleSource: "derived",
          linkedDirectories: [],
          source: "grok",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeError: new Error("codex unavailable"),
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeError: new Error("codex unavailable"),
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "grok",
      threadId: "thread-title",
      input: [{ type: "text", text: "Issue 123 rename" }],
    });
    await waitForCondition(() => grokClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "grok",
      userPrompt: "Issue 123 rename",
    });
    expect(grokClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Issue 123 rename",
    });

    await registry.close();
  });

  it("skips generated titles when the thread already has an explicit name", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Generated title",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "User title",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["turn/start", "thread/name/set"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: "Make button" }],
    });
    await flushAsync();
    await flushAsync();

    expect(titleService.generateTitle).not.toHaveBeenCalled();
    expect(codexClient.lastRenameThreadParams).toBeUndefined();

    await registry.close();
  });

  it("does not schedule generated titles for image-only turns", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Generated title",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["turn/start", "thread/name/set"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok unavailable"),
      }),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "image", url: "file:///tmp/image.png" }],
    });
    await flushAsync();

    expect(titleService.generateTitle).not.toHaveBeenCalled();

    await registry.close();
  });

  it("routes review start to the selected backend client", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["review/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeError: new Error("codex unavailable"),
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeError: new Error("codex unavailable"),
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    const response = await registry.startReview({
      backend: "grok",
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    expect(response).toEqual({
      backend: "grok",
      threadId: "thread-1",
      reviewThreadId: "thread-1",
      turnId: "turn-review-1",
    });
    expect(grokClient.lastStartReviewParams).toEqual({
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    await registry.close();
  });

  it("normalizes backend notifications with backend identity", async () => {
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await grokClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [{ type: "text", text: "Done." }],
        },
      },
    });

    expect(events).toEqual([
      {
        backend: "grok",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done." }],
            },
          },
        },
      },
    ]);

    unsubscribe();
    await registry.close();
  });

  it("emits server request resolution when a pending request is submitted externally", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["turn/start"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    const request: AppServerPendingRequestNotification = {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "call-1",
        requestId: "approval-1",
        command: "npm view dive",
      },
    } as AppServerPendingRequestNotification;
    const responsePromise = codexClient.emitRequest(request);
    await waitForCondition(() => events.length === 1);

    await registry.submitServerRequest({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "approval-1",
      response: { decision: "accept" },
    });

    await expect(responsePromise).resolves.toEqual({ decision: "accept" });
    expect(events.map((event) => event.notification.method)).toEqual([
      "item/commandExecution/requestApproval",
      "serverRequest/resolved",
    ]);
    expect(events.at(-1)).toMatchObject({
      backend: "codex",
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          requestId: "approval-1",
        },
      },
    });

    unsubscribe();
    await registry.close();
  });

  it("forwards pagination parameters when reading a thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/read"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
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

  it("forwards normalized read-thread status metadata", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/read"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.readThread({
        backend: "codex",
        threadId: "thread-1",
      })
    ).resolves.toMatchObject({
      threadStatus: "idle",
      replay: {
        threadStatus: "idle",
      },
    });

    await registry.close();
  });

  it("updates execution mode through the current Codex thread owner", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "thread/resume"] },
    });
    const codexFullAccessClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "thread/resume"] },
      setThreadPermissionsError: new Error("thread not found on full-access client"),
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
    });

    const response = await registry.setThreadExecutionMode({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
    });
    expect(codexClient.lastSetThreadPermissionsParams).toEqual({
      threadId: "thread-1",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(codexFullAccessClient.lastSetThreadPermissionsParams).toBeUndefined();

    await registry.close();
  });

  it("starts compaction through the current Codex thread owner", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "thread/resume", "thread/compact/start"] },
    });
    const codexFullAccessClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read", "thread/resume", "thread/compact/start"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
    });

    const response = await registry.compactThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      turnId: "compact-turn-1",
      itemId: "compact-item-1",
    });
    expect(codexClient.lastCompactThreadParams).toEqual({
      threadId: "thread-1",
    });
    expect(codexFullAccessClient.lastCompactThreadParams).toBeUndefined();

    await registry.close();
  });

  it("lists Codex threads only through the default client and reapplies overlay execution mode", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-1",
          title: "Thread one",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 2,
        },
        {
          id: "thread-2",
          title: "Thread two",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 1,
        },
      ],
    });
    const codexFullAccessClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-3",
          title: "Should not appear",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
          updatedAt: 3,
        },
      ],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient,
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock({ executionMode: "full-access" }),
    });

    const threads = await registry.listThreads({ backend: "codex", filter: "thread" });

    expect(threads).toEqual([
      expect.objectContaining({
        id: "thread-1",
        executionMode: "full-access",
      }),
      expect.objectContaining({
        id: "thread-2",
        executionMode: "default",
      }),
    ]);
    expect(codexClient.listThreadsCallCount).toBe(1);
    expect(codexClient.lastListThreadsParams).toEqual({ filter: "thread" });
    expect(codexFullAccessClient.listThreadsCallCount).toBe(0);

    await registry.close();
  });

  it("snapshots and removes linked worktrees when archiving a thread", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "worktree",
          worktreePath: "/repo/.worktrees/archive-me",
        },
      ],
      source: "codex",
      gitBranch: "codex/archive-me",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const archiveWorktree = vi.fn(async () => ({
      id: "snapshot-1",
      backend: "codex" as const,
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      sourceBranch: "codex/archive-me",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived" as const,
      ignoredFilesExcluded: true,
    }));
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: [],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(codexClient.lastArchiveThreadParams).toEqual({ threadId: "thread-1" });
    expect(archiveWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: expect.any(Number),
      cleanup: [
        {
          worktreePath: "/repo/.worktrees/archive-me",
          branch: "codex/archive-me",
          removedWorktree: true,
          deletedBranch: false,
        },
      ],
    });

    await registry.close();
  });

  it("hands off a local thread to a worktree and records the new workspace overlay", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Move me",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/handoff",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock();
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "local-to-worktree" as const,
      workMode: "worktree" as const,
      branch: "feature/handoff",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app/.worktrees/app-feature-handoff",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const updateThreadCwd = vi.fn(async () => ({ updated: true }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [thread],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
      gitDirectoryService: {
        recordCodexWorktreeOwnerThread,
      } as never,
      codexSessionMetadataService: {
        updateThreadCwd,
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    const response = await registry.handoffThreadWorkspace({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      leaveLocalBranch: "main",
    });

    expect(handoff).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      leaveLocalBranch: "main",
      repositoryPath: "/repo/app",
      sourcePath: "/repo/app",
      sourceBranch: undefined,
    });
    expect(response.workMode).toBe("worktree");
    expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
      worktreePath: "/repo/app/.worktrees/app-feature-handoff",
      threadId: "thread-1",
    });
    expect(updateThreadCwd).toHaveBeenCalledWith({
      cwd: "/repo/app/.worktrees/app-feature-handoff",
      threadId: "thread-1",
    });
    expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
      threadId: "thread-1",
      gitInfo: {
        branch: "feature/handoff",
      },
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "feature/handoff",
      observedGitBranch: "feature/handoff",
      extraLinkedDirectories: [
        expect.objectContaining({
          id: "pwragent-handoff:codex:thread-1",
          kind: "worktree",
        }),
      ],
    });

    await registry.close();
  });

  it("records detached handoff results as HEAD immediately", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Detached handoff",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "pwragent-handoff:codex:thread-1",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/app/.worktrees/app-main-detached",
          kind: "worktree",
        },
      ],
      source: "codex",
      gitBranch: "main",
      observedGitBranch: "HEAD",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock();
    const handoff = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      direction: "worktree-to-local" as const,
      strategy: "detached-changes" as const,
      workMode: "local" as const,
      baseSha: "abc123",
      repositoryPath: "/repo/app",
      targetPath: "/repo/app",
      linkedDirectory: {
        id: "pwragent-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        kind: "local" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
    const updateThreadCwd = vi.fn(async () => ({ updated: true }));
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [thread],
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
      codexSessionMetadataService: {
        updateThreadCwd,
      } as never,
      gitWorkspaceHandoffService: {
        handoff,
      } as never,
    });

    await registry.handoffThreadWorkspace({
      backend: "codex",
      threadId: "thread-1",
      direction: "worktree-to-local",
    });

    expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
      threadId: "thread-1",
      gitInfo: {
        branch: "HEAD",
      },
    });
    expect(updateThreadCwd).toHaveBeenCalledWith({
      cwd: "/repo/app",
      threadId: "thread-1",
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "HEAD",
      observedGitBranch: "HEAD",
      extraLinkedDirectories: [
        expect.objectContaining({
          id: "pwragent-handoff:codex:thread-1",
          kind: "local",
        }),
      ],
    });

    await registry.close();
  });

  it("uses an observed handoff branch as expected when legacy overlay state has no gitBranch", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Moved thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "fix/context-rail-slide-reflow",
      observedGitBranch: "feat/thread-workspace-handoff-plan",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "full-access",
          observedGitBranch: "feat/thread-workspace-handoff-plan",
          extraLinkedDirectories: [
            {
              id: "pwragent-handoff:codex:thread-1",
              kind: "worktree",
              label: "app",
              path: "/repo/app",
              worktreePath: "/repo/app/.worktrees/app-feature",
            },
          ],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const response = await registry.checkThreadBranchDrift({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response).toMatchObject({
      expectedBranch: "feat/thread-workspace-handoff-plan",
      observedBranch: "feat/thread-workspace-handoff-plan",
      drifted: false,
    });

    await registry.close();
  });

  it("does not persist a retained branch drift pair when expected branch is HEAD", async () => {
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-head": {
          backend: "codex",
          threadId: "thread-head",
          gitBranch: "HEAD",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const response = await registry.retainThreadBranchDrift({
      backend: "codex",
      threadId: "thread-head",
      expectedBranch: "HEAD",
      observedBranch: "feature/foo",
    });

    // Response still echoes the request so the renderer can update its
    // dialog state, but no pair is persisted.
    expect(response.expectedBranch).toBe("HEAD");
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-head",
    });
    expect(overlay?.retainedBranchDriftPairs ?? []).toEqual([]);

    // Sanity: a non-HEAD pair still persists.
    await registry.retainThreadBranchDrift({
      backend: "codex",
      threadId: "thread-head",
      expectedBranch: "feature/old",
      observedBranch: "feature/new",
    });
    const overlayAfter = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-head",
    });
    expect(overlayAfter?.retainedBranchDriftPairs).toHaveLength(1);

    await registry.close();
  });

  it("does not flag drift when observed branch is HEAD (restored archived snapshot)", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-archived",
      title: "Restored from archive",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/work-from-archive",
      // Worktree was restored to a snapshot ref → detached HEAD.
      observedGitBranch: "HEAD",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-archived": {
          backend: "codex",
          threadId: "thread-archived",
          gitBranch: "feature/work-from-archive",
          observedGitBranch: "HEAD",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore,
    });

    const response = await registry.checkThreadBranchDrift({
      backend: "codex",
      threadId: "thread-archived",
    });

    expect(response).toMatchObject({
      observedBranch: "HEAD",
      drifted: false,
    });

    await registry.close();
  });

  it("restores threads through the selected backend client", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/unarchive"] },
    });
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["thread/unarchive"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/unarchive"] },
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.restoreThread({
        backend: "codex",
        threadId: "thread-1",
      })
    ).resolves.toEqual({
      backend: "codex",
      threadId: "thread-1",
      restoredAt: expect.any(Number),
    });

    await expect(
      registry.restoreThread({
        backend: "grok",
        threadId: "thread-2",
      })
    ).resolves.toEqual({
      backend: "grok",
      threadId: "thread-2",
      restoredAt: expect.any(Number),
    });

    expect(codexClient.lastRestoreThreadParams).toEqual({ threadId: "thread-1" });
    expect(grokClient.lastRestoreThreadParams).toEqual({ threadId: "thread-2" });

    await registry.close();
  });

  it("renames threads through the selected backend client", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/name/set"] },
    });
    const grokClient = new MockBackendClient({
      initializeResult: { methods: ["thread/name/set"] },
    });
    const registry = new DesktopBackendRegistry({
      codexClient,
      codexFullAccessClient: new MockBackendClient({
        initializeResult: { methods: ["thread/name/set"] },
      }),
      grokClient,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.renameThread({
        backend: "codex",
        threadId: "thread-1",
        name: "Renamed Codex thread",
      })
    ).resolves.toEqual({
      backend: "codex",
      threadId: "thread-1",
      renamedAt: expect.any(Number),
    });

    await expect(
      registry.renameThread({
        backend: "grok",
        threadId: "thread-2",
        name: "Renamed Grok thread",
      })
    ).resolves.toEqual({
      backend: "grok",
      threadId: "thread-2",
      renamedAt: expect.any(Number),
    });

    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-1",
      name: "Renamed Codex thread",
    });
    expect(grokClient.lastRenameThreadParams).toEqual({
      threadId: "thread-2",
      name: "Renamed Grok thread",
    });

    await registry.close();
  });
});
