import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerListThreadsRequest,
  GetNavigationSnapshotRequest,
  MarkThreadSeenRequest,
} from "@pwragnt/shared";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const listThreads = vi.fn(async (_request?: { backend?: "codex" | "grok"; filter?: string }) => [
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
]);
const readThread = vi.fn(async ({ threadId }: { threadId: string }) => ({
  messages: [{ id: `${threadId}-message`, role: "assistant" as const, text: "Loaded" }],
  pagination: {
    supportsPagination: false,
    hasPreviousPage: false,
  },
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
    getPath: vi.fn(() => "/tmp/pwragnt-userdata"),
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

vi.mock("@pwragnt/agent-core", () => ({
  OverlayStore: class MockOverlayStore {
    reconcileNavigationSnapshot = reconcileNavigationSnapshot;
    markThreadSeen = markThreadSeen;
  },
}));

vi.mock("../app-server/backend-registry", () => ({
  disposeDesktopBackendRegistry: vi.fn(async () => undefined),
  getDesktopBackendRegistry: () => ({
    listThreads,
    readThread,
    readDirectoryStatuses,
  }),
}));

describe("app server ipc", () => {
  beforeEach(() => {
    handlers.clear();
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

    expect(listThreads).toHaveBeenCalledWith({ backend: undefined, filter: undefined });
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
});
