import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ManageThreadDependenciesRequest,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationThreadSummary,
  ThreadDependency,
} from "@pwragent/shared";
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

/** An api whose empty search lists `recent`, the way ⌘K lists recent threads. */
function searchingApi(manage: unknown, recent: NavigationThreadSummary[] = []): DesktopApi {
  return {
    manageThreadDependencies: manage,
    getNavigationQueryPage: vi.fn(async (request: NavigationQueryRequest) => {
      const rows = request.query.kind === "search" ? [] : recent;
      return {
        protocol: 2, queryKey: request.query.kind, generation: "generation", ownerEpoch: "owner", countsRevision: "counts",
        counts: { total: rows.length, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, complete: true,
        entries: rows.map((row) => ({ row })),
      } as unknown as NavigationQueryPage;
    }),
    jumpSearchRemoteThreads: vi.fn(async () => ({ results: [] })),
  } as unknown as DesktopApi;
}

function renderDialog(api: DesktopApi, subject = thread) {
  const onClose = vi.fn();
  const view = render(<ContinueAfterDialog thread={subject} desktopApi={api} onClose={onClose} />);
  return { ...view, onClose };
}

/** The search row for `title`, once the recent threads have loaded. */
const findOption = (title: string) => screen.findByRole("option", { name: new RegExp(title) });

async function pick(title: string) {
  const option = await findOption(title);
  await act(async () => { fireEvent.click(within(option).getByRole("button", { name: new RegExp(title) })); });
}

const dialog = () => screen.getByRole("dialog", { name: "Continue After" });
const instructions = () => screen.getByRole("textbox", { name: "Instructions" });

describe("Continue After dialog", () => {
  it("opens on the form when nothing is registered and saves exactly the picked row", async () => {
    const manage = vi.fn(async (request) => ({ dependencies: request.action === "create" ? [dependency] : [] }));
    const api = searchingApi(manage, [thread, target]);
    renderDialog(api);
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "list", backend: "codex", threadId: "waiting" }));
    // The dialog stays in its loading view until the list response resolves;
    // the call alone does not mean the form has rendered.
    await waitFor(() => expect(dialog()).toHaveAccessibleDescription("Choose what “Dependencies” waits for, and what it does next."));
    expect(screen.getByRole("combobox", { name: "Find a thread to wait for" })).toHaveFocus();
    await findOption("Foundation");
    // The waiting thread itself is never offered.
    expect(screen.queryByRole("option", { name: /Dependencies/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await pick("Foundation");
    // A picked thread leaves the search; its row is the only place it shows.
    expect(screen.queryByRole("option", { name: /Foundation/ })).not.toBeInTheDocument();
    expect(screen.getByText("Its PR can be attached later.")).toBeInTheDocument();
    // A single prerequisite has no all/any choice; a CI condition offers the failure policy.
    expect(screen.queryByRole("group", { name: "Continue when" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "If CI fails" })).toBeInTheDocument();
    // Waiting on CI alone leaves merging alone.
    expect(screen.getByRole("checkbox", { name: "Hold merging until then" })).not.toBeChecked();
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
    renderDialog(searchingApi(manage, [target]));
    await pick("Foundation");
    fireEvent.change(instructions(), { target: { value: "Rebase onto main" } });
    fireEvent.keyDown(instructions(), { key: "Enter" });
    expect(manage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "create" }));
    fireEvent.keyDown(instructions(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "create", continuation: "Rebase onto main" })));
  });

  it("closes from the form with Cancel when there is no list to go back to", async () => {
    const { onClose } = renderDialog(searchingApi(vi.fn(async () => ({ dependencies: [] })), [target]));
    await findOption("Foundation");
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens on the registrations, adds from the same dialog, and goes back without saving", async () => {
    const manage = vi.fn(async () => ({ dependencies: [dependency] }));
    const { onClose } = renderDialog(searchingApi(manage, [target, second]));
    expect(await screen.findByText("Waiting")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Find a thread to wait for" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Prerequisites…" }));
    await pick("Driver bump");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("combobox", { name: "Find a thread to wait for" })).not.toBeInTheDocument();
    expect(manage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "create" }));
    // The form starts empty again.
    fireEvent.click(screen.getByRole("button", { name: "Add Prerequisites…" }));
    await findOption("Driver bump");
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
    renderDialog(searchingApi(manage, [target, second]));
    await pick("Foundation");
    await pick("Driver bump");
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

  it("removes a row and offers its thread again", async () => {
    renderDialog(searchingApi(vi.fn(async () => ({ dependencies: [] })), [target]));
    await pick("Foundation");
    fireEvent.change(instructions(), { target: { value: "Continue" } });
    expect(screen.queryByRole("option", { name: /Foundation/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Foundation" }));
    expect(await findOption("Foundation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("requires a PR choice among the primary-workspace PRs only", async () => {
    const withPrs = { ...target, primaryGitRepository: "github.com/acme/widgets", prs: [
      { provider: "github.com", org: "acme", repo: "widgets", number: 4127, url: "https://github.com/acme/widgets/pull/4127" },
      { provider: "github.com", org: "acme", repo: "widgets", number: 4131, url: "https://github.com/acme/widgets/pull/4131",
        explicitlyAttached: true, sourceRepository: { provider: "github.com", org: "contributor", repo: "widgets" } },
      { provider: "github.com", org: "acme", repo: "docs", number: 77, url: "https://github.com/acme/docs/pull/77", explicitlyAttached: true },
      { provider: "github.com", org: "acme", repo: "widgets", number: 78, url: "https://github.com/acme/widgets/pull/78",
        sourceRepository: { provider: "github.com", org: "unrelated", repo: "widgets" } },
    ] } as unknown as NavigationThreadSummary;
    const manage = vi.fn(async () => ({ dependencies: [] }));
    renderDialog(searchingApi(manage, [withPrs]));
    await pick("Foundation");
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
    renderDialog(searchingApi(vi.fn(async () => ({ dependencies: [] })), [secondaryOnly]));
    await pick("Foundation");
    expect(screen.getByText("Its PR can be attached later.")).toBeInTheDocument();
    expect(screen.queryByText(/Follows #77/)).not.toBeInTheDocument();
  });

  it("lists threads waiting on this one and will not offer them as prerequisites", async () => {
    const waiter: ThreadDependency = {
      ...dependency, id: "dependency-2", threadId: "downstream",
      conditions: [{ backend: "codex", threadId: "waiting", when: "pr_merged" }],
    };
    const manage = vi.fn(async () => ({ dependencies: [], dependents: [waiter] }));
    renderDialog(searchingApi(manage, [dependent, target]));
    expect(await screen.findByRole("heading", { name: "Waiting on this thread" })).toBeInTheDocument();
    expect(screen.getByText("until it is merged")).toBeInTheDocument();
    expect(screen.getByText("Not waiting on anything.")).toBeInTheDocument();
    // Only a marked-done wait can be marked done from here.
    expect(screen.queryByRole("button", { name: "Mark Done…" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Prerequisites…" }));
    await findOption("Foundation");
    expect(screen.queryByRole("option", { name: /Downstream/ })).not.toBeInTheDocument();
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

  it("reminds the operator with a checklist of steps instead of resuming the thread", async () => {
    const manage = vi.fn(async () => ({ dependencies: [] }));
    renderDialog(searchingApi(manage, [target]));
    await pick("Foundation");
    const whenMet = screen.getByRole("group", { name: "When met" });
    expect(within(whenMet).getByRole("button", { name: "Resume this thread" })).toHaveAttribute("aria-pressed", "true");
    // Start thread is offered only for a reminder.
    expect(screen.queryByRole("checkbox", { name: "Offer to start a thread with this reminder" })).not.toBeInTheDocument();
    fireEvent.click(within(whenMet).getByRole("button", { name: "Remind me" }));
    expect(screen.queryByRole("textbox", { name: "Instructions" })).not.toBeInTheDocument();
    const reminder = screen.getByRole("textbox", { name: "Remind me to" });
    expect(reminder).toBeRequired();
    expect(reminder).toHaveAccessibleDescription("Required. One step per line. They become a checklist on a to-do card on this thread. No turn starts.");
    fireEvent.change(reminder, { target: { value: "- Rebase onto #3291\n\n2. Merge #17\n" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Offer to start a thread with this reminder" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "create", backend: "codex", threadId: "waiting",
      conditions: [{ backend: "codex", threadId: "foundation", when: "ci_passed", title: "Foundation" }],
      mode: "all", onFailure: "wait", continuation: "Rebase onto #3291\nMerge #17", deliver: "operator", handoff: true,
      steps: ["Rebase onto #3291", "Merge #17"],
    }));
  });

  it("refuses more reminder steps than a card holds", async () => {
    renderDialog(searchingApi(vi.fn(async () => ({ dependencies: [] })), [target]));
    await pick("Foundation");
    fireEvent.click(within(screen.getByRole("group", { name: "When met" })).getByRole("button", { name: "Remind me" }));
    const reminder = screen.getByRole("textbox", { name: "Remind me to" });
    fireEvent.change(reminder, { target: { value: Array.from({ length: 13 }, (_, index) => `Step ${index + 1}`).join("\n") } });
    expect(reminder).toHaveAccessibleDescription("Use at most 12 steps of 200 characters.");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("waits for something that is not a thread, and holds merging until it is marked done", async () => {
    const manage = vi.fn(async () => ({ dependencies: [] }));
    renderDialog(searchingApi(manage, [target]));
    await findOption("Foundation");
    fireEvent.click(screen.getByRole("button", { name: "Add Something Else" }));
    const subject = screen.getByRole("textbox", { name: "Something else to wait for" });
    fireEvent.change(instructions(), { target: { value: "Merge the fix" } });
    // A blank row names nothing to wait for.
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(subject, { target: { value: " Windows validation of the shutdown fix " } });
    const hold = screen.getByRole("checkbox", { name: "Hold merging until then" });
    expect(hold).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "create", backend: "codex", threadId: "waiting",
      conditions: [{ backend: "codex", threadId: "", when: "marked_done", subject: "Windows validation of the shutdown fix" }],
      mode: "all", onFailure: "wait", continuation: "Merge the fix", holdMerge: true,
    }));
  });

  it("leaves merging alone when the operator unticks the hold", async () => {
    const manage = vi.fn(async (_request: ManageThreadDependenciesRequest) => ({ dependencies: [] }));
    renderDialog(searchingApi(manage, [target]));
    await pick("Foundation");
    chooseSelectOption(screen.getByRole("combobox", { name: "Continue when Foundation" }), "Is marked done");
    const hold = screen.getByRole("checkbox", { name: "Hold merging until then" });
    expect(hold).toBeChecked();
    fireEvent.click(hold);
    fireEvent.change(instructions(), { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "create" })));
    const create = manage.mock.calls.find(([request]) => request.action === "create")![0];
    expect(create).not.toHaveProperty("holdMerge");
    expect(create).toMatchObject({ conditions: [{ threadId: "foundation", when: "marked_done" }] });
  });

  it("waits on another machine's thread until it is marked done, named from the waiting thread's owner", async () => {
    const peerRow = {
      ...target, id: "validation", title: "Windows validation",
      federation: {
        ref: { backend: "codex", threadId: "validation", target: { scope: "remote", instanceId: "win-lab" } },
        instanceLabel: "Windows lab", peerStatus: "connected", capabilities: ["turn_control"],
      },
    } as unknown as NavigationThreadSummary;
    const manage = vi.fn(async () => ({ dependencies: [] }));
    renderDialog(searchingApi(manage, [peerRow]));
    await pick("Windows validation");
    // Only "marked done" crosses machines, so there is no milestone to choose.
    expect(screen.queryByRole("combobox", { name: "Continue when Windows validation" })).not.toBeInTheDocument();
    expect(screen.getByText("On another machine. Waits until that thread, you, or an agent mark it done.")).toBeInTheDocument();
    fireEvent.change(instructions(), { target: { value: "Merge" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({
      action: "create",
      conditions: [{ backend: "codex", threadId: "validation", when: "marked_done", title: "Windows validation", target: { scope: "remote", instanceId: "win-lab" } }],
      holdMerge: true,
    })));
  });

  it("manages a peer's thread on its owner", async () => {
    const peerThread = {
      ...thread,
      federation: {
        ref: { backend: "codex", threadId: "waiting", target: { scope: "remote", instanceId: "lab" } },
        instanceLabel: "Lab", peerStatus: "connected", capabilities: ["turn_control"],
      },
    } as unknown as NavigationThreadSummary;
    const manage = vi.fn(async () => ({ dependencies: [] }));
    renderDialog(searchingApi(manage, [target]), peerThread);
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "list", backend: "codex", threadId: "waiting", federationTarget: { scope: "remote", instanceId: "lab" },
    }));
    expect(screen.queryByText(/available for local threads/)).not.toBeInTheDocument();
  });

  it("marks its own marked-done prerequisite done with a note", async () => {
    const waitingForDone: ThreadDependency = {
      ...dependency, holdMerge: true,
      conditions: [{ backend: "codex", threadId: "", when: "marked_done", subject: "Windows validation" }],
    };
    const manage = vi.fn(async (_request: ManageThreadDependenciesRequest) => ({ dependencies: [waitingForDone] }));
    renderDialog(searchingApi(manage));
    expect(await screen.findByText("Windows validation")).toBeInTheDocument();
    expect(screen.getByText("Merge held")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark Done… Windows validation" }));
    const markDone = screen.getByRole("button", { name: "Mark Done" });
    fireEvent.change(screen.getByRole("textbox", { name: "What finished (optional)" }), { target: { value: " Windows checks passed. " } });
    fireEvent.click(markDone);
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "mark_done", backend: "codex", threadId: "waiting",
      dependencyId: "dependency-1", conditionIndex: 0, note: "Windows checks passed.",
    }));
    // The list is read again after the mark.
    await waitFor(() => expect(manage.mock.calls.filter(([request]) => request.action === "list")).toHaveLength(2));
    expect(screen.queryByRole("textbox", { name: "What finished (optional)" })).not.toBeInTheDocument();
  });

  it("lets this thread mark done the wait another machine keeps on it, on that machine", async () => {
    const remoteWaiter: ThreadDependency = {
      ...dependency, id: "remote-wait", threadId: "merge-work",
      conditions: [{ backend: "codex", threadId: "waiting", when: "marked_done", title: "Dependencies", target: { scope: "remote", instanceId: "mac" } }],
    };
    const manage = vi.fn(async () => ({
      dependencies: [], peerDependents: [{ dependency: remoteWaiter, owner: { scope: "remote" as const, instanceId: "lab" } }],
    }));
    renderDialog(searchingApi(manage));
    expect(await screen.findByRole("heading", { name: "Waiting on this thread" })).toBeInTheDocument();
    expect(screen.getByText("until it is marked done")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark Done…" }));
    // The note is optional; the owner records "Marked done" without one.
    fireEvent.click(screen.getByRole("button", { name: "Mark Done" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "mark_done", backend: "codex", threadId: "merge-work", federationTarget: { scope: "remote", instanceId: "lab" },
      dependencyId: "remote-wait", conditionIndex: 0,
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

  it("shows a refused registration in the dialog and keeps the form", async () => {
    const manage = vi.fn(async (request) => {
      if (request.action === "create") throw new Error("This dependency would create a thread dependency cycle.");
      return { dependencies: [] };
    });
    renderDialog(searchingApi(manage, [target]));
    await pick("Foundation");
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
