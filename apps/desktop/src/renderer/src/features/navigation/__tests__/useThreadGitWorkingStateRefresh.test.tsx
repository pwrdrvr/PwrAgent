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

  it("refreshes a selected thread from its linked local directory", async () => {
    const refreshThreadGitWorkingState = vi.fn(async () => ({ scheduled: true }));
    const desktopApi = {
      refreshThreadGitWorkingState,
    } satisfies DesktopApi;

    renderHook(() =>
      useThreadGitWorkingStateRefresh({
        desktopApi,
        selectedThread: buildThread({
          projectKey: undefined,
          linkedDirectories: [
            {
              id: "directory:/repo/local",
              kind: "local",
              label: "local",
              path: "/repo/local",
            },
          ],
        }),
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

  it("routes remote-owned refreshes to the thread-owning instance", async () => {
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

    await waitFor(() => {
      expect(refreshThreadGitWorkingState).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        trigger: "scheduled",
        federationTarget: { scope: "remote", instanceId: "peer-laptop" },
      });
    });

    result.current.prefetch(remoteThread);

    await waitFor(() => {
      expect(refreshThreadGitWorkingState).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        trigger: "user",
        federationTarget: { scope: "remote", instanceId: "peer-laptop" },
      });
    });
  });

  it("targets the fronted instance from a federation window hover", async () => {
    const refreshThreadGitWorkingState = vi.fn(async () => ({ scheduled: true }));
    const desktopApi = {
      refreshThreadGitWorkingState,
    } satisfies DesktopApi;
    const federationWindow = window as typeof window & {
      __pwragentFederationTarget?: { scope: "remote"; instanceId: string };
    };
    federationWindow.__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "pwr_owner",
    };
    try {
      const { result } = renderHook(() =>
        useThreadGitWorkingStateRefresh({ desktopApi }),
      );

      result.current.prefetch(buildThread());

      await waitFor(() => {
        expect(refreshThreadGitWorkingState).toHaveBeenCalledWith({
          backend: "codex",
          threadId: "thread-1",
          trigger: "user",
          federationTarget: { scope: "remote", instanceId: "pwr_owner" },
        });
      });
    } finally {
      delete federationWindow.__pwragentFederationTarget;
    }
  });
});
