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
  it("shows an agent's CI run wait with its outcomes, gates and latest check, and cancels it", async () => {
    const condition = { backend: "codex" as const, threadId: "", when: "ci_run" as const, title: "Release run 8841207733",
      ciRun: { url: "https://github.com/example/app/actions/runs/8841207733", environments: ["windows-signing"] } };
    const run: ThreadDependency = {
      ...dependency, id: "run-wait", conditions: [condition], onFailure: "notify",
      evidence: [{ condition, state: "waiting", reason: "Waiting for run 8841207733", observedAt: 1,
        ciRun: { runId: 8841207733, status: "in_progress", checkedAt: 1,
          jobs: { total: 5, passed: 2, failed: 0, running: 1, queued: 2, waiting: 0, skipped: 0 } } }],
    };
    const manage = vi.fn(async () => ({ dependencies: [run] }));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderDialog(searchingApi(manage));
    const link = await screen.findByRole("button", { name: "Release run 8841207733" });
    expect(screen.getByText("reaches an approval gate, has a failed job, or finishes")).toBeInTheDocument();
    expect(screen.getByText("Approval gates: windows-signing only")).toBeInTheDocument();
    expect(screen.getByText("Running · 2 passed, 1 running, 2 queued")).toBeInTheDocument();
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("https://github.com/example/app/actions/runs/8841207733", "_blank", "noopener,noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "cancel", backend: "codex", threadId: "waiting", dependencyId: "run-wait" }));
    open.mockRestore();
  });

  it("shows a durable recovery suspension and lets the local operator rearm it", async () => {
    const hook = { ...dependency, repeat: true, conditions: [{ backend: "codex" as const, threadId: "waiting", when: "compaction_completed" as const }] };
    const manage = vi.fn(async (request: ManageThreadDependenciesRequest) => ({
      dependencies: [hook], recoveryProtection: { attemptsInWindow: 3, ...(request.action === "rearm_compaction" ? {} : { suspendedAt: 1000 }) },
    }));
    renderDialog(searchingApi(manage));
    expect(await screen.findByText("Automatic recovery suspended")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rearm recovery" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "rearm_compaction", backend: "codex", threadId: "waiting" }));
    await waitFor(() => expect(screen.queryByText("Automatic recovery suspended")).not.toBeInTheDocument());
  });

  it("registers a recurring self compaction subscription without wait-barrier controls", async () => {
    const manage = vi.fn(async () => ({ dependencies: [] }));
    renderDialog(searchingApi(manage));
    fireEvent.click(await screen.findByRole("button", { name: "Add Compaction Recovery" }));
    expect(screen.queryByRole("checkbox", { name: "Hold merging until then" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remind me" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Repeat after each future compaction" }));
    fireEvent.change(instructions(), { target: { value: "Read /workspace/AGENTS.md and resolve the current assignment with the recovery tool." } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({
      action: "create", backend: "codex", threadId: "waiting",
      conditions: [{ backend: "codex", threadId: "waiting", when: "compaction_completed", title: "Dependencies" }],
      mode: "all", onFailure: "wait", repeat: true,
      continuation: "Read /workspace/AGENTS.md and resolve the current assignment with the recovery tool.",
    }));
  });

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
    const manage = vi.fn(async (request: ManageThreadDependenciesRequest) => ({
      dependencies: [{ ...dependency, status: request.action === "dismiss" ? "dismissed" : "dispatching", error: "Delivery was interrupted" }],
    }));
    const api = { manageThreadDependencies: manage } as unknown as DesktopApi;
    renderDialog(api);
    expect(await screen.findByText("1 delivery needs review")).toBeInTheDocument();
    expect(screen.getByText("Delivery was interrupted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry|Resend|Replay/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss 1 Reviewed…" }));
    expect(manage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "dismiss" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Dismiss 1 delivery after review?" })).getByRole("button", { name: "Dismiss 1" }));
    // One reviewed claim keeps the single-id request an older owner knows.
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "dismiss", backend: "codex", threadId: "waiting", dependencyId: "dependency-1" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 delivery dismissed after review. It is in History.");
  });

  it("reviews many uncertain deliveries by error and dismisses only the chosen groups in one request", async () => {
    const refusal = "Continuation delivery needs review: json-rpc error (-32600): cannot change PwrAgent Token Miser activation while thread 7c1e9a40 has an active turn";
    const timeout = "Continuation delivery needs review: request timed out after 60000ms";
    const claims: ThreadDependency[] = [
      ...Array.from({ length: 30 }, (_, index): ThreadDependency => ({
        ...dependency, id: `refused-${String(index).padStart(2, "0")}`, status: "dispatching", error: refusal, createdAt: 10 + index,
        mode: "any", continuation: "Collect the finished worker results.",
        conditions: [{ backend: "codex", threadId: "docs", when: "turn_completed", title: "Docs sweep worker" }, { backend: "codex", threadId: "schema", when: "turn_completed", title: "Schema migration worker" }],
      })),
      ...Array.from({ length: 2 }, (_, index): ThreadDependency => ({ ...dependency, id: `timeout-${index}`, status: "dispatching", error: timeout, createdAt: 100 + index })),
    ];
    const ready: ThreadDependency = { ...dependency, id: "held", status: "ready", outcome: "success", continuation: "Fold in the release notes." };
    let current = [...claims, ready];
    const manage = vi.fn(async (request: ManageThreadDependenciesRequest) => {
      if (request.action === "dismiss") {
        current = current.map((item) => request.dependencyIds?.includes(item.id) ? { ...item, status: "dismissed" as const } : item);
      }
      return { dependencies: current };
    });
    renderDialog({ manageThreadDependencies: manage } as unknown as DesktopApi);
    const review = await screen.findByRole("region", { name: "32 deliveries need review" });
    // Each cause is printed once, without the lead every claim shares.
    expect(within(review).getAllByText(refusal.replace("Continuation delivery needs review: ", ""))).toHaveLength(1);
    expect(within(review).getByText("request timed out after 60000ms")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss after review" })).not.toBeInTheDocument();
    // The ordinary wait keeps its card below the review.
    expect(screen.getByText("Fold in the release notes.")).toBeInTheDocument();
    fireEvent.click(within(review).getByRole("button", { name: "Show 30 registrations" }));
    const rows = within(review).getByRole("list", { name: "Registrations with this error" });
    expect(within(rows).getAllByRole("listitem")).toHaveLength(30);
    expect(within(rows).getAllByText("Any of: Docs sweep worker, Schema migration worker")).toHaveLength(30);
    // Keep the timeouts for a closer look.
    fireEvent.click(within(review).getByRole("checkbox", { name: /^2 deliveries/ }));
    fireEvent.click(within(review).getByRole("button", { name: "Dismiss 30 Reviewed…" }));
    const confirm = within(review).getByRole("group", { name: "Dismiss 30 deliveries after review?" });
    expect(confirm).toHaveTextContent("Nothing is cancelled or sent again.");
    expect(within(confirm).getByRole("button", { name: "Keep for Review" })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss 30" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "dismiss" })));
    const request = manage.mock.calls.find(([call]) => call.action === "dismiss")![0];
    expect(request).toEqual({ action: "dismiss", backend: "codex", threadId: "waiting", dependencyIds: claims.slice(0, 30).map((item) => item.id) });
    expect(await screen.findByRole("region", { name: "2 deliveries need review" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("30 deliveries dismissed after review. They are in History.");
  });

  it("dismisses only the claims shown when the operator confirmed, even after a refresh adds one", async () => {
    let current: ThreadDependency[] = ["one", "two"].map((id): ThreadDependency => ({ ...dependency, id, status: "dispatching", error: "Delivery was interrupted" }));
    let notify: ((event: { notification: { method: string } }) => void) | undefined;
    const manage = vi.fn(async (request: ManageThreadDependenciesRequest) => {
      if (request.action === "dismiss") current = current.map((item) => request.dependencyIds?.includes(item.id) ? { ...item, status: "dismissed" as const } : item);
      return { dependencies: current };
    });
    const api = { manageThreadDependencies: manage, onAgentEvent: (listener: typeof notify) => { notify = listener; return () => {}; } } as unknown as DesktopApi;
    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss 2 Reviewed…" }));
    // A new claim with another error arrives while the confirmation is open.
    current = [...current, { ...dependency, id: "late", status: "dispatching", error: "request timed out" }];
    await act(async () => { notify!({ notification: { method: "thread/dependencies/updated" } }); });
    expect(await screen.findByText("request timed out")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Dismiss 2 deliveries after review?" })).getByRole("button", { name: "Dismiss 2" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "dismiss" })));
    expect(manage.mock.calls.find(([call]) => call.action === "dismiss")![0]).toEqual({ action: "dismiss", backend: "codex", threadId: "waiting", dependencyIds: ["one", "two"] });
    expect(current.find((item) => item.id === "late")?.status).toBe("dispatching");
  });

  it("keeps the review when the owner refuses the cleanup", async () => {
    const claims = ["one", "two"].map((id): ThreadDependency => ({ ...dependency, id, status: "dispatching", error: "Delivery was interrupted" }));
    const manage = vi.fn(async (request: ManageThreadDependenciesRequest) => {
      if (request.action === "dismiss") throw new Error("Dependency changed while dismissing. Read its current state first.");
      return { dependencies: claims };
    });
    renderDialog({ manageThreadDependencies: manage } as unknown as DesktopApi);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss 2 Reviewed…" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss 2" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dependency changed while dismissing.");
    expect(screen.getByRole("group", { name: "Dismiss 2 deliveries after review?" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("names a wait replaced by a newer registration of the same plan in History", async () => {
    const manage = vi.fn(async () => ({ dependencies: [{ ...dependency, id: "older", status: "cancelled", supersededBy: "newer" }, { ...dependency, id: "newer" }] }));
    renderDialog({ manageThreadDependencies: manage } as unknown as DesktopApi);
    fireEvent.click(await screen.findByRole("button", { name: "History (1)" }));
    expect(screen.getByText("Replaced")).toBeInTheDocument();
    expect(screen.getByText("Replaced by a newer wait for the same plan on later turns.")).toBeInTheDocument();
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
