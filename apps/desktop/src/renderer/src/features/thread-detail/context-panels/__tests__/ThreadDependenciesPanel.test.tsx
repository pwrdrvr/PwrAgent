import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const dependency: ThreadDependency = {
  id: "dependency-1", backend: "codex", threadId: "waiting", status: "waiting",
  conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed" }],
  mode: "all", onFailure: "wait", evidence: [], createdAt: 1, updatedAt: 1,
};

describe("Continue after", () => {
  it("creates a dependency before the prerequisite has a PR and can cancel it", async () => {
    const manage = vi.fn(async (request) => ({ dependencies: request.action === "list" ? [] : request.action === "create" ? [dependency] : [] }));
    const query = vi.fn(async (_request: unknown, _consumerId: string) => ({ entries: [thread, target].map((row) => ({ row })), complete: true, coverage: { state: "complete" } }));
    const release = vi.fn(async () => {});
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: query, releaseNavigationQuery: release } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "list", backend: "codex", threadId: "waiting" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue after…" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Prerequisite thread" })).toBeEnabled());
    expect(query).toHaveBeenCalledWith({ protocol: 2, consumer: "search", inventory: "owner", query: { kind: "lens", lens: "recents" }, pageSize: 100 }, expect.any(String));
    expect(release).toHaveBeenCalledWith(query.mock.calls[0][1]);
    chooseSelectOption(screen.getByRole("combobox", { name: "Prerequisite thread" }), "Foundation · codex");
    fireEvent.change(screen.getByRole("textbox", { name: "Continuation (optional)" }), { target: { value: "Start the dependency upgrades" } });
    fireEvent.click(screen.getByRole("button", { name: "Save dependency" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "create", backend: "codex", threadId: "waiting",
      conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed" }],
      mode: "all", onFailure: "wait", continuation: "Start the dependency upgrades",
    }));
    expect(await screen.findByText("Waiting")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "cancel", backend: "codex", threadId: "waiting", dependencyId: "dependency-1" }));
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

  it("filters a bounded target page and releases its navigation consumer", async () => {
    const query = vi.fn(async (_request: unknown, _consumerId: string) => ({ entries: [{ row: target }], complete: false, coverage: { state: "complete" } }));
    const release = vi.fn(async () => {});
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [] })), getNavigationQueryPage: query, releaseNavigationQuery: release } as unknown as DesktopApi;
    render(<ThreadDependenciesPanel thread={thread} desktopApi={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue after…" }));
    expect(await screen.findByText("Showing a bounded page. Refine the filter to find another thread.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Find thread" }), { target: { value: "Foundation" } });
    fireEvent.click(screen.getByRole("button", { name: "Find threads" }));
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
