import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerNotification,
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
} from "@pwragnt/shared";
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
    }) => ({
      backend,
      threadId,
      executionMode,
      extraLinkedDirectories: [],
    }),
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
  } as unknown as InstanceType<typeof import("@pwragnt/agent-core").OverlayStore>;
}

class MockBackendClient {
  private readonly listeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
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
    model?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  lastStartReviewParams?: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: "inline" | "detached";
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
  }): Promise<AppServerThreadSummary[]> {
    this.listThreadsCallCount += 1;
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

  async listModels() {
    this.listModelsCallCount += 1;
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
    model?: string;
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

  async emit(notification: AppServerNotification): Promise<void> {
    for (const listener of this.listeners) {
      await listener(notification);
    }
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
      createScratchProjectDirectory: async () => "/tmp/pwragnt-scratch",
    });

    const firstResponse = await registry.listBackends({ includeUnavailable: true });
    const secondResponse = await registry.listBackends({ includeUnavailable: true });
    await registry.startThread({ backend: "codex" });

    expect(codexClient.listModelsCallCount).toBe(1);
    expect(codexFullAccessClient.listModelsCallCount).toBe(0);
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

  it("retries Codex model discovery after a transient startup failure", async () => {
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
      createScratchProjectDirectory: async () => "/tmp/pwragnt-scratch",
    });

    await flushAsync();
    const response = await registry.listBackends({ includeUnavailable: true });
    await registry.startThread({ backend: "codex" });

    expect(codexClient.listModelsCallCount).toBe(2);
    expect(codexFullAccessClient.listModelsCallCount).toBe(0);
    expect(response.backends[0]?.launchpadOptions?.models).toMatchObject([
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
      },
    ]);
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
    });

    const workspace = await registry.ensureDirectoryLaunchpad({
      directoryKey: "workspace:/Users/test/.pwragnt/projects",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: "/Users/test/.pwragnt/projects",
    });

    expect(workspace.defaults.workMode).toBe("worktree");
    expect(workspace.launchpad.directoryKind).toBe("workspace");
    expect(workspace.launchpad.directoryLabel).toBe("Workspaces");
    expect(workspace.launchpad.workMode).toBe("local");
    expect(workspace.launchpad.branchName).toBeUndefined();

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
      createScratchProjectDirectory: async () => "/Users/test/.pwragnt/projects/2026-04-16-a1b2c3",
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
      cwd: "/Users/test/.pwragnt/projects/2026-04-16-a1b2c3",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      serviceTier: undefined,
      fastMode: undefined,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });

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
      backend: "codex",
      threadId: "thread-modelled",
      input: [{ type: "text", text: "Use this thread's model settings" }],
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
      backend: "codex",
      threadId: "thread-plain",
      input: [{ type: "text", text: "Do not inherit another thread's settings" }],
      model: "gpt-5.5",
      serviceTier: undefined,
      reasoningEffort: "medium",
      fastMode: undefined,
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
            "# AGENTS.md instructions for /Users/huntharo/github/PwrAgnt/.worktrees/launchpad-pwragnt-main-moj56ty6",
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
        id: "pwragnt-handoff:codex:thread-1",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/app-feature-handoff",
        kind: "worktree" as const,
      },
      warnings: [],
      completedAt: 1000,
    }));
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
          id: "pwragnt-handoff:codex:thread-1",
          kind: "worktree",
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
              id: "pwragnt-handoff:codex:thread-1",
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
