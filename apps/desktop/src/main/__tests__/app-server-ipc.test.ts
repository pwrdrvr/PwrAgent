import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArchiveWorktreeRequest,
  ArchiveThreadRequest,
  AppServerListThreadsRequest,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  MarkThreadSeenRequest,
  PrSummary,
  RefreshThreadPullRequestsRequest,
  RenameThreadRequest,
  RestoreWorktreeRequest,
  RestoreThreadRequest,
} from "@pwragent/shared";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const listThreads = vi.fn(async (request?: {
  archived?: boolean;
  backend?: "codex" | "grok";
  filter?: string;
}) =>
  request?.archived
    ? [
        {
          id: "thread-archived",
          title: "Archived thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          updatedAt: 500,
        },
      ]
    : [
        {
          id: "thread-1",
          title: "Thread one",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          updatedAt: 2000,
        },
        {
          id: "thread-1",
          title: "Thread one (Grok)",
          titleSource: "explicit" as const,
          source: "grok" as const,
          linkedDirectories: [],
          updatedAt: 1000,
        },
      ]
);
const readThread = vi.fn(async ({ threadId }: { threadId: string }) => ({
  messages: [{ id: `${threadId}-message`, role: "assistant" as const, text: "Loaded" }],
  pagination: {
    supportsPagination: false,
    hasPreviousPage: false,
  },
}));
const archiveThread = vi.fn(async (request: ArchiveThreadRequest) => ({
  backend: request.backend ?? "codex",
  threadId: request.threadId,
  archivedAt: 3000,
  cleanup: [],
}));
const restoreThread = vi.fn(async (request: RestoreThreadRequest) => ({
  backend: request.backend ?? "codex",
  threadId: request.threadId,
  restoredAt: 3000,
}));
const archiveWorktree = vi.fn(async (request: ArchiveWorktreeRequest) => ({
  backend: request.backend,
  threadId: request.threadId,
  archivedAt: 3000,
  snapshot: {
    id: "snapshot-1",
    backend: request.backend,
    threadId: request.threadId,
    worktreePath: request.worktreePath,
    repositoryPath: request.repositoryPath ?? "/repo",
    snapshotRef: "refs/codex/snapshots/snapshot-1",
    snapshotCommit: "abc123",
    createdAt: 3000,
    archivedAt: 3000,
    state: "archived" as const,
    ignoredFilesExcluded: true,
  },
}));
const restoreWorktree = vi.fn(async (request: RestoreWorktreeRequest) => ({
  backend: request.backend,
  threadId: request.threadId,
  restoredAt: 4000,
  snapshot: {
    id: "snapshot-1",
    backend: request.backend,
    threadId: request.threadId,
    worktreePath: request.worktreePath,
    repositoryPath: request.repositoryPath ?? "/repo",
    snapshotRef: request.snapshotRef ?? "refs/codex/snapshots/snapshot-1",
    snapshotCommit: "abc123",
    createdAt: 3000,
    archivedAt: 3000,
    restoredAt: 4000,
    state: "restored" as const,
    ignoredFilesExcluded: true,
  },
}));
const handoffThreadWorkspace = vi.fn(async (request: HandoffThreadWorkspaceRequest) => ({
  backend: request.backend,
  threadId: request.threadId,
  direction: request.direction,
  workMode: request.direction === "local-to-worktree" ? "worktree" as const : "local" as const,
  branch: request.sourceBranch ?? "feature/handoff",
  repositoryPath: request.repositoryPath ?? "/repo",
  targetPath: "/repo/.worktrees/app-feature-handoff",
  linkedDirectory: {
    id: "pwragent-handoff:codex:thread-1",
    label: "app",
    path: request.repositoryPath ?? "/repo",
    worktreePath: "/repo/.worktrees/app-feature-handoff",
    kind: "worktree" as const,
  },
  warnings: [],
  completedAt: 5000,
}));
const renameThread = vi.fn(async (request: RenameThreadRequest) => ({
  backend: request.backend ?? "codex",
  threadId: request.threadId,
  renamedAt: 3000,
}));
const reconcileNavigationSnapshot = vi.fn(async (params: unknown) => ({
  backend: (params as { backend: "all" | "codex" | "grok" }).backend,
  fetchedAt: 1234,
  unchanged: false,
  threads: (params as { threads: unknown[] }).threads,
  inboxThreadKeys: ["grok:thread-1"],
  directories: [
    {
      key: "directory:/repo/app",
      kind: "directory" as const,
      label: "app",
      path: "/repo/app",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 1,
      latestUpdatedAt: 2000,
    },
  ],
  launchpadDefaults: {
    backend: "codex" as const,
    executionMode: "default" as const,
  },
}));
const readDirectoryStatuses = vi.fn(async () => ({
  "directory:/repo/app": {
    currentBranch: "main",
    upstreamBranch: "origin/main",
    ahead: 0,
    behind: 0,
    syncState: "in-sync" as const,
    branches: ["main"],
  },
}));
const directoryGitStatus = {
  currentBranch: "main",
  upstreamBranch: "origin/main",
  ahead: 0,
  behind: 0,
  syncState: "in-sync" as const,
  branches: ["main"],
};
const readDirectoryStatusEntries = vi.fn((directories: Array<{ key: string }>) =>
  (async function* () {
    for (const directory of directories) {
      yield {
        directoryKey: directory.key,
        gitStatus: directoryGitStatus,
      };
    }
  })(),
);
const readDirectoryGitStatusCache = vi.fn(async () => ({}));
const writeDirectoryGitStatusCacheEntry = vi.fn(async () => undefined);
const publishLocalEvent = vi.fn(async () => undefined);
const ensureDirectoryLaunchpad = vi.fn(async (request: {
  directoryKey: string;
  directoryKind: string;
  directoryLabel: string;
  directoryPath?: string;
  currentBranch?: string;
}) => ({
  launchpad: {
    directoryKey: request.directoryKey,
    directoryKind: request.directoryKind,
    directoryLabel: request.directoryLabel,
    directoryPath: request.directoryPath,
    backend: "codex",
    executionMode: "default",
    prompt: "",
    branchName: request.currentBranch,
    createdAt: 1000,
    updatedAt: 1000,
  },
  defaults: {
    backend: "codex",
    executionMode: "default",
  },
}));
const markThreadSeen = vi.fn(async (request: MarkThreadSeenRequest) => ({
  backend: request.backend ?? "codex",
  threadId: request.threadId,
  seenAt: request.seenAt ?? 2000,
  seenUpdatedAt: request.seenUpdatedAt,
}));
const getThreadOverlayState = vi.fn();
const getThreadOverlayStates = vi.fn(async () => ({}));
const setThreadPullRequests = vi.fn(async (request: {
  backend: "codex" | "grok";
  threadId: string;
  prs: PrSummary[];
  refreshKey?: string;
}) => ({
  backend: request.backend,
  threadId: request.threadId,
  executionMode: "default" as const,
  extraLinkedDirectories: [],
  prs: request.prs,
  prsFetchedAt: Date.now(),
  prsRefreshKey: request.refreshKey,
}));
const isGhAvailable = vi.fn(async () => true);
const getAuthStatus = vi.fn(async () => ({
  installed: true,
  loggedIn: true,
  scopes: ["repo"],
  hasRepoScope: true,
}));
const detectPullRequestsForThread = vi.fn(async (): Promise<PrSummary[]> => []);

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/pwragent-userdata"),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("../app-server/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({
    reconcileNavigationSnapshot,
    markThreadSeen,
    getThreadOverlayState,
    getThreadOverlayStates,
    setThreadPullRequests,
    readDirectoryGitStatusCache,
    writeDirectoryGitStatusCacheEntry,
  }),
}));

vi.mock("../app-server/backend-registry", () => ({
  disposeDesktopBackendRegistry: vi.fn(async () => undefined),
  getDesktopBackendRegistry: () => ({
    archiveThread,
    restoreThread,
    archiveWorktree,
    restoreWorktree,
    handoffThreadWorkspace,
    renameThread,
    listThreads,
    readThread,
    readDirectoryStatuses,
    readDirectoryStatusEntries,
    publishLocalEvent,
    ensureDirectoryLaunchpad,
    getQueuedExecutionModesSnapshot: () => ({}),
  }),
}));

vi.mock("../pr-status/github-pr-fetcher", () => ({
  GithubPrFetcher: vi.fn(function GithubPrFetcher() {
    return {
      isGhAvailable,
      getAuthStatus,
    };
  }),
}));

vi.mock("../pr-status/pr-detection", () => ({
  detectPullRequestsForThread,
}));

describe("app server ipc", () => {
  beforeEach(() => {
    handlers.clear();
    archiveThread.mockClear();
    restoreThread.mockClear();
    archiveWorktree.mockClear();
    restoreWorktree.mockClear();
    handoffThreadWorkspace.mockClear();
    renameThread.mockClear();
    listThreads.mockClear();
    readThread.mockClear();
    reconcileNavigationSnapshot.mockClear();
    readDirectoryStatuses.mockClear();
    readDirectoryStatusEntries.mockClear();
    readDirectoryGitStatusCache.mockClear();
    readDirectoryGitStatusCache.mockResolvedValue({});
    writeDirectoryGitStatusCacheEntry.mockClear();
    publishLocalEvent.mockClear();
    ensureDirectoryLaunchpad.mockClear();
    markThreadSeen.mockClear();
    getThreadOverlayState.mockReset();
    getThreadOverlayState.mockResolvedValue(undefined);
    getThreadOverlayStates.mockReset();
    getThreadOverlayStates.mockResolvedValue({});
    setThreadPullRequests.mockClear();
    isGhAvailable.mockClear();
    isGhAvailable.mockResolvedValue(true);
    getAuthStatus.mockClear();
    detectPullRequestsForThread.mockReset();
    detectPullRequestsForThread.mockResolvedValue([]);
  });

  afterEach(async () => {
    const { disposeAppServerIpcHandlers } = await import("../ipc/app-server");
    await disposeAppServerIpcHandlers();
  });

  it("aggregates navigation snapshots across backends by default", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.(
      {},
      {} satisfies GetNavigationSnapshotRequest,
    );

    expect(listThreads).toHaveBeenCalledWith({
      backend: undefined,
      callerReason: "navigation-snapshot",
      filter: undefined,
    });
    expect(reconcileNavigationSnapshot).toHaveBeenCalledWith({
      backend: "all",
      fetchedAt: expect.any(Number),
      messagingBindingsByThreadKey: undefined,
      queuedExecutionModesByThreadId: {},
      threads: [
        expect.objectContaining({ source: "codex", id: "thread-1" }),
        expect.objectContaining({ source: "grok", id: "thread-1" }),
      ],
      workspaceRoots: [
        path.join(os.homedir(), ".pwragent", "profiles", "default", "projects"),
        path.join(os.homedir(), ".pwragent", "projects"),
        path.join(os.homedir(), ".pwragnt", "projects"),
      ],
    });
    expect(response).toEqual({
      backend: "all",
      fetchedAt: 1234,
      unchanged: false,
      threads: [
        expect.objectContaining({ source: "codex", id: "thread-1" }),
        expect.objectContaining({ source: "grok", id: "thread-1" }),
      ],
      inboxThreadKeys: ["grok:thread-1"],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory",
          label: "app",
          path: "/repo/app",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 1,
          latestUpdatedAt: 2000,
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
  });

  it("returns backend scope all when listing threads without a backend filter", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { APP_SERVER_LIST_THREADS_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_LIST_THREADS_CHANNEL)?.(
      {},
      {} satisfies AppServerListThreadsRequest,
    );

    expect(response).toEqual({
      backend: "all",
      fetchedAt: expect.any(Number),
      threads: [
        expect.objectContaining({ source: "codex", id: "thread-1" }),
        expect.objectContaining({ source: "grok", id: "thread-1" }),
      ],
      workspaceRoots: [
        path.join(os.homedir(), ".pwragent", "profiles", "default", "projects"),
        path.join(os.homedir(), ".pwragent", "projects"),
        path.join(os.homedir(), ".pwragnt", "projects"),
      ],
    });
  });

  it("hydrates retained worktree snapshots when listing archived threads", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { APP_SERVER_LIST_THREADS_CHANNEL } = await import("../../shared/ipc");
    getThreadOverlayStates.mockResolvedValue({
      "thread-archived": {
        backend: "codex",
        threadId: "thread-archived",
        executionMode: "default",
        extraLinkedDirectories: [],
        worktreeSnapshots: [
          {
            id: "snapshot-1",
            backend: "codex",
            threadId: "thread-archived",
            worktreePath: "/Users/test/.codex/worktrees/mp7efuda/PwrSnap",
            repositoryPath: "/Users/test/github/PwrSnap",
            snapshotRef: "refs/codex/snapshots/snapshot-1",
            snapshotCommit: "abc123",
            createdAt: 1000,
            archivedAt: 3000,
            state: "archived",
            ignoredFilesExcluded: true,
          },
        ],
      },
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_LIST_THREADS_CHANNEL)?.(
      {},
      { archived: true } satisfies AppServerListThreadsRequest,
    );

    expect(getThreadOverlayStates).toHaveBeenCalledWith({
      backend: "codex",
      threadIds: ["thread-archived"],
    });
    expect(response).toEqual({
      backend: "all",
      fetchedAt: expect.any(Number),
      threads: [
        expect.objectContaining({
          id: "thread-archived",
          worktreeSnapshots: [
            expect.objectContaining({
              repositoryPath: "/Users/test/github/PwrSnap",
              worktreePath: "/Users/test/.codex/worktrees/mp7efuda/PwrSnap",
            }),
          ],
        }),
      ],
      workspaceRoots: [
        path.join(os.homedir(), ".pwragent", "profiles", "default", "projects"),
        path.join(os.homedir(), ".pwragent", "projects"),
        path.join(os.homedir(), ".pwragnt", "projects"),
      ],
    });
  });

  it("archives threads through the app-server IPC handler", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { APP_SERVER_ARCHIVE_THREAD_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_ARCHIVE_THREAD_CHANNEL)?.({}, {
      backend: "codex",
      threadId: "thread-1",
    } satisfies ArchiveThreadRequest);

    expect(archiveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: 3000,
      cleanup: [],
    });
  });

  it("restores threads through the app-server IPC handler", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { APP_SERVER_RESTORE_THREAD_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_RESTORE_THREAD_CHANNEL)?.({}, {
      backend: "grok",
      threadId: "thread-1",
    } satisfies RestoreThreadRequest);

    expect(restoreThread).toHaveBeenCalledWith({
      backend: "grok",
      threadId: "thread-1",
    });
    expect(response).toEqual({
      backend: "grok",
      threadId: "thread-1",
      restoredAt: 3000,
    });
  });

  it("archives worktrees through the app-server IPC handler", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { APP_SERVER_ARCHIVE_WORKTREE_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_ARCHIVE_WORKTREE_CHANNEL)?.({}, {
      backend: "codex",
      threadId: "thread-1",
      repositoryPath: "/repo",
      worktreePath: "/worktrees/thread-1",
    } satisfies ArchiveWorktreeRequest);

    expect(archiveWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      repositoryPath: "/repo",
      worktreePath: "/worktrees/thread-1",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: 3000,
      snapshot: expect.objectContaining({
        snapshotRef: "refs/codex/snapshots/snapshot-1",
        state: "archived",
      }),
    });
  });

  it("restores worktrees through the app-server IPC handler", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { APP_SERVER_RESTORE_WORKTREE_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_RESTORE_WORKTREE_CHANNEL)?.({}, {
      backend: "codex",
      threadId: "thread-1",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      worktreePath: "/worktrees/thread-1",
    } satisfies RestoreWorktreeRequest);

    expect(restoreWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      worktreePath: "/worktrees/thread-1",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      restoredAt: 4000,
      snapshot: expect.objectContaining({
        snapshotRef: "refs/codex/snapshots/snapshot-1",
        state: "restored",
      }),
    });
  });

  it("hands off thread workspaces through the app-server IPC handler", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL)?.({}, {
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      repositoryPath: "/repo",
      sourcePath: "/repo",
      sourceBranch: "feature/handoff",
      leaveLocalBranch: "main",
    } satisfies HandoffThreadWorkspaceRequest);

    expect(handoffThreadWorkspace).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      repositoryPath: "/repo",
      sourcePath: "/repo",
      sourceBranch: "feature/handoff",
      leaveLocalBranch: "main",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      workMode: "worktree",
      branch: "feature/handoff",
      repositoryPath: "/repo",
      targetPath: "/repo/.worktrees/app-feature-handoff",
      linkedDirectory: expect.objectContaining({
        kind: "worktree",
      }),
      warnings: [],
      completedAt: 5000,
    });
  });

  it("renames threads through the app-server IPC handler", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { APP_SERVER_RENAME_THREAD_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(APP_SERVER_RENAME_THREAD_CHANNEL)?.({}, {
      backend: "grok",
      threadId: "thread-1",
      name: "Renamed thread",
    } satisfies RenameThreadRequest);

    expect(renameThread).toHaveBeenCalledWith({
      backend: "grok",
      threadId: "thread-1",
      name: "Renamed thread",
    });
    expect(response).toEqual({
      backend: "grok",
      threadId: "thread-1",
      renamedAt: 3000,
    });
  });

  it("marks Grok threads seen without rejecting the backend", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_MARK_THREAD_SEEN_CHANNEL } = await import("../../shared/ipc");

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_MARK_THREAD_SEEN_CHANNEL)?.({}, {
      backend: "grok",
      threadId: "thread-1",
      seenUpdatedAt: 3000,
    } satisfies MarkThreadSeenRequest);

    expect(markThreadSeen).toHaveBeenCalledWith({
      backend: "grok",
      threadId: "thread-1",
      seenAt: undefined,
      seenUpdatedAt: 3000,
    });
    expect(response).toEqual({
      backend: "grok",
      threadId: "thread-1",
      seenAt: 2000,
      seenUpdatedAt: 3000,
    });
  });

  it("refreshes mixed terminal and non-terminal PR chips instead of short-circuiting", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/desktop-source-link-goto",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = JSON.stringify({
      lookupVersion: 2,
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/desktop-source-link-goto",
      directoryPaths: ["/repo"],
    });
    const stalePassingPr: PrSummary = {
      number: 433,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/433",
    };
    const mergedPr: PrSummary = {
      number: 430,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "merged",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/430",
    };
    const refreshedPrs: PrSummary[] = [
      { ...stalePassingPr, state: "merged" },
      mergedPr,
    ];
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: [stalePassingPr, mergedPr],
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });
    detectPullRequestsForThread.mockResolvedValueOnce(refreshedPrs);

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(detectPullRequestsForThread).toHaveBeenCalledWith({
      fetcher: expect.any(Object),
      branch: "fix/desktop-source-link-goto",
      directoryPaths: ["/repo"],
    });
    expect(setThreadPullRequests).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      prs: refreshedPrs,
      refreshKey: requestKey,
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      ghAvailable: true,
      prs: refreshedPrs,
    });
  });

  it("short-circuits PR refresh when all cached PRs are terminal for the same lookup", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_REFRESH_THREAD_PRS_CHANNEL } = await import("../../shared/ipc");
    const request = {
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/done",
      directoryPaths: ["/repo"],
    } satisfies RefreshThreadPullRequestsRequest;
    const requestKey = JSON.stringify({
      lookupVersion: 2,
      backend: "codex",
      threadId: "thread-1",
      branch: "fix/done",
      directoryPaths: ["/repo"],
    });
    const terminalPrs: PrSummary[] = [
      {
        number: 433,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "merged",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/433",
      },
      {
        number: 430,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "closed",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/430",
      },
    ];
    getThreadOverlayState.mockResolvedValueOnce({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      prs: terminalPrs,
      prsFetchedAt: Date.now() - 120_000,
      prsRefreshKey: requestKey,
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL)?.(
      {},
      request,
    );

    expect(detectPullRequestsForThread).not.toHaveBeenCalled();
    expect(setThreadPullRequests).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      ghAvailable: true,
      prs: terminalPrs,
      shortCircuited: true,
    });
  });

  it("preserves unchanged snapshots when directory statuses are unchanged", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    reconcileNavigationSnapshot
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 1234,
        unchanged: false,
        threads: [
          {
            id: "thread-1",
            title: "Thread one",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            updatedAt: 2000,
          },
        ],
        inboxThreadKeys: ["codex:thread-1"],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: ["codex:thread-1"],
            needsAttentionCount: 1,
            latestUpdatedAt: 2000,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 5678,
        unchanged: true,
        threads: [
          {
            id: "thread-1",
            title: "Thread one",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            updatedAt: 2000,
          },
        ],
        inboxThreadKeys: ["codex:thread-1"],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: ["codex:thread-1"],
            needsAttentionCount: 1,
            latestUpdatedAt: 2000,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 9012,
        unchanged: true,
        threads: [
          {
            id: "thread-1",
            title: "Thread one",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            updatedAt: 2000,
          },
        ],
        inboxThreadKeys: ["codex:thread-1"],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: ["codex:thread-1"],
            needsAttentionCount: 1,
            latestUpdatedAt: 2000,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(publishLocalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          notification: expect.objectContaining({
            method: "navigation/directoryGitStatus/updated",
          }),
        }),
      );
    });
    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(readDirectoryStatuses).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "all",
      fetchedAt: 9012,
      unchanged: true,
      threads: [
        expect.objectContaining({ source: "codex", id: "thread-1" }),
      ],
      inboxThreadKeys: ["codex:thread-1"],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory",
          label: "app",
          path: "/repo/app",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 1,
          latestUpdatedAt: 2000,
          gitStatus: directoryGitStatus,
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
  });

  it("marks snapshots changed when hydrated launchpad environment options change", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-nav-env-"));
    const environmentsDir = path.join(root, ".codex", "environments");
    await mkdir(environmentsDir, { recursive: true });
    await writeFile(
      path.join(environmentsDir, "environment.toml"),
      'name = "Existing environment"\n',
      "utf8",
    );

    const launchpad = {
      directoryKey: "directory:/repo/app",
      directoryKind: "directory" as const,
      directoryLabel: "app",
      directoryPath: root,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "local" as const,
      createdAt: 1000,
      updatedAt: 1000,
    };

    reconcileNavigationSnapshot
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 1234,
        unchanged: false,
        threads: [],
        inboxThreadKeys: [],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: [],
            needsAttentionCount: 0,
            latestUpdatedAt: 2000,
            launchpad,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      } as unknown as Awaited<ReturnType<typeof reconcileNavigationSnapshot>>)
      .mockResolvedValueOnce({
        backend: "all",
        fetchedAt: 5678,
        unchanged: true,
        threads: [],
        inboxThreadKeys: [],
        directories: [
          {
            key: "directory:/repo/app",
            kind: "directory" as const,
            label: "app",
            path: "/repo/app",
            threadKeys: [],
            needsAttentionCount: 0,
            latestUpdatedAt: 2000,
            launchpad,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      } as unknown as Awaited<ReturnType<typeof reconcileNavigationSnapshot>>);

    try {
      registerAppServerIpcHandlers();

      await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
      await writeFile(
        path.join(environmentsDir, "new-environment.toml"),
        'name = "New environment"\n',
        "utf8",
      );
      const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

      expect(response).toMatchObject({
        unchanged: false,
        directories: [
          {
            launchpad: {
              codexEnvironmentOptions: [
                { id: "environment" },
                { id: "new-environment" },
              ],
            },
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses cached directory git status without refreshing unchanged directories", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    readDirectoryGitStatusCache.mockResolvedValueOnce({
      "directory:/repo/app": {
        directoryKey: "directory:/repo/app",
        directoryPath: "/repo/app",
        directoryUpdatedAt: 2000,
        fetchedAt: Date.now(),
        gitStatus: directoryGitStatus,
      },
    });

    registerAppServerIpcHandlers();

    const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(readDirectoryStatusEntries).not.toHaveBeenCalled();
    expect(response).toEqual(
      expect.objectContaining({
        directories: [
          expect.objectContaining({
            key: "directory:/repo/app",
            gitStatus: directoryGitStatus,
          }),
        ],
      }),
    );
  });

  it("refreshes stale cached directory git status in the background", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    readDirectoryGitStatusCache.mockResolvedValueOnce({
      "directory:/repo/app": {
        directoryKey: "directory:/repo/app",
        directoryPath: "/repo/app",
        directoryUpdatedAt: 2000,
        fetchedAt: Date.now() - 60 * 60 * 1000,
        gitStatus: directoryGitStatus,
      },
    });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    await vi.waitFor(() => {
      expect(readDirectoryStatusEntries).toHaveBeenCalled();
    });
    expect(readDirectoryStatusEntries.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ key: "directory:/repo/app" }),
    ]);
  });

  it("refreshes cached directory git status when explicitly requested", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const {
      NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
      NAVIGATION_SNAPSHOT_CHANNEL,
    } = await import("../../shared/ipc");

    readDirectoryGitStatusCache.mockResolvedValueOnce({
      "directory:/repo/app": {
        directoryKey: "directory:/repo/app",
        directoryPath: "/repo/app",
        directoryUpdatedAt: 2000,
        fetchedAt: Date.now(),
        gitStatus: directoryGitStatus,
      },
    });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    expect(readDirectoryStatusEntries).not.toHaveBeenCalled();

    await expect(
      handlers.get(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL)?.(
        {},
        {
          directoryKeys: ["directory:/repo/app"],
        },
      ),
    ).resolves.toEqual({ scheduledCount: 1 });

    await vi.waitFor(() => {
      expect(readDirectoryStatusEntries).toHaveBeenCalled();
    });
    expect(readDirectoryStatusEntries.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ key: "directory:/repo/app" }),
    ]);
  });

  it("caps automatic startup directory git status refreshes", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    const directories = Array.from({ length: 6 }, (_, index) => ({
      key: `directory:/repo/app-${index}`,
      kind: "directory" as const,
      label: `app-${index}`,
      path: `/repo/app-${index}`,
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      latestUpdatedAt: 1000 + index,
    }));
    reconcileNavigationSnapshot.mockResolvedValueOnce({
      backend: "all",
      fetchedAt: 1234,
      unchanged: false,
      threads: [
        {
          id: "thread-1",
          title: "Thread one",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
      inboxThreadKeys: [],
      directories,
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    await vi.waitFor(() => {
      expect(readDirectoryStatusEntries).toHaveBeenCalled();
    });

    expect(readDirectoryStatusEntries.mock.calls[0]?.[0]).toHaveLength(4);
    expect(
      (readDirectoryStatusEntries.mock.calls[0]?.[0] as Array<{ key: string }>)
        .map((directory) => directory.key),
    ).toEqual([
      "directory:/repo/app-5",
      "directory:/repo/app-4",
      "directory:/repo/app-3",
      "directory:/repo/app-2",
    ]);
  });

  it("refreshes launchpad directory git status before selecting the default branch", async () => {
    const { registerAppServerIpcHandlers } = await import("../ipc/app-server");
    const { NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL } = await import("../../shared/ipc");

    readDirectoryStatusEntries.mockImplementationOnce((directories: Array<{ key: string }>) =>
      (async function* () {
        yield {
          directoryKey: directories[0]!.key,
          gitStatus: {
            ...directoryGitStatus,
            currentBranch: "fresh-branch",
          },
        };
      })(),
    );

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL)?.({}, {
      directoryKey: "directory:/repo/app",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/app",
      currentBranch: "stale-branch",
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryKey: "directory:/repo/app",
        currentBranch: "fresh-branch",
      }),
    );
    expect(writeDirectoryGitStatusCacheEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryKey: "directory:/repo/app",
        gitStatus: expect.objectContaining({ currentBranch: "fresh-branch" }),
      }),
    );
  });
});
