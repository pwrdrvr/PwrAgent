import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ManageThreadDependenciesResponse,
  NavigationThreadSummary,
  PrMergeQueueStatus,
  PrSummary,
  ThreadTodo,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { PullRequestLinkProvider } from "../../../lib/pull-request-links";
import { PrStatusCard } from "../../pr-status/PrStatusCard";
import { prStatusLabel, resolvePrChipQueueBadge } from "../../pr-status/pr-chip-state";
import { ThreadTodoCard } from "../ThreadTodoCard";

/**
 * A base branch with a merge queue takes no direct merge. The merge card
 * offers "Add to merge queue", with no method menu; it follows the PR into
 * the queue and says why the queue removed it. The chip and its card say the
 * same. See "Merge Queue Aware PRs UX Review" in the PwrAgent design project.
 */

const PR_URL = "https://github.com/acme/atlas/pull/3631";

afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: DesktopApi }).pwragent;
});

function pr(mergeQueue?: PrMergeQueueStatus, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com", number: 3631, org: "acme", repo: "atlas", title: "Tighten composer padding",
    baseRefName: "main", state: "passing", checkState: "passing", lifecycleState: "open",
    reviewState: "ready_for_review", mergeState: "mergeable", url: PR_URL,
    ...(mergeQueue ? { mergeQueue } : {}),
    ...overrides,
  };
}

function thread(prs: PrSummary[]): NavigationThreadSummary {
  return {
    id: "raiser", title: "raiser", titleSource: "derived", source: "claude", linkedDirectories: [],
    inbox: { inInbox: true, unread: false }, prs,
  } as NavigationThreadSummary;
}

function renderCard(livePr: PrSummary, onRun = vi.fn()) {
  // No merge holds, so the card shows its action.
  (window as Window & { pwragent?: DesktopApi }).pwragent = {
    manageThreadDependencies: vi.fn(async (): Promise<ManageThreadDependenciesResponse> => ({ dependencies: [], mergeHolds: [] })),
    onAgentEvent: () => () => {},
  } as unknown as DesktopApi;
  const todo = {
    id: "merge", backend: "claude", threadId: "raiser", kind: "merge", status: "open",
    title: "Merge the padding fix", action: { type: "merge_pull_request", pullRequest: PR_URL },
    createdAt: 0, updatedAt: 0,
  } as ThreadTodo;
  render(
    <PullRequestLinkProvider threads={[thread([livePr])]}>
      <ThreadTodoCard todo={todo} running={false} now={0} onRun={onRun}
        onStartReview={vi.fn()} onResolve={vi.fn()} onSetItemChecked={vi.fn()} />
    </PullRequestLinkProvider>,
  );
  return onRun;
}

describe("merge card on a branch with a merge queue", () => {
  it("adds the PR to the queue, with no method menu", async () => {
    const onRun = renderCard(pr({ kind: "merge_queue", state: "not_queued" }));
    const add = await screen.findByRole("button", { name: "Add to merge queue" });
    expect(screen.queryByRole("button", { name: "Merge options" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("main requires a merge queue. The queue tests the PR again and merges it with its own method.");
    fireEvent.click(add);
    expect(screen.getByText(/Add this pull request to the merge queue for main\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("has nothing to run while the PR is in the queue", async () => {
    renderCard(pr({ kind: "merge_queue", state: "group_checks_running", position: 1 }));
    expect(await screen.findByRole("button", { name: "In merge queue" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Queued #1 · merge group checks running.");
  });

  it("says why the queue removed the PR and offers it again", async () => {
    renderCard(pr({ kind: "merge_queue", state: "removed", removedAt: 1, removedReason: "checks_failed" }));
    expect(await screen.findByRole("button", { name: "Add to merge queue again" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Removed from the merge queue. The merge group's checks failed.");
  });

  it("keeps the method menu where there is no queue", async () => {
    renderCard(pr());
    expect(await screen.findByRole("button", { name: "Merge options" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge queue/ })).toBeNull();
  });
});

describe("PR chip and card in the queue", () => {
  it("names the queue state in the chip's status sentence and badge", () => {
    expect(prStatusLabel(pr({ kind: "merge_queue", state: "queued", position: 2 })))
      .toBe("ready for review · queued #2 · checks passing");
    expect(prStatusLabel(pr({ kind: "merge_queue", state: "removed", removedReason: "merge_conflict" })))
      .toBe("ready for review · removed from queue · merge conflict · checks passing");
    expect(prStatusLabel(pr({ kind: "merge_queue", state: "merged_by_queue" }, { lifecycleState: "merged" })))
      .toBe("merged by queue");
    expect(resolvePrChipQueueBadge(pr({ kind: "merge_queue", state: "queued", position: 2 }))).toEqual({ state: "queued", position: 2 });
    expect(resolvePrChipQueueBadge(pr({ kind: "merge_queue", state: "merging", position: 1 }))).toEqual({ state: "merging" });
    expect(resolvePrChipQueueBadge(pr({ kind: "merge_queue", state: "not_queued" }))).toBeUndefined();
    expect(resolvePrChipQueueBadge(pr({ kind: "merge_queue", state: "merged_by_queue" }, { lifecycleState: "merged" }))).toBeUndefined();
  });

  it("gives the hover card a Merge queue section", () => {
    const { container } = render(<PrStatusCard now={10 * 60_000}
      pr={pr({ kind: "merge_queue", state: "queued", position: 2, enqueuedAt: 6 * 60_000 })} />);
    const section = [...container.querySelectorAll(".pr-status-card__section")]
      .find((node) => node.textContent?.startsWith("Merge queue · main"));
    expect(section).toHaveTextContent("Position#2");
    expect(section).toHaveTextContent("StateWaiting");
    expect(section).toHaveTextContent("Joined4m ago");
  });
});
