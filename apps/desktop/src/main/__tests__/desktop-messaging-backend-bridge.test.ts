import { describe, expect, it, vi } from "vitest";
import { findPreferredReviewWorkspaceCwd } from "@pwragent/shared";
import type {
  AgentEvent,
  AppServerThreadSummary,
  AppServerReadThreadResponse,
  AppServerThreadReplay,
  NavigationSnapshot,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";
import {
  DesktopMessagingBackendBridge,
  type DesktopMessagingFederationBridge,
} from "../messaging/desktop-backend-bridge";

const { reconcileNavigationSnapshot } = vi.hoisted(() => ({
  reconcileNavigationSnapshot: vi.fn(async (params: {
    backend: NavigationSnapshot["backend"];
    fetchedAt: number;
    threads: AppServerThreadSummary[];
  }): Promise<NavigationSnapshot> => ({
    backend: params.backend,
    fetchedAt: params.fetchedAt,
    unchanged: false,
    threads: params.threads.map((thread) => ({
      ...thread,
      inbox: { inInbox: false },
    })),
    inboxThreadKeys: [],
    directories: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  })),
}));

vi.mock("../app-server/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({ reconcileNavigationSnapshot }),
}));

describe("DesktopMessagingBackendBridge", () => {
  it("hydrates review working state before the messenger chooses a project", async () => {
    const pwrAgentWorktree = "/worktrees/PwrAgnt";
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "PwrAgent federation dogfood PR #735",
      titleSource: "explicit",
      source: "codex",
      projectKey: pwrAgentWorktree,
      linkedDirectories: [
        {
          id: "pwragent",
          kind: "worktree",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
          worktreePath: pwrAgentWorktree,
        },
        {
          id: "pwrsnap",
          kind: "local",
          label: "PwrSnap",
          path: "/repos/PwrSnap",
        },
      ],
    };
    const gitWorkingState = {
      dirtyFiles: 0,
      dirtyAdditions: 0,
      dirtyDeletions: 0,
      untrackedFiles: 0,
      unpushedCommits: 0,
      baseBranch: "main",
      baseAheadCommitCount: 16,
    };
    const registry = {
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
      hydrateThreadGitWorkingStates: vi.fn(async () => [
        { ...thread, gitWorkingState },
      ]),
      listThreads: vi.fn(async () => [thread]),
      readDirectoryStatuses: vi.fn(async () => ({})),
      rememberCompleteNavigationSnapshot: vi.fn(),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    const snapshot = await bridge.getNavigationSnapshot({ backend: "codex" });

    expect(registry.hydrateThreadGitWorkingStates).toHaveBeenCalledWith(
      [thread],
      { probeMissing: true },
    );
    expect(findPreferredReviewWorkspaceCwd(snapshot.threads[0])).toBe(
      pwrAgentWorktree,
    );
  });

  it("preserves enriched messaging provenance when starting a turn", async () => {
    const submitTurn = vi.fn(async (request) => ({
      status: "started" as const,
      entry: {
        ...request,
        id: "queue-entry-1",
        createdAt: 1_000,
      },
      turnId: "turn-1",
    }));
    const bridge = new DesktopMessagingBackendBridge({
      submitTurn,
    } as unknown as DesktopBackendRegistry);
    const messageOrigin = {
      kind: "messaging" as const,
      messaging: {
        platform: "slack" as const,
        surface: {
          id: "thread-1",
          kind: "thread" as const,
          title: "api-search circuit breaker timeout",
          parentTitle: "signals-chat",
          ancestorTitle: "PwrAgent",
        },
        actor: {
          platformUserId: "U012345",
          displayName: "Hunter",
          username: "huntharo",
        },
      },
    };

    await bridge.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Go for it." }],
      messageOrigin,
    });

    expect(submitTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Go for it." }],
      messageOrigin,
      origin: "messaging",
    });
  });

  it("reads active turns from the registry", async () => {
    const bridge = createBridge({
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });

    await expect(
      bridge.readActiveTurn({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-live",
    });
  });

  it("prefers newer transcript assistant entries over stale replay messages", async () => {
    const bridge = createBridge({
      entries: [
        {
          type: "message",
          id: "newer-entry",
          role: "assistant",
          text: "Actually latest bot reply.",
          createdAt: 3_000,
        },
      ],
      messages: [
        {
          id: "stale-message",
          role: "assistant",
          text: "Stale nested response item.",
          createdAt: 1_000,
        },
      ],
      lastAssistantMessage: "Stale nested response item.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });

    await expect(
      bridge.readThreadLastAssistantReply({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      text: "Actually latest bot reply.",
      createdAt: 3_000,
    });
  });

  it("prefers the latest replay message over older transcript entries", async () => {
    const bridge = createBridge({
      entries: [
        {
          type: "message",
          id: "older-entry",
          role: "assistant",
          text: "Older transcript entry.",
          createdAt: 1_000,
        },
      ],
      messages: [
        {
          id: "older-message",
          role: "assistant",
          text: "Older transcript entry.",
        },
        {
          id: "newer-nested-message",
          role: "assistant",
          text: "Newer nested response item.",
          createdAt: 2_000,
        },
      ],
      lastAssistantMessage: "Newer nested response item.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });

    await expect(
      bridge.readThreadLastAssistantReply({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      text: "Newer nested response item.",
      createdAt: 2_000,
    });
  });

  it("uses matching transcript entry timestamps when replay messages lack one", async () => {
    const bridge = createBridge({
      entries: [
        {
          type: "message",
          id: "entry-final",
          role: "assistant",
          text: "Final turn-shaped answer.",
          createdAt: 3_000,
        },
      ],
      messages: [
        {
          id: "message-final",
          role: "assistant",
          text: "Final turn-shaped answer.",
        },
      ],
      lastAssistantMessage: "Final turn-shaped answer.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });

    await expect(
      bridge.readThreadLastAssistantReply({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      text: "Final turn-shaped answer.",
      createdAt: 3_000,
    });
  });

  it("resolves and shares final assistant images across messaging controllers", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1,
      threadId: "thread-1",
      replay: {
        entries: [],
        messages: [
          {
            id: "assistant-final",
            role: "assistant",
            text: "Final screenshot.",
            parts: [
              { type: "text", text: "Final screenshot." },
              {
                type: "image",
                url: "https://example.com/final.png",
                alt: "Final screenshot",
              },
            ],
          },
        ],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const readThread = vi.fn(async () => response);
    const bridge = new DesktopMessagingBackendBridge({
      getThreadTranscriptImageRoots: vi.fn(async () => []),
      readThread,
    } as unknown as DesktopBackendRegistry);
    const request = {
      backend: "codex" as const,
      text: "Final screenshot.",
      threadId: "thread-1",
      turnId: "turn-1",
    };

    await expect(Promise.all([
      bridge.resolveAssistantMessageImages(request),
      bridge.resolveAssistantMessageImages(request),
    ])).resolves.toEqual([
      [
        {
          type: "image",
          url: "https://example.com/final.png",
          alt: "Final screenshot",
          source: "assistant",
        },
      ],
      [
        {
          type: "image",
          url: "https://example.com/final.png",
          alt: "Final screenshot",
          source: "assistant",
        },
      ],
    ]);
    expect(readThread).toHaveBeenCalledTimes(1);
  });

  it("resolves the exact image-only assistant replay message by item id", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1,
      threadId: "thread-1",
      replay: {
        entries: [],
        messages: [
          {
            id: "other-empty-assistant",
            role: "assistant",
            text: "",
            parts: [{ type: "image", url: "https://example.com/other.png" }],
          },
          {
            id: "target-empty-assistant",
            role: "assistant",
            text: "",
            parts: [{ type: "image", url: "https://example.com/target.png" }],
          },
        ],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const bridge = new DesktopMessagingBackendBridge({
      getThreadTranscriptImageRoots: vi.fn(async () => []),
      readThread: vi.fn(async () => response),
    } as unknown as DesktopBackendRegistry);

    await expect(bridge.resolveAssistantMessageImages({
      backend: "codex",
      itemId: "other-empty-assistant",
      text: "",
      threadId: "thread-1",
      turnId: "turn-1",
    })).resolves.toEqual([
      expect.objectContaining({
        type: "image",
        url: "https://example.com/other.png",
      }),
    ]);
  });

  it("does not reuse an older image-only message for an unrelated empty turn", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1,
      threadId: "thread-1",
      replay: {
        entries: [
          {
            id: "older-image-only",
            role: "assistant",
            text: "",
            type: "message",
            turn: { id: "turn-older" },
            parts: [{ type: "image", url: "https://example.com/older.png" }],
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const bridge = new DesktopMessagingBackendBridge({
      getThreadTranscriptImageRoots: vi.fn(async () => []),
      readThread: vi.fn(async () => response),
    } as unknown as DesktopBackendRegistry);

    await expect(bridge.resolveAssistantMessageImages({
      backend: "codex",
      text: "",
      threadId: "thread-1",
      turnId: "turn-current",
    })).resolves.toEqual([]);
  });

  it("resolves an image-only assistant replay entry by turn id", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1,
      threadId: "thread-1",
      replay: {
        entries: [
          {
            id: "current-image-only",
            role: "assistant",
            text: "",
            type: "message",
            turn: { id: "turn-current" },
            parts: [{ type: "image", url: "https://example.com/current.png" }],
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const bridge = new DesktopMessagingBackendBridge({
      getThreadTranscriptImageRoots: vi.fn(async () => []),
      readThread: vi.fn(async () => response),
    } as unknown as DesktopBackendRegistry);

    await expect(bridge.resolveAssistantMessageImages({
      backend: "codex",
      text: "",
      threadId: "thread-1",
      turnId: "turn-current",
    })).resolves.toEqual([
      expect.objectContaining({
        type: "image",
        url: "https://example.com/current.png",
      }),
    ]);
  });

  it("routes targeted messaging turns and navigation to the remote backend", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-remote",
      queueStatus: "started" as const,
    }));
    const remoteNavigation: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 2_000,
      unchanged: false,
      threads: [],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const remoteNavigationSnapshot = vi.fn(async () => remoteNavigation);
    const listBackends = vi.fn(async () => ({
      fetchedAt: 2_000,
      backends: [
        {
          kind: "codex" as const,
          label: "Remote Codex",
          available: true,
          methods: [],
          capabilities: {},
          executionModes: [],
        },
      ],
    }));
    const federation = {
      connectedPeerTargets: () => [],
      onRemoteBackendEvent: () => () => undefined,
      remoteBackend: () => ({
        listBackends,
        startTurn,
      } as unknown as FederationBackendOperations),
      remoteNavigationSnapshot,
    } satisfies DesktopMessagingFederationBridge;
    const registry = {
      submitTurn: vi.fn(() => {
        throw new Error("local turn should not run");
      }),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry, federation);
    const target = { scope: "remote" as const, instanceId: "client_one" };

    await expect(
      bridge.startTurn({
        backend: "codex",
        federationTarget: target,
        threadId: "thread-1",
        input: [{ type: "text", text: "ship it" }],
      }),
    ).resolves.toMatchObject({ turnId: "turn-remote" });
    await expect(
      bridge.getNavigationSnapshot({
        backend: "all",
        federationTarget: target,
      }),
    ).resolves.toBe(remoteNavigation);
    await expect(
      bridge.listBackends({
        includeUnavailable: true,
        federationTarget: target,
      }),
    ).resolves.toMatchObject({
      backends: [{ label: "Remote Codex" }],
    });

    expect(startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "ship it" }],
    });
    expect(remoteNavigationSnapshot).toHaveBeenCalledWith(target, {
      backend: "all",
      federationTarget: target,
    });
    expect(listBackends).toHaveBeenCalledWith({
      includeUnavailable: true,
    });
  });

  it("subscribes messaging controllers to local and remote backend events", async () => {
    let localListener: ((event: AgentEvent) => void | Promise<void>) | undefined;
    let remoteListener: ((event: AgentEvent) => void | Promise<void>) | undefined;
    const unsubscribeLocal = vi.fn();
    const unsubscribeRemote = vi.fn();
    const registry = {
      onEvent: vi.fn(
        (listener: (event: AgentEvent) => void | Promise<void>) => {
          localListener = listener;
          return unsubscribeLocal;
        },
      ),
    } as unknown as DesktopBackendRegistry;
    const federation = {
      connectedPeerTargets: () => [],
      onRemoteBackendEvent: (
        listener: (event: AgentEvent) => void | Promise<void>,
      ) => {
        remoteListener = listener;
        return unsubscribeRemote;
      },
      remoteBackend: vi.fn(),
      remoteNavigationSnapshot: vi.fn(),
    } as unknown as DesktopMessagingFederationBridge;
    const bridge = new DesktopMessagingBackendBridge(registry, federation);
    const listener = vi.fn();

    const unsubscribe = bridge.onEvent(listener);
    await remoteListener?.({
      backend: "codex",
      federationTarget: { scope: "remote", instanceId: "client_one" },
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    await localListener?.({
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
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(unsubscribeLocal).toHaveBeenCalledOnce();
    expect(unsubscribeRemote).toHaveBeenCalledOnce();
  });
});

function createBridge(replay: AppServerThreadReplay): DesktopMessagingBackendBridge {
  const response: AppServerReadThreadResponse = {
    backend: "codex",
    fetchedAt: 1,
    threadId: "thread-1",
    replay,
  };
  const registry = {
    getActiveTurnForThread: vi.fn(async () => ({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-live",
    })),
    readThread: vi.fn(async () => response),
  } as unknown as DesktopBackendRegistry;
  return new DesktopMessagingBackendBridge(registry);
}
