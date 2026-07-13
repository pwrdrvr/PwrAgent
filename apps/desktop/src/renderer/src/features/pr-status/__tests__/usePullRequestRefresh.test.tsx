import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  RefreshThreadPullRequestsResponse,
} from "@pwragent/shared";
import { usePullRequestRefresh } from "../usePullRequestRefresh";
import type { DesktopApi } from "../../../lib/desktop-api";

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
    linkedDirectories: [
      {
        id: "directory:/repo",
        kind: "local",
        label: "repo",
        path: "/repo",
      },
    ],
    gitBranch: "feat/pr-chip",
    ...overrides,
  };
}

function buildResponse(
  overrides: Partial<RefreshThreadPullRequestsResponse> = {},
): RefreshThreadPullRequestsResponse {
  return {
    backend: "codex",
    threadId: "thread-1",
    provider: "github.com",
    ghAvailable: true,
    prs: [
      {
        provider: "github.com",
        number: 249,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "passing",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/249",
      },
    ],
    ...overrides,
  };
}

describe("usePullRequestRefresh", () => {
  it("refreshes navigation when the PR probe returns changed PRs", async () => {
    const onRefreshNavigation = vi.fn(async () => undefined);
    const refreshThreadPullRequests = vi.fn(async () => buildResponse());
    const desktopApi = {
      refreshThreadPullRequests,
    } satisfies DesktopApi;

    renderHook(() =>
      usePullRequestRefresh({
        desktopApi,
        onRefreshNavigation,
        selectedThread: buildThread(),
      }),
    );

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        trigger: "scheduled",
        branch: "feat/pr-chip",
        directoryPaths: ["/repo"],
      });
    });
    await waitFor(() => {
      expect(onRefreshNavigation).toHaveBeenCalledOnce();
    });
  });

  it("does not refresh navigation when the PR probe matches current PRs", async () => {
    const response = buildResponse();
    const onRefreshNavigation = vi.fn(async () => undefined);
    const refreshThreadPullRequests = vi.fn(async () => response);
    const desktopApi = {
      refreshThreadPullRequests,
    } satisfies DesktopApi;

    renderHook(() =>
      usePullRequestRefresh({
        desktopApi,
        onRefreshNavigation,
        selectedThread: buildThread({ prs: response.prs }),
      }),
    );

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledOnce();
    });
    expect(onRefreshNavigation).not.toHaveBeenCalled();
  });

  it("does not refresh again when the selected thread object is replaced", async () => {
    const response = buildResponse({ prs: [] });
    const refreshThreadPullRequests = vi.fn(async () => response);
    const desktopApi = {
      refreshThreadPullRequests,
    } satisfies DesktopApi;

    const { rerender } = renderHook(
      ({ selectedThread }: { selectedThread: NavigationThreadSummary }) =>
        usePullRequestRefresh({
          desktopApi,
          selectedThread,
        }),
      {
        initialProps: {
          selectedThread: buildThread({ prs: [] }),
        },
      },
    );

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledOnce();
    });

    rerender({
      selectedThread: buildThread({ prs: [], updatedAt: 99 }),
    });

    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(refreshThreadPullRequests).toHaveBeenCalledOnce();
  });

  it("does not refresh again when only the navigation refresh callback changes", async () => {
    const response = buildResponse({ prs: [] });
    const refreshThreadPullRequests = vi.fn(async () => response);
    const desktopApi = {
      refreshThreadPullRequests,
    } satisfies DesktopApi;

    const { rerender } = renderHook(
      ({ onRefreshNavigation }: { onRefreshNavigation: () => Promise<void> }) =>
        usePullRequestRefresh({
          desktopApi,
          onRefreshNavigation,
          selectedThread: buildThread({ prs: [] }),
        }),
      {
        initialProps: {
          onRefreshNavigation: vi.fn(async () => undefined),
        },
      },
    );

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledOnce();
    });

    rerender({
      onRefreshNavigation: vi.fn(async () => undefined),
    });

    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(refreshThreadPullRequests).toHaveBeenCalledOnce();
  });

  it("refreshes again when the selected thread PR request changes", async () => {
    const response = buildResponse({ prs: [] });
    const refreshThreadPullRequests = vi.fn(async () => response);
    const desktopApi = {
      refreshThreadPullRequests,
    } satisfies DesktopApi;

    const { rerender } = renderHook(
      ({ selectedThread }: { selectedThread: NavigationThreadSummary }) =>
        usePullRequestRefresh({
          desktopApi,
          selectedThread,
        }),
      {
        initialProps: {
          selectedThread: buildThread({ prs: [] }),
        },
      },
    );

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledOnce();
    });

    rerender({
      selectedThread: buildThread({ gitBranch: "feat/next", prs: [] }),
    });

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledTimes(2);
    });
    expect(refreshThreadPullRequests).toHaveBeenLastCalledWith({
      backend: "codex",
      threadId: "thread-1",
      trigger: "scheduled",
      branch: "feat/next",
      directoryPaths: ["/repo"],
    });
  });

  it("uses the observed branch for PR refresh when it differs from the expected branch", async () => {
    const refreshThreadPullRequests = vi.fn(async () => buildResponse({ prs: [] }));
    const desktopApi = {
      refreshThreadPullRequests,
    } satisfies DesktopApi;

    renderHook(() =>
      usePullRequestRefresh({
        desktopApi,
        selectedThread: buildThread({
          gitBranch: "feat/old",
          observedGitBranch: "fix/new-pr",
          prs: [],
        }),
      }),
    );

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        trigger: "scheduled",
        branch: "fix/new-pr",
        directoryPaths: ["/repo"],
      });
    });
  });

  it("marks hover prefetches as user-triggered refreshes", async () => {
    const refreshThreadPullRequests = vi.fn(async () => buildResponse({ prs: [] }));
    const desktopApi = {
      refreshThreadPullRequests,
    } satisfies DesktopApi;

    const { result } = renderHook(() =>
      usePullRequestRefresh({
        desktopApi,
      }),
    );

    result.current.prefetch(buildThread());

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        trigger: "user",
        branch: "feat/pr-chip",
        directoryPaths: ["/repo"],
      });
    });
  });

  it("prefetches retained PR chips from HEAD worktree links", async () => {
    const refreshThreadPullRequests = vi.fn(async () => buildResponse({ prs: [] }));
    const desktopApi = {
      refreshThreadPullRequests,
    } satisfies DesktopApi;

    const { result } = renderHook(() =>
      usePullRequestRefresh({
        desktopApi,
      }),
    );

    result.current.prefetch(buildThread({
      gitBranch: undefined,
      linkedDirectories: [
        {
          id: "/repo/app",
          kind: "worktree",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/.worktrees/app",
          gitBranch: "HEAD",
        },
      ],
      prs: buildResponse().prs,
    }));

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        trigger: "user",
        branch: "HEAD",
        directoryPaths: ["/repo/.worktrees/app"],
      });
    });
  });

  it("scopes directory-derived branch refreshes to matching linked directories", async () => {
    const refreshThreadPullRequests = vi.fn(async () => buildResponse({ prs: [] }));
    const desktopApi = {
      refreshThreadPullRequests,
    } satisfies DesktopApi;

    const { result } = renderHook(() =>
      usePullRequestRefresh({
        desktopApi,
      }),
    );

    result.current.prefetch(buildThread({
      gitBranch: undefined,
      linkedDirectories: [
        {
          id: "/repo/app",
          kind: "worktree",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/.worktrees/app",
          gitBranch: "feat/app",
        },
        {
          id: "/repo/docs",
          kind: "worktree",
          label: "docs",
          path: "/repo/docs",
          worktreePath: "/repo/.worktrees/docs",
          gitBranch: "feat/docs",
        },
      ],
      prs: [],
    }));

    await waitFor(() => {
      expect(refreshThreadPullRequests).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        trigger: "user",
        branch: "feat/app",
        directoryPaths: ["/repo/.worktrees/app"],
      });
    });
  });
});
