import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  PrSummary,
  ThreadPrAutoFixState,
  ThreadPrWatchHistoryEntry,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../../lib/desktop-api";
import {
  summarizeThreadPrWatches,
  ThreadPrWatchIndicatorsContext,
  type ThreadPrWatchIndicatorsValue,
} from "../../../pr-watches/useThreadPrWatchIndicators";
import { PullRequestsPanel } from "../PullRequestsPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const baseThread: NavigationThreadSummary = {
  id: "thread-1",
  title: "Thread",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
  inbox: { inInbox: false },
};

function threadWithPrs(prs: PrSummary[]): NavigationThreadSummary {
  return { ...baseThread, prs };
}

describe("PullRequestsPanel", () => {
  it("renders a card with a clickable PrChip, status pills, title, and repo", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <PullRequestsPanel
        thread={threadWithPrs([
          {
            provider: "github.com",
            number: 233,
            org: "pwrdrvr",
            repo: "PwrSnap",
            title: "fix(desktop): polish the PR panel",
            state: "passing",
            checkState: "passing",
            lifecycleState: "open",
            reviewState: "ready_for_review",
            url: "https://github.com/pwrdrvr/PwrSnap/pull/233",
          },
        ])}
      />,
    );

    const card = screen.getByRole("listitem");
    // #number is the same clickable PrChip used in the sidebar.
    expect(within(card).getByText("#233")).toHaveClass("pr-chip__label");
    // Status reads as a pill with a colored dot (no competing inline status).
    const checksPill = within(card).getByText("Checks passing");
    expect(checksPill).toHaveClass("rail-chip");
    expect(checksPill.querySelector(".rail-chip__dot--ok")).not.toBeNull();
    expect(within(card).getByText("fix(desktop): polish the PR panel")).toBeInTheDocument();
    expect(within(card).getByText("github.com/pwrdrvr/PwrSnap")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: /Open pwrdrvr\/PwrSnap#233/ }));
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrSnap/pull/233",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("tints failing + conflicting PRs so they stand out", () => {
    render(
      <PullRequestsPanel
        thread={threadWithPrs([
          {
            provider: "github.com",
            number: 12,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "wip",
            state: "failing",
            checkState: "failing",
            lifecycleState: "open",
            reviewState: "ready_for_review",
            mergeState: "conflicting",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/12",
          },
        ])}
      />,
    );

    expect(screen.getByText("Merge conflict")).toHaveClass("rail-chip--alert");
    expect(screen.getByText("Checks failing")).toHaveClass("rail-chip--alert");
  });

  it("labels and pulses a failure while checks are still running", () => {
    render(
      <PullRequestsPanel
        thread={threadWithPrs([
          {
            provider: "github.com",
            number: 13,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "mixed CI state",
            state: "failing",
            checkState: "failing",
            checksStillRunning: true,
            lifecycleState: "open",
            reviewState: "ready_for_review",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/13",
          },
        ])}
      />,
    );

    const checksPill = screen.getByText("Checks failing · still running");
    expect(checksPill.querySelector(".rail-chip__dot--blink")).not.toBeNull();
    expect(screen.getByRole("button", {
      name: /checks failing · checks still running/,
    })).toHaveClass("pr-chip--checks-running");
  });

  it("defers draft + conflict to the pills — the card's chip stays check-state", () => {
    // Regression guard for `withStatusPills`: a draft + conflicting PR whose
    // checks pass would, on a standalone chip, render a red dot + draft bar.
    // Inside the card the chip must instead mirror the CHECK state (green) so
    // it agrees with the "Checks passing" pill — draft + conflict are carried
    // by the pills, never duplicated on the chip.
    render(
      <PullRequestsPanel
        thread={threadWithPrs([
          {
            provider: "github.com",
            number: 77,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "draft + conflict, checks passing",
            state: "passing",
            checkState: "passing",
            lifecycleState: "open",
            reviewState: "draft",
            mergeState: "conflicting",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/77",
          },
        ])}
      />,
    );

    const card = screen.getByRole("listitem");
    const chip = within(card).getByRole("button", {
      name: /Open pwrdrvr\/PwrAgent#77/,
    });
    expect(chip).toHaveClass("pr-chip--passing");
    expect(chip).not.toHaveClass("pr-chip--conflicting");
    expect(chip).not.toHaveClass("pr-chip--draft");
    expect(chip.querySelector(".pr-chip__draft-bar")).toBeNull();
    // The dimensions surface as pills instead.
    expect(within(card).getByText("Draft")).toHaveClass("rail-chip");
    expect(within(card).getByText("Merge conflict")).toHaveClass("rail-chip");
    expect(within(card).getByText("Checks passing")).toHaveClass("rail-chip");
  });

  it("labels merged PRs (no checks pill) and falls back to a generic title", () => {
    render(
      <PullRequestsPanel
        thread={threadWithPrs([
          {
            provider: "github.com",
            number: 99,
            org: "pwrdrvr",
            repo: "PwrAgent",
            state: "merged",
            lifecycleState: "merged",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/99",
          },
        ])}
      />,
    );

    const merged = screen.getByText("Merged");
    expect(merged).toHaveClass("rail-chip");
    expect(merged.querySelector(".rail-chip__dot--merged")).not.toBeNull();
    expect(screen.getByText("Pull request #99")).toBeInTheDocument();
    expect(screen.queryByText(/Checks/)).not.toBeInTheDocument();
  });

  it("orders PRs newest first by number", () => {
    render(
      <PullRequestsPanel
        thread={threadWithPrs([
          {
            provider: "github.com",
            number: 386,
            org: "pwrdrvr",
            repo: "PwrAgent",
            state: "closed",
            lifecycleState: "closed",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/386",
          },
          {
            provider: "github.com",
            number: 691,
            org: "pwrdrvr",
            repo: "PwrAgent",
            state: "failing",
            checkState: "failing",
            lifecycleState: "open",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/691",
          },
        ])}
      />,
    );

    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]!).getByText("#691")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("#386")).toBeInTheDocument();
  });

  it("renders an empty state when there are no PRs", () => {
    render(<PullRequestsPanel thread={baseThread} />);

    expect(
      screen.getByText("No pull requests linked to this thread yet."),
    ).toBeInTheDocument();
  });

  describe("Wakes this thread", () => {
    const openPr: PrSummary = {
      provider: "github.com",
      number: 3174,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "fix(desktop): arm CI watches after re-runs",
      state: "pending",
      checkState: "pending",
      lifecycleState: "open",
      reviewState: "ready_for_review",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/3174",
    };
    const ciWatch: ThreadPullRequestWatchSummary = {
      watchId: "watch-ci",
      backend: "codex",
      threadId: "thread-1",
      prKey: "github.com/pwrdrvr/pwragent#3174",
      prUrl: openPr.url,
      prNumber: 3174,
      headSha: "9f2c41a0000000000000000000000000000000000",
      notifyOn: ["success", "failure"],
      createdAt: Date.now(),
      failureHandledByAutoFix: false,
      kind: "checks",
      baseline: { outcome: "failure", observedAt: Date.now(), runAttempt: 2 },
    };
    const terminalWatch: ThreadPullRequestWatchSummary = {
      ...ciWatch,
      watchId: "watch-merge",
      notifyOn: ["merged", "closed"],
      kind: "terminal",
      baseline: undefined,
    };

    function autoFixThread(prs: PrSummary[]): NavigationThreadSummary {
      return { ...threadWithPrs(prs), prAutoDispatchEnabled: true, primaryGitRepository: "github.com/pwrdrvr/pwragent" };
    }

    function renderPanel(options: {
      thread?: NavigationThreadSummary;
      watches?: ThreadPullRequestWatchSummary[];
      autoFix?: ThreadPrAutoFixState[];
      context?: Partial<ThreadPrWatchIndicatorsValue>;
      desktopApi?: Pick<DesktopApi, "manageThreadPrWatches">;
    } = {}) {
      const stop = vi.fn(async () => undefined);
      const askAgentToWatchCi = vi.fn();
      const onSetThreadPrAutoDispatch = vi.fn(async () => undefined);
      const thread = options.thread ?? autoFixThread([openPr]);
      render(
        <ThreadPrWatchIndicatorsContext.Provider value={{
          byThreadKey: summarizeThreadPrWatches(options.watches ?? [], options.autoFix),
          stop,
          askAgentToWatchCi,
          ...options.context,
        }}>
          <PullRequestsPanel
            desktopApi={options.desktopApi}
            onSetThreadPrAutoDispatch={onSetThreadPrAutoDispatch}
            thread={thread}
          />
        </ThreadPrWatchIndicatorsContext.Provider>,
      );
      return { stop, askAgentToWatchCi, onSetThreadPrAutoDispatch, thread };
    }

    it("lists each watch and Auto-fix with a way to stop each", async () => {
      const { stop, onSetThreadPrAutoDispatch } = renderPanel({ watches: [ciWatch, terminalWatch] });
      const card = screen.getByRole("listitem");
      expect(within(card).getByText("Wakes this thread")).toBeInTheDocument();
      expect(within(card).getByText("Waiting for CI · attempt 2")).toBeInTheDocument();
      const ciSub = within(card).getByText(/^On pass or fail\. Agent, /);
      expect(ciSub).toHaveTextContent("Attempt 1's failure will not wake it.");
      expect(within(card).getByText("Waiting for merge or close")).toBeInTheDocument();
      expect(within(card).getByText("Starts a repair turn when a new push fails CI.")).toBeInTheDocument();
      expect(within(card).queryByText("Not waiting for CI.")).toBeNull();
      // The chip in the card wears the eye too.
      expect(card.querySelector(".pr-chip .pr-chip__watch")).not.toBeNull();

      // Each Stop disables itself until the stop settles.
      await act(async () => {
        fireEvent.click(within(card).getByRole("button", { name: "Stop waiting for CI on #3174" }));
      });
      expect(stop).toHaveBeenCalledWith(ciWatch);
      await act(async () => {
        fireEvent.click(within(card).getByRole("button", { name: "Stop watching #3174 for merge" }));
      });
      expect(stop).toHaveBeenCalledWith(terminalWatch);
      // The setting is the thread's, so the button says so.
      fireEvent.click(within(card).getByRole("button", { name: "Turn off Auto-fix for this thread" }));
      expect(onSetThreadPrAutoDispatch).toHaveBeenCalledWith(false);
    });

    it("lists Auto-fix only where it can wake the thread", () => {
      const linkedPr: PrSummary = {
        ...openPr,
        number: 12,
        repo: "docs.pwragent.ai",
        url: "https://github.com/pwrdrvr/docs.pwragent.ai/pull/12",
      };
      renderPanel({ thread: autoFixThread([openPr, linkedPr]), context: { autoFixAvailable: true } });
      const cards = screen.getAllByRole("listitem");
      const docsCard = cards.find((card) => card.textContent?.includes("docs.pwragent.ai"))!;
      const primaryCard = cards.find((card) => card !== docsCard)!;
      expect(within(primaryCard).getByText("Auto-fix")).toBeInTheDocument();
      // Auto-fix never polls a linked directory's PR.
      expect(within(docsCard).queryByText("Auto-fix")).toBeNull();
      cleanup();

      // Git settings turned Auto-fix off: the thread's saved opt-in wakes nothing.
      renderPanel({ context: { autoFixAvailable: false } });
      expect(within(screen.getByRole("listitem")).queryByText("Auto-fix")).toBeNull();
      expect(screen.queryByRole("button", { name: "Turn off Auto-fix for this thread" })).toBeNull();
    });

    it("says Auto-fix is paused or handled by another thread instead of claiming a wake", () => {
      const state: ThreadPrAutoFixState = {
        backend: "codex", threadId: "thread-1", prKey: ciWatch.prKey, state: "paused",
      };
      const paused = renderPanel({ autoFix: [state], context: { autoFixAvailable: true } });
      let card = screen.getByRole("listitem");
      expect(within(card).getByText("Auto-fix paused")).toBeInTheDocument();
      expect(within(card).queryByText("Starts a repair turn when a new push fails CI.")).toBeNull();
      // Paused, the opt-in still resumes here, so it can still be turned off.
      fireEvent.click(within(card).getByRole("button", { name: "Turn off Auto-fix for this thread" }));
      expect(paused.onSetThreadPrAutoDispatch).toHaveBeenCalledWith(false);
      cleanup();

      renderPanel({
        autoFix: [{
          ...state, state: "handled_by_other_thread",
          handledBy: { backend: "codex", threadId: "thread-2", title: "Owns the repairs" },
        }],
        context: { autoFixAvailable: true },
      });
      card = screen.getByRole("listitem");
      expect(within(card).getByText("Auto-fix handled by Owns the repairs")).toBeInTheDocument();
      expect(within(card).queryByText("Starts a repair turn when a new push fails CI.")).toBeNull();
      expect(within(card).queryByRole("button", { name: "Turn off Auto-fix for this thread" })).toBeNull();
    });

    it("hints at asking for a CI watch when nothing waits for CI", () => {
      const { askAgentToWatchCi, thread } = renderPanel({
        thread: threadWithPrs([openPr]),
        watches: [terminalWatch],
      });
      const card = screen.getByRole("listitem");
      expect(within(card).getByText("Not waiting for CI.")).toBeInTheDocument();
      expect(within(card).queryByText("Auto-fix")).toBeNull();
      fireEvent.click(within(card).getByRole("button", { name: "Ask Agent to Watch CI" }));
      expect(askAgentToWatchCi).toHaveBeenCalledWith(thread, openPr);
    });

    it("loads the history on first expand and counts this PR's ended watches", async () => {
      const history: ThreadPrWatchHistoryEntry[] = [
        { ...ciWatch, watchId: "ended-1", status: "dispatched", updatedAt: Date.now(), endedReason: "woke", wokeOn: "failure" },
        { ...ciWatch, watchId: "ended-2", status: "superseded", updatedAt: Date.now() - 1, endedReason: "moved", movedTo: "watch-ci" },
        { ...ciWatch, watchId: "other-pr", prKey: "github.com/pwrdrvr/pwragent#1", status: "cancelled", updatedAt: 1 },
      ];
      const manageThreadPrWatches = vi.fn(async () => ({ ok: true as const, history }));
      renderPanel({ watches: [ciWatch], desktopApi: { manageThreadPrWatches } });
      expect(manageThreadPrWatches).not.toHaveBeenCalled();
      const toggle = screen.getByRole("button", { name: "History" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      await act(async () => {
        fireEvent.click(toggle);
      });
      expect(manageThreadPrWatches).toHaveBeenCalledWith({
        action: "history",
        backend: "codex",
        threadId: "thread-1",
        limit: 20,
      });
      expect(screen.getByRole("button", { name: "History (2)" })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Woke the thread · CI failed")).toBeInTheDocument();
      expect(screen.getByText("Moved to new head · 9f2c41a")).toBeInTheDocument();
      expect(screen.queryByText("Stopped")).toBeNull();
    });

    it("says the history could not load instead of claiming none ended, and retries on the next expand", async () => {
      const manageThreadPrWatches = vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { code: "invalid_arguments", message: "state is closing" } })
        .mockResolvedValueOnce({ ok: true, history: [
          { ...ciWatch, watchId: "ended-1", status: "dispatched", updatedAt: Date.now(), endedReason: "another_thread_woke", wokeOn: "success" },
        ] });
      renderPanel({ watches: [ciWatch], desktopApi: { manageThreadPrWatches } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "History" }));
      });
      expect(screen.getByText("Couldn't load history.")).toBeInTheDocument();
      expect(screen.queryByText("No watch has ended yet.")).toBeNull();
      expect(screen.queryByRole("button", { name: /History \(/ })).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "History" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "History" }));
      });
      expect(manageThreadPrWatches).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "History (1)" })).toBeInTheDocument();
      expect(screen.getByText("Another thread was woken · CI passed")).toBeInTheDocument();
    });

    it("shows a peer's watches read-only and names where to stop them", () => {
      renderPanel({
        thread: {
          ...threadWithPrs([openPr]),
          prAutoDispatchEnabled: true,
          activePrWatches: [ciWatch],
          federation: {
            ref: { backend: "codex", target: { scope: "remote", instanceId: "peer" }, threadId: "thread-1" },
            instanceLabel: "Laptop",
            peerStatus: "connected",
            capabilities: [],
          },
        } as NavigationThreadSummary,
        // A local list for the same id must not leak onto the peer's card.
        watches: [terminalWatch],
      });
      const card = screen.getByRole("listitem");
      expect(within(card).getByText("Waiting for CI · attempt 2")).toBeInTheDocument();
      expect(within(card).queryByText("Waiting for merge or close")).toBeNull();
      expect(within(card).getByText("Watches run on Laptop. Stop them there.")).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: /^Stop|^Turn off|History|Ask Agent/ })).toBeNull();
    });

    it("draws no watch list on a merged PR", () => {
      renderPanel({
        thread: threadWithPrs([{ ...openPr, lifecycleState: "merged", state: "merged" }]),
        watches: [terminalWatch],
      });
      expect(screen.queryByText("Wakes this thread")).toBeNull();
    });
  });
});
