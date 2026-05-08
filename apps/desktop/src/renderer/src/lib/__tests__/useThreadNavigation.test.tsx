import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { shortenDerivedThreadTitle } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadNavigation } from "../useThreadNavigation";

describe("useThreadNavigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  } {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    return { promise, resolve, reject };
  }

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
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
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
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
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
              label: "PwrAgent",
              path: "/Users/huntharo/github/PwrAgent",
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
          key: "directory:/Users/huntharo/github/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/huntharo/github/PwrAgent",
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

  it("restores focus to the selected thread when archive fails", async () => {
    const navigationSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-archived",
          title: "Archive target",
          titleSource: "explicit" as const,
          summary: "This thread should regain focus when archive fails",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 2_000,
        },
        {
          id: "thread-fallback",
          title: "Fallback thread",
          titleSource: "explicit" as const,
          summary: "This thread is selected optimistically during archive",
          source: "codex" as const,
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
    const getNavigationSnapshot = vi.fn(async () => navigationSnapshot);
    const archiveThread = vi.fn(async () => {
      throw new Error("Archive failed");
    });

    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-archived");
    });

    await act(async () => {
      await result.current.archiveThread(result.current.threads[0]!);
    });

    expect(result.current.archiveThreadError).toBe("Archive failed");
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      "thread-archived",
      "thread-fallback",
    ]);
    expect(result.current.selectedThread?.id).toBe("thread-archived");
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
          key: "directory:/Users/huntharo/github/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/huntharo/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey: "directory:/Users/huntharo/github/PwrAgent",
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/huntharo/github/PwrAgent",
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
        "directory:/Users/huntharo/github/PwrAgent"
      );
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(
        "directory:/Users/huntharo/github/PwrAgent"
      );
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "directory:/Users/huntharo/github/PwrAgent",
      launchpad: expect.objectContaining({
        directoryKey: "directory:/Users/huntharo/github/PwrAgent",
      }),
      input: undefined,
      collaborationMode: undefined,
      reviewTarget: undefined,
    });
    expect(result.current.selectedThread?.id).toBe("thread-new");
    expect(result.current.selectedThread?.gitBranch).toBe("HEAD");
    expect(result.current.selectedThread?.observedGitBranch).toBe("HEAD");
    expect(result.current.directories[0]?.threadKeys).toEqual(["codex:thread-new"]);
    expect(result.current.directories[0]?.needsAttentionCount).toBe(1);
  });

  it("keeps a launchpad prompt-derived title when the hydrated thread only has a fallback id title", async () => {
    const directoryKey = "directory:/Users/huntharo/github/PwrAgent";
    const threadId = "019df3a2-75b2-73d1-a273-5f94ac425966";
    const prompt =
      "What went wrong with Discord? Investigate the adapter path and explain the failure";
    const initialSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/huntharo/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/huntharo/github/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt,
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
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce({
        ...initialSnapshot,
        inboxThreadKeys: [`codex:${threadId}`],
        threads: [
          {
            id: threadId,
            title: threadId,
            titleSource: "fallback" as const,
            summary: undefined,
            source: "codex" as const,
            linkedDirectories: [
              {
                id: directoryKey,
                label: "PwrAgent",
                path: "/Users/huntharo/github/PwrAgent",
                kind: "worktree" as const,
              },
            ],
            gitBranch: "HEAD",
            observedGitBranch: "HEAD",
            inbox: {
              inInbox: true,
              reason: "new-thread" as const,
            },
            updatedAt: 2,
          },
        ],
        directories: [
          {
            ...initialSnapshot.directories[0]!,
            threadKeys: [`codex:${threadId}`],
            needsAttentionCount: 1,
            launchpad: undefined,
          },
        ],
      });
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId,
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
      expect(result.current.directories[0]?.launchpad?.prompt).toBe(prompt);
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(directoryKey);
    });

    expect(result.current.selectedThread?.id).toBe(threadId);
    expect(result.current.selectedThread?.title).toBe(shortenDerivedThreadTitle(prompt));
    expect(result.current.selectedThread?.titleSource).toBe("derived");
    expect(result.current.selectedThread?.title).not.toBe(threadId);
  });

  it("does not let a materialized thread refresh override a newer user thread selection", async () => {
    const directoryKey = "directory:/Users/huntharo/github/PwrAgent";
    const refreshedSnapshot = createDeferred<Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSnapshot"]>>>>();
    const initialSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-existing",
          title: "Existing thread",
          titleSource: "explicit" as const,
          summary: "Existing thread summary",
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
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/huntharo/github/PwrAgent",
          threadKeys: ["codex:thread-existing"],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/huntharo/github/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "Start the focus regression thread",
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
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockImplementationOnce(async () => await refreshedSnapshot.promise);
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
      expect(result.current.selectedThread?.id).toBe("thread-existing");
    });

    let materializePromise: Promise<void> | undefined;
    act(() => {
      materializePromise = result.current.materializeDirectoryLaunchpad(directoryKey);
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-new");
    });

    act(() => {
      result.current.selectThread(
        result.current.threads.find((thread) => thread.id === "thread-existing")!,
      );
    });
    expect(result.current.selectedThread?.id).toBe("thread-existing");

    await act(async () => {
      refreshedSnapshot.resolve({
        ...initialSnapshot,
        threads: [
          {
            id: "thread-new",
            title: "Fresh focus thread",
            titleSource: "derived" as const,
            summary: undefined,
            source: "codex" as const,
            linkedDirectories: [],
            inbox: {
              inInbox: true,
              reason: "new-thread" as const,
            },
            updatedAt: 2_000,
          },
          ...initialSnapshot.threads,
        ],
        directories: [
          {
            ...initialSnapshot.directories[0]!,
            launchpad: undefined,
            threadKeys: ["codex:thread-new", "codex:thread-existing"],
            needsAttentionCount: 1,
          },
        ],
      });
      await materializePromise;
    });

    expect(result.current.selectedThread?.id).toBe("thread-existing");
  });

  it("does not keep a directory launchpad selected when a thread in that directory is selected", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-1",
          title: "Existing thread",
          titleSource: "explicit" as const,
          summary: "Thread summary",
          source: "codex" as const,
          linkedDirectories: [
            {
              id: "launchpad:directory:/Users/huntharo/github/PwrAgent",
              label: "PwrAgent",
              path: "/Users/huntharo/github/PwrAgent",
              kind: "local" as const,
            },
          ],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: "directory:/Users/huntharo/github/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/huntharo/github/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey: "directory:/Users/huntharo/github/PwrAgent",
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/huntharo/github/PwrAgent",
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
    const launchpad = {
      directoryKey: "directory:/Users/huntharo/github/PwrAgent",
      directoryKind: "directory" as const,
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/huntharo/github/PwrAgent",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "worktree" as const,
      branchName: "main",
      createdAt: 1,
      updatedAt: 1,
    };
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      ensureDirectoryLaunchpad: vi.fn(async () => ({
        launchpad,
        defaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })),
      markThreadSeen: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        seenAt: Date.now(),
      })),
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(result.current.selectedLaunchpad).toBeUndefined();

    await act(async () => {
      await result.current.openDirectoryLaunchpad(result.current.directories[0]!);
    });

    expect(result.current.selectedLaunchpad?.directoryKey).toBe(
      "directory:/Users/huntharo/github/PwrAgent"
    );

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    expect(result.current.selectedThread?.id).toBe("thread-1");
    expect(result.current.selectedLaunchpad).toBeUndefined();
  });

  it("keeps newer launchpad edits when an older update response resolves later", async () => {
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const launchpad = {
      directoryKey: "directory:/Users/huntharo/github/PwrAgent",
      directoryKind: "directory" as const,
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/huntharo/github/PwrAgent",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "local" as const,
      branchName: "main",
      createdAt: 1,
      updatedAt: 1,
    };
    const olderUpdate = createDeferred<{
      defaults: typeof defaults;
      launchpad: typeof launchpad;
    }>();
    const newerUpdate = createDeferred<{
      defaults: typeof defaults;
      launchpad: typeof launchpad;
    }>();
    const updateDirectoryLaunchpad = vi
      .fn()
      .mockReturnValueOnce(olderUpdate.promise)
      .mockReturnValueOnce(newerUpdate.promise);
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "directory:/Users/huntharo/github/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/huntharo/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.directoryKey).toBe(
        "directory:/Users/huntharo/github/PwrAgent"
      );
    });

    let firstUpdate: Promise<void> | undefined;
    let secondUpdate: Promise<void> | undefined;
    act(() => {
      firstUpdate = result.current.updateDirectoryLaunchpad(
        "directory:/Users/huntharo/github/PwrAgent",
        { prompt: "older prompt" },
      );
      secondUpdate = result.current.updateDirectoryLaunchpad(
        "directory:/Users/huntharo/github/PwrAgent",
        { prompt: "newer prompt" },
      );
    });

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.prompt).toBe("newer prompt");
    });

    await act(async () => {
      newerUpdate.resolve({
        defaults,
        launchpad: {
          ...launchpad,
          prompt: "newer prompt",
          updatedAt: 3,
        },
      });
      await secondUpdate!;
    });
    expect(result.current.selectedLaunchpad?.prompt).toBe("newer prompt");

    await act(async () => {
      olderUpdate.resolve({
        defaults,
        launchpad: {
          ...launchpad,
          prompt: "older prompt",
          updatedAt: 2,
        },
      });
      await firstUpdate!;
    });

    expect(result.current.selectedLaunchpad?.prompt).toBe("newer prompt");
  });

  it("opens masthead new-thread drafts inside the Workspaces directory", async () => {
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "workspace:/Users/test/.pwragent/projects",
        directoryKind: "workspace" as const,
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "workspace:/Users/test/.pwragent/projects",
          kind: "workspace" as const,
          label: "Workspaces",
          path: "/Users/test/.pwragent/projects",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.label).toBe("Workspaces");
    });

    await act(async () => {
      await result.current.createThread();
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: "/Users/test/.pwragent/projects",
      preferredBackend: undefined,
    });
    expect(result.current.selectedItemKey).toBe(
      "launchpad:workspace:/Users/test/.pwragent/projects"
    );
    expect(result.current.selectedDirectory?.label).toBe("Workspaces");
    expect(result.current.selectedLaunchpad?.directoryKind).toBe("workspace");
    expect(result.current.directories.map((directory) => directory.label)).toEqual([
      "Workspaces",
    ]);
    expect(result.current.directories.some((directory) => directory.kind === "unlinked")).toBe(
      false
    );
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

  it("refreshes the selected thread when only reactions change", async () => {
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
            id: "019e0755-ac96-7be2-a94d-78a6912eccb6",
            title: "Emoji sync regression",
            titleSource: "explicit" as const,
            summary: "The thread whose reactions were disappearing.",
            source: "codex" as const,
            linkedDirectories: [],
            inbox: {
              inInbox: false,
            },
            reactions: navigationCallCount === 1 ? [] : ["👀", "🚀"],
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
      expect(result.current.selectedThread?.id).toBe(
        "019e0755-ac96-7be2-a94d-78a6912eccb6"
      );
    });
    expect(result.current.selectedThread?.reactions).toEqual([]);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "019e0755-ac96-7be2-a94d-78a6912eccb6",
              turnId: "turn-1",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.reactions).toEqual(["👀", "🚀"]);
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

  it("patches the snapshot for thread/executionMode/updated without refetching", async () => {
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
          source: "codex" as const,
          linkedDirectories: [],
          executionMode: "default" as const,
          inbox: { inInbox: true, reason: "new-thread" as const },
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
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.executionMode).toBe("default");
    });
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/executionMode/updated",
            params: {
              threadId: "thread-1",
              executionMode: "full-access",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.executionMode).toBe("full-access");
    });
    // Push-driven patch is immediate; an additional snapshot refresh
    // follows so the persisted permissionTransitionLog (which the
    // registry just appended an `applied` entry to) reaches the
    // renderer for transcript rendering.
    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("patches the snapshot for thread/executionMode/queued and queueCleared", async () => {
    const listeners = new Set<(event: any) => void>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "Queued thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          executionMode: "default" as const,
          inbox: { inInbox: true, reason: "new-thread" as const },
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
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.executionMode).toBe("default");
    });

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/executionMode/queued",
            params: {
              threadId: "thread-1",
              queuedExecutionMode: "full-access",
              queuedAt: 5_000,
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.queuedExecutionMode).toBe(
        "full-access",
      );
      expect(result.current.selectedThread?.queuedExecutionModeAt).toBe(5_000);
      // Applied mode is unchanged while queued.
      expect(result.current.selectedThread?.executionMode).toBe("default");
    });

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/executionMode/queueCleared",
            params: {
              threadId: "thread-1",
              reason: "cancelled",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.queuedExecutionMode).toBeUndefined();
      expect(
        result.current.selectedThread?.queuedExecutionModeAt,
      ).toBeUndefined();
    });
  });

  it("patches the snapshot for thread/modelSettings/updated without refetching", async () => {
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
          source: "codex" as const,
          linkedDirectories: [],
          model: "gpt-5",
          reasoningEffort: "low",
          fastMode: false,
          inbox: { inInbox: true, reason: "new-thread" as const },
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
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.model).toBe("gpt-5");
    });
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/modelSettings/updated",
            params: {
              threadId: "thread-1",
              model: "gpt-5.5",
              reasoningEffort: "high",
              fastMode: true,
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.model).toBe("gpt-5.5");
      expect(result.current.selectedThread?.reasoningEffort).toBe("high");
      expect(result.current.selectedThread?.fastMode).toBe(true);
    });
    // Push-driven patch — no full snapshot re-fetch.
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
  });

  it("removes a revoked messaging binding from the thread row after onMessagingBindingsChanged fires", async () => {
    const bindingsListeners = new Set<(event: { at: number }) => void>();
    let navigationCallCount = 0;
    const getNavigationSnapshot = vi.fn(async () => {
      navigationCallCount += 1;
      const messagingBindings =
        navigationCallCount === 1
          ? [
              {
                bindingId: "binding:telegram:topic:-1003841603622:5642:codex:thread-1",
                platform: "telegram" as const,
                conversationKind: "topic" as const,
                conversationTitle: "Knock Knock Rock",
                parentTitle: "PwrDrvr",
              },
              {
                bindingId: "binding:discord:channel:1480554271907905731:1501244021886943405:codex:thread-1",
                platform: "discord" as const,
                conversationKind: "channel" as const,
                conversationTitle: "knock-knock-rock",
                parentTitle: "PwrDrvr",
              },
            ]
          : [
              {
                bindingId: "binding:discord:channel:1480554271907905731:1501244021886943405:codex:thread-1",
                platform: "discord" as const,
                conversationKind: "channel" as const,
                conversationTitle: "knock-knock-rock",
                parentTitle: "PwrDrvr",
              },
            ];
      return {
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [
          {
            id: "thread-1",
            title: "Knock Knock Rock",
            titleSource: "explicit" as const,
            summary: "A thread that's bound to two messaging platforms.",
            source: "codex" as const,
            linkedDirectories: [],
            inbox: {
              inInbox: false,
            },
            // The reconciler bug we're regression-testing: this updatedAt
            // does NOT change between fetches, because the messaging
            // store mutates only the binding row, not the thread row.
            // Without `messagingBindings` in `threadSummariesEqual`, the
            // reconciler decides "nothing changed" and reuses the
            // previous thread reference (with stale bindings).
            updatedAt: 1_000,
            messagingBindings,
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
      onAgentEvent: () => () => undefined,
      onMessagingBindingsChanged: (callback: (event: { at: number }) => void) => {
        bindingsListeners.add(callback);
        return () => {
          bindingsListeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(result.current.selectedThread?.messagingBindings).toHaveLength(2);

    // Simulate the bus event the runtime fans out after a UI-originated
    // unbind: backend revokes the binding, fires onMessagingBindingsChanged,
    // and the renderer refetches. The next snapshot has only one binding.
    await act(async () => {
      for (const listener of bindingsListeners) {
        listener({ at: Date.now() });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.messagingBindings).toHaveLength(1);
    });
    expect(
      result.current.selectedThread?.messagingBindings?.[0]?.platform,
    ).toBe("discord");
  });

  describe("pickAndRegisterDirectory (issue #223)", () => {
    function buildBaseDesktopApi(
      overrides: Partial<DesktopApi> = {},
    ): DesktopApi {
      return {
        getNavigationSnapshot: vi.fn(async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        })),
        onAgentEvent: () => () => undefined,
        ...overrides,
      };
    }

    it("seeds the launchpad and focuses it on a successful pick", async () => {
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: false as const,
        path: "/Users/me/repos/PwrAgent",
      }));
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: true as const,
        directoryPath: "/Users/me/repos/PwrAgent",
        directoryKey: "directory:/Users/me/repos/PwrAgent",
        directoryLabel: "PwrAgent",
        currentBranch: "main",
        launchpad: {
          directoryKey: "directory:/Users/me/repos/PwrAgent",
          directoryKind: "directory" as const,
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/me/repos/PwrAgent",
          backend: "codex" as const,
          executionMode: "default" as const,
          prompt: "",
          workMode: "local" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        defaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      }));

      const desktopApi = buildBaseDesktopApi({
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.pickAndRegisterDirectory();
      });

      expect(pickDirectoryFromDisk).toHaveBeenCalledOnce();
      expect(registerDirectoryFromDisk).toHaveBeenCalledExactlyOnceWith({
        path: "/Users/me/repos/PwrAgent",
        preferredBackend: undefined,
      });
      expect(result.current.pickDirectoryError).toBeUndefined();
      expect(result.current.pickingDirectory).toBe(false);
      expect(result.current.selectedItemKey).toBe(
        "launchpad:directory:/Users/me/repos/PwrAgent",
      );
    });

    it("is silent when the user cancels the OS dialog", async () => {
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: true as const,
      }));
      const registerDirectoryFromDisk = vi.fn();
      const desktopApi = buildBaseDesktopApi({
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.pickAndRegisterDirectory();
      });

      expect(registerDirectoryFromDisk).not.toHaveBeenCalled();
      expect(result.current.pickDirectoryError).toBeUndefined();
    });

    it("surfaces an inline error when the chosen path is not a git repo", async () => {
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: false as const,
        path: "/tmp/not-a-repo",
      }));
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: false as const,
        reason: "not-a-git-repo" as const,
        message: "/tmp/not-a-repo is not inside a git repository.",
      }));
      const desktopApi = buildBaseDesktopApi({
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.pickAndRegisterDirectory();
      });

      expect(result.current.pickDirectoryError).toContain("not inside a git");
      expect(result.current.selectedItemKey).toBeUndefined();

      // clearPickDirectoryError resets the inline error state.
      act(() => {
        result.current.clearPickDirectoryError();
      });
      expect(result.current.pickDirectoryError).toBeUndefined();
    });
  });
});
