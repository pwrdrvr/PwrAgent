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
});
