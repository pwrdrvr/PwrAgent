import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerNotification,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  ThreadOverlayState,
} from "@pwragnt/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { GitDirectoryService } from "../app-server/git-directory-service";

function createOverlayStoreMock(params?: {
  executionMode?: "default" | "full-access";
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

  async listSkills(): Promise<Array<{ cwd?: string; skills: AppServerSkillSummary[] }>> {
    return this.options.skills ?? [];
  }

  async listModels() {
    this.listModelsCallCount += 1;
    return this.options.models ?? [];
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
          steerTurn: false,
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

  it("archives a thread without cleaning up linked worktrees", async () => {
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
    const cleanupThreadWorktrees = vi.fn(async () => [
      {
        worktreePath: "/repo/.worktrees/archive-me",
        branch: "codex/archive-me",
        removedWorktree: true,
        deletedBranch: true,
      },
    ]);
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
      gitDirectoryService: {
        cleanupThreadWorktrees,
        readDirectoryStatuses: async () => ({}),
      } as unknown as GitDirectoryService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(codexClient.lastArchiveThreadParams).toEqual({ threadId: "thread-1" });
    expect(cleanupThreadWorktrees).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: expect.any(Number),
      cleanup: [],
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
