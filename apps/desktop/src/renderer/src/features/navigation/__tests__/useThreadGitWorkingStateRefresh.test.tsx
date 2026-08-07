import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildFederatedThreadRef,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useThreadGitWorkingStateRefresh } from "../useThreadGitWorkingStateRefresh";

function buildThread(
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id: "thread-1",
    source: "codex",
    title: "Thread",
    titleSource: "explicit",
    createdAt: 1,
    updatedAt: 2,
    inbox: { inInbox: false },
    linkedDirectories: [],
    projectKey: "/repo/worktree",
    ...overrides,
  };
}

describe("useThreadGitWorkingStateRefresh", () => {
  it("puts the selected thread on the scheduled refresh tier", async () => {
    const refreshThreadGitWorkingState = vi.fn(async () => ({ scheduled: true }));
    const desktopApi = {
      refreshThreadGitWorkingState,
    } satisfies DesktopApi;

    renderHook(() =>
      useThreadGitWorkingStateRefresh({
        desktopApi,
        selectedThread: buildThread(),
      }),
    );

    await waitFor(() => {
      expect(refreshThreadGitWorkingState).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        trigger: "scheduled",
      });
    });
  });

  it("marks deliberate hover prefetches as user-triggered", async () => {
    const refreshThreadGitWorkingState = vi.fn(async () => ({ scheduled: true }));
    const desktopApi = {
      refreshThreadGitWorkingState,
    } satisfies DesktopApi;
    const { result } = renderHook(() =>
      useThreadGitWorkingStateRefresh({ desktopApi }),
    );

    result.current.prefetch(buildThread());

    await waitFor(() => {
      expect(refreshThreadGitWorkingState).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        trigger: "user",
      });
    });
  });

  it("does not refresh remote-owned threads from the viewer", async () => {
    const refreshThreadGitWorkingState = vi.fn(async () => ({ scheduled: true }));
    const desktopApi = {
      refreshThreadGitWorkingState,
    } satisfies DesktopApi;
    const remoteThread = buildThread({
      federation: {
        ref: buildFederatedThreadRef({
          backend: "codex",
          instanceId: "peer-laptop",
          threadId: "thread-1",
        }),
        instanceLabel: "Laptop",
        peerStatus: "connected",
      },
    });
    const { result } = renderHook(() =>
      useThreadGitWorkingStateRefresh({
        desktopApi,
        selectedThread: remoteThread,
      }),
    );

    result.current.prefetch(remoteThread);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(refreshThreadGitWorkingState).not.toHaveBeenCalled();
  });
});
