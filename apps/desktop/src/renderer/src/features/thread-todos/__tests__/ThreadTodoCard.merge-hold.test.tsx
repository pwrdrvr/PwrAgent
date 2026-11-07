import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageThreadDependenciesRequest, ManageThreadDependenciesResponse, ThreadDependency, ThreadTodo } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadTodoCard } from "../ThreadTodoCard";

/**
 * Oracle: the merge card says "Merge waits for …" exactly when main would
 * refuse the merge. Main also refuses for a hold on another thread with the
 * same PR attached, so the card shows main's own answer (`mergeHolds`), not
 * a filter of the card thread's waits. Before, thread A's card offered Merge
 * while thread B held #17, and the click failed with "Merge held: …".
 */

const PR_URL = "https://github.com/acme/atlas/pull/17";

afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: DesktopApi }).pwragent;
});

function hold(threadId: string, subject: string): ThreadDependency {
  return {
    id: `hold-${threadId}`, backend: "codex", threadId, holdMerge: true, status: "waiting",
    mode: "all", onFailure: "notify", deliver: "operator", createdAt: 1, updatedAt: 1, evidence: [],
    conditions: [{ backend: "codex", threadId: "", when: "marked_done", subject }],
  };
}

function mergeCard(): ThreadTodo {
  return {
    id: "merge", backend: "codex", threadId: "thread-a", kind: "merge", status: "open",
    title: "Ready to merge (#17)", action: { type: "merge_pull_request", pullRequest: PR_URL },
    createdAt: 0, updatedAt: 0,
  } as ThreadTodo;
}

function install(answer: (request: ManageThreadDependenciesRequest) => ManageThreadDependenciesResponse) {
  const manageThreadDependencies = vi.fn(async (request: ManageThreadDependenciesRequest) => answer(request));
  (window as Window & { pwragent?: DesktopApi }).pwragent = { manageThreadDependencies } as unknown as DesktopApi;
  return manageThreadDependencies;
}

function renderCard() {
  render(<ThreadTodoCard todo={mergeCard()} running={false} now={0}
    onRun={vi.fn()} onStartReview={vi.fn()} onResolve={vi.fn()} onSetItemChecked={vi.fn()} />);
}

describe("merge card holds", () => {
  it("waits for a hold on another thread that shares the PR", async () => {
    const manage = install((request) => ({
      dependencies: [],
      ...(request.pullRequest === PR_URL ? { mergeHolds: [hold("thread-b", "Lab validation")] } : {}),
    }));
    renderCard();

    expect(await screen.findByText("Merge waits for Lab validation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Merge/ })).toBeNull();
    expect(manage).toHaveBeenCalledWith(expect.objectContaining({
      action: "list", backend: "codex", threadId: "thread-a", pullRequest: PR_URL,
    }));
  });

  it("offers Merge when main reports no hold, even with the thread's own non-holding waits", async () => {
    install(() => ({ dependencies: [{ ...hold("thread-a", "Docs"), holdMerge: false }], mergeHolds: [] }));
    renderCard();

    expect(await screen.findByRole("button", { name: /Merge/ })).toBeInTheDocument();
    expect(screen.queryByText(/Merge waits for/)).toBeNull();
  });

  it("falls back to the thread's own holds when the owner predates mergeHolds", async () => {
    install(() => ({ dependencies: [hold("thread-a", "Release notes")] }));
    renderCard();

    expect(await screen.findByText("Merge waits for Release notes")).toBeInTheDocument();
  });
});
