import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadReviewEntry, ThreadReview, ThreadTodo } from "@pwragent/shared";
import { threadReviewDisplayTitle, threadReviewTodo } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { TranscriptReview } from "../../thread-detail/TranscriptReview";
import { ThreadTodoCard } from "../ThreadTodoCard";
import { formatEvidenceLabel } from "../review-tracking";

const entry: AppServerThreadReviewEntry = {
  type: "review", id: "artifact", review: "A cancellation regression.",
  output: {
    overall_correctness: "patch is incorrect", overall_explanation: "A cancellation regression.",
    findings: [{ title: "Abort pending exports", body: "Stop the export when its owner closes.", confidence_score: 0.9,
      code_location: { absolute_file_path: "/example/queue.ts", line_range: { start: 1, end: 2 } } }],
  },
};
const review: ThreadReview = {
  id: "review", backend: "codex", threadId: "owner", sourceKey: "artifact", title: "Code review", status: "open", createdAt: 1, updatedAt: 1,
  items: [{ id: "finding", title: "Abort pending exports", status: "open", createdAt: 1, updatedAt: 1 }],
};

function installApi(result: ThreadReview, current: ThreadReview = review) {
  const api: Pick<DesktopApi, "listThreadReviews" | "updateThreadReview" | "onThreadTodosChanged"> = {
    listThreadReviews: vi.fn(async () => ({ reviews: [current] })),
    updateThreadReview: vi.fn(async () => ({ review: result })),
    onThreadTodosChanged: vi.fn(() => () => {}),
  };
  Object.assign(window, { pwragent: api });
  return api;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { pwragent?: unknown }).pwragent;
  delete (window as unknown as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
});

describe("review status controls", () => {
  it("shares one pending read across two surfaces of the same review", async () => {
    const api = installApi(review);
    render(<>
      <TranscriptReview entry={entry} parentThreadId="owner" />
      <TranscriptReview entry={entry} parentThreadId="owner" />
    </>);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Dismiss review" })).toHaveLength(2));
    expect(api.listThreadReviews).toHaveBeenCalledTimes(1);
  });

  it("documents an addressed finding and keeps the original review visible", async () => {
    const api = installApi({
      ...review, status: "handled", resolution: { note: "All findings addressed or dismissed.", actor: "system", at: 2 },
      items: [{ ...review.items[0]!, status: "addressed", resolution: { note: "Added the abort handler.", url: "https://example.com/atlas/commit/1a2b3c4d5e", actor: "agent", at: 2 } }],
    });
    render(<TranscriptReview entry={entry} parentThreadId="owner" parentThreadBackend="codex" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark addressed: Abort pending exports" }));
    await waitFor(() => expect(api.updateThreadReview).toHaveBeenCalledWith({ id: "review", itemId: "finding", status: "addressed" }));
    await screen.findByText("All findings addressed or dismissed.");
    expect(screen.getByText("Abort pending exports")).toBeVisible();
    expect(screen.getByRole("link", { name: "Commit 1a2b3c4" })).toHaveAttribute("href", "https://example.com/atlas/commit/1a2b3c4d5e");
    expect(screen.getByText("Addressed by the agent · Added the abort handler.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reopen finding: Abort pending exports" })).toBeVisible();
  });

  it("labels the whole review and its findings Do not address after dismissal", async () => {
    const api = installApi({ ...review, status: "dismissed", resolution: { note: "Dismissed by operator.", actor: "user", at: 2 } });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss review" }));
    await waitFor(() => expect(screen.getAllByText("Do not address", { exact: true })).toHaveLength(2));
    expect(screen.getByText("Stop the export when its owner closes.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Mark addressed:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen review" }));
    await waitFor(() => expect(api.updateThreadReview).toHaveBeenLastCalledWith({ id: "review", status: "open" }));
  });

  it("renders what a finding says from the transcript and reads only its state from the record", async () => {
    installApi(review, { ...review, items: [{ ...review.items[0]!, title: "Stored excerpt…", body: "Stored body" }] });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    await screen.findByRole("button", { name: "Mark addressed: Abort pending exports" });
    expect(screen.getByText("Stop the export when its owner closes.")).toBeVisible();
    expect(screen.queryByText("Stored excerpt…")).not.toBeInTheDocument();
    expect(screen.queryByText("Stored body")).not.toBeInTheDocument();
  });

  it("never looks up peer reviews in the local database", () => {
    const api = installApi(review);
    Object.assign(window, { __pwragentFederationTarget: { scope: "remote", instanceId: "peer" } });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    expect(api.listThreadReviews).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Dismiss review" })).not.toBeInTheDocument();
  });
});

const finding = (id: string, title: string, priority: number, status: "open" | "addressed" | "dismissed" = "open") => ({
  id, title, priority, status, createdAt: 1, updatedAt: 1,
  body: `Why ${title.toLowerCase()} matters.`,
  codeLocation: { absolute_file_path: "/example/atlas/src/export-queue.ts", line_range: { start: 42, end: 46 } },
});

function renderCard(current: ThreadReview, onDoHere = vi.fn()) {
  const api = installApi(current, current);
  const handlers = { onRun: vi.fn(), onStartReview: vi.fn(), onResolve: vi.fn(), onDoHere };
  const todo: ThreadTodo = threadReviewTodo(current);
  render(<ThreadTodoCard todo={todo} running={false} {...handlers} />);
  return { api, handlers, todo };
}

describe("review To-do card", () => {
  it("lists open findings first by priority and asks the agent to fix the picked ones", async () => {
    const current: ThreadReview = {
      ...review,
      items: [
        finding("done", "Drop the stale cursor", 1, "addressed"),
        finding("format", "Keep the selected output format", 2),
        finding("abort", "Abort pending exports", 1),
      ],
    };
    const { handlers, todo } = renderCard(current);
    await screen.findByText("2 of 3 open");
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(rows[0]).toContain("Abort pending exports");
    expect(rows[1]).toContain("Keep the selected output format");
    expect(rows[2]).toContain("Drop the stale cursor");
    expect(screen.getByRole("button", { name: "Reopen finding: Drop the stale cursor" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Fix finding: Drop the stale cursor" })).not.toBeInTheDocument();

    // Every open finding starts picked; unticking one leaves it out.
    expect(screen.getByRole("button", { name: "Fix 2 findings" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Fix finding: Keep the selected output format" }));
    fireEvent.click(screen.getByRole("button", { name: "Fix 1 finding" }));
    expect(handlers.onDoHere).toHaveBeenCalledWith(todo, [
      "Fix this finding from Code review:",
      "",
      "1. [P1] Abort pending exports",
      "",
      "Use PwrAgent's `list_reviews` tool for their details and how to record each fix.",
    ].join("\n"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fix 1 finding" })).toBeEnabled());

    fireEvent.click(screen.getByRole("checkbox", { name: "Fix finding: Abort pending exports" }));
    expect(screen.getByRole("button", { name: "Fix findings" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Fix finding: Abort pending exports" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Fix finding: Keep the selected output format" }));
    fireEvent.click(screen.getByRole("button", { name: "Fix 2 findings" }));
    expect(handlers.onDoHere).toHaveBeenLastCalledWith(todo, expect.stringMatching(
      /^Fix these 2 findings from Code review:\n\n1\. \[P1\] Abort pending exports\n2\. \[P2\] Keep the selected output format\n\n/,
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fix 2 findings" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss review" }));
    expect(handlers.onResolve).toHaveBeenCalledWith(todo, "dismissed");
  });

  it("sends the hand-off once while the first send is still settling", async () => {
    let settle: (sent: boolean) => void = () => {};
    const onDoHere = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    renderCard({ ...review, items: [finding("abort", "Abort pending exports", 1)] }, onDoHere);
    const button = await screen.findByRole("button", { name: "Fix 1 finding" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onDoHere).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    settle(true);
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("settles a finding from its row", async () => {
    const current: ThreadReview = { ...review, items: [finding("abort", "Abort pending exports", 1)] };
    const { api } = renderCard(current);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss finding: Abort pending exports" }));
    await waitFor(() => expect(api.updateThreadReview).toHaveBeenCalledWith({ id: "review", itemId: "abort", status: "dismissed" }));
  });

  it("offers Mark handled once nothing is left open", async () => {
    const current: ThreadReview = { ...review, items: [], summary: "Prose only." };
    const { api } = renderCard(current);
    await screen.findByText("No findings to settle");
    expect(screen.getByText("Prose only.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Fix/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(api.updateThreadReview).toHaveBeenCalledWith({ id: "review", status: "handled" }));
  });

  it("collapses past four findings", async () => {
    const current: ThreadReview = {
      ...review,
      items: Array.from({ length: 6 }, (_, index) => finding(`f${index}`, `Finding ${index}`, 2)),
    };
    renderCard(current);
    await screen.findByText("6 open");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("review naming", () => {
  it("names a generic review after its pull request, then its branch", () => {
    const context = { workspacePath: "/example/atlas", gitBranch: "feat/export-queue" };
    expect(threadReviewDisplayTitle({ title: "Code review", context })).toBe("Review of feat/export-queue");
    expect(threadReviewDisplayTitle({
      title: "Code review",
      context: { ...context, pullRequest: { provider: "github.com", org: "example", repo: "atlas", number: 412, url: "https://github.com/example/atlas/pull/412" } },
    })).toBe("Review of PR #412");
    expect(threadReviewDisplayTitle({ title: "Security pass", context })).toBe("Security pass");
    expect(threadReviewDisplayTitle({ title: "Code review" })).toBe("Code review");
  });

  it("labels evidence links by what they point at", () => {
    expect(formatEvidenceLabel("https://github.com/example/atlas/commit/9c41e07aa")).toBe("Commit 9c41e07");
    expect(formatEvidenceLabel("https://github.com/example/atlas/pull/412#discussion_r1")).toBe("PR #412");
    expect(formatEvidenceLabel("https://www.example.com/notes")).toBe("example.com");
  });
});
