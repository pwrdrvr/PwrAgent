import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopApi } from "../desktop-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadNavigation } from "../useThreadNavigation";

describe("useThreadNavigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
