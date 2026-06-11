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
  it("renders each PR as a card with a state dot, title, repo/number, and open action", () => {
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
    expect(within(card).getByText("Ready for review · Checks passing")).toBeInTheDocument();
    expect(within(card).getByText("fix(desktop): polish the PR panel")).toBeInTheDocument();
    expect(within(card).getByText("github.com/pwrdrvr/PwrSnap · #233")).toBeInTheDocument();
    // The status dot carries the passing tone, not a competing inline status.
    expect(card.querySelector(".rail-card__dot--ok")).not.toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: /Open pwrdrvr\/PwrSnap#233/ }));
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrSnap/pull/233",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("labels merged PRs and falls back to a generic title", () => {
    const { container } = render(
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

    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.getByText("Pull request #99")).toBeInTheDocument();
    expect(container.querySelector(".rail-card__dot--merged")).not.toBeNull();
  });

  it("renders an empty state when there are no PRs", () => {
    render(<PullRequestsPanel thread={baseThread} />);

    expect(
      screen.getByText("No pull requests linked to this thread yet."),
    ).toBeInTheDocument();
  });
});
