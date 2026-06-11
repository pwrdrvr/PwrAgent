import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
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
  it("renders a card with #number + state pills, title, repo, and open action", () => {
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
    expect(within(card).getByText("#233")).toHaveClass("rail-chip--id");
    expect(within(card).getByText("Checks passing")).toHaveClass("rail-chip--ok");
    expect(within(card).getByText("fix(desktop): polish the PR panel")).toBeInTheDocument();
    expect(within(card).getByText("github.com/pwrdrvr/PwrSnap")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: /Open pwrdrvr\/PwrSnap#233/ }));
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrSnap/pull/233",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("shows merge conflict as its own danger pill, distinct from the checks pill", () => {
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

    expect(screen.getByText("Merge conflict")).toHaveClass("rail-chip--error");
    expect(screen.getByText("Checks failing")).toHaveClass("rail-chip--error");
  });

  it("labels merged PRs and falls back to a generic title", () => {
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
    expect(merged.querySelector(".rail-chip__dot--merged")).not.toBeNull();
    expect(screen.getByText("Pull request #99")).toBeInTheDocument();
    // Merged PRs don't show a checks pill.
    expect(screen.queryByText(/Checks/)).not.toBeInTheDocument();
  });

  it("renders an empty state when there are no PRs", () => {
    render(<PullRequestsPanel thread={baseThread} />);

    expect(
      screen.getByText("No pull requests linked to this thread yet."),
    ).toBeInTheDocument();
  });
});
