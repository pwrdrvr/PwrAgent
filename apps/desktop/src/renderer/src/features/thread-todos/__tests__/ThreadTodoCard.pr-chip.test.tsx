import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary, ThreadTodo } from "@pwragent/shared";
import { PullRequestLinkProvider } from "../../../lib/pull-request-links";
import { ThreadTodoCard, type ThreadTodoCardProps } from "../ThreadTodoCard";

/**
 * A merge card printed its PR as `#3088` text: no status, no link. After a
 * failed merge the operator could not see whether the PR was still open or
 * open it. The card now shows the live PR chip. See "To-do Merge PR Chip UX
 * Review" in the PwrAgent design project.
 */

afterEach(() => {
  cleanup();
});

const REPO_ROOT = "/repos/atlas";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 418,
    org: "acme",
    repo: "atlas",
    title: "ci: bound nightly export jobs",
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "approved",
    mergeState: "mergeable",
    url: "https://github.com/acme/atlas/pull/418",
    ...overrides,
  };
}

function thread(
  id: string,
  prs: PrSummary[],
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    title: id,
    titleSource: "derived",
    source: "claude",
    linkedDirectories: [],
    inbox: { inInbox: true, unread: false },
    prs,
    ...overrides,
  } as NavigationThreadSummary;
}

function inProject(id: string, prs: PrSummary[]): NavigationThreadSummary {
  const worktreePath = `${REPO_ROOT}-${id}`;
  return thread(id, prs, {
    projectKey: worktreePath,
    linkedDirectories: [{
      id: worktreePath,
      kind: "worktree",
      label: "atlas",
      path: REPO_ROOT,
      worktreePath,
    }],
  } as Partial<NavigationThreadSummary>);
}

function mergeCard(pullRequest: string, overrides: Partial<ThreadTodo> = {}): ThreadTodo {
  return {
    id: "merge",
    backend: "claude",
    threadId: "raiser",
    kind: "merge",
    status: "open",
    title: "Ready to merge: nightly export timeouts (#418)",
    action: { type: "merge_pull_request", pullRequest },
    sourceProject: { key: `directory:${REPO_ROOT}`, label: "atlas", path: REPO_ROOT },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as ThreadTodo;
}

function props(todo: ThreadTodo): ThreadTodoCardProps {
  return {
    todo,
    running: false,
    now: 0,
    onRun: vi.fn(),
    onStartReview: vi.fn(),
    onResolve: vi.fn(),
    onSetItemChecked: vi.fn(),
  };
}

function renderCard(todo: ThreadTodo, threads: NavigationThreadSummary[]) {
  const ui = (list: NavigationThreadSummary[]) => (
    <PullRequestLinkProvider threads={list}>
      <ThreadTodoCard {...props(todo)} />
    </PullRequestLinkProvider>
  );
  const view = render(ui(threads));
  return { ...view, rerenderThreads: (next: NavigationThreadSummary[]) => view.rerender(ui(next)) };
}

function prFact(): HTMLElement {
  return screen.getByText("PR").closest(".thread-todo-card__fact") as HTMLElement;
}

describe("merge card PR chip", () => {
  it("shows the raising thread's PR as a live chip that opens it", () => {
    renderCard(mergeCard("418"), [thread("raiser", [pr()])]);

    const chip = screen.getByRole("button", { name: "Open acme/atlas#418 (Checks passed) in browser" });
    expect(chip).toHaveClass("pr-chip", "pr-chip--passing");
    expect(chip).toHaveTextContent("#418");
    expect(chip).toHaveAttribute("data-pr-url", "https://github.com/acme/atlas/pull/418");
    expect(prFact()).toContainElement(chip);
  });

  it("follows the PR's status as it changes, so a merge on GitHub shows", () => {
    const { rerenderThreads } = renderCard(mergeCard("418"), [thread("raiser", [pr()])]);
    rerenderThreads([thread("raiser", [pr({ lifecycleState: "merged", mergedAt: "2026-10-29T12:00:00Z" })])]);

    expect(prFact().querySelector(".pr-chip")).toHaveClass("pr-chip--merged");
  });

  it("finds the PR on another thread in the card's project", () => {
    renderCard(mergeCard("418"), [thread("raiser", []), inProject("worker", [pr()])]);

    expect(prFact().querySelector(".pr-chip")).toHaveAttribute("data-pr-url", pr().url);
  });

  it("keeps the text when the number names PRs in two repositories", () => {
    renderCard(mergeCard("418"), [
      thread("raiser", []),
      inProject("one", [pr()]),
      inProject("two", [pr({ repo: "atlas-web", url: "https://github.com/acme/atlas-web/pull/418" })]),
    ]);

    expect(prFact().querySelector(".pr-chip")).toBeNull();
    expect(prFact()).toHaveTextContent("PR#418");
  });

  it("keeps the text when nothing names the PR", () => {
    renderCard(mergeCard("418"), [thread("raiser", []), thread("elsewhere", [pr()])]);

    expect(prFact().querySelector(".pr-chip")).toBeNull();
    expect(prFact()).toHaveTextContent("PR#418");
  });

  it("resolves a PR URL by itself", () => {
    renderCard(mergeCard("https://github.com/acme/atlas/pull/418"), []);

    expect(prFact().querySelector(".pr-chip")).toHaveAttribute("data-pr-url", pr().url);
  });
});
