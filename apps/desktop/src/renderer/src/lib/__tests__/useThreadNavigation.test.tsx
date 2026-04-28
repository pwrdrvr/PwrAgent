import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopApi } from "../desktop-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadNavigation } from "../useThreadNavigation";

describe("useThreadNavigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears a directory attention count after the selected thread is marked seen", async () => {
    const markThreadSeen = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      seenAt: Date.now(),
      seenUpdatedAt: 1_000,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr/PwrAgnt",
              kind: "local" as const,
            },
          ],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
          kind: "directory" as const,
          label: "PwrAgnt",
          path: "/Users/huntharo/pwrdrvr/PwrAgnt",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 1,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        seenUpdatedAt: 1_000,
      });
    });

    await waitFor(() => {
      expect(result.current.inboxThreads).toHaveLength(0);
      expect(result.current.directories[0]?.needsAttentionCount).toBe(0);
    });
  });

  it("keeps a selected unread thread in Inbox until another item is selected", async () => {
    const markThreadSeen = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-unread",
      seenAt: Date.now(),
      seenUpdatedAt: 2_000,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-unread"],
      threads: [
        {
          id: "thread-unread",
          title: "Unread thread",
          titleSource: "explicit" as const,
          summary: "Unread thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "updated-since-seen" as const,
            lastSeenUpdatedAt: 1_000,
          },
          updatedAt: 2_000,
        },
        {
          id: "thread-read",
          title: "Read thread",
          titleSource: "explicit" as const,
          summary: "Read thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_500,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.inboxThreads.map((thread) => thread.id)).toEqual([
        "thread-unread",
      ]);
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-unread",
        seenUpdatedAt: 2_000,
      });
    });
    expect(result.current.inboxThreads.map((thread) => thread.id)).toEqual([
      "thread-unread",
    ]);

    act(() => {
      result.current.selectThread(result.current.threads[1]!);
    });

    await waitFor(() => {
      expect(result.current.inboxThreads).toHaveLength(0);
    });
  });

  it("coalesces repeated turn lifecycle notifications into one navigation refresh", async () => {
    const listeners = new Set<(event: any) => void>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        seenAt: Date.now(),
      })),
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const method of ["turn/completed", "turn/failed", "turn/cancelled"] as const) {
        for (const listener of listeners) {
          listener({
            backend: "codex",
            notification: {
              method,
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
              },
            },
          });
        }
      }
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("does not move selection to another thread when refresh temporarily drops the selected thread", async () => {
    const listeners = new Set<(event: any) => void>();
    let includeSelectedThread = true;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
        ...(includeSelectedThread
          ? [
              {
                id: "thread-2",
                title: "Clicked thread",
                titleSource: "explicit" as const,
                summary: "Clicked thread summary",
                source: "codex" as const,
                linkedDirectories: [],
                inbox: {
                  inInbox: false,
                },
                updatedAt: 2_000,
              },
            ]
          : []),
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    act(() => {
      result.current.selectThread(result.current.threads[1]!);
    });

    expect(result.current.selectedThread?.id).toBe("thread-2");

    includeSelectedThread = false;

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });

    expect(result.current.selectedItemKey).toBe("codex:thread-2");
    expect(result.current.selectedThread?.id).not.toBe("thread-1");
  });

  it("keeps an archived thread hidden when the post-archive refresh is stale", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-archived"],
      threads: [
        {
          id: "thread-archived",
          title: "Archived thread",
          titleSource: "explicit" as const,
          summary: "This thread is archived before the backend list catches up",
          source: "codex" as const,
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/Users/huntharo/github/PwrAgnt",
              kind: "local" as const,
            },
          ],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 2_000,
        },
        {
          id: "thread-remaining",
          title: "Remaining thread",
          titleSource: "explicit" as const,
          summary: "This thread stays in navigation",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: "directory:/Users/huntharo/github/PwrAgnt",
          kind: "directory" as const,
          label: "PwrAgnt",
          path: "/Users/huntharo/github/PwrAgnt",
          threadKeys: ["codex:thread-archived"],
          needsAttentionCount: 1,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const archiveThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-archived",
      archivedAt: 3_000,
      cleanup: [],
    }));

    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads.map((thread) => thread.id)).toEqual([
        "thread-archived",
        "thread-remaining",
      ]);
    });

    await act(async () => {
      await result.current.archiveThread(result.current.threads[0]!);
    });

    expect(archiveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-archived",
    });
    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      "thread-remaining",
    ]);
    expect(result.current.inboxThreads).toHaveLength(0);
    expect(result.current.directories[0]?.threadKeys).toEqual([]);
    expect(result.current.directories[0]?.needsAttentionCount).toBe(0);
  });

  it("renames a thread and refreshes navigation with the explicit title", async () => {
    let threadTitle = "First thread";
    const renameThread = vi.fn(async ({ name }: { name: string }) => {
      threadTitle = name;
      return {
        backend: "codex" as const,
        threadId: "thread-1",
        renamedAt: Date.now(),
      };
    });
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: threadTitle,
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        seenAt: Date.now(),
      })),
      renameThread,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.title).toBe("First thread");
    });

    await act(async () => {
      await result.current.renameThread(result.current.threads[0]!, "  Renamed thread  ");
    });

    expect(renameThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      name: "Renamed thread",
    });
    await waitFor(() => {
      expect(result.current.selectedThread?.title).toBe("Renamed thread");
      expect(result.current.selectedThread?.titleSource).toBe("explicit");
    });
  });

  it("shows a newly materialized detached worktree thread as HEAD before the backend snapshot catches up", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "directory:/Users/huntharo/github/PwrAgnt",
          kind: "directory" as const,
          label: "PwrAgnt",
          path: "/Users/huntharo/github/PwrAgnt",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey: "directory:/Users/huntharo/github/PwrAgnt",
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgnt",
            directoryPath: "/Users/huntharo/github/PwrAgnt",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "",
            workMode: "worktree" as const,
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-new",
      executionMode: "default" as const,
      workMode: "worktree" as const,
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.launchpad?.directoryKey).toBe(
        "directory:/Users/huntharo/github/PwrAgnt"
      );
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(
        "directory:/Users/huntharo/github/PwrAgnt"
      );
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "directory:/Users/huntharo/github/PwrAgnt",
      input: undefined,
      collaborationMode: undefined,
    });
    expect(result.current.selectedThread?.id).toBe("thread-new");
    expect(result.current.selectedThread?.gitBranch).toBe("HEAD");
    expect(result.current.selectedThread?.observedGitBranch).toBe("HEAD");
    expect(result.current.directories[0]?.threadKeys).toEqual(["codex:thread-new"]);
    expect(result.current.directories[0]?.needsAttentionCount).toBe(1);
  });

  it("refreshes the selected thread when only the observed branch changes", async () => {
    const listeners = new Set<(event: any) => void>();
    let navigationCallCount = 0;
    const getNavigationSnapshot = vi.fn(async () => {
      navigationCallCount += 1;
      return {
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [
          {
            id: "thread-1",
            title: "Detached branch naming",
            titleSource: "explicit" as const,
            summary: "Test branch chip refresh",
            source: "codex" as const,
            gitBranch: navigationCallCount === 1 ? undefined : "fix/branch-pill",
            observedGitBranch:
              navigationCallCount === 1 ? undefined : "fix/branch-pill",
            linkedDirectories: [],
            inbox: {
              inInbox: false,
            },
            updatedAt: 1_000,
          },
        ],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      };
    });

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(result.current.selectedThread?.gitBranch).toBeUndefined();

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.gitBranch).toBe("fix/branch-pill");
      expect(result.current.selectedThread?.observedGitBranch).toBe(
        "fix/branch-pill"
      );
    });
  });

  it("restores backend state and surfaces errors when rename fails", async () => {
    const renameThread = vi.fn(async () => {
      throw new Error("rename failed");
    });
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        seenAt: Date.now(),
      })),
      renameThread,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.title).toBe("First thread");
    });

    await act(async () => {
      await result.current.renameThread(result.current.threads[0]!, "Broken rename");
    });

    await waitFor(() => {
      expect(result.current.renameThreadError).toBe("rename failed");
      expect(result.current.selectedThread?.title).toBe("First thread");
    });
  });
});
