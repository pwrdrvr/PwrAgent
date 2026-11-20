import {
  createAgentOverlay,
  createOverlayStoreMock,
  MockBackendClient,
  createMessagingArchiveCleanupStoreMock,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MAX_THREAD_READ_EVALUATION_PRICING_SUMMARIES } from "@pwragent/shared/contracts/thread-tools";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadSearchService } from "../thread-search/thread-search-service";

describe("DesktopBackendRegistry", () => {
  it("handles thread inspection dynamic tool calls from active turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-1",
          title: "Inbox triage",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: "directory:/repo/app",
              kind: "local",
              label: "App",
              path: "/repo/app",
            },
          ],
          updatedAt: 2000,
        },
        {
          id: "thread-2",
          title: "Ordinary work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 1000,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingStore: createMessagingArchiveCleanupStoreMock({
        bindings: [
          {
            id: "binding-telegram-jambalayah",
            backend: "codex",
            channel: "telegram",
            conversationKind: "topic",
            conversationTitle: "Jambalayah",
            parentTitle: "PwrAgent Mini Dev Group",
            targetKind: "agent_thread",
            threadId: "thread-1",
            updatedAt: 2_500,
          },
        ],
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [],
            agent: {
              name: "Inbox Agent",
              instructionLineCount: 1,
              instructionsTooLong: false,
              updatedAt: 1500,
            },
          },
        },
      }),
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
        tool: "search_threads",
        arguments: {
          agentOnly: true,
          query: "inbox",
          limit: 5,
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
    expect(payload).toMatchObject({
      threads: [
        {
          backend: "codex",
          threadId: "thread-1",
          title: "Inbox triage",
          agent: {
            name: "Inbox Agent",
          },
          messagingBindings: [
            {
              bindingId: "binding-telegram-jambalayah",
              platform: "telegram",
              conversationKind: "topic",
              conversationTitle: "Jambalayah",
              parentTitle: "PwrAgent Mini Dev Group",
              activeAt: 2_500,
            },
          ],
        },
      ],
      totalCount: 1,
      limit: 5,
      truncated: false,
    });
    expect(codexClient.lastListThreadsDiagnostics).toMatchObject({
      callerReason: "agent-thread-inspection",
    });

    await registry.close();
  });

  it("routes thread inspection search through the thread search service when available", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [],
    });
    const search = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 2_000,
      query: "branch drift",
      filters: {
        backend: "all" as const,
        includeArchived: true,
        projectKeys: ["PwrAgent"],
        directoryPaths: ["/repo/pwragent"],
        models: ["gpt-5.5"],
        dateRange: { from: 1_000, to: 3_000 },
      },
      contentMode: "required" as const,
      semanticMode: "required" as const,
      searchedScopes: ["metadata", "projection"] as const,
      unavailableScopes: [
        {
          scope: "semantic" as const,
          reason: "disabled" as const,
          message: "Semantic thread search is disabled.",
        },
      ],
      results: [
        {
          backend: "codex" as const,
          threadId: "thread-1",
          identityKey: "codex:thread-1",
          title: "Branch drift dialog screenshots",
          summary: "Discussed screenshot capture.",
          projectKey: "PwrAgent",
          updatedAt: 2_000,
          linkedDirectories: [
            {
              id: "directory:/repo/pwragent",
              kind: "local" as const,
              label: "PwrAgent",
              path: "/repo/pwragent",
            },
          ],
          source: "codex" as const,
          model: "gpt-5.5",
          score: 42,
          confidence: "medium" as const,
          matchReasons: [{ kind: "provider_content_match" as const }],
          snippets: [
            {
              scope: "provider_content" as const,
              field: "message:user",
              text: "We need branch drift dialog screenshots.",
            },
          ],
        },
      ],
      truncated: false,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingStore: createMessagingArchiveCleanupStoreMock({
        bindings: [
          {
            id: "binding-discord-branch-drift",
            backend: "codex",
            channel: "discord",
            conversationKind: "thread",
            conversationTitle: "branch drift screenshots",
            parentTitle: "dev",
            threadId: "thread-1",
            updatedAt: 4_000,
          },
        ],
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
        },
      }),
      threadSearchService: { search } as unknown as ThreadSearchService,
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
        tool: "search_threads",
        arguments: {
          query: "branch drift",
          includeArchived: true,
          projectKeys: ["PwrAgent"],
          directoryPaths: ["/repo/pwragent"],
          models: ["gpt-5.5"],
          updatedAfter: 1_000,
          updatedBefore: 3_000,
          contentMode: "required",
          semanticMode: "required",
          limit: 5,
        },
      },
    } as AppServerPendingRequestNotification);

    expect(search).toHaveBeenCalledWith({
      query: "branch drift",
      filters: {
        backend: "all",
        includeArchived: true,
        projectKeys: ["PwrAgent"],
        directoryPaths: ["/repo/pwragent"],
        models: ["gpt-5.5"],
        dateRange: { from: 1_000, to: 3_000 },
      },
      limit: 5,
      contentMode: "required",
      semanticMode: "required",
    });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      query: "branch drift",
      searchedScopes: ["metadata", "projection"],
      unavailableScopes: [
        {
          scope: "semantic",
          reason: "disabled",
        },
      ],
      contentMode: "required",
      semanticMode: "required",
      threads: [
        {
          backend: "codex",
          threadId: "thread-1",
          title: "Branch drift dialog screenshots",
          confidence: "medium",
          messagingBindings: [
            {
              bindingId: "binding-discord-branch-drift",
              platform: "discord",
              conversationKind: "thread",
              conversationTitle: "branch drift screenshots",
              parentTitle: "dev",
              activeAt: 4_000,
            },
          ],
          snippets: [
            {
              scope: "provider_content",
              field: "message:user",
            },
          ],
        },
      ],
      totalCount: 1,
      limit: 5,
      truncated: false,
    });

    await registry.close();
  });

  it("lists recent lightweight thread candidates for Agent thread search", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-1",
          title: "Investigate desktop E2E failures",
          titleSource: "explicit",
          source: "codex",
          summary: `${"Failure details ".repeat(40)}end`,
          linkedDirectories: [
            {
              id: "directory:/repo/pwragent",
              kind: "local",
              label: "PwrAgent",
              path: "/repo/pwragent",
            },
          ],
          model: "gpt-5.5",
          reasoningEffort: "high",
          updatedAt: 2000,
        },
        {
          id: "thread-2",
          title: "Ordinary work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 1000,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
        },
      }),
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
        tool: "search_threads",
        arguments: {},
      },
    } as AppServerPendingRequestNotification);

    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      threads: [
        {
          backend: "codex",
          threadId: "thread-1",
          title: "Investigate desktop E2E failures",
          linkedDirectories: [
            {
              label: "PwrAgent",
              path: "/repo/pwragent",
            },
          ],
        },
        {
          backend: "codex",
          threadId: "thread-2",
          title: "Ordinary work",
        },
      ],
      totalCount: 2,
      limit: 100,
      truncated: false,
    });
    expect(payload.threads[0].summary.length).toBeLessThanOrEqual(240);
    expect(payload.threads[0]).not.toHaveProperty("model");
    expect(payload.threads[0]).not.toHaveProperty("reasoningEffort");

    await registry.close();
  });

  it("includes overlay-attached directories in Agent thread search results", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-1",
          title: "Sit tight",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: "directory:/repo/pwragent",
              kind: "local",
              label: "PwrAgent",
              path: "/repo/pwragent",
            },
          ],
          updatedAt: 2000,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [
              {
                id: "directory:/repo/agent-kit",
                kind: "local",
                label: "agent-kit",
                path: "/repo/agent-kit",
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
        tool: "search_threads",
        arguments: {},
      },
    } as AppServerPendingRequestNotification);

    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.threads[0].linkedDirectories).toEqual([
      expect.objectContaining({
        label: "agent-kit",
        path: "/repo/agent-kit",
      }),
      expect.objectContaining({
        label: "PwrAgent",
        path: "/repo/pwragent",
      }),
    ]);
    expect(payload.threads[0].linkedRepositories).toEqual([
      expect.objectContaining({
        labels: ["agent-kit"],
        repositoryPath: "/repo/agent-kit",
      }),
      expect.objectContaining({
        labels: ["PwrAgent"],
        repositoryPath: "/repo/pwragent",
      }),
    ]);

    await registry.close();
  });

  it("matches thread search alternatives without an exact phrase", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-1",
          title: "Investigate desktop E2E failures",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 1000,
        },
        {
          id: "thread-2",
          title: "Telegram thread naming issue",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
        },
      }),
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
        tool: "search_threads",
        arguments: {
          query: "telegram naming OR playwright e2e OR desktop failures",
          limit: 5,
        },
      },
    } as AppServerPendingRequestNotification);

    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.threads.map((thread: { threadId: string }) => thread.threadId)).toEqual([
      "thread-2",
      "thread-1",
    ]);

    await registry.close();
  });

  it("reads active Agent thread status instead of only archived threads", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read"] },
      threads: [
        {
          id: "active-thread",
          title: "Jeeves",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
      archivedThreads: [
        {
          id: "archived-thread",
          title: "Archived Jeeves",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          archivedAt: 1000,
        },
      ],
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
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingStore: createMessagingArchiveCleanupStoreMock({
        bindings: [
          {
            id: "binding-telegram-active",
            backend: "codex",
            channel: "telegram",
            conversationKind: "topic",
            conversationTitle: "Jeeves",
            parentTitle: "PwrAgent Mini Dev Group",
            targetKind: "agent_thread",
            threadId: "active-thread",
            updatedAt: 3_000,
          },
        ],
      }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
        },
      }),
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
        tool: "get_thread_status",
        arguments: {
          backend: "codex",
          threadId: "active-thread",
        },
      },
    } as AppServerPendingRequestNotification);

    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      thread: {
        backend: "codex",
        threadId: "active-thread",
        title: "Jeeves",
        status: "idle",
        messagingBindings: [
          {
            bindingId: "binding-telegram-active",
            platform: "telegram",
            conversationKind: "topic",
            conversationTitle: "Jeeves",
            parentTitle: "PwrAgent Mini Dev Group",
            activeAt: 3_000,
          },
        ],
      },
    });
    expect(
      codexClient.listThreadsCalls
        .map((call) => call.params?.archived)
    ).toEqual([false]);

    await registry.close();
  });

  it("defaults get_thread_status to the invoking thread and returns attached directories", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read"] },
      threads: [
        {
          id: "agent-thread",
          title: "Sit tight",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: "directory:/repo/pwragent",
              kind: "local",
              label: "PwrAgent",
              path: "/repo/pwragent",
            },
          ],
          updatedAt: 2000,
        },
      ],
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
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": {
            ...createAgentOverlay(),
            extraLinkedDirectories: [
              {
                id: "directory:/repo/agent-kit",
                kind: "local",
                label: "agent-kit",
                path: "/repo/agent-kit",
              },
            ],
          },
        },
      }),
    });
    const inspectPrAutomation = vi.fn(async () => ({
      backgroundPollingEnabled: true,
      autoFixAllowed: true,
      autoFixEnabled: true,
      autoFixActive: true,
      guidance: "End the turn and let PwrAgent watch CI.",
    }));
    registry.setThreadPrAutoDispatchHandler({
      preferenceChanged: vi.fn(async () => undefined),
      cancelPending: vi.fn(async () => false),
      sendPendingNow: vi.fn(async () => false),
      inspect: inspectPrAutomation,
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
        tool: "get_thread_status",
        arguments: {},
      },
    } as AppServerPendingRequestNotification);

    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.thread).toMatchObject({
      backend: "codex",
      threadId: "agent-thread",
      title: "Sit tight",
      status: "idle",
      prAutomation: {
        backgroundPollingEnabled: true,
        autoFixAllowed: true,
        autoFixEnabled: true,
        autoFixActive: true,
      },
    });
    expect(payload.thread.linkedDirectories).toEqual([
      expect.objectContaining({
        label: "agent-kit",
        path: "/repo/agent-kit",
      }),
      expect.objectContaining({
        label: "PwrAgent",
        path: "/repo/pwragent",
      }),
    ]);
    expect(payload.thread.linkedRepositories).toEqual([
      expect.objectContaining({
        labels: ["agent-kit"],
        repositoryPath: "/repo/agent-kit",
      }),
      expect.objectContaining({
        labels: ["PwrAgent"],
        repositoryPath: "/repo/pwragent",
      }),
    ]);
    expect(inspectPrAutomation).toHaveBeenCalledWith(
      {
        backend: "codex",
        threadId: "agent-thread",
      },
      {
        backend: "codex",
        threadId: "agent-thread",
      },
    );

    await registry.close();
  });

  it("resolves enriched remote status when the local backend is unavailable", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read"] },
      listThreadsError: new Error("local codex backend unavailable"),
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: { "codex:agent-thread": createAgentOverlay() },
      }),
    });
    const federatedInspection = vi.fn(async () => ({
      instanceId: "pwr_remote",
      instanceLabel: "Remote Mac",
      thread: {
        id: "remote-thread",
        title: "Remote collector",
        titleSource: "explicit" as const,
        source: "codex" as const,
        linkedDirectories: [],
      },
      summary: {
        id: "remote-thread",
        title: "Remote collector",
        titleSource: "explicit" as const,
        source: "codex" as const,
        linkedDirectories: [{
          id: "remote-directory",
          label: "PwrSuiteLab",
          path: "/remote/PwrSuiteLab",
          kind: "worktree" as const,
        }],
        inbox: { inInbox: false },
        agent: {
          name: "Collector",
          instructionLineCount: 1,
          instructionsTooLong: false,
          updatedAt: 1_000,
        },
        handoffOrigin: {
          sourceBackend: "codex" as const,
          sourceThreadId: "coordinator-thread",
          sourceTitle: "Coordinator",
          seedMode: "clean" as const,
          groupingMode: "none" as const,
          createdAt: 900,
          workspace: {
            mode: "none" as const,
            git: {
              kind: "none" as const,
              worktreeCreationAvailable: false as const,
              unavailableReason: "No workspace requested.",
            },
          },
        },
        prs: [{
          provider: "github.com",
          org: "pwrdrvr",
          repo: "PwrAgent",
          number: 1317,
          state: "passing" as const,
          url: "https://github.com/pwrdrvr/PwrAgent/pull/1317",
        }],
        messagingBindings: [{
          bindingId: "binding-1",
          platform: "telegram" as const,
          conversationKind: "topic" as const,
          conversationTitle: "Federation",
        }],
      },
      read: {
        backend: "codex" as const,
        fetchedAt: 2_000,
        threadId: "remote-thread",
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
          threadStatus: "idle" as const,
        },
        threadStatus: "idle" as const,
      },
    }));
    registry.setFederatedThreadInspectionHandler(federatedInspection);
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
        callId: "call-remote-status",
        requestId: "call-remote-status",
        namespace: "pwragent",
        tool: "get_thread_status",
        arguments: {
          backend: "codex",
          threadId: "remote-thread",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.thread).toMatchObject({
      backend: "codex",
      threadId: "remote-thread",
      instanceId: "pwr_remote",
      instanceLabel: "Remote Mac",
      title: "Remote collector",
      status: "idle",
      threadLink: expect.stringContaining("instanceId=pwr_remote"),
      agent: { name: "Collector" },
      handoffOrigin: {
        sourceThreadId: "coordinator-thread",
      },
      linkedDirectories: [{ id: "remote-directory" }],
      pullRequests: [{ number: 1317 }],
      messagingBindings: [{
        bindingId: "binding-1",
        platform: "telegram",
      }],
    });
    expect(federatedInspection).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "remote-thread",
      limit: 0,
      includeTurns: false,
    });

    await registry.close();
  });

  it("respects includeRemote false for thread status resolution", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: { "codex:agent-thread": createAgentOverlay() },
      }),
    });
    const federatedInspection = vi.fn();
    registry.setFederatedThreadInspectionHandler(federatedInspection);
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
        callId: "call-local-status",
        requestId: "call-local-status",
        namespace: "pwragent",
        tool: "get_thread_status",
        arguments: {
          backend: "codex",
          threadId: "remote-thread",
          includeRemote: false,
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: false });
    expect(federatedInspection).not.toHaveBeenCalled();

    await registry.close();
  });

  it("reads a remote transcript after local resolution fails", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
      readThreadError: new Error("thread not loaded"),
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: { "codex:agent-thread": createAgentOverlay() },
      }),
    });
    const federatedInspection = vi.fn(async () => ({
      instanceId: "pwr_remote",
      instanceLabel: "Remote Mac",
      thread: {
        id: "remote-thread",
        title: "Remote collector",
        titleSource: "explicit" as const,
        source: "codex" as const,
        linkedDirectories: [],
      },
      read: {
        backend: "codex" as const,
        fetchedAt: 2_000,
        threadId: "remote-thread",
        tokenMiserEnabled: true,
        tokenMiserOverride: true,
        pricing: {
          compactions: [{
            backend: "codex" as const,
            threadId: "remote-thread",
            compactionId: "compaction-1",
            observedAt: 1_900,
            updatedAt: 1_900,
          }],
          lines: [{
            backend: "codex",
            cachedInputCostMicros: 1_000,
            cachedInputTokens: 1_000,
            createdAt: 2_000,
            currency: "USD",
            inputTokens: 1_500,
            outputCostMicros: 2_000,
            outputTokens: 200,
            priceStatus: "priced" as const,
            provider: "openai",
            reasoningOutputTokens: 50,
            scope: "turn" as const,
            source: "live" as const,
            status: "finalized" as const,
            threadId: "remote-thread",
            totalCostMicros: 42_000,
            totalTokens: 1_700,
            turnId: "turn-remote",
            turnUsageAttributed: true,
            uncachedInputCostMicros: 39_000,
            uncachedInputTokens: 500,
            usageLineId: "usage-remote",
          }],
          summaries: Array.from(
            {
              length:
                MAX_THREAD_READ_EVALUATION_PRICING_SUMMARIES + 1,
            },
            (_, index) => ({
              backend: "codex" as const,
              cachedInputTokens: 1_000,
              currency: "USD",
              inputTokens: 1_500,
              outputTokens: 200,
              pricedUsageLineCount: 1,
              provider: `openai-${index}`,
              reasoningOutputTokens: 50,
              threadId: "remote-thread",
              totalCostMicros: 42_000 + index,
              totalTokens: 1_700,
              uncachedInputTokens: 500,
              unpricedUsageLineCount: 0,
              updatedAt: 2_000,
              usageLineCount: 1,
            }),
          ),
        },
        toolAccounting: {
          alerts: [],
          invocations: [],
          summaries: [],
          tokenMiser: {
            savings: {
              currency: "USD" as const,
              pricedGateCount: 1,
              gateCount: 1,
              withoutGateCostMicros: 8_000,
              gateCostMicros: 1_000,
              revealedCostMicros: 500,
              savingsMicros: 6_500,
              directlyObservedReplayCount: 1,
              reconstructedReplayCount: 0,
            },
            interceptionCount: 1,
            originalCharacters: 8_000,
            baselineParentTokens: 2_000,
            replacementTokens: 200,
            retrievedTokens: 0,
            estimatedParentTokensSaved: 1_800,
            interceptions: [{
              objectId: "object-1",
              turnId: "turn-remote",
              toolUseId: "tool-use-1",
              toolName: "exec_command",
              createdAt: 1_950,
              originalCharacters: 8_000,
              baselineParentTokens: 2_000,
              replacementTokens: 200,
              retrievedTokens: 0,
              estimatedParentTokensSaved: 1_800,
            }],
            codeMode: {
              callCount: 1,
              commandCellCount: 1,
              directCommandCellCount: 0,
              dispatchClusterCount: 1,
              multiInvocationClusterCount: 0,
              largestDispatchCluster: 1,
              nestedCommandInvocationCount: 1,
              patchCellCount: 0,
              otherCellCount: 0,
              pollingCellCount: 0,
              directCount: 0,
              summarizedCount: 1,
              passThroughCount: 0,
              retrievalCount: 0,
              capturedNestedInvocationCount: 1,
              observations: [{
                observationId: "observation-1",
                turnId: "turn-remote",
                callId: "call-1",
                cellId: "cell-1",
                createdAt: 1_950,
                outputCharacters: 8_000,
                maxOutputTokens: 2_000,
                scriptStatus: "completed",
                retrieval: false,
                capturedNestedInvocationCount: 1,
                disposition: "summarized" as const,
              }],
            },
          },
        },
        replay: {
          entries: [],
          messages: [
            {
              id: "remote-result",
              role: "assistant" as const,
              text: "Sanitized result",
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
          threadStatus: "idle" as const,
        },
        threadStatus: "idle" as const,
      },
    }));
    registry.setFederatedThreadInspectionHandler(federatedInspection);
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
        callId: "call-remote-read",
        requestId: "call-remote-read",
        namespace: "pwragent",
        tool: "read_thread",
        arguments: {
          backend: "codex",
          threadId: "remote-thread",
          includeEvaluation: true,
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.read).toMatchObject({
      backend: "codex",
      threadId: "remote-thread",
      instanceId: "pwr_remote",
      instanceLabel: "Remote Mac",
      title: "Remote collector",
      threadUrl:
        "pwragent://thread/remote-thread?backend=codex&instanceId=pwr_remote",
      threadLink: expect.stringContaining("pwragent://thread/remote-thread"),
      status: "idle",
      messages: [{
        text: "Sanitized result",
        messageUrl: expect.stringContaining("messageId=remote-result"),
        messageLink: expect.stringContaining("messageId=remote-result"),
      }],
      evaluation: {
        tokenMiserEnabled: true,
        tokenMiserOverride: true,
        pricing: {
          compactionCount: 1,
          summaryCount:
            MAX_THREAD_READ_EVALUATION_PRICING_SUMMARIES + 1,
          usageLineCount: 1,
          truncated: true,
        },
        tokenMiser: {
          interceptionCount: 1,
          interceptionDetailCount: 1,
          estimatedParentTokensSaved: 1_800,
          savings: {
            savingsMicros: 6_500,
          },
          codeMode: {
            callCount: 1,
            observationCount: 1,
            summarizedCount: 1,
          },
        },
      },
    });
    expect(payload.read.evaluation.pricing.summaries).toHaveLength(
      MAX_THREAD_READ_EVALUATION_PRICING_SUMMARIES,
    );
    expect(payload.read.evaluation.pricing.summaries[0]).toMatchObject({
      totalCostMicros: 42_000,
    });
    expect(payload.read.evaluation.pricing).not.toHaveProperty("lines");
    expect(payload.read.evaluation.pricing).not.toHaveProperty("compactions");
    expect(payload.read.evaluation.tokenMiser).not.toHaveProperty(
      "interceptions",
    );
    expect(payload.read.evaluation.tokenMiser.codeMode).not.toHaveProperty(
      "observations",
    );
    expect(federatedInspection).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "remote-thread",
      limit: 10,
      includeTurns: true,
    });

    await registry.close();
  });

  it("reads bounded transcript content from another thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
      replay: {
        entries: [
          {
            type: "message",
            id: "entry-user-1",
            role: "user",
            text: "Please inspect this thread.",
            createdAt: 1000,
          },
          {
            type: "activity",
            id: "entry-command-1",
            summary: "Ran command",
            status: "completed",
            details: [
              {
                id: "detail-1",
                kind: "command",
                label: "pnpm test",
                status: "completed",
                command: {
                  displayCommand: "pnpm test",
                  output: `${"line ".repeat(1000)}done`,
                  exitCode: 0,
                },
              },
            ],
          },
        ],
        messages: [
          {
            id: "message-user-1",
            role: "user",
            text: "Please inspect this thread.",
            createdAt: 1000,
          },
        ],
        lastUserMessage: "Please inspect this thread.",
        pagination: {
          supportsPagination: true,
          hasPreviousPage: true,
          previousCursor: "cursor-1",
        },
        threadStatus: "idle",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    const internals = registry as unknown as {
      resolveTokenMiserDefaultEnabledFn: () => boolean;
      resolveTokenMiserEnabledFn: () => boolean;
    };
    internals.resolveTokenMiserEnabledFn = () => true;
    internals.resolveTokenMiserDefaultEnabledFn = () => true;
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
        tool: "read_thread",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          limit: 5,
          maxCharsPerEntry: 200,
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      read: {
        backend: "codex",
        threadId: "target-thread",
        tokenMiserEnabled: true,
        limit: 5,
        maxCharsPerEntry: 200,
        threadUrl: "pwragent://thread/target-thread?backend=codex",
        threadLink:
          "[target-thread](pwragent://thread/target-thread?backend=codex)",
        status: "idle",
        pagination: {
          supportsPagination: true,
          hasPreviousPage: true,
          previousCursor: "cursor-1",
        },
        entries: [
          {
            type: "message",
            id: "entry-user-1",
            role: "user",
            text: "Please inspect this thread.",
            messageUrl: expect.stringContaining("messageId=entry-user-1"),
            messageLink: expect.stringContaining("messageId=entry-user-1"),
          },
          {
            type: "activity",
            id: "entry-command-1",
            details: [
              {
                kind: "command",
                command: {
                  displayCommand: "pnpm test",
                  output: expect.stringContaining("..."),
                },
                truncated: true,
              },
            ],
          },
        ],
        messages: [
          {
            id: "message-user-1",
            role: "user",
            text: "Please inspect this thread.",
            messageUrl: expect.stringContaining("messageId=message-user-1"),
            messageLink: expect.stringContaining("messageId=message-user-1"),
          },
        ],
      },
    });
    expect(codexClient.lastReadThreadParams).toEqual({
      threadId: "target-thread",
      includeTurns: true,
      limit: 5,
    });
    expect(payload.read).not.toHaveProperty("evaluation");

    await registry.close();
  });

  it("keeps the newest entries when an owner's turn page exceeds the read limit", async () => {
    // Owners page whole turns, so limit 1 returns every entry of the newest
    // turn. The reply is the entry a reader needs, not the prompt.
    const turn = { id: "turn-2", status: "completed" as const };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
      replay: {
        entries: [
          { type: "message", id: "user-2", role: "user", text: "Run it", turn },
          { type: "activity", id: "command-2", summary: "Ran command", status: "completed", details: [], turn },
          { type: "message", id: "answer-2", role: "assistant", text: "Done", turn },
        ],
        messages: [
          { id: "user-2", role: "user", text: "Run it" },
          { id: "answer-2", role: "assistant", text: "Done" },
        ],
        lastUserMessage: "Run it",
        lastAssistantMessage: "Done",
        pagination: { supportsPagination: true, hasPreviousPage: true, previousCursor: "cursor-2" },
        threadStatus: "idle",
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "agent-thread", turnId: "turn-1", turn: { id: "turn-1" } },
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
        tool: "read_thread",
        arguments: { backend: "codex", threadId: "target-thread", limit: 1 },
      },
    } as AppServerPendingRequestNotification);

    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.read.entries.map((entry: { id: string }) => entry.id)).toEqual(["answer-2"]);
    expect(payload.read.messages.map((message: { id: string }) => message.id)).toEqual(["answer-2"]);
    expect(payload.read).toMatchObject({
      omittedEntries: 2,
      omittedMessages: 1,
      pagination: { previousCursor: "cursor-2" },
    });

    await registry.close();
  });

  it("combines local search_threads results with connected Federation metadata", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [{
        id: "local-thread",
        title: "Local collector",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
        projectKey: "PwrSuiteLab",
        updatedAt: 1_000,
      }, {
        id: "local-thread-2",
        title: "Local collector follow-up",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
        projectKey: "PwrSuiteLab",
        updatedAt: 900,
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: { "codex:agent-thread": createAgentOverlay() },
      }),
    });
    const federationHandler = vi.fn(async () => ({
      ok: true as const,
      data: {
        query: "collector",
        totalCount: 3,
        truncated: true,
        results: [{
          instanceId: "pwr_remote",
          instanceLabel: "Remote Mac",
          isLocal: false,
          backend: "codex" as const,
          threadId: "remote-thread",
          title: "Remote collector",
          updatedAt: 2_000,
          projectKey: "PwrSuiteLab",
          score: 10_000,
          threadLink: "[Remote collector](pwragent://thread/remote-thread)",
        }, {
          instanceId: "pwr_remote",
          instanceLabel: "Remote Mac",
          isLocal: false,
          backend: "codex" as const,
          threadId: "remote-thread-2",
          title: "Remote collector follow-up",
          updatedAt: 1_500,
          projectKey: "PwrSuiteLab",
          score: 9_000,
          threadLink: "[Remote collector follow-up](pwragent://thread/remote-thread-2)",
        }],
        searchedInstances: [{
          instanceId: "pwr_remote",
          instanceLabel: "Remote Mac",
          resultCount: 1,
        }],
        failures: [],
      },
    }));
    registry.setPwrAgentFederationHandler(federationHandler);
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
        callId: "call-search",
        requestId: "call-search",
        namespace: "pwragent",
        tool: "search_threads",
        arguments: {
          query: "collector",
          backend: "codex",
          includeArchived: true,
          projectKeys: ["PwrSuiteLab"],
          updatedAfter: 500,
          updatedBefore: 3_000,
          limit: 2,
        },
      },
    } as AppServerPendingRequestNotification);
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );

    expect(payload.threads).toEqual([
      expect.objectContaining({
        threadId: "remote-thread",
        instanceId: "pwr_remote",
        instanceLabel: "Remote Mac",
        linkedDirectories: [],
      }),
      expect.objectContaining({ threadId: "local-thread" }),
    ]);
    expect(payload).toMatchObject({
      totalCount: 5,
      limit: 2,
      truncated: true,
    });
    expect(federationHandler).toHaveBeenCalledWith(expect.objectContaining({
      operation: "search_federation_threads",
      args: {
        scope: "remote",
        query: "collector",
        backend: "codex",
        includeArchived: true,
        projectKeys: ["PwrSuiteLab"],
        updatedAfter: 500,
        updatedBefore: 3_000,
        limit: 2,
      },
    }));

    await registry.close();
  });
});
