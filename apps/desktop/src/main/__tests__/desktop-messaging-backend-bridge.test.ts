import { describe, expect, it, vi } from "vitest";
import { findPreferredReviewWorkspaceCwd } from "@pwragent/shared";
import type {
  AgentEvent,
  AppServerThreadSummary,
  AppServerReadThreadResponse,
  AppServerThreadReplay,
  CreateScheduledThreadActionRequest,
  NavigationSnapshot,
  ThreadOverlayState,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";
import {
  DesktopMessagingBackendBridge,
  type DesktopMessagingFederationBridge,
} from "../messaging/desktop-backend-bridge";

const {
  getThreadOverlayState,
  readDirectoryGitStatusCache,
  reconcileNavigationSnapshot,
} = vi.hoisted(() => ({
  getThreadOverlayState: vi.fn(
    async (): Promise<ThreadOverlayState | undefined> => undefined,
  ),
  readDirectoryGitStatusCache: vi.fn(async () => ({})),
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
  getDesktopOverlayStore: () => ({
    getThreadOverlayState,
    readDirectoryGitStatusCache,
    reconcileNavigationSnapshot,
  }),
}));

const { hydrateLaunchpadCodexEnvironmentOptions } = vi.hoisted(() => ({
  hydrateLaunchpadCodexEnvironmentOptions: vi.fn(
    async (launchpad: { directoryPath: string }) => ({
      ...launchpad,
      codexEnvironmentOptions: [
        {
          id: "env-default",
          name: "Default",
          sourcePath: "/repos/PwrAgnt/.codex/environments.toml",
          actions: [],
        },
      ],
    }),
  ),
}));

vi.mock("../app-server/codex-environment-config", () => ({
  hydrateLaunchpadCodexEnvironmentOptions,
}));

describe("DesktopMessagingBackendBridge", () => {
  it("resolves admission state from one thread cache and overlay only", async () => {
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      fastMode: true,
      handoffOrigin: {
        sourceBackend: "codex",
        sourceThreadId: "parent-1",
        seedMode: "clean",
        groupingMode: "none",
        createdAt: 1_000,
        workspace: {
          mode: "same",
          cwd: "/repos/PwrAgnt",
          git: {
            kind: "git_local",
            worktreeCreationAvailable: true,
          },
        },
      },
      model: "gpt-5.5",
    });
    const getCachedThreadSummary = vi.fn(() => ({
      id: "thread-1",
      title: "Cached thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      executionMode: "full-access" as const,
      threadStatus: "idle" as const,
    }));
    const listThreads = vi.fn(async () => []);
    const readDirectoryStatuses = vi.fn(async () => ({}));
    const registry = {
      getActiveTurnForThread: vi.fn(() => ({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-live",
      })),
      getCachedThreadSummary,
      isThreadTurnOccupied: vi.fn(() => true),
      getQueuedExecutionModesSnapshot: vi.fn(() => ({
        "codex:thread-1": { mode: "full-access", queuedAt: 2_000 },
      })),
      getQueuedTurnsSnapshot: vi.fn(() => ({
        "codex:thread-1": [
          {
            queueEntryId: "queue-1",
            origin: "messaging",
            displayText: "queued reply",
            createdAt: 2_100,
            position: 0,
          },
        ],
      })),
      listThreads,
      readDirectoryStatuses,
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    const state = await bridge.getThreadAdmissionState({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(state).toMatchObject({
      activeTurn: { turnId: "turn-live" },
      threadStatus: "active",
      thread: {
        executionMode: "default",
        fastMode: true,
        handoffOrigin: { sourceThreadId: "parent-1" },
        model: "gpt-5.5",
        queuedExecutionMode: "full-access",
        queuedTurns: [{ queueEntryId: "queue-1" }],
        title: "Cached thread",
      },
    });
    expect(getCachedThreadSummary).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(listThreads).not.toHaveBeenCalled();
    expect(readDirectoryStatuses).not.toHaveBeenCalled();
  });

  it("preserves overlay branch metadata when the thread summary cache is cold", async () => {
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-cold",
      extraLinkedDirectories: [
        {
          id: "directory:/repos/PwrAgnt",
          kind: "local",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
        },
      ],
      gitBranch: "feature/cache-owner",
      observedGitBranch: "feature/cache-owner-observed",
    });
    const registry = {
      getActiveTurnForThread: vi.fn(() => undefined),
      getCachedThreadSummary: vi.fn(() => undefined),
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
      getQueuedTurnsSnapshot: vi.fn(() => ({})),
      isThreadTurnOccupied: vi.fn(() => false),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    await expect(bridge.getThreadAdmissionState({
      backend: "codex",
      threadId: "thread-cold",
    })).resolves.toMatchObject({
      thread: {
        gitBranch: "feature/cache-owner",
        observedGitBranch: "feature/cache-owner-observed",
        linkedDirectories: [
          expect.objectContaining({ path: "/repos/PwrAgnt" }),
        ],
      },
      threadStatus: "idle",
    });
  });

  it("serves cached directory status without awaiting a fleet refresh", async () => {
    const cachedGitStatus = {
      currentBranch: "main",
      syncState: "in-sync" as const,
    };
    reconcileNavigationSnapshot.mockResolvedValueOnce({
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [],
      inboxThreadKeys: [],
      directories: [
        {
          key: "directory:/repos/PwrAgnt",
          kind: "directory",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
    readDirectoryGitStatusCache.mockResolvedValueOnce({
      "directory:/repos/PwrAgnt": {
        directoryKey: "directory:/repos/PwrAgnt",
        directoryPath: "/repos/PwrAgnt",
        fetchedAt: Date.now(),
        gitStatus: cachedGitStatus,
      },
    });
    const readDirectoryStatuses = vi.fn(async () => ({}));
    const refreshDirectoryGitStatuses = vi.fn(async () => ({ scheduledCount: 0 }));
    const registry = {
      canonicalizeNavigationThreadPullRequests: vi.fn(
        async (threads: NavigationSnapshot["threads"]) => threads,
      ),
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
      getQueuedTurnsSnapshot: vi.fn(() => ({})),
      hydrateThreadGitWorkingStates: vi.fn(
        async (threads: NavigationSnapshot["threads"]) => threads,
      ),
      listThreads: vi.fn(async () => []),
      refreshThreadGitWorkingStates: vi.fn(async () => ({ scheduledCount: 0 })),
      readDirectoryStatuses,
      refreshDirectoryGitStatuses,
      rememberCompleteNavigationSnapshot: vi.fn(),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    const snapshot = await bridge.getNavigationSnapshot({});

    expect(snapshot.directories[0]?.gitStatus).toEqual(cachedGitStatus);
    expect(readDirectoryStatuses).not.toHaveBeenCalled();
  });

  it("returns a broad snapshot before its stale directory batch finishes", async () => {
    reconcileNavigationSnapshot.mockResolvedValueOnce({
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [],
      inboxThreadKeys: [],
      directories: [
        {
          key: "directory:/repos/PwrAgnt",
          kind: "directory",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
    readDirectoryGitStatusCache.mockResolvedValueOnce({});
    let finishRefresh: (() => void) | undefined;
    const refreshDirectoryGitStatuses = vi.fn(
      async () => await new Promise<{ scheduledCount: number }>((resolve) => {
        finishRefresh = () => resolve({ scheduledCount: 1 });
      }),
    );
    const registry = {
      canonicalizeNavigationThreadPullRequests: vi.fn(
        async (threads: NavigationSnapshot["threads"]) => threads,
      ),
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
      getQueuedTurnsSnapshot: vi.fn(() => ({})),
      hydrateThreadGitWorkingStates: vi.fn(
        async (threads: NavigationSnapshot["threads"]) => threads,
      ),
      listThreads: vi.fn(async () => []),
      refreshThreadGitWorkingStates: vi.fn(async () => ({ scheduledCount: 0 })),
      refreshDirectoryGitStatuses,
      rememberCompleteNavigationSnapshot: vi.fn(),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    await expect(bridge.getNavigationSnapshot({})).resolves.toMatchObject({
      directories: [{ key: "directory:/repos/PwrAgnt" }],
    });
    expect(refreshDirectoryGitStatuses).toHaveBeenCalledExactlyOnceWith({
      directoryKeys: ["directory:/repos/PwrAgnt"],
      force: false,
    });
    finishRefresh?.();
  });

  it("serves cached review working state and probes in the background", async () => {
    const pwrAgentWorktree = "/worktrees/PwrAgnt";
    const listedThread: AppServerThreadSummary = {
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
      ],
    };
    const reconciledThread: NavigationSnapshot["threads"][number] = {
      ...listedThread,
      linkedDirectories: [
        ...listedThread.linkedDirectories,
        {
          id: "pwrsnap",
          kind: "local",
          label: "PwrSnap",
          path: "/repos/PwrSnap",
        },
      ],
      inbox: { inInbox: false },
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
    reconcileNavigationSnapshot.mockResolvedValueOnce({
      backend: "codex",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [reconciledThread],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
    const registry = {
      canonicalizeNavigationThreadPullRequests: vi.fn(
        async (threads: NavigationSnapshot["threads"]) => threads,
      ),
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
      getQueuedTurnsSnapshot: vi.fn(() => ({})),
      hydrateThreadGitWorkingStates: vi.fn(async (
        threads: NavigationSnapshot["threads"],
      ) =>
        threads.map((thread) => ({ ...thread, gitWorkingState }))
      ),
      listThreads: vi.fn(async () => [listedThread]),
      readDirectoryStatuses: vi.fn(async () => ({})),
      // A Git fleet that never settles: the snapshot must not wait on it.
      refreshThreadGitWorkingStates: vi.fn(() => new Promise(() => {})),
      rememberCompleteNavigationSnapshot: vi.fn(),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    const snapshot = await bridge.getNavigationSnapshot({ backend: "codex" });

    expect(registry.hydrateThreadGitWorkingStates).toHaveBeenCalledWith(
      [reconciledThread],
      { probeMissing: false },
    );
    // The canonical threads, not the hydrated ones: scheduling reads the
    // cache to decide staleness, and passing threads that hydration just
    // stamped from that same cache is how a probe stops converging.
    expect(registry.refreshThreadGitWorkingStates).toHaveBeenCalledExactlyOnceWith(
      [reconciledThread],
    );
    expect(findPreferredReviewWorkspaceCwd(snapshot.threads[0])).toBe(
      pwrAgentWorktree,
    );
  });

  it("awaits the working-state fleet when the caller opts in", async () => {
    // The messenger's review picker resolves a multi-project thread's
    // workspace from working state (findPreferredReviewWorkspaceCwd) and
    // infers its base branch from it (buildReviewBranchOptions), so it cannot
    // race a background probe: on a cold cache it would pick linkedDirectories[0].
    const pwrAgentWorktree = "/worktrees/PwrAgnt";
    const listedThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "PwrAgent federation dogfood PR #735",
      titleSource: "explicit",
      source: "codex",
      projectKey: pwrAgentWorktree,
      linkedDirectories: [
        {
          id: "pwrsnap",
          kind: "local",
          label: "PwrSnap",
          path: "/repos/PwrSnap",
        },
        {
          id: "pwragent",
          kind: "worktree",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
          worktreePath: pwrAgentWorktree,
        },
      ],
    };
    const reconciledThread: NavigationSnapshot["threads"][number] = {
      ...listedThread,
      inbox: { inInbox: false },
    };
    reconcileNavigationSnapshot.mockResolvedValueOnce({
      backend: "codex",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [reconciledThread],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
    const registry = {
      canonicalizeNavigationThreadPullRequests: vi.fn(
        async (threads: NavigationSnapshot["threads"]) => threads,
      ),
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
      getQueuedTurnsSnapshot: vi.fn(() => ({})),
      // Only the awaited probe answers here; a cached read returns the
      // threads untouched, which is what a cold cache looks like.
      hydrateThreadGitWorkingStates: vi.fn(async (
        threads: NavigationSnapshot["threads"],
        options?: { probeMissing?: boolean },
      ) =>
        options?.probeMissing
          ? threads.map((thread) => ({
            ...thread,
            gitWorkingState: {
              dirtyFiles: 2,
              dirtyAdditions: 9,
              dirtyDeletions: 1,
              untrackedFiles: 0,
              unpushedCommits: 0,
              baseBranch: "main",
              baseAheadCommitCount: 16,
            },
          }))
          : threads
      ),
      listThreads: vi.fn(async () => [listedThread]),
      readDirectoryStatuses: vi.fn(async () => ({})),
      refreshThreadGitWorkingStates: vi.fn(async () => ({ scheduledCount: 0 })),
      rememberCompleteNavigationSnapshot: vi.fn(),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    const snapshot = await bridge.getNavigationSnapshot({
      backend: "codex",
      probeWorkingStates: true,
    });

    expect(registry.hydrateThreadGitWorkingStates).toHaveBeenCalledWith(
      [reconciledThread],
      { probeMissing: true },
    );
    // An opted-in caller already awaited the fleet; scheduling a second
    // round behind it would re-probe the paths it just read.
    expect(registry.refreshThreadGitWorkingStates).not.toHaveBeenCalled();
    expect(findPreferredReviewWorkspaceCwd(snapshot.threads[0])).toBe(
      pwrAgentWorktree,
    );
  });

  it("hydrates launchpad Codex environment options for served snapshots", async () => {
    // Federation remote viewers get their navigation snapshot through
    // this bridge; without hydration here their launchpad has no
    // Environment picker even though the local window's does.
    reconcileNavigationSnapshot.mockResolvedValueOnce({
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [],
      inboxThreadKeys: [],
      directories: [
        {
          key: "directory:/repos/PwrAgnt",
          kind: "directory",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryPath: "/repos/PwrAgnt",
            backend: "codex",
          },
        },
        {
          key: "directory:/repos/PwrSnap",
          kind: "directory",
          label: "PwrSnap",
          path: "/repos/PwrSnap",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    } as unknown as NavigationSnapshot);
    const registry = {
      canonicalizeNavigationThreadPullRequests: vi.fn(
        async (threads: NavigationSnapshot["threads"]) => threads,
      ),
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
      getQueuedTurnsSnapshot: vi.fn(() => ({})),
      hydrateThreadGitWorkingStates: vi.fn(
        async (threads: NavigationSnapshot["threads"]) => threads,
      ),
      listThreads: vi.fn(async () => []),
      refreshThreadGitWorkingStates: vi.fn(async () => ({ scheduledCount: 0 })),
      readDirectoryStatuses: vi.fn(async () => ({})),
      rememberCompleteNavigationSnapshot: vi.fn(),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    const snapshot = await bridge.getNavigationSnapshot({});

    expect(hydrateLaunchpadCodexEnvironmentOptions).toHaveBeenCalledTimes(1);
    expect(snapshot.directories[0]?.launchpad).toMatchObject({
      directoryPath: "/repos/PwrAgnt",
      codexEnvironmentOptions: [{ id: "env-default", name: "Default" }],
    });
    // Directories without a launchpad pass through untouched.
    expect(snapshot.directories[1]?.launchpad).toBeUndefined();
  });

  it("serves canonical PR status rather than the stale overlay copy", async () => {
    // The background poller writes fresh status into the PR status
    // registry, never back into the thread overlay. A federation viewer
    // is served through this bridge, so without canonicalization it sees
    // the status frozen at the last attachment rewrite — a PR that
    // merged hours ago still rendered open with checks running, and it
    // never converges because the poller skips terminal PRs.
    const stalePr = {
      number: 1242,
      provider: "github" as const,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "federation queue boundary review",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1242",
      state: "open" as const,
      lifecycleState: "open" as const,
      checkState: "pending" as const,
      checksStillRunning: true,
    };
    const canonicalPr = {
      ...stalePr,
      state: "merged" as const,
      lifecycleState: "merged" as const,
      checkState: "success" as const,
      checksStillRunning: false,
    };
    reconcileNavigationSnapshot.mockResolvedValueOnce({
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [
        {
          id: "thread-1",
          title: "Thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
          prs: [stalePr],
        },
        {
          id: "thread-2",
          title: "No PRs",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        },
      ],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    } as unknown as NavigationSnapshot);
    const canonicalizeNavigationThreadPullRequests = vi.fn(
      async (threads: NavigationSnapshot["threads"]) =>
        threads.map((thread) =>
          thread.prs?.length ? { ...thread, prs: [canonicalPr] } : thread
        ),
    );
    const hydrateThreadGitWorkingStates = vi.fn(
      async (threads: NavigationSnapshot["threads"]) => threads,
    );
    const registry = {
      canonicalizeNavigationThreadPullRequests,
      getQueuedExecutionModesSnapshot: vi.fn(() => ({})),
      getQueuedTurnsSnapshot: vi.fn(() => ({})),
      hydrateThreadGitWorkingStates,
      listThreads: vi.fn(async () => []),
      readDirectoryStatuses: vi.fn(async () => ({})),
      refreshThreadGitWorkingStates: vi.fn(async () => ({ scheduledCount: 0 })),
      rememberCompleteNavigationSnapshot: vi.fn(),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    const snapshot = await bridge.getNavigationSnapshot({});

    expect(canonicalizeNavigationThreadPullRequests).toHaveBeenCalledTimes(1);
    expect(snapshot.threads[0]?.prs).toEqual([canonicalPr]);
    // A thread with no attached PRs passes through untouched.
    expect(snapshot.threads[1]?.prs).toBeUndefined();
    // Canonicalization runs before git hydration, so hydration already
    // sees the canonical chips rather than the reconciled overlay ones.
    const hydratedThreads = hydrateThreadGitWorkingStates.mock.calls[0]?.[0];
    expect(hydratedThreads?.[0]?.prs).toEqual([canonicalPr]);
    expect(hydratedThreads?.[1]?.prs).toBeUndefined();
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
          username: "fixtureuser",
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

  it("resolves an explicit remote attach target with a federated thread ref", async () => {
    const remoteThread: NavigationSnapshot["threads"][number] = {
      id: "remote-thread",
      title: "Remote collector",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const remoteNavigation: NavigationSnapshot = {
      backend: "codex",
      fetchedAt: 2_000,
      unchanged: false,
      threads: [remoteThread],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const resolveThread = vi.fn(async () => ({
      thread: {
        ...remoteThread,
        inbox: undefined,
      },
    }));
    const federation = {
      connectedPeerTargets: () => [{
        target: { scope: "remote" as const, instanceId: "pwr_remote" },
        label: "Remote Mac",
        capabilities: ["thread_navigation", "messaging_route"] as const,
      }],
      health: async () => ({
        enabled: true,
        role: "dual" as const,
        status: "connected" as const,
        peers: [],
      }),
      onRemoteBackendEvent: () => () => undefined,
      remoteBackend: () => ({ resolveThread } as unknown as FederationBackendOperations),
      remoteNavigationSnapshot: vi.fn(async () => remoteNavigation),
    } satisfies DesktopMessagingFederationBridge;
    const registry = {
      listThreads: vi.fn(async () => []),
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry, federation);

    await expect(bridge.resolveThreadTarget({
      backend: "codex",
      threadId: "remote-thread",
      instanceId: "pwr_remote",
    })).resolves.toMatchObject({
      thread: { id: "remote-thread" },
      federatedThread: {
        backend: "codex",
        threadId: "remote-thread",
        target: { scope: "remote", instanceId: "pwr_remote" },
      },
    });
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
    const resolveThreadAdmissionState = vi.fn(async () => ({
      thread: {
        id: "thread-1",
        title: "Remote thread",
        titleSource: "explicit" as const,
        source: "codex" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
      threadStatus: "idle" as const,
    }));
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
    const createScheduledThreadAction = vi.fn(async (
      request: CreateScheduledThreadActionRequest,
    ) => ({
      action: {
        ...request,
        id: "scheduled-remote",
        origin: "messaging" as const,
        status: "scheduled" as const,
        createdAt: 2_000,
        updatedAt: 2_000,
      },
    }));
    const listScheduledThreadActions = vi.fn(async () => ({ actions: [] }));
    const federation = {
      connectedPeerTargets: () => [],
      health: async () => ({
        enabled: false,
        role: "dual" as const,
        status: "disabled" as const,
        peers: [],
      }),
      onRemoteBackendEvent: () => () => undefined,
      remoteBackend: () => ({
        createScheduledThreadAction,
        listBackends,
        listScheduledThreadActions,
        resolveThreadAdmissionState,
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
      bridge.getThreadAdmissionState({
        backend: "codex",
        federationTarget: target,
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      thread: {
        id: "thread-1",
        federation: {
          instanceLabel: "client_one",
          ref: {
            backend: "codex",
            threadId: "thread-1",
            target: { scope: "remote", instanceId: "client_one" },
          },
        },
      },
    });
    await expect(
      bridge.listBackends({
        includeUnavailable: true,
        federationTarget: target,
      }),
    ).resolves.toMatchObject({
      backends: [{ label: "Remote Codex" }],
    });
    await expect(
      bridge.createScheduledThreadAction({
        backend: "codex",
        federationTarget: target,
        threadId: "thread-1",
        kind: "turn",
        origin: "messaging",
        scheduledFor: 3_000,
        displayText: "Follow up",
        turn: { input: [{ type: "text", text: "Follow up" }] },
      }),
    ).resolves.toMatchObject({ action: { id: "scheduled-remote" } });
    await bridge.listScheduledThreadActions({
      backend: "codex",
      federationTarget: target,
      threadId: "thread-1",
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
    expect(resolveThreadAdmissionState).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(listBackends).toHaveBeenCalledWith({
      includeUnavailable: true,
    });
    expect(createScheduledThreadAction).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "messaging",
      scheduledFor: 3_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
    });
    expect(listScheduledThreadActions).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
  });

  it("falls back to remote navigation when an older peer lacks targeted admission", async () => {
    const methodNotFound = Object.assign(
      new Error("Unknown federation method: resolve_thread_admission_state"),
      { code: "method_not_found" },
    );
    const resolveThreadAdmissionState = vi.fn(async () => {
      throw methodNotFound;
    });
    const remoteNavigation: NavigationSnapshot = {
      backend: "codex",
      fetchedAt: 2_000,
      unchanged: false,
      threads: [
        {
          id: "thread-1",
          title: "Remote thread",
          titleSource: "explicit",
          source: "codex",
          threadStatus: "active",
          linkedDirectories: [],
          inbox: { inInbox: false },
        },
      ],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const remoteNavigationSnapshot = vi.fn(async () => remoteNavigation);
    const target = { scope: "remote" as const, instanceId: "legacy_peer" };
    const federation = {
      connectedPeerTargets: () => [
        {
          capabilities: ["messaging_route"],
          label: "Legacy Peer",
          target,
        },
      ],
      onRemoteBackendEvent: () => () => undefined,
      remoteBackend: () => ({
        resolveThreadAdmissionState,
      } as unknown as FederationBackendOperations),
      remoteNavigationSnapshot,
    } as unknown as DesktopMessagingFederationBridge;
    const bridge = new DesktopMessagingBackendBridge(
      {} as DesktopBackendRegistry,
      federation,
    );

    await expect(
      bridge.getThreadAdmissionState({
        backend: "codex",
        federationTarget: target,
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      thread: {
        id: "thread-1",
        federation: { instanceLabel: "Legacy Peer" },
      },
      threadStatus: "active",
    });
    expect(remoteNavigationSnapshot).toHaveBeenCalledWith(
      target,
      {
        backend: "codex",
        federationTarget: target,
      },
      {
        kind: "threads",
        threads: [{ backend: "codex", threadId: "thread-1" }],
      },
    );
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

  it("reads launchpad branch inventory from the owner filesystem", async () => {
    const ownerGitStatus = {
      currentBranch: "owner/main",
      branches: ["owner/main", "owner/release"],
      syncState: "in-sync" as const,
    };
    const readDirectoryStatusEntries = vi.fn(() => (async function* () {
      yield {
        directoryKey: "directory:/shared/PwrAgent",
        gitStatus: ownerGitStatus,
      };
    })());
    const ensureDirectoryLaunchpad = vi.fn(async (request: {
      currentBranch?: string;
    }) => ({
      launchpad: {
        directoryKey: "directory:/shared/PwrAgent",
        directoryKind: "directory" as const,
        directoryLabel: "PwrAgent",
        directoryPath: "/shared/PwrAgent",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        branchName: request.currentBranch,
        createdAt: 1,
        updatedAt: 1,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const registry = {
      ensureDirectoryLaunchpad,
      readDirectoryStatusEntries,
    } as unknown as DesktopBackendRegistry;
    const bridge = new DesktopMessagingBackendBridge(registry);

    const response = await bridge.ensureDirectoryLaunchpad({
      directoryKey: "directory:/shared/PwrAgent",
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/shared/PwrAgent",
      currentBranch: "viewer/local-only",
    });

    expect(readDirectoryStatusEntries).toHaveBeenCalledWith([
      expect.objectContaining({
        key: "directory:/shared/PwrAgent",
        path: "/shared/PwrAgent",
      }),
    ]);
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({ currentBranch: "owner/main" }),
    );
    expect(response.gitStatus).toEqual(ownerGitStatus);
    expect(response.launchpad.branchName).toBe("owner/main");
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
