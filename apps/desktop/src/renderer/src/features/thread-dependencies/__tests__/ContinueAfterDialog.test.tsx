import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, ThreadDependency } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { chooseSelectOption, selectOptionLabels } from "../../../test/select";
import { ContinueAfterDialog } from "../ContinueAfterDialog";

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

function renderDialog(api: DesktopApi, subject = thread) {
  const onClose = vi.fn();
  const view = render(<ContinueAfterDialog thread={subject} desktopApi={api} onClose={onClose} />);
  return { ...view, onClose };
}

const dialog = () => screen.getByRole("dialog", { name: "Continue After" });
const instructions = () => screen.getByRole("textbox", { name: "Instructions" });

describe("Continue After dialog", () => {
  it("opens on the form when nothing is registered and saves exactly the picked row", async () => {
    const manage = vi.fn(async (request) => ({ dependencies: request.action === "create" ? [dependency] : [] }));
    const query = pageOf([thread, target]);
    const release = vi.fn(async () => {});
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: query, releaseNavigationQuery: release } as unknown as DesktopApi;
    renderDialog(api);
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "list", backend: "codex", threadId: "waiting" }));
    // The dialog stays in its loading view until the list response resolves;
    // the call alone does not mean the form has rendered.
    await waitFor(() => expect(dialog()).toHaveAccessibleDescription("Choose what “Dependencies” waits for, and what it does next."));
    const results = await screen.findByRole("list", { name: "Threads" });
    await waitFor(() => expect(release).toHaveBeenCalledWith(query.mock.calls[0]![1]));
    expect(query).toHaveBeenCalledWith({ protocol: 2, consumer: "search", inventory: "owner", query: { kind: "lens", lens: "recents" }, pageSize: 100 }, expect.any(String));
    // The waiting thread itself is never offered.
    expect(within(results).queryByRole("button", { name: "Dependencies" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.click(within(results).getByRole("button", { name: "Foundation" }));
    expect(within(results).getByRole("button", { name: "Foundation" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Its PR can be attached later.")).toBeInTheDocument();
    // A single prerequisite has no all/any choice; a CI condition offers the failure policy.
    expect(screen.queryByRole("group", { name: "Continue when" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "If CI fails" })).toBeInTheDocument();
    // The resumed turn starts from the instructions, so they are required.
    expect(instructions()).toBeRequired();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(instructions(), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(instructions(), { target: { value: "  Start the dependency upgrades " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "create", backend: "codex", threadId: "waiting",
      conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed", title: "Foundation" }],
      mode: "all", onFailure: "wait", continuation: "Start the dependency upgrades",
    }));
    // A saved registration returns the dialog to the list.
    expect(await screen.findByText("Waiting")).toBeInTheDocument();
    expect(screen.getByText("Foundation")).toBeInTheDocument();
    expect(dialog()).toHaveAccessibleDescription("“Dependencies” starts a turn when its prerequisites are met.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "cancel", backend: "codex", threadId: "waiting", dependencyId: "dependency-1" }));
  });

  it("adds with ⌘Enter from the instructions, where Enter alone adds a line", async () => {
    const manage = vi.fn(async () => ({ dependencies: [] }));
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([target]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Foundation" }));
    fireEvent.change(instructions(), { target: { value: "Rebase onto main" } });
    fireEvent.keyDown(instructions(), { key: "Enter" });
    expect(manage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "create" }));
    fireEvent.keyDown(instructions(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "create", continuation: "Rebase onto main" })));
  });

  it("closes from the form with Cancel when there is no list to go back to", async () => {
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [] })), getNavigationQueryPage: pageOf([target]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    const { onClose } = renderDialog(api);
    await screen.findByRole("list", { name: "Threads" });
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens on the registrations, adds from the same dialog, and goes back without saving", async () => {
    const manage = vi.fn(async () => ({ dependencies: [dependency] }));
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([target, second]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    const { onClose } = renderDialog(api);
    expect(await screen.findByText("Waiting")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Threads" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Prerequisites…" }));
    const results = await screen.findByRole("list", { name: "Threads" });
    fireEvent.click(await within(results).findByRole("button", { name: "Driver bump" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("list", { name: "Threads" })).not.toBeInTheDocument();
    expect(manage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "create" }));
    // The form starts empty again.
    fireEvent.click(screen.getByRole("button", { name: "Add Prerequisites…" }));
    await screen.findByRole("list", { name: "Threads" });
    expect(screen.queryByRole("button", { name: "Remove Driver bump" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", async () => {
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [dependency] })) } as unknown as DesktopApi;
    const { onClose } = renderDialog(api);
    await screen.findByText("Waiting");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submits every visible row with its own condition and the all/any choice", async () => {
    const manage = vi.fn(async () => ({ dependencies: [] }));
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([target, second]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    renderDialog(api);
    const results = await screen.findByRole("list", { name: "Threads" });
    await waitFor(() => expect(within(results).getByRole("button", { name: "Driver bump" })).toBeInTheDocument());
    fireEvent.click(within(results).getByRole("button", { name: "Foundation" }));
    fireEvent.click(within(results).getByRole("button", { name: "Driver bump" }));
    chooseSelectOption(screen.getByRole("combobox", { name: "Continue when Foundation" }), "Finishes its turn");
    chooseSelectOption(screen.getByRole("combobox", { name: "Continue when Driver bump" }), "Is merged");
    // No row waits on CI, so the CI failure policy has nothing to govern.
    expect(screen.queryByRole("group", { name: "If CI fails" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Continue when" })).getByRole("button", { name: "Any is met" }));
    fireEvent.change(instructions(), { target: { value: "Ship the release" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "create", backend: "codex", threadId: "waiting",
      conditions: [
        { backend: "codex", threadId: "foundation", when: "turn_completed", title: "Foundation" },
        { backend: "codex", threadId: "driver", when: "pr_merged", title: "Driver bump" },
      ],
      mode: "any", onFailure: "wait", continuation: "Ship the release",
    }));
  });

  it("removes a row when its thread is chosen again or removed", async () => {
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [] })), getNavigationQueryPage: pageOf([target]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    renderDialog(api);
    const option = await screen.findByRole("button", { name: "Foundation" });
    fireEvent.change(instructions(), { target: { value: "Continue" } });
    fireEvent.click(option);
    expect(screen.getByRole("button", { name: "Remove Foundation" })).toBeInTheDocument();
    fireEvent.click(option);
    expect(screen.queryByRole("button", { name: "Remove Foundation" })).not.toBeInTheDocument();
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "Remove Foundation" }));
    expect(option).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("requires a PR choice among the primary-workspace PRs only", async () => {
    const withPrs = { ...target, primaryGitRepository: "github.com/acme/widgets", prs: [
      { provider: "github.com", org: "acme", repo: "widgets", number: 4127, url: "https://github.com/acme/widgets/pull/4127" },
      { provider: "github.com", org: "acme", repo: "widgets", number: 4131, url: "https://github.com/acme/widgets/pull/4131" },
      { provider: "github.com", org: "acme", repo: "docs", number: 77, url: "https://github.com/acme/docs/pull/77" },
    ] } as unknown as NavigationThreadSummary;
    const manage = vi.fn(async () => ({ dependencies: [] }));
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([withPrs]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Foundation" }));
    fireEvent.change(instructions(), { target: { value: "Continue" } });
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(selectOptionLabels(screen.getByRole("combobox", { name: "Pull request for Foundation" }))).toEqual(["#4127", "#4131"]);
    chooseSelectOption(screen.getByRole("combobox", { name: "Pull request for Foundation" }), "#4131");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({
      conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed", title: "Foundation", prUrl: "https://github.com/acme/widgets/pull/4131" }],
    })));
  });

  it("does not offer a secondary-workspace PR the prerequisite cannot release on", async () => {
    const secondaryOnly = { ...target, primaryGitRepository: "github.com/acme/widgets", prs: [
      { provider: "github.com", org: "acme", repo: "docs", number: 77, url: "https://github.com/acme/docs/pull/77" },
    ] } as unknown as NavigationThreadSummary;
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [] })), getNavigationQueryPage: pageOf([secondaryOnly]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Foundation" }));
    expect(screen.getByText("Its PR can be attached later.")).toBeInTheDocument();
    expect(screen.queryByText(/Follows #77/)).not.toBeInTheDocument();
  });

  it("lists threads waiting on this one and will not offer them as prerequisites", async () => {
    const waiter: ThreadDependency = {
      ...dependency, id: "dependency-2", threadId: "downstream",
      conditions: [{ backend: "codex", threadId: "waiting", when: "pr_merged" }],
    };
    const manage = vi.fn(async () => ({ dependencies: [], dependents: [waiter] }));
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([dependent, target]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    renderDialog(api);
    expect(await screen.findByRole("heading", { name: "Waiting on this thread" })).toBeInTheDocument();
    expect(screen.getByText("until it is merged")).toBeInTheDocument();
    expect(screen.getByText("Not waiting on other threads.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Prerequisites…" }));
    const results = await screen.findByRole("list", { name: "Threads" });
    const blocked = await within(results).findByRole("button", { name: /Downstream/ });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(within(blocked).getByText("Waits on this")).toBeInTheDocument();
    fireEvent.click(blocked);
    expect(screen.queryByRole("button", { name: "Remove Downstream" })).not.toBeInTheDocument();
  });

  it("shows per-prerequisite progress and the plan with saved titles instead of thread ids", async () => {
    const twoWay: ThreadDependency = {
      ...dependency,
      continuation: "Retarget onto main and drop the duplicated commits.",
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
    renderDialog(api);
    expect(await screen.findByText("Waiting · 1 of 2 met")).toBeInTheDocument();
    expect(screen.getByText("Driver bump")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Met" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for CI to pass · 9f2c41ab")).toBeInTheDocument();
    expect(screen.getByText("Retarget onto main and drop the duplicated commits.")).toBeInTheDocument();
    expect(screen.getByText("Waits through CI repairs")).toBeInTheDocument();
    expect(screen.queryByText(/^foundation$/)).not.toBeInTheDocument();
  });

  it("keeps finished registrations under a collapsed history", async () => {
    const delivered: ThreadDependency = { ...dependency, id: "old", status: "delivered", outcome: "failure" };
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [delivered] })) } as unknown as DesktopApi;
    renderDialog(api);
    const toggle = await screen.findByRole("button", { name: "History (1)" });
    expect(screen.queryByText("Prerequisite failed")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText("Prerequisite failed")).toBeInTheDocument();
  });

  it("reminds the operator instead of resuming the thread when chosen", async () => {
    const manage = vi.fn(async () => ({ dependencies: [] }));
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([target]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    renderDialog(api);
    const results = await screen.findByRole("list", { name: "Threads" });
    fireEvent.click(await within(results).findByRole("button", { name: "Foundation" }));
    const whenMet = screen.getByRole("group", { name: "When met" });
    expect(within(whenMet).getByRole("button", { name: "Resume this thread" })).toHaveAttribute("aria-pressed", "true");
    // Start thread is offered only for a reminder.
    expect(screen.queryByRole("checkbox", { name: "Offer to start a thread with this reminder" })).not.toBeInTheDocument();
    fireEvent.click(within(whenMet).getByRole("button", { name: "Remind me" }));
    expect(screen.queryByRole("textbox", { name: "Instructions" })).not.toBeInTheDocument();
    const reminder = screen.getByRole("textbox", { name: "Reminder" });
    expect(reminder).toBeRequired();
    expect(reminder).toHaveAccessibleDescription("Required. It becomes a to-do card on this thread, after the met prerequisites. No turn starts.");
    fireEvent.change(reminder, { target: { value: "Write the release notes" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Offer to start a thread with this reminder" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "create", backend: "codex", threadId: "waiting",
      conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed", title: "Foundation" }],
      mode: "all", onFailure: "wait", continuation: "Write the release notes", deliver: "operator", handoff: true,
    }));
  });

  it("names who acts on each card", async () => {
    const reminder: ThreadDependency = { ...dependency, id: "reminder", deliver: "operator", continuation: "Call mom" };
    const reminded: ThreadDependency = { ...reminder, id: "reminded", status: "delivered", outcome: "success", todoId: "todo-1" };
    const continued: ThreadDependency = { ...dependency, id: "continued", status: "delivered", outcome: "success" };
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [dependency, reminder, reminded, continued] })) } as unknown as DesktopApi;
    renderDialog(api);
    expect(await screen.findByText("Reminds you")).toBeInTheDocument();
    // A registration made before operator delivery resumes the thread.
    expect(screen.getByText("Resumes this thread")).toBeInTheDocument();
    expect(dialog()).toHaveAccessibleDescription("“Dependencies” starts a turn when its prerequisites are met.");
    fireEvent.click(screen.getByRole("button", { name: "History (2)" }));
    expect(screen.getByText("Reminded")).toBeInTheDocument();
    expect(screen.getByText("Continued")).toBeInTheDocument();
    expect(screen.getAllByText("Reminds you")).toHaveLength(2);
  });

  it("says the thread reminds you when every active registration does", async () => {
    const reminder: ThreadDependency = { ...dependency, id: "reminder", deliver: "operator", continuation: "Call mom" };
    const api = { manageThreadDependencies: vi.fn(async () => ({ dependencies: [reminder] })) } as unknown as DesktopApi;
    renderDialog(api);
    expect(await screen.findByText("Reminds you")).toBeInTheDocument();
    expect(dialog()).toHaveAccessibleDescription("“Dependencies” reminds you when its prerequisites are met.");
  });

  it("shows registration failures and uncertain delivery without offering to replay it", async () => {
    const manage = vi.fn(async () => ({ dependencies: [{ ...dependency, status: "dispatching", error: "Delivery was interrupted" }] }));
    const api = { manageThreadDependencies: manage } as unknown as DesktopApi;
    renderDialog(api);
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
    renderDialog(api);
    expect(await screen.findByText("Showing recent matches. Refine the search to find another thread.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Find a thread" }), { target: { value: "Foundation" } });
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ query: { kind: "lens", lens: "recents", filter: "Foundation" }, pageSize: 100 }), expect.any(String)));
    await waitFor(() => expect(release).toHaveBeenCalledTimes(2));
  });

  it("shows a refused registration in the dialog and keeps the form", async () => {
    const manage = vi.fn(async (request) => {
      if (request.action === "create") throw new Error("This dependency would create a thread dependency cycle.");
      return { dependencies: [] };
    });
    const api = { manageThreadDependencies: manage, getNavigationQueryPage: pageOf([target]), releaseNavigationQuery: vi.fn(async () => {}) } as unknown as DesktopApi;
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Foundation" }));
    fireEvent.change(instructions(), { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This dependency would create a thread dependency cycle.");
    expect(screen.getByRole("button", { name: "Remove Foundation" })).toBeInTheDocument();
    expect(instructions()).toHaveValue("Continue");
  });

  it("ignores stale responses after switching threads", async () => {
    let resolve!: (value: { dependencies: ThreadDependency[] }) => void;
    const manage = vi.fn((request) => request.threadId === "waiting"
      ? new Promise<{ dependencies: ThreadDependency[] }>((done) => { resolve = done; }) : Promise.resolve({ dependencies: [] }));
    const api = { manageThreadDependencies: manage } as unknown as DesktopApi;
    const { rerender, onClose } = renderDialog(api);
    rerender(<ContinueAfterDialog thread={target} desktopApi={api} onClose={onClose} />);
    resolve({ dependencies: [dependency] });
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "list", backend: "codex", threadId: "foundation" }));
    expect(screen.queryByText("Waiting")).not.toBeInTheDocument();
  });
});
