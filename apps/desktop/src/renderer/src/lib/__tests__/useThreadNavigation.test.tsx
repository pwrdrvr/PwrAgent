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
                runId: "run-1",
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
});
