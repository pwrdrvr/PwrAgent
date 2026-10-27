import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAppearanceDensity, NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { usePullRequestRefresh } from "../../pr-status/usePullRequestRefresh";
import { ThreadRow } from "../ThreadRow";
import { ThreadRowDensityContext } from "../thread-row-density";

const openPr: PrSummary = {
  provider: "github.com",
  org: "acme",
  repo: "orbit",
  number: 12,
  title: "Refresh the PR chip",
  url: "https://github.com/acme/orbit/pull/12",
  state: "passing",
  lifecycleState: "open",
  checkState: "passing",
  reviewState: "ready_for_review",
  mergeState: "mergeable",
};
const mergedPr: PrSummary = { ...openPr, state: "merged", lifecycleState: "merged" };
const olderPr: PrSummary = {
  ...mergedPr,
  number: 11,
  url: "https://github.com/acme/orbit/pull/11",
};

function buildThread(prs: PrSummary[]): NavigationThreadSummary {
  return {
    id: "thread-pr-hover",
    source: "codex",
    title: "PR hover refresh",
    titleSource: "explicit",
    updatedAt: 1,
    inbox: { inInbox: false },
    gitBranch: "fix/pr-hover",
    linkedDirectories: [{ id: "directory:/repo", kind: "local", label: "repo", path: "/repo" }],
    prs,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each<DesktopAppearanceDensity>(["minimal", "compact", "mission-control"])("%s PR hover refresh", (density) => {
  // Minimal's visible chip is outside the ordinary chip flow. Target that
  // chip explicitly: hovering the hidden flow would conceal the regression.
  const chipSelector = density === "minimal"
    ? ".thread-row__pr-rollup .pr-chip"
    : ".thread-row__chips [data-pr-chip]";

  it.each([false, true])("refreshes a merged PR under a resting pointer (multiple=%s)", async (multiple) => {
    vi.useFakeTimers();
    const initialPrs = multiple ? [openPr, olderPr] : [openPr];
    const refreshedPrs = multiple ? [mergedPr, olderPr] : [mergedPr];
    let completeRefresh!: () => void;
    const responseReady = new Promise<void>((resolve) => { completeRefresh = resolve; });
    const refreshThreadPullRequests = vi.fn(async () => {
      await responseReady;
      return {
        backend: "codex" as const,
        threadId: "thread-pr-hover",
        provider: "github.com",
        ghAvailable: true,
        prs: refreshedPrs,
      };
    });
    const desktopApi = { refreshThreadPullRequests } satisfies DesktopApi;
    const onRefreshNavigation = vi.fn();
    function Harness() {
      const [thread, setThread] = useState(() => buildThread(initialPrs));
      const { prefetch } = usePullRequestRefresh({
        desktopApi,
        onRefreshNavigation: async () => {
          onRefreshNavigation();
          setThread(buildThread(refreshedPrs));
        },
      });
      return (
        <ThreadRowDensityContext.Provider value={density}>
          <ThreadRow
            thread={thread}
            onPrefetchPullRequests={prefetch}
            onSelectThread={vi.fn()}
            onOpenContextMenu={vi.fn()}
          />
        </ThreadRowDensityContext.Provider>
      );
    }
    const { container } = render(<Harness />);
    const chip = container.querySelector(chipSelector)!;
    expect(chip).toHaveClass("pr-chip--passing");
    fireEvent.mouseOver(chip);
    await act(async () => { vi.advanceTimersByTime(749); });
    expect(refreshThreadPullRequests).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });

    expect(refreshThreadPullRequests).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      threadId: "thread-pr-hover",
      trigger: "user",
      branch: "fix/pr-hover",
      directoryPaths: ["/repo"],
    });
    if (multiple && density === "minimal") {
      const list = screen.getByRole("group", { name: "Pull requests for PR hover refresh" });
      const row = list.querySelector(".pr-rollup-popover__row")!;
      // Cross the portal boundary while the request is still pending, so
      // the nested detail card is already open when fresh status arrives.
      fireEvent.mouseOut(chip, { relatedTarget: row });
      fireEvent.mouseOver(row, { relatedTarget: chip });
      await act(async () => { vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS); });
    }
    expect(screen.getByRole("tooltip")).toHaveTextContent("checks passing");
    expect(onRefreshNavigation).not.toHaveBeenCalled();
    await act(async () => { completeRefresh(); });

    expect(onRefreshNavigation).toHaveBeenCalledOnce();
    expect(refreshThreadPullRequests).toHaveBeenCalledOnce();
    expect(container.querySelector(chipSelector)).toHaveClass("pr-chip--merged");
    expect(screen.getByRole("tooltip")).toHaveTextContent("merged");
    if (multiple && density === "minimal") {
      expect(screen.getByRole("group", { name: "Pull requests for PR hover refresh" }))
        .toHaveTextContent("all merged");
    }
  });

  it.each(["leave", "unmount"])("cancels the pending refresh on %s", (action) => {
    vi.useFakeTimers();
    const onPrefetchPullRequests = vi.fn();
    const view = render(
      <ThreadRowDensityContext.Provider value={density}>
        <ThreadRow
          thread={buildThread([openPr])}
          onPrefetchPullRequests={onPrefetchPullRequests}
          onSelectThread={vi.fn()}
          onOpenContextMenu={vi.fn()}
        />
      </ThreadRowDensityContext.Provider>,
    );
    const chip = view.container.querySelector(chipSelector)!;
    fireEvent.mouseOver(chip);
    act(() => { vi.advanceTimersByTime(300); });
    if (action === "leave") {
      fireEvent.mouseOut(chip, { relatedTarget: document.body });
    } else {
      view.unmount();
    }
    act(() => { vi.advanceTimersByTime(750); });
    expect(onPrefetchPullRequests).not.toHaveBeenCalled();
  });
});
