import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArchiveWorktreeRequest,
  ArchiveThreadRequest,
  AppServerListThreadsRequest,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  MarkThreadSeenRequest,
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
const markThreadSeen = vi.fn(async (request: MarkThreadSeenRequest) => ({
  backend: request.backend ?? "codex",
  threadId: request.threadId,
  seenAt: request.seenAt ?? 2000,
  seenUpdatedAt: request.seenUpdatedAt,
}));

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
  }),
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
    markThreadSeen.mockClear();
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
      threads: [
        expect.objectContaining({ source: "codex", id: "thread-1" }),
        expect.objectContaining({ source: "grok", id: "thread-1" }),
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
          gitStatus: {
            currentBranch: "main",
            upstreamBranch: "origin/main",
            ahead: 0,
            behind: 0,
            syncState: "in-sync",
            branches: ["main"],
          },
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
      });

    registerAppServerIpcHandlers();

    await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});
    const response = await handlers.get(NAVIGATION_SNAPSHOT_CHANNEL)?.({}, {});

    expect(readDirectoryStatuses).toHaveBeenCalledTimes(2);
    expect(response).toEqual({
      backend: "all",
      fetchedAt: 5678,
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
          gitStatus: {
            currentBranch: "main",
            upstreamBranch: "origin/main",
            ahead: 0,
            behind: 0,
            syncState: "in-sync",
            branches: ["main"],
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
  });
});
