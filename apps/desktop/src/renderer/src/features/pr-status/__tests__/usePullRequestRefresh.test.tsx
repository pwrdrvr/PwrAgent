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
    ghAvailable: true,
    prs: [
      {
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
});
