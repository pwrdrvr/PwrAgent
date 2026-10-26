import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadReviewEntry, ThreadReview, ThreadTodo, ThreadTodosChangedEvent } from "@pwragent/shared";
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
  it("loads and updates tracked findings on a mounted remote thread", async () => {
    const target = { scope: "remote" as const, instanceId: "peer" };
    const api = installApi({ ...review, status: "handled" });
    render(<TranscriptReview entry={entry} parentThreadId="owner"
      fileViewerContext={{ key: "remote-thread", title: "Remote thread", federationTarget: target }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark addressed: Abort pending exports" }));
    expect(api.listThreadReviews).toHaveBeenCalledWith({ backend: "codex", threadId: "owner", status: "all", federationTarget: target });
    expect(api.updateThreadReview).toHaveBeenCalledWith({ id: "review", itemId: "finding", status: "addressed", federationTarget: target });
    await screen.findByText("Handled");
  });

  it("reloads transcript status when provider recovery refreshes all To-dos", async () => {
    const api = installApi(review);
    vi.mocked(api.listThreadReviews!).mockResolvedValueOnce({ reviews: [] });
    let changed: (event: ThreadTodosChangedEvent) => void = () => {};
    vi.mocked(api.onThreadTodosChanged!).mockImplementation((listener) => { changed = listener; return () => {}; });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    await waitFor(() => expect(api.listThreadReviews).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Dismiss review" })).not.toBeInTheDocument();
    act(() => changed({ at: 2 }));
    await screen.findByRole("button", { name: "Mark addressed: Abort pending exports" });
    expect(api.listThreadReviews).toHaveBeenLastCalledWith({ backend: "codex", threadId: "owner", status: "all" });
  });

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
      ...review, status: "handled", resolution: { note: "Every finding is addressed, declined, or deferred.", actor: "system", at: 2 },
      items: [{ ...review.items[0]!, status: "addressed", resolution: { note: "Added the abort handler.", url: "https://example.com/atlas/commit/1a2b3c4d5e", actor: "agent", at: 2 } }],
    });
    render(<TranscriptReview entry={entry} parentThreadId="owner" parentThreadBackend="codex" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark addressed: Abort pending exports" }));
    await waitFor(() => expect(api.updateThreadReview).toHaveBeenCalledWith({ id: "review", itemId: "finding", status: "addressed" }));
    await screen.findByText("Every finding is addressed, declined, or deferred.");
    expect(screen.getByText("Abort pending exports")).toBeVisible();
    expect(screen.getByRole("link", { name: "Commit 1a2b3c4" })).toHaveAttribute("href", "https://example.com/atlas/commit/1a2b3c4d5e");
    expect(screen.getByText("Addressed by the agent · Added the abort handler.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reopen finding: Abort pending exports" })).toBeVisible();
  });

  it("labels the whole review and its findings Dismissed after dismissal", async () => {
    const api = installApi({ ...review, status: "dismissed", resolution: { note: "Dismissed by operator.", actor: "user", at: 2 } });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss review" }));
    await waitFor(() => expect(screen.getAllByText("Dismissed", { exact: true })).toHaveLength(2));
    expect(screen.queryByText("Did not address")).not.toBeInTheDocument();
    expect(screen.getByText("Stop the export when its owner closes.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Mark addressed:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen review" }));
    await waitFor(() => expect(api.updateThreadReview).toHaveBeenLastCalledWith({ id: "review", status: "open" }));
  });

  it.each([
    ["declined", "Declined", "Declined by the agent · The caller owns the connection.", undefined],
    ["deferred", "Deferred", "Deferred by the agent · Needs a design pass.", { id: "todo-1", title: "Design the abort path" }],
  ] as const)("labels a %s finding in the transcript with its outcome and reason", async (status, label, line, todo) => {
    const note = status === "declined" ? "The caller owns the connection." : "Needs a design pass.";
    installApi(review, { ...review, status: "handled", items: [{ ...review.items[0]!, status,
      resolution: { note, actor: "agent", at: 2, ...(todo ? { todo } : {}) } }] });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    expect(await screen.findByText(label, { exact: true })).toBeVisible();
    expect(screen.getByText(line)).toBeVisible();
    if (todo) expect(screen.getByText(todo.title)).toBeVisible();
    expect(screen.getByRole("button", { name: "Reopen finding: Abort pending exports" })).toBeVisible();
  });

  it("renders what a finding says from the transcript and reads only its state from the record", async () => {
    installApi(review, { ...review, items: [{ ...review.items[0]!, title: "Stored excerpt…", body: "Stored body" }] });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    await screen.findByRole("button", { name: "Mark addressed: Abort pending exports" });
    expect(screen.getByText("Stop the export when its owner closes.")).toBeVisible();
    expect(screen.queryByText("Stored excerpt…")).not.toBeInTheDocument();
    expect(screen.queryByText("Stored body")).not.toBeInTheDocument();
  });

  it("routes review reads in a remote window to the peer", async () => {
    const api = installApi(review);
    Object.assign(window, { __pwragentFederationTarget: { scope: "remote", instanceId: "peer" } });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    await screen.findByRole("button", { name: "Dismiss review" });
    expect(api.listThreadReviews).toHaveBeenCalledWith({ backend: "codex", threadId: "owner", status: "all",
      federationTarget: { scope: "remote", instanceId: "peer" },
    });
  });
});

const finding = (id: string, title: string, priority: number, status: ThreadReview["items"][number]["status"] = "open") => ({
  id, title, priority, status, createdAt: 1, updatedAt: 1,
  body: `Why ${title.toLowerCase()} matters.`,
  codeLocation: { absolute_file_path: "/example/atlas/src/export-queue.ts", line_range: { start: 42, end: 46 } },
});

function renderCard(current: ThreadReview, onDoHere = vi.fn()) {
  const api = installApi(current, current);
  const handlers = { onRun: vi.fn(), onStartReview: vi.fn(), onResolve: vi.fn(), onDoHere, onSetItemChecked: vi.fn() };
  const todo: ThreadTodo = threadReviewTodo(current);
  const mounted = render(<ThreadTodoCard todo={todo} running={false} {...handlers} />);
  const rerenderCard = (threadRunning: boolean) => mounted.rerender(
    <ThreadTodoCard todo={todo} running={false} threadRunning={threadRunning} {...handlers} />,
  );
  return { api, handlers, todo, rerenderCard };
}

const prompt = (lines: string[]) => [...lines, "", "Use PwrAgent's `list_reviews` tool for their details and how to record each fix."].join("\n");

describe("review To-do card", () => {
  it("lists findings by priority with no mark at rest, and fixes every open one by default", async () => {
    const current: ThreadReview = {
      ...review,
      items: [
        finding("done", "Drop the stale cursor", 1, "addressed"),
        finding("format", "Keep the selected output format", 2),
        finding("abort", "Abort pending exports", 1),
        finding("retry", "Name the retry budget", 3, "declined"),
      ],
    };
    const { handlers, todo } = renderCard(current);
    // Settled of total, the way a card with steps counts.
    await screen.findByText("2 of 4");
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Abort pending exports"),
      expect.stringContaining("Keep the selected output format"),
      expect.stringContaining("Drop the stale cursor"),
      expect.stringContaining("Name the retry budget"),
    ]);
    // Nothing on a row reads as a step's checkbox.
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(within(rows[2]!).getByText("Addressed")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Declined")).toBeInTheDocument();
    expect(within(rows[3]!).getByRole("button", { name: "Reopen finding: Name the retry budget" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fix all" }));
    expect(handlers.onDoHere).toHaveBeenCalledWith(todo, { prompt: prompt([
      "Fix these 2 findings from Code review:",
      "",
      "1. [P1] Abort pending exports",
      "2. [P2] Keep the selected output format",
    ]) });
    await waitFor(() => expect(screen.getByRole("button", { name: "Fix all" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss review" }));
    expect(handlers.onResolve).toHaveBeenCalledWith(todo, "dismissed");
  });

  it("fixes only the selected findings, then clears the selection", async () => {
    const current: ThreadReview = {
      ...review,
      items: [finding("format", "Keep the selected output format", 2), finding("abort", "Abort pending exports", 1)],
    };
    const { handlers, todo } = renderCard(current);
    const select = await screen.findByRole("button", { name: "Select finding: Keep the selected output format" });
    expect(select).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(select);
    expect(select).toHaveAttribute("aria-pressed", "true");
    expect(within(select.closest("li")!).getAllByText("Selected")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Fix 1 selected" }));
    expect(handlers.onDoHere).toHaveBeenCalledWith(todo, { prompt: prompt([
      "Fix this finding from Code review:",
      "",
      "1. [P2] Keep the selected output format",
    ]) });
    await screen.findByRole("button", { name: "Fix all" });
    expect(select).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the other selected findings when Fix now sends one", async () => {
    const current: ThreadReview = {
      ...review,
      items: [finding("format", "Keep the selected output format", 2), finding("abort", "Abort pending exports", 1)],
    };
    renderCard(current);
    const select = await screen.findByRole("button", { name: "Select finding: Keep the selected output format" });
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("button", { name: "Fix now: Abort pending exports" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fix 1 selected" })).toBeEnabled());
    expect(select).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the selection when the reply did not send", async () => {
    const onDoHere = vi.fn(async () => false);
    renderCard({ ...review, items: [finding("abort", "Abort pending exports", 1), finding("retry", "Name the retry budget", 3)] }, onDoHere);
    fireEvent.click(await screen.findByRole("button", { name: "Select finding: Abort pending exports" }));
    fireEvent.click(screen.getByRole("button", { name: "Fix 1 selected" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fix 1 selected" })).toBeEnabled());
    expect(onDoHere).toHaveBeenCalledTimes(1);
  });

  it("fixes one finding now from its row", async () => {
    const current: ThreadReview = {
      ...review,
      items: [finding("format", "Keep the selected output format", 2), finding("abort", "Abort pending exports", 1)],
    };
    const { handlers, todo } = renderCard(current);
    fireEvent.click(await screen.findByRole("button", { name: "Fix now: Keep the selected output format" }));
    expect(handlers.onDoHere).toHaveBeenCalledWith(todo, { prompt: prompt([
      "Fix this finding from Code review:",
      "",
      "1. [P2] Keep the selected output format",
    ]) });
    await waitFor(() => expect(screen.getByRole("button", { name: "Fix all" })).toBeEnabled());
  });

  it("sends the hand-off once while the first send is still settling", async () => {
    let settle: (sent: boolean) => void = () => {};
    const onDoHere = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    renderCard({ ...review, items: [finding("abort", "Abort pending exports", 1)] }, onDoHere);
    const button = await screen.findByRole("button", { name: "Fix all" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onDoHere).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "Fix now: Abort pending exports" })).toBeDisabled();
    settle(true);
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("shows Sending then Working and blocks duplicate fixes until the owning turn finishes", async () => {
    let settle: (sent: boolean) => void = () => {};
    const onDoHere = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const { rerenderCard } = renderCard({ ...review, items: [finding("abort", "Abort pending exports", 1)] }, onDoHere);
    fireEvent.click(await screen.findByRole("button", { name: "Fix all" }));
    const sending = screen.getByRole("button", { name: "Sending…" });
    expect(sending).toBeDisabled();
    expect(sending).toHaveAttribute("aria-busy", "true");
    expect(sending.querySelector(".pending-spinner")).toBeInTheDocument();
    fireEvent.click(sending);
    fireEvent.click(screen.getByRole("button", { name: "Fix now: Abort pending exports" }));
    expect(onDoHere).toHaveBeenCalledTimes(1);

    rerenderCard(true);
    settle(true);
    const working = await screen.findByRole("button", { name: "Working…" });
    expect(working).toBeDisabled();
    expect(working).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Fix now: Abort pending exports" })).toBeDisabled();
    fireEvent.click(working);
    expect(onDoHere).toHaveBeenCalledTimes(1);

    rerenderCard(false);
    expect(screen.getByRole("button", { name: "Fix all" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Fix now: Abort pending exports" })).toBeEnabled();
  });

  it("starts disabled when mounting during an active owning turn", async () => {
    const { handlers, rerenderCard } = renderCard(review);
    rerenderCard(true);
    const working = await screen.findByRole("button", { name: "Working…" });
    fireEvent.click(working);
    fireEvent.click(screen.getByRole("button", { name: "Fix now: Abort pending exports" }));
    expect(handlers.onDoHere).not.toHaveBeenCalled();
    expect(working).toBeDisabled();
  });

  it.each(["throw", "reject"])("recovers from a submission %s and keeps selected findings available for retry", async (failure) => {
    const onDoHere = vi.fn().mockImplementationOnce(() => {
      if (failure === "throw") throw new Error("Repair request failed");
      return Promise.reject(new Error("Repair request failed"));
    }).mockResolvedValue(true);
    renderCard({ ...review, items: [finding("abort", "Abort pending exports", 1)] }, onDoHere);
    fireEvent.click(await screen.findByRole("button", { name: "Select finding: Abort pending exports" }));
    fireEvent.click(screen.getByRole("button", { name: "Fix 1 selected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Repair request failed");
    const retry = screen.getByRole("button", { name: "Fix 1 selected" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(onDoHere).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("button", { name: "Fix all" })).toBeEnabled();
  });

  it("declines a finding from its row", async () => {
    const current: ThreadReview = { ...review, items: [finding("abort", "Abort pending exports", 1)] };
    const { api } = renderCard(current);
    fireEvent.click(await screen.findByRole("button", { name: "Decline finding: Abort pending exports" }));
    await waitFor(() => expect(api.updateThreadReview).toHaveBeenCalledWith({ id: "review", itemId: "abort", status: "declined" }));
  });

  it("labels a deferred finding Deferred and keeps it unstruck", async () => {
    const current: ThreadReview = { ...review, items: [
      finding("abort", "Abort pending exports", 1),
      { ...finding("retry", "Name the retry budget", 2, "deferred"), resolution: {
        note: "Needs a design pass.", todo: { id: "todo-1", title: "Design the retry budget" }, actor: "agent", at: 2,
      } },
    ] };
    renderCard(current);
    await screen.findByText("1 of 2");
    const row = screen.getAllByRole("listitem")[1]!;
    expect(row).toHaveAttribute("data-status", "deferred");
    expect(within(row).getByText("Deferred")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Reopen finding: Name the retry budget" })).toBeInTheDocument();
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
    await screen.findByText("0 of 6");
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
