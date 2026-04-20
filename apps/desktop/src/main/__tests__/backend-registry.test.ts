import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AppServerNotification,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadSummary,
  AppServerTurnInputItem,
} from "@pwragnt/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";

function createOverlayStoreMock(params?: { executionMode?: "default" | "full-access" }) {
  const overlay = params?.executionMode
    ? {
        backend: "codex" as const,
        threadId: "thread-1",
        executionMode: params.executionMode,
        extraLinkedDirectories: [],
      }
    : undefined;

  return {
    getThreadOverlayState: async () => overlay,
    getThreadOverlayStates: async ({ threadIds }: { threadIds: string[] }) =>
      Object.fromEntries(threadIds.map((threadId) => [threadId, threadId === "thread-1" ? overlay : undefined])),
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
  };
  lastSetThreadPermissionsParams?: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
  };
  listThreadsCallCount = 0;
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

  async listThreads(params?: { filter?: string }): Promise<AppServerThreadSummary[]> {
    this.listThreadsCallCount += 1;
    this.lastListThreadsParams = params;
    return this.options.threads ?? [];
  }

  async listSkills(): Promise<Array<{ cwd?: string; skills: AppServerSkillSummary[] }>> {
    return this.options.skills ?? [];
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
  }): Promise<{ threadId: string }> {
    this.lastStartThreadParams = params;
    return { threadId: "thread-1" };
  }

  async startTurn(): Promise<{ threadId: string; runId: string }> {
    return { threadId: "thread-1", runId: "turn-1" };
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

  async interruptTurn(): Promise<{ threadId: string; runId: string }> {
    return { threadId: "thread-1", runId: "turn-1" };
  }

  async emit(notification: AppServerNotification): Promise<void> {
    for (const listener of this.listeners) {
      await listener(notification);
    }
  }
}

describe("DesktopBackendRegistry", () => {
  it("reports backend availability and capabilities", async () => {
    const registry = new DesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: {
          serverInfo: { name: "Codex App Server", version: "1.0.0" },
          methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
        },
      }),
      codexFullAccessClient: new MockBackendClient({
        initializeResult: {
          serverInfo: { name: "Codex App Server", version: "1.0.0" },
          methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
        },
      }),
      grokClient: new MockBackendClient({
        initializeError: new Error("grok app server unavailable: XAI_API_KEY is not set"),
      }),
      overlayStore: createOverlayStoreMock(),
    });

    const response = await registry.listBackends({ includeUnavailable: true });

    expect(response.backends).toEqual([
      {
        kind: "codex",
        label: "Codex app server",
        available: true,
        serverName: "Codex App Server",
        serverVersion: "1.0.0",
        methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
        capabilities: {
          listThreads: true,
          createThread: true,
          resumeThread: false,
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
      },
      {
        kind: "grok",
        label: "Grok app server",
        available: false,
        methods: [],
        capabilities: {
          listThreads: false,
          createThread: false,
          resumeThread: false,
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
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
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
        runId: "turn-1",
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
            runId: "turn-1",
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
});
