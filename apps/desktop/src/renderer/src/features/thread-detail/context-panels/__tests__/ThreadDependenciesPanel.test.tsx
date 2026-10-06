import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, ThreadDependency } from "@pwragent/shared";
import type { DesktopApi } from "../../../../lib/desktop-api";
import { chooseSelectOption } from "../../../../test/select";
import { ThreadDependenciesPanel } from "../ThreadDependenciesPanel";

afterEach(cleanup);
const thread: NavigationThreadSummary = {
  id: "waiting", source: "codex", title: "Dependencies", titleSource: "explicit",
  linkedDirectories: [], inbox: { inInbox: false },
};
const target: NavigationThreadSummary = { ...thread, id: "foundation", title: "Foundation" };
const second: NavigationThreadSummary = { ...thread, id: "driver", title: "Driver bump" };
const dependent: NavigationThreadSummary = { ...thread, id: "downstream", title: "Downstream" };
const dependency: ThreadDependency = {
  id: "dependency-1", backend: "codex", threadId: "waiting", status: "waiting",
  conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed", title: "Foundation" }],
  mode: "all", onFailure: "wait", evidence: [], createdAt: 1, updatedAt: 1,
};

function pageOf(rows: NavigationThreadSummary[], complete = true) {
  return vi.fn(async (_request: unknown, _consumerId: string) => ({
    entries: rows.map((row) => ({ row })), complete, coverage: { state: "complete" },
  }));
}

describe("Continue after", () => {
  it("adds a searched thread as a prerequisite row and saves exactly that row", async () => {
    const manage = vi.fn(async (request) => ({ dependencies: request.action === "create" ? [dependency] : [] }));
    const query = pageOf([thread, target]);
    const release = vi.fn(async () => {});
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: query, releaseNavigationQuery: release } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "list", backend: "codex", threadId: "waiting" }));
    expect(screen.getByText("Not waiting on other threads.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add prerequisites" }));
    const results = await screen.findByRole("list", { name: "Threads" });
    await waitFor(() => expect(release).toHaveBeenCalledWith(query.mock.calls[0]![1]));
    expect(query).toHaveBeenCalledWith({ protocol: 2, consumer: "search", inventory: "owner", query: { kind: "lens", lens: "recents" }, pageSize: 100 }, expect.any(String));
    // The waiting thread itself is never offered.
    expect(within(results).queryByRole("button", { name: "Dependencies" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(within(results).getByRole("button", { name: "Foundation" }));
    expect(within(results).getByRole("button", { name: "Foundation" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Its PR can be attached later.")).toBeInTheDocument();
    // A single prerequisite has no all/any choice; a CI condition offers the failure policy.
    expect(screen.queryByRole("group", { name: "Continue when" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "If CI fails" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions (optional)" }), { target: { value: "Start the dependency upgrades" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "create", backend: "codex", threadId: "waiting",
      conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed", title: "Foundation" }],
      mode: "all", onFailure: "wait", continuation: "Start the dependency upgrades",
    }));
    expect(await screen.findByText("Waiting")).toBeInTheDocument();
    expect(screen.getByText("Foundation")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "cancel", backend: "codex", threadId: "waiting", dependencyId: "dependency-1" }));
  });

  it("submits every visible row with its own condition and the all/any choice", async () => {
    const manage = vi.fn(async () => ({ dependencies: [] }));
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([target, second]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Add prerequisites" }));
    const results = await screen.findByRole("list", { name: "Threads" });
    await waitFor(() => expect(within(results).getByRole("button", { name: "Driver bump" })).toBeInTheDocument());
    fireEvent.click(within(results).getByRole("button", { name: "Foundation" }));
    fireEvent.click(within(results).getByRole("button", { name: "Driver bump" }));
    chooseSelectOption(screen.getByRole("combobox", { name: "Continue when Foundation" }), "Finishes its turn");
    chooseSelectOption(screen.getByRole("combobox", { name: "Continue when Driver bump" }), "Is merged");
    // No row waits on CI, so the CI failure policy has nothing to govern.
    expect(screen.queryByRole("group", { name: "If CI fails" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Continue when" })).getByRole("button", { name: "Any is met" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "create", backend: "codex", threadId: "waiting",
      conditions: [
        { backend: "codex", threadId: "foundation", when: "turn_completed", title: "Foundation" },
        { backend: "codex", threadId: "driver", when: "pr_merged", title: "Driver bump" },
      ],
      mode: "any", onFailure: "wait",
    }));
  });

  it("removes a row when its thread is chosen again or removed", async () => {
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [] })), getNavigationQueryPage: pageOf([target]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Add prerequisites" }));
    const option = await screen.findByRole("button", { name: "Foundation" });
    fireEvent.click(option);
    expect(screen.getByRole("button", { name: "Remove Foundation" })).toBeInTheDocument();
    fireEvent.click(option);
    expect(screen.queryByRole("button", { name: "Remove Foundation" })).not.toBeInTheDocument();
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "Remove Foundation" }));
    expect(option).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("requires a PR choice when the prerequisite has several PRs", async () => {
    const withPrs = { ...target, prs: [
      { provider: "github.com", org: "acme", repo: "widgets", number: 4127, url: "https://github.com/acme/widgets/pull/4127" },
      { provider: "github.com", org: "acme", repo: "widgets", number: 4131, url: "https://github.com/acme/widgets/pull/4131" },
    ] } as unknown as NavigationThreadSummary;
    const manage = vi.fn(async () => ({ dependencies: [] }));
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([withPrs]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Add prerequisites" }));
    fireEvent.click(await screen.findByRole("button", { name: "Foundation" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    chooseSelectOption(screen.getByRole("combobox", { name: "Pull request for Foundation" }), "#4131");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({
      conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed", title: "Foundation", prUrl: "https://github.com/acme/widgets/pull/4131" }],
    })));
  });

  it("lists threads waiting on this one and will not offer them as prerequisites", async () => {
    const waiter: ThreadDependency = {
      ...dependency, id: "dependency-2", threadId: "downstream",
      conditions: [{ backend: "codex", threadId: "waiting", when: "pr_merged" }],
    };
    const manage = vi.fn(async () => ({ dependencies: [], dependents: [waiter] }));
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([dependent, target]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    expect(await screen.findByRole("heading", { name: "Waiting on this thread" })).toBeInTheDocument();
    expect(screen.getByText("until it is merged")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add prerequisites" }));
    const results = await screen.findByRole("list", { name: "Threads" });
    const blocked = await within(results).findByRole("button", { name: /Downstream/ });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(within(blocked).getByText("Waits on this")).toBeInTheDocument();
    fireEvent.click(blocked);
    expect(screen.queryByRole("button", { name: "Remove Downstream" })).not.toBeInTheDocument();
  });

  it("shows per-prerequisite progress with saved titles instead of thread ids", async () => {
    const twoWay: ThreadDependency = {
      ...dependency,
      conditions: [
        { backend: "codex", threadId: "driver", when: "pr_merged", title: "Driver bump" },
        { backend: "codex", threadId: "foundation", when: "ci_passed", title: "Foundation" },
      ],
      evidence: [
        { condition: { backend: "codex", threadId: "driver", when: "pr_merged", title: "Driver bump" }, state: "satisfied", reason: "PR merged", observedAt: 2 },
        { condition: { backend: "codex", threadId: "foundation", when: "ci_passed", title: "Foundation" }, state: "waiting", reason: "Waiting for CI to pass", headSha: "9f2c41ab77", observedAt: 2 },
      ],
    };
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [twoWay] })) } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    expect(await screen.findByText("Waiting · 1 of 2 met")).toBeInTheDocument();
    expect(screen.getByText("Driver bump")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Met" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for CI to pass · 9f2c41ab")).toBeInTheDocument();
    expect(screen.queryByText(/^foundation$/)).not.toBeInTheDocument();
  });

  it("keeps finished registrations under a collapsed history", async () => {
    const delivered: ThreadDependency = { ...dependency, id: "old", status: "delivered", outcome: "failure" };
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [delivered] })) } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    const toggle = await screen.findByRole("button", { name: "History (1)" });
    expect(screen.queryByText("Prerequisite failed")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText("Prerequisite failed")).toBeInTheDocument();
  });

  it("shows registration failures and uncertain delivery without offering to replay it", async () => {
    const manage = vi.fn(async () => ({ dependencies: [{ ...dependency, status: "dispatching", error: "Delivery was interrupted" }] }));
    const api = { manageThreadDependencies: manage } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    expect(await screen.findByText("Delivery needs review")).toBeInTheDocument();
    expect(screen.getByText("Delivery was interrupted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss after review" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "dismiss", backend: "codex", threadId: "waiting", dependencyId: "dependency-1" }));
  });

  it("filters as the operator types and releases each navigation consumer", async () => {
    const query = pageOf([target], false);
    const release = vi.fn(async () => {});
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [] })), getNavigationQueryPage: query, releaseNavigationQuery: release } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Add prerequisites" }));
    expect(await screen.findByText("Showing recent matches. Refine the search to find another thread.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Find a thread" }), { target: { value: "Foundation" } });
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ query: { kind: "lens", lens: "recents", filter: "Foundation" }, pageSize: 100 }), expect.any(String)));
    await waitFor(() => expect(release).toHaveBeenCalledTimes(2));
  });

  it("ignores stale responses after switching threads", async () => {
    let resolve!: (value: { dependencies: ThreadDependency[] }) => void;
    const manage = vi.fn((request) => request.threadId === "waiting"
      ? new Promise<{ dependencies: ThreadDependency[] }>((done) => { resolve = done; }) : Promise.resolve({ dependencies: [] }));
    const api = { manageThreadDependencies: manage } as unknown as DesktopApi;
    const { rerender } = render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    rerender(<ThreadDependenciesPanel thread={target} desktopApi={api} />);
    resolve({ dependencies: [dependency] });
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "list", backend: "codex", threadId: "foundation" }));
    expect(screen.queryByText("Waiting")).not.toBeInTheDocument();
  });
});
