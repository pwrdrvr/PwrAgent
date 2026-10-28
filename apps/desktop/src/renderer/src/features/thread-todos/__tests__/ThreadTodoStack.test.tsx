import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, ThreadReview, ThreadTodo, ThreadTodoProject } from "@pwragent/shared";
import type { AppServerPendingRequestNotification } from "@pwragent/shared";
import {
  THREAD_TODO_BUSY_RETRY_MS,
  codexAsyncQuestionItemId,
  threadTodoThreadKey,
  threadReviewTodo,
  operatorTodoItemKey,
  parseCodexAsyncQuestionReply,
} from "@pwragent/shared";
import { copyTextWithHtml } from "../../../lib/copy-text";
import { ThreadMetaChips } from "../../navigation/ThreadMetaChips";
import { ThreadTodoStack } from "../ThreadTodoStack";
import { ThreadTodosPanel } from "../ThreadTodosPanel";
import { ThreadTodoCountsContext } from "../useThreadTodos";
import { unwrapNavigationRead } from "../../../../../shared/navigation-ipc-result";
import type { ThreadTodosView } from "../thread-todos-view";
import { buildOperatorWaits, type OperatorWait } from "../../operator-requests/operator-waits";
import { OperatorWaitsContext } from "../../operator-requests/useOperatorRequests";

vi.mock("../../../lib/copy-text", () => ({
  copyText: vi.fn(async () => undefined),
  copyTextWithHtml: vi.fn(async () => undefined),
}));

afterEach(() => {
  cleanup();
  delete (window as unknown as { pwragent?: unknown }).pwragent;
  vi.useRealTimers();
  vi.mocked(copyTextWithHtml).mockClear();
});

const AGENT: ThreadTodoProject = { key: "directory:/src/pwragent", label: "PwrAgent", path: "/src/pwragent" };
const SNAP: ThreadTodoProject = { key: "directory:/src/pwrsnap", label: "PwrSnap", path: "/src/pwrsnap" };
const GIT: ThreadTodoProject = { key: "directory:/src/pwrgit", label: "PwrGit", path: "/src/pwrgit" };

function todo(overrides: Partial<ThreadTodo> & { id: string }): ThreadTodo {
  return {
    backend: "codex",
    threadId: "thread-a",
    kind: "reminder",
    status: "open",
    title: `Card ${overrides.id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createView(open: ThreadTodo[], overrides: Partial<ThreadTodosView> = {}): ThreadTodosView {
  const openByThreadKey = new Map<string, ThreadTodo[]>();
  for (const entry of open) {
    const key = threadTodoThreadKey(entry);
    openByThreadKey.set(key, [...(openByThreadKey.get(key) ?? []), entry]);
  }
  return {
    open,
    openByThreadKey,
    revision: 0,
    runningIds: new Set(),
    instances: [],
    threadTitle: (entry) => (entry.threadId === "thread-a" ? "Alpha" : "Beta"),
    resolve: vi.fn(async (entry, status) => ({ ...entry, status })),
    run: vi.fn(async (entry) => entry),
    setItemChecked: vi.fn(async (entry) => entry),
    openThread: vi.fn(),
    openStartedThread: vi.fn(),
    waits: [],
    waitsByThreadKey: new Map(),
    // Cards start seen; the unread tests below pass their own set.
    seenKeys: new Set(open.map((entry) => operatorTodoItemKey(entry.id))),
    markSeen: vi.fn(),
    respond: vi.fn(async () => undefined),
    dismissQuestion: vi.fn(async () => undefined),
    dismissedQuestionKeys: new Set(),
    openWait: vi.fn(),
    threadTitleForKey: (threadKey) => (threadKey === "codex:thread-a" ? "Alpha" : "Beta"),
    threadProjectForKey: () => undefined,
    ...overrides,
  };
}

describe("ThreadTodoStack", () => {
  it("keeps remote review fixes pending until the owner accepts them and retains selection on refusal", async () => {
    const federationTarget = { scope: "remote" as const, instanceId: "owner" };
    const review: ThreadReview = {
      id: "review", backend: "codex", threadId: "thread-a", sourceKey: "artifact",
      title: "Review", status: "open", createdAt: 1, updatedAt: 1, federationTarget,
      items: [{ id: "finding", title: "Repair cancellation", status: "open", createdAt: 1, updatedAt: 1 }],
    };
    Object.assign(window, { pwragent: {
      listThreadReviews: vi.fn(async () => ({ reviews: [review] })),
      onThreadTodosChanged: () => () => {},
    } });
    let settle!: (accepted: boolean) => void;
    const onDoHere = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const card = threadReviewTodo(review);
    render(<ThreadTodoStack threadKey={threadTodoThreadKey(card)} todos={[card]}
      view={createView([card])} onStartReview={vi.fn()} onDoHere={onDoHere} />);
    const select = await screen.findByRole("button", { name: "Select finding: Repair cancellation" });
    fireEvent.click(select);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Fix 1 selected/ })); });
    expect(onDoHere).toHaveBeenCalledTimes(1);
    expect(select.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Sending/ }).hasAttribute("disabled")).toBe(true);
    await act(async () => settle(false));
    expect(select.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Fix 1 selected/ }).hasAttribute("disabled")).toBe(false);
  });

  it("gives a review that ranks nothing no priority column, and keeps it for one that does", async () => {
    const review = (id: string, priority?: number): ThreadReview => ({
      id, backend: "claude", threadId: "thread-a", sourceKey: id,
      title: "Review", status: "open", createdAt: 1, updatedAt: 1,
      items: [
        { id: `${id}-a`, title: "Duplicate CSS rule", category: "simplification", status: "open", createdAt: 1, updatedAt: 1 },
        { id: `${id}-b`, title: "Ranked finding", ...(priority === undefined ? {} : { priority }), status: "open", createdAt: 1, updatedAt: 1 },
      ],
    });
    for (const [entry, ranked] of [[review("unranked"), false], [review("ranked", 1), true]] as const) {
      Object.assign(window, { pwragent: {
        listThreadReviews: vi.fn(async () => ({ reviews: [entry] })),
        onThreadTodosChanged: () => () => {},
      } });
      const card = threadReviewTodo(entry);
      render(<ThreadTodoStack threadKey={threadTodoThreadKey(card)} todos={[card]}
        view={createView([card])} onStartReview={vi.fn()} onDoHere={vi.fn()} />);
      const list = await screen.findByRole("list", { name: "Findings" });
      expect(list.hasAttribute("data-unranked")).toBe(!ranked);
      expect(list.querySelectorAll(".review-todo__priority").length).toBe(ranked ? 2 : 0);
      expect(within(list).queryByText("P?")).toBeNull();
      cleanup();
    }
  });

  it("pages through this thread's cards", () => {
    const todos = [todo({ id: "1" }), todo({ id: "2" }), todo({ id: "3" })];
    render(
      <ThreadTodoStack
        threadKey="codex:thread-a"
        todos={todos}
        view={createView(todos)}
        onStartReview={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Card 1" })).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous to-do" }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next to-do" }));
    fireEvent.click(screen.getByRole("button", { name: "Next to-do" }));
    expect(screen.getByRole("heading", { name: "Card 3" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next to-do" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("stays collapsed for the cards it had and reopens for a new one", () => {
    const first = [todo({ id: "c1" })];
    const view = createView(first);
    const { rerender } = render(
      <ThreadTodoStack threadKey="codex:collapse" todos={first} view={view} onStartReview={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse to-dos" }));
    expect(screen.getByRole("button", { name: "Show to-dos: 1 open" })).toBeTruthy();

    const second = [todo({ id: "c2" }), ...first];
    rerender(
      <ThreadTodoStack threadKey="codex:collapse" todos={second} view={view} onStartReview={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "Card c2" })).toBeTruthy();
  });

  it("asks before a squash merge", async () => {
    const merge = todo({
      id: "m",
      kind: "merge",
      title: "Merge the fix",
      action: { type: "merge_pull_request", pullRequest: "42" },
    });
    const view = createView([merge]);
    render(
      <ThreadTodoStack threadKey="codex:thread-a" todos={[merge]} view={view} onStartReview={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Squash merge" }));
    expect(view.run).not.toHaveBeenCalled();
    expect(screen.getByText(/Squash merge #42\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Squash merge #42\?/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Squash merge" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Squash merge" }));
    });
    expect(view.run).toHaveBeenCalledWith(merge, { mergeMethod: "squash" });
  });

  it("remembers a merge method picked from the menu", async () => {
    const merge = todo({
      id: "m2",
      kind: "merge",
      title: "Merge the fix",
      sourceProject: AGENT,
      action: { type: "merge_pull_request", pullRequest: "42" },
    });
    const view = createView([merge]);
    render(
      <ThreadTodoStack threadKey="codex:thread-a" todos={[merge]} view={view} onStartReview={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Merge options" }));
    const menu = screen.getByRole("menu", { name: "Merge options" });
    expect(within(menu).getByRole("menuitemradio", { name: "Squash and merge" })
      .getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Rebase and merge" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText(/Rebase and merge #42\?/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rebase and merge" }));
    });
    expect(view.run).toHaveBeenCalledWith(merge, {
      mergeMethod: "rebase",
      rememberMergeMethod: true,
    });
  });

  it("labels the merge with the target project's remembered method", () => {
    const merge = todo({
      id: "m3",
      kind: "merge",
      sourceProject: AGENT,
      targetProject: SNAP,
      action: { type: "merge_pull_request", pullRequest: "7" },
    });
    const view = createView([merge], {
      mergeMethods: { defaultMethod: "squash", byProject: { [SNAP.key]: "merge" } },
    });
    render(
      <ThreadTodoStack threadKey="codex:thread-a" todos={[merge]} view={view} onStartReview={vi.fn()} />,
    );

    expect(screen.getByText("For PwrSnap")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(screen.getByText("Merge #7 in PwrSnap? This cannot be undone here.")).toBeTruthy();
  });

  describe("project menu", () => {
    const handoff = (overrides: Partial<ThreadTodo> = {}) => todo({
      id: "p",
      kind: "handoff",
      sourceProject: AGENT,
      action: { type: "start_thread", prompt: "Add the retry" },
      ...overrides,
    });
    const menu = () => ({
      list: vi.fn(async () => [AGENT, SNAP, GIT]),
      set: vi.fn(async (entry: ThreadTodo) => entry),
    });
    const renderCard = (card: ThreadTodo, projectMenu?: ReturnType<typeof menu>) =>
      render(
        <ThreadTodoStack
          threadKey="codex:thread-a"
          todos={[card]}
          view={createView([card], projectMenu ? { projectMenu } : {})}
          onStartReview={vi.fn()}
        />,
      );
    const openMenu = async (name: RegExp) => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name }));
      });
    };

    it("names the thread's own project and retags the card from its menu", async () => {
      const projectMenu = menu();
      const card = handoff();
      renderCard(card, projectMenu);

      await openMenu(/^To-do project: PwrAgent\./);
      const options = screen.getAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual([
        "✓PwrAgentThis thread/src/pwragent",
        "PwrSnap/src/pwrsnap",
        "PwrGit/src/pwrgit",
      ]);
      expect(options[0]!.getAttribute("aria-selected")).toBe("true");

      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: /PwrSnap/ }));
      });
      expect(projectMenu.set).toHaveBeenCalledWith(card, SNAP.key);
      expect(screen.queryByRole("dialog", { name: "Project for this to-do" })).toBeNull();
      // The picked row is gone, so focus goes back to the line, not <body>.
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^To-do project: PwrAgent\./ }),
      );
    });

    it("clears the tag when the thread's own project is picked", async () => {
      const projectMenu = menu();
      const card = handoff({ targetProject: SNAP });
      renderCard(card, projectMenu);

      await openMenu(/^To-do project: For PwrSnap\./);
      expect(screen.getByRole("option", { name: /PwrSnap/ }).getAttribute("aria-selected"))
        .toBe("true");
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: /PwrAgent/ }));
      });
      expect(projectMenu.set).toHaveBeenCalledWith(card, null);
    });

    it("filters by name or path", async () => {
      renderCard(handoff(), menu());
      await openMenu(/^To-do project: PwrAgent\./);
      fireEvent.change(screen.getByRole("textbox", { name: "Find a project" }), {
        target: { value: "git" },
      });
      expect(screen.getAllByRole("option").map((option) => option.textContent))
        .toEqual(["PwrGit/src/pwrgit"]);
    });

    it("keeps the menu open with the reason when the change fails", async () => {
      const projectMenu = menu();
      projectMenu.set.mockRejectedValueOnce(new Error(
        "Error invoking remote method 'thread-todos:set-project': ThreadTodoError: That project is no longer in the sidebar.",
      ));
      renderCard(handoff(), projectMenu);
      await openMenu(/^To-do project: PwrAgent\./);
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: /PwrGit/ }));
      });
      expect(screen.getByRole("alert").textContent).toBe("That project is no longer in the sidebar.");
      expect(screen.getByRole("dialog", { name: "Project for this to-do" })).toBeTruthy();
    });

    it("offers a thread with no directory a project, from a dashed line", async () => {
      const projectMenu = menu();
      const card = handoff({ sourceProject: undefined });
      renderCard(card, projectMenu);
      const trigger = screen.getByRole("button", { name: /^To-do project: No project\./ });
      expect(trigger.className).toContain("is-empty");
      await openMenu(/^To-do project: No project\./);
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    it("offers no pick while the card's action runs", async () => {
      const card = handoff();
      const projectMenu = menu();
      const view = createView([card], { projectMenu });
      const { rerender } = render(
        <ThreadTodoStack threadKey="codex:thread-a" todos={[card]} view={view} onStartReview={vi.fn()} />,
      );
      await openMenu(/^To-do project: PwrAgent\./);
      rerender(
        <ThreadTodoStack
          threadKey="codex:thread-a"
          todos={[card]}
          view={{ ...view, runningIds: new Set([card.id]) }}
          onStartReview={vi.fn()}
        />,
      );
      expect(screen.getAllByRole("option").every((option) => (option as HTMLButtonElement).disabled))
        .toBe(true);
    });

    it("gives a review card no menu, and a window without one a static line", () => {
      const projectMenu = menu();
      renderCard(todo({ id: "r", kind: "review", sourceProject: AGENT, action: { type: "start_review" } }), projectMenu);
      expect(screen.queryByRole("button", { name: /^To-do project:/ })).toBeNull();
      cleanup();

      renderCard(handoff({ targetProject: SNAP }));
      expect(screen.queryByRole("button", { name: /^To-do project:/ })).toBeNull();
      expect(screen.getByText("For PwrSnap")).toBeTruthy();
    });
  });

  it("offers a handoff here, on a peer, or as handled elsewhere", async () => {
    const handoff = todo({
      id: "h2",
      kind: "handoff",
      action: { type: "start_thread", prompt: "Build it" },
    });
    const view = createView([handoff], {
      instances: [{ instanceId: "peer-1", label: "Studio Mac" }],
    });
    const onDoHere = vi.fn(async () => true);
    render(
      <ThreadTodoStack
        threadKey="codex:thread-a"
        todos={[handoff]}
        view={view}
        onStartReview={vi.fn()}
        onDoHere={onDoHere}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Handoff options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Do it here" }));
    expect(onDoHere).toHaveBeenCalledWith(handoff, undefined);

    fireEvent.click(screen.getByRole("button", { name: "Handoff options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start thread on" }));
    expect(screen.getByRole("menu", { name: "Start thread on" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Studio Mac" }));
    expect(view.run).toHaveBeenCalledWith(handoff, { startOnInstanceId: "peer-1" });

    fireEvent.click(screen.getByRole("button", { name: "Handoff options" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Handled elsewhere" }));
    });
    expect(view.resolve).toHaveBeenCalledWith(handoff, "done", "handled_elsewhere", undefined);
  });

  it("shows a handoff's model and permissions", () => {
    const handoff = todo({
      id: "h4",
      kind: "handoff",
      action: {
        type: "start_thread",
        prompt: "Build it",
        model: "gpt-6.1-sol",
        reasoningEffort: "xhigh",
        executionMode: "auto",
      },
    });
    render(
      <ThreadTodoStack threadKey="codex:thread-a" todos={[handoff]} view={createView([handoff])} onStartReview={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Model for the new thread: OpenAI, gpt-6.1-sol, xhigh" })).toBeTruthy();
    expect(screen.getByText("Access").nextElementSibling?.textContent).toBe("Auto");
  });

  it("says so when Do it here cannot reach the composer", async () => {
    const handoff = todo({
      id: "h5",
      kind: "handoff",
      action: { type: "start_thread", prompt: "Build it" },
    });
    const onDoHere = vi.fn(async () => false);
    render(
      <ThreadTodoStack
        threadKey="codex:thread-a"
        todos={[handoff]}
        view={createView([handoff])}
        onStartReview={vi.fn()}
        onDoHere={onDoHere}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Handoff options" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Do it here" }));
    });
    expect(onDoHere).toHaveBeenCalledWith(handoff, undefined);
    expect(screen.getByRole("status").textContent).toContain("The composer is busy.");
  });

  it("copies the handoff prompt", async () => {
    const handoff = todo({
      id: "h3",
      kind: "handoff",
      action: { type: "start_thread", prompt: "Port the parser" },
    });
    render(
      <ThreadTodoStack threadKey="codex:thread-a" todos={[handoff]} view={createView([handoff])} onStartReview={vi.fn()} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    });
    expect(copyTextWithHtml).toHaveBeenCalledWith("Port the parser", "<p>Port the parser</p>");
    expect(screen.getByRole("button", { name: "Prompt copied" })).toBeTruthy();
  });

  it("hands Start review to the composer instead of running it", () => {
    const review = todo({ id: "r", kind: "review", action: { type: "start_review" } });
    const view = createView([review]);
    const onStartReview = vi.fn();
    render(
      <ThreadTodoStack threadKey="codex:thread-a" todos={[review]} view={view} onStartReview={onStartReview} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onStartReview).toHaveBeenCalledWith(review, undefined);
    expect(view.run).not.toHaveBeenCalled();
  });

  it("offers Undo after Done", async () => {
    const reminder = todo({ id: "u" });
    const view = createView([reminder]);
    const { rerender } = render(
      <ThreadTodoStack threadKey="codex:thread-a" todos={[reminder]} view={view} onStartReview={vi.fn()} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    rerender(
      <ThreadTodoStack threadKey="codex:thread-a" todos={[]} view={view} onStartReview={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toContain("Marked done");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(view.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "u", status: "done" }),
      "open",
    );
  });

  it("shows a failed action's error on the card", () => {
    const handoff = todo({
      id: "h",
      kind: "handoff",
      error: "backend unavailable",
      action: { type: "start_thread", prompt: "Carry on" },
    });
    render(
      <ThreadTodoStack threadKey="codex:thread-a" todos={[handoff]} view={createView([handoff])} onStartReview={vi.fn()} />,
    );
    expect(screen.getByRole("alert").textContent).toBe("backend unavailable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("thread to-do checklists", () => {
  const steps = (checked: boolean[]): NonNullable<ThreadTodo["items"]> =>
    ["Run the tests", "Update the docs", "Attach screenshots", "Tag the release"]
      .slice(0, checked.length)
      .map((text, index) => ({ id: `s${index + 1}`, text, checked: checked[index] ?? false }));
  const prerequisite = (text: string): NonNullable<ThreadTodo["items"]>[number] =>
    ({ id: `p-${text}`, text, checked: false, prerequisite: true });

  it("lists the steps as labelled checkboxes with the card's progress", () => {
    const card = todo({ id: "k1", title: "Ship it", items: steps([true, false, false]) });
    const view = createView([card]);
    render(
      <ThreadTodoStack threadKey="codex:checklist-1" todos={[card]} view={view} onStartReview={vi.fn()} />,
    );

    expect(screen.getByText("1 of 3")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Steps, 1 of 3 checked" });
    const boxes = within(list).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false]);
    const docs = within(list).getByRole("checkbox", { name: "Update the docs" });

    fireEvent.click(docs);
    expect(view.setItemChecked).toHaveBeenCalledWith(card, "s2", true);
    // Not optimistic: the box follows the stored card.
    expect((docs as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(list).getByRole("checkbox", { name: "Run the tests" }));
    expect(view.setItemChecked).toHaveBeenLastCalledWith(card, "s1", false);
  });

  it("asks before marking a card with open steps done, and sends the override only then", async () => {
    const card = todo({ id: "k2", title: "Ship it", items: steps([true, false, false]) });
    const view = createView([card]);
    render(
      <ThreadTodoStack threadKey="codex:checklist-2" todos={[card]} view={view} onStartReview={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(view.resolve).not.toHaveBeenCalled();
    expect(screen.getByText("2 steps still open. Mark it done anyway?")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    expect(cancel.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(cancel);
    expect(screen.queryByText(/still open/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done anyway" }));
    });
    expect(view.resolve).toHaveBeenCalledWith(card, "done", undefined, { allowOpenItems: true });
  });

  it("marks a card whose steps are all checked done without asking", async () => {
    const card = todo({ id: "k3", items: steps([true, true]) });
    const view = createView([card]);
    render(
      <ThreadTodoStack threadKey="codex:checklist-3" todos={[card]} view={view} onStartReview={vi.fn()} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    expect(view.resolve).toHaveBeenCalledWith(card, "done", undefined, undefined);
  });

  it("reports a failed resolved-queue read", async () => {
    const view = createView([], { listResolved: vi.fn(async () => { throw new Error("Owner disconnected"); }) });
    render(<ThreadTodosPanel view={view} threadKey="remote:owner:codex:thread-a" onStartReview={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resolved" })); });
    expect(screen.getByRole("alert").textContent).toContain("Owner disconnected");
  });

  // One pinned owner's failure must not hide the cards every other owner sent.
  it("shows a pinned owner's failure beside the resolved cards that did load", async () => {
    const done = todo({ id: "d0", status: "done", title: "Shipped locally", resolvedAt: 1 });
    const view = createView([], { listResolved: vi.fn(async () => ({ todos: [done], errors: ["peer: Owner store failed"] })) });
    render(<ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resolved" })); });
    expect(screen.getByText("Shipped locally")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("peer: Owner store failed");
  });

  it("keeps a busy owner's resolved queue quiet", async () => {
    const busy = Object.assign(new Error("handler_failed: [navigation_busy] Busy"), { code: "navigation_busy" });
    const view = createView([], { listResolved: vi.fn(async () => { throw busy; }) });
    render(<ThreadTodosPanel view={view} threadKey="remote:owner:codex:thread-a" onStartReview={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resolved" })); });
    expect(view.listResolved).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("a resolved-queue read while an owner is busy", () => {
    const peer = { scope: "remote" as const, instanceId: "peer" };
    const done = todo({ id: "d1", status: "done", title: "Shipped the fix", resolvedAt: 2 });
    const later = todo({ id: "d2", status: "done", title: "Merged the docs", resolvedAt: 3 });
    const pinned = todo({ id: "remote-todo:peer:d3", threadId: "pinned", status: "done", title: "Pinned owner card",
      federationTarget: peer, resolvedAt: 1 });
    const busyPinned = { todos: [later], busyThreads: [{ federationTarget: peer, backend: "codex" as const, threadId: "pinned" }] };
    // The rejection the preload hands the renderer for a busy owner.
    const busy = () => {
      try {
        return unwrapNavigationRead({ navigationReadFailure: true, code: "navigation_busy",
          message: "handler_failed: [navigation_busy] Navigation read deadline expired." });
      } catch (error) {
        return error;
      }
    };
    const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    function setup(...responses: unknown[]) {
      vi.useFakeTimers();
      const listResolved = vi.fn();
      for (const response of responses) {
        if (response instanceof Error) listResolved.mockRejectedValueOnce(response);
        else listResolved.mockResolvedValueOnce(response);
      }
      const view = createView([], { listResolved });
      const panel = render(<ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />);
      fireEvent.click(screen.getByRole("tab", { name: /All/ }));
      fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
      // A change event bumps the revision, which lists the queue again.
      const change = () => panel.rerender(
        <ThreadTodosPanel view={{ ...view, revision: 1 }} threadKey="codex:thread-a" onStartReview={vi.fn()} />,
      );
      return { listResolved, change };
    }

    afterEach(() => {
      // The scope is remembered across panels; leave the default for later tests.
      fireEvent.click(screen.getByRole("tab", { name: /Thread/ }));
    });

    it("keeps the last cards without an error and re-lists once", async () => {
      const { listResolved, change } = setup({ todos: [done] }, busy(), { todos: [later, done] });
      await flush();
      change();
      await flush();
      expect(listResolved).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Shipped the fix")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      await flush(THREAD_TODO_BUSY_RETRY_MS);
      expect(listResolved).toHaveBeenCalledTimes(3);
      expect(screen.getByText("Merged the docs")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("re-lists only once when the owner is still busy", async () => {
      const { listResolved, change } = setup({ todos: [done] }, busy(), busy(), { todos: [] });
      await flush();
      change();
      await flush(THREAD_TODO_BUSY_RETRY_MS);
      expect(listResolved).toHaveBeenCalledTimes(3);
      await flush(THREAD_TODO_BUSY_RETRY_MS * 10);
      expect(listResolved).toHaveBeenCalledTimes(3);
      expect(screen.getByText("Shipped the fix")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("keeps a busy pinned thread's last cards beside fresh ones and re-lists once", async () => {
      const { listResolved, change } = setup({ todos: [done, pinned] }, busyPinned, busyPinned, { todos: [later] });
      await flush();
      change();
      await flush();
      // `done` was reopened elsewhere and leaves; the busy owner's card stays.
      expect(screen.getByText("Merged the docs")).toBeTruthy();
      expect(screen.getByText("Pinned owner card")).toBeTruthy();
      expect(screen.queryByText("Shipped the fix")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      await flush(THREAD_TODO_BUSY_RETRY_MS * 10);
      expect(listResolved).toHaveBeenCalledTimes(3);
      expect(screen.getByText("Pinned owner card")).toBeTruthy();
    });
  });

  it("shows a rejected owner action without hiding the card", async () => {
    const card = todo({ id: "remote-todo:owner:card", title: "Ship it", federationTarget: { scope: "remote", instanceId: "owner" } });
    const view = createView([card], { resolve: vi.fn(async () => { throw new Error("Owner disconnected"); }) });
    render(<ThreadTodoStack threadKey={threadTodoThreadKey(card)} todos={[card]} view={view} onStartReview={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss to-do: Ship it" })); });
    expect(screen.getByRole("status").textContent).toContain("Owner disconnected");
    expect(screen.getByRole("heading", { name: "Ship it" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("dismisses a card with open steps without asking", async () => {
    const card = todo({ id: "k4", title: "Ship it", items: steps([false]) });
    const view = createView([card]);
    render(
      <ThreadTodoStack threadKey="codex:checklist-4" todos={[card]} view={view} onStartReview={vi.fn()} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss to-do: Ship it" }));
    });
    expect(view.resolve).toHaveBeenCalledWith(card, "dismissed", undefined, undefined);
  });

  it("asks before an action that would complete the card", async () => {
    const review = todo({
      id: "k5",
      kind: "review",
      action: { type: "start_review" },
      items: steps([false]),
    });
    const onStartReview = vi.fn();
    const view = createView([review]);
    render(
      <ThreadTodoStack threadKey="codex:checklist-5" todos={[review]} view={view} onStartReview={onStartReview} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onStartReview).not.toHaveBeenCalled();
    expect(screen.getByText("1 step still open. Start the review anyway?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onStartReview).toHaveBeenCalledWith(review, { allowOpenItems: true });
    cleanup();

    const handoff = todo({
      id: "k6",
      kind: "handoff",
      action: { type: "start_thread", prompt: "Carry on" },
      items: [prerequisite("Clone the repository"), ...steps([false, false])],
    });
    const handoffView = createView([handoff]);
    render(
      <ThreadTodoStack threadKey="codex:checklist-6" todos={[handoff]} view={handoffView} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(handoffView.run).not.toHaveBeenCalled();
    expect(screen.getByText("1 prerequisite still open. Start the thread anyway?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    expect(handoffView.run).toHaveBeenCalledWith(handoff, { allowOpenItems: true, modelSettings: { backend: "codex" } });
  });

  it("starts a thread at once when only the new thread's steps are open", async () => {
    // The steps are the plan the new thread carries out, not chores for the
    // operator. A local card sends no override, so the owner still refuses
    // a prerequisite added since this card rendered.
    const handoff = todo({
      id: "k20",
      kind: "handoff",
      action: { type: "start_thread", prompt: "Carry on" },
      items: [{ ...prerequisite("Clone the repository"), checked: true }, ...steps([false, false])],
    });
    const view = createView([handoff]);
    render(
      <ThreadTodoStack threadKey="codex:checklist-20" todos={[handoff]} view={view} onStartReview={vi.fn()} />,
    );
    expect(screen.getByRole("list", { name: "Before you start, 1 of 1 checked" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Steps for the new thread, 0 of 2 checked" })).toBeTruthy();
    expect(screen.getByText("0 of 2")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    expect(screen.queryByText(/still open/)).toBeNull();
    expect(view.run).toHaveBeenCalledWith(handoff, { modelSettings: { backend: "codex" } });
    cleanup();

    // A peer's card may live on an older owner, which blocks on every open
    // step, so the override goes along.
    const remote: ThreadTodo = {
      ...handoff,
      id: "k21",
      federationTarget: { instanceId: "peer-1", scope: "remote" },
    };
    const remoteView = createView([remote]);
    render(
      <ThreadTodoStack threadKey="codex:checklist-21" todos={[remote]} view={remoteView} onStartReview={vi.fn()} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    expect(remoteView.run).toHaveBeenCalledWith(remote, { allowOpenItems: true, modelSettings: { backend: "codex" } });
  });

  it("drops the question once the last open step is checked", () => {
    const open = todo({ id: "k10", items: steps([true, false]) });
    const view = createView([open]);
    const { rerender } = render(
      <ThreadTodoStack threadKey="codex:checklist-10" todos={[open]} view={view} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("1 step still open. Mark it done anyway?")).toBeTruthy();

    const ticked = { ...open, items: steps([true, true]) };
    rerender(
      <ThreadTodoStack threadKey="codex:checklist-10" todos={[ticked]} view={view} onStartReview={vi.fn()} />,
    );
    expect(screen.queryByText(/still open/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Done anyway" })).toBeNull();
    // Reopening a step later does not bring the old question back.
    rerender(
      <ThreadTodoStack threadKey="codex:checklist-10" todos={[open]} view={view} onStartReview={vi.fn()} />,
    );
    expect(screen.queryByText(/still open/)).toBeNull();
  });

  it("returns focus to the card's buttons when the question is cancelled", () => {
    // A handoff's buttons are a split button, not the question's plain
    // buttons, so Cancel's node goes away with the question.
    const card = todo({
      id: "k11",
      kind: "handoff",
      action: { type: "start_thread", prompt: "Carry on" },
      items: [prerequisite("Clone the repository")],
    });
    render(
      <ThreadTodoStack threadKey="codex:checklist-11" todos={[card]} view={createView([card])} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start thread" }));
  });

  it("names the open steps in the merge confirmation, which is the override", async () => {
    const merge = todo({
      id: "k7",
      kind: "merge",
      action: { type: "merge_pull_request", pullRequest: "42" },
      items: steps([true, false]),
    });
    const view = createView([merge]);
    render(
      <ThreadTodoStack threadKey="codex:checklist-7" todos={[merge]} view={view} onStartReview={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Squash merge" }));
    expect(screen.getByText(/^1 step still open\. Squash merge #42\?/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Squash merge" }));
    });
    expect(view.run).toHaveBeenCalledWith(merge, { mergeMethod: "squash", allowOpenItems: true });
  });

  it("keeps a lone collapsed card's progress on its chip", () => {
    const card = todo({ id: "k8", items: steps([true, true, false, false]) });
    render(
      <ThreadTodoStack threadKey="codex:checklist-8" todos={[card]} view={createView([card])} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse to-dos" }));
    const chip = screen.getByRole("button", { name: "Show to-dos: 1 open, 2 of 4 steps checked" });
    expect(chip.textContent).toContain("2 of 4");
  });

  it("shows progress on another thread's collapsed row", () => {
    const elsewhere = todo({
      id: "k9",
      threadId: "thread-b",
      title: "Ship it",
      items: steps([true, false, false, false]),
    });
    render(
      <ThreadTodosPanel
        view={createView([elsewhere])}
        threadKey="codex:thread-a"
        projectKey={AGENT.key}
        onStartReview={vi.fn()}
      />,
    );
    // The panel remembers its lens across mounts: put back the one it had.
    const before = screen.getAllByRole("tab")
      .find((tab) => tab.getAttribute("aria-selected") === "true");
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    const row = screen.getByRole("button", { name: "Open thread: Ship it, in Beta, 1 of 4 steps checked" });
    expect(row.textContent).toContain("1 of 4");
    if (before) fireEvent.click(before);
  });
});

describe("ThreadTodosPanel", () => {
  it("keeps missing instance coverage in a quiet, deduplicated footnote and clears it after recovery", async () => {
    const disconnected = { instanceId: "studio", label: "Studio Mac", reason: "disconnected" as const };
    const unsupported = { instanceId: "mini", label: "Build Mini", reason: "unsupported" as const };
    const view = createView([todo({ id: "available", title: "Available work" })], {
      unavailableInstances: [disconnected, unsupported, disconnected, unsupported],
    });
    const { rerender } = render(<ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { name: "Available work" })).toBeTruthy();
    const note = screen.getByRole("button", { name: /Show affected instances/ });
    expect(note.textContent).toBe("Some instances are disconnected or do not support to-dos.");
    await act(async () => { fireEvent.click(note); });
    expect(screen.getByRole("tooltip").textContent).toBe("Build Mini — To-dos unavailable; update PwrAgent on this instance\nStudio Mac — Disconnected");
    expect(note.closest("footer")).toBeTruthy();
    await act(async () => {
      rerender(<ThreadTodosPanel view={{ ...view, unavailableInstances: [] }} threadKey="codex:thread-a" onStartReview={vi.fn()} />);
    });
    expect(screen.queryByRole("button", { name: /Show affected instances/ })).toBeNull();
  });

  it.each(["disconnected", "unsupported"] as const)("explains %s coverage without an error alert", (reason) => {
    const view = createView([], { unavailableInstances: [{ instanceId: "mini", label: "Build Mini", reason }] });
    render(<ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /Show affected instances/ }).textContent).toBe(reason === "disconnected"
      ? "Some instances are disconnected." : "Some instances do not support to-dos.");
    expect(screen.getByText("No to-dos for this thread.")).toBeTruthy();
  });

  it("puts this thread first and opens another thread from its row", () => {
    const other = todo({ id: "o", threadId: "thread-b", title: "Elsewhere" });
    const mine = todo({ id: "a", title: "Mine" });
    const view = createView([other, mine]);
    render(
      <ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />,
    );

    // Without a project, the panel has no Project lens.
    expect(screen.queryByRole("tab", { name: /Project/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /Thread/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Elsewhere")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    // All groups by project; neither card has one.
    const groups = screen.getAllByRole("heading", { level: 4 });
    expect(groups.map((group) => group.textContent)).toEqual(["No project2"]);
    // This thread's cards are whole; another thread's are rows.
    expect(screen.getByRole("heading", { level: 3, name: "Mine" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open thread: Elsewhere, in Beta" }));
    expect(view.openThread).toHaveBeenCalledWith(other);
  });

  it("reopens a card the operator marked handled elsewhere", async () => {
    const handled = todo({
      id: "r1",
      status: "done",
      title: "Handed off by hand",
      result: "Handled elsewhere",
      resolvedAt: Date.now(),
    });
    const merged = todo({
      id: "r2",
      status: "done",
      title: "Merged it",
      result: "Squash-merged #42",
      resolvedAt: Date.now(),
    });
    const view = createView([], { listResolved: async () => ({ todos: [handled, merged] }) });
    render(<ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
    });
    expect(screen.getAllByRole("button", { name: "Reopen" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(view.resolve).toHaveBeenCalledWith(handled, "open");
  });

  it("shows a cross-project card in both projects and names both ends in All", () => {
    const mine = todo({ id: "p1", title: "Mine", sourceProject: AGENT });
    const incoming = todo({
      id: "p2",
      threadId: "thread-b",
      title: "Adopt the agent API",
      sourceProject: GIT,
      targetProject: AGENT,
    });
    const outgoing = todo({
      id: "p3",
      threadId: "thread-b",
      title: "Build it in PwrSnap",
      sourceProject: GIT,
      targetProject: SNAP,
    });
    const view = createView([mine, incoming, outgoing]);
    render(
      <ThreadTodosPanel
        view={view}
        threadKey="codex:thread-a"
        projectKey={AGENT.key}
        onStartReview={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Project/ }));
    expect(screen.getByRole("tab", { name: /Project/ }).textContent).toBe("Project2");
    expect(screen.getByText("Adopt the agent API")).toBeTruthy();
    expect(screen.getByText("From PwrGit")).toBeTruthy();
    expect(screen.queryByText("Build it in PwrSnap")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    const groups = screen.getAllByRole("heading", { level: 4 });
    expect(groups.map((group) => group.textContent)).toEqual(["PwrAgent1", "PwrGit2"]);
    expect(screen.getByText("Beta · PwrGit → PwrAgent")).toBeTruthy();
    expect(screen.getByText("Beta · PwrGit → PwrSnap")).toBeTruthy();
  });
});

function sampleWaits(): OperatorWait[] {
  return buildOperatorWaits({
    serverRequests: [{
      backend: "codex",
      createdAt: Date.now(),
      notification: {
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-a", turnId: "turn-1", requestId: "req-1", command: "pnpm test" },
      } as unknown as AppServerPendingRequestNotification,
    }],
    questions: [{
      backend: "codex",
      threadId: "thread-b",
      messageId: "msg-1",
      questions: [{ title: "Which environment?", options: ["Staging", "Production"] }],
      createdAt: Date.now(),
    }],
    seenKeys: [],
  });
}

function waitsView(waits: OperatorWait[], overrides: Partial<ThreadTodosView> = {}): ThreadTodosView {
  const waitsByThreadKey = new Map<string, OperatorWait[]>();
  for (const wait of waits) {
    waitsByThreadKey.set(wait.threadKey, [...(waitsByThreadKey.get(wait.threadKey) ?? []), wait]);
  }
  return createView([], { waits, waitsByThreadKey, ...overrides });
}

describe("ThreadTodosPanel waits", () => {
  it("answers an approval in its row and opens a question's thread", async () => {
    const waits = sampleWaits();
    const view = waitsView(waits, { seenKeys: new Set(waits.map((wait) => wait.key)) });
    render(<ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />);
    // The panel remembers its lens across mounts.
    fireEvent.click(screen.getByRole("tab", { name: /^Thread/ }));

    expect(screen.getByText("Run pnpm test")).toBeTruthy();
    expect(screen.getByText("Approval")).toBeTruthy();
    expect(screen.queryByText("Which environment?")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Decline/ }));
    });
    expect(view.respond).toHaveBeenCalledWith(waits[0], { decision: "decline" });

    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    expect(screen.getByText("Which environment?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(view.openWait).toHaveBeenCalledWith(waits[1]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    expect(view.dismissQuestion).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      threadId: "thread-b",
      messageId: "msg-1",
    }));
  });

  it("answers another thread's question in its row through that thread's owner", async () => {
    const waits = sampleWaits();
    const answerQuestion = vi.fn(async (_wait: OperatorWait, _text: string) => true);
    const view = waitsView(waits, { answerQuestion });
    render(<ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const form = screen.getByRole("group", { name: "Answer: Which environment?" });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Answer" }));
    });
    expect(answerQuestion).toHaveBeenCalledTimes(1);
    expect(answerQuestion.mock.calls[0]![0]).toBe(waits[1]);
    expect(parseCodexAsyncQuestionReply(answerQuestion.mock.calls[0]![1])).toEqual([{
      questionItemId: codexAsyncQuestionItemId("msg-1", 0),
      question: "Which environment?",
      answer: "Staging",
    }]);
    expect(view.openWait).not.toHaveBeenCalled();
  });

  it("shows another thread's answer as sent until it lands", () => {
    const waits = sampleWaits();
    const view = waitsView(waits, {
      answerQuestion: vi.fn(async () => true),
      sentQuestionAnswers: new Map([
        [`codex:thread-b\0${codexAsyncQuestionItemId("msg-1", 0)}`, "Staging"],
      ]),
    });
    render(<ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    expect(screen.getByRole("status").textContent).toContain("Answer sent");
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  });

  it("counts unread items per lens and marks what is on screen seen while focused", () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      const waits = sampleWaits();
      const card = todo({ id: "c1", title: "Mine" });
      const view = waitsView(waits, {
        open: [card],
        openByThreadKey: new Map([["codex:thread-a", [card]]]),
        seenKeys: new Set(),
      });
      render(<ThreadTodosPanel view={view} threadKey="codex:thread-a" onStartReview={vi.fn()} />);
      fireEvent.click(screen.getByRole("tab", { name: /^Thread/ }));

      expect(screen.getByRole("tab", { name: /^Thread/ }).getAttribute("aria-label"))
        .toMatch(/2 open, 2 unread/);
      expect(screen.getByRole("tab", { name: /^All/ }).getAttribute("aria-label"))
        .toMatch(/3 open, 3 unread/);
      expect(view.markSeen).not.toHaveBeenCalled();

      focus.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(view.markSeen).toHaveBeenCalledWith(
        expect.arrayContaining([waits[0]!.key, operatorTodoItemKey("c1")]),
      );
      expect(vi.mocked(view.markSeen).mock.calls[0]![0]).not.toContain(waits[1]!.key);
    } finally {
      focus.mockRestore();
    }
  });
});

describe("thread row to-do chip", () => {
  const thread = {
    id: "thread-a",
    source: "codex",
    title: "Alpha",
    titleSource: "explicit",
  } as NavigationThreadSummary;

  it("counts open cards and shows nothing at zero", () => {
    const counts = new Map([["codex:thread-a", [todo({ id: "1" }), todo({ id: "2" })]]]);
    const { rerender } = render(
      <ThreadTodoCountsContext.Provider value={counts}>
        <ThreadMetaChips thread={thread} />
      </ThreadTodoCountsContext.Provider>,
    );
    expect(screen.getByRole("img", { name: "2 open to-dos" })).toBeTruthy();

    rerender(
      <ThreadTodoCountsContext.Provider value={new Map()}>
        <ThreadMetaChips thread={thread} />
      </ThreadTodoCountsContext.Provider>,
    );
    expect(screen.queryByRole("img", { name: /open to-do/ })).toBeNull();
  });

  it("names what a thread waits on, and counts its waits with its cards", () => {
    const waits = sampleWaits().filter((wait) => wait.threadId === "thread-a");
    const counts = new Map([["codex:thread-a", [todo({ id: "1" })]]]);
    render(
      <ThreadTodoCountsContext.Provider value={counts}>
        <OperatorWaitsContext.Provider
          value={{
            waitsByThreadKey: new Map([["codex:thread-a", waits]]),
            seenKeys: new Set([operatorTodoItemKey("1")]),
          }}
        >
          <ThreadMetaChips thread={thread} hasApprovalRequest />
        </OperatorWaitsContext.Provider>
      </ThreadTodoCountsContext.Provider>,
    );
    expect(screen.getByRole("img", { name: "Approval: Run pnpm test" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 open items, 1 unread" })).toBeTruthy();
    // The wait chip replaces the session's own approval flag.
    expect(screen.queryByText("Waiting for approval")).toBeNull();
  });

  it("names a question a thread asked", () => {
    const waits = sampleWaits().filter((wait) => wait.threadId === "thread-b");
    render(
      <OperatorWaitsContext.Provider
        value={{ waitsByThreadKey: new Map([["codex:thread-b", waits]]), seenKeys: new Set() }}
      >
        <ThreadMetaChips thread={{ ...thread, id: "thread-b" }} />
      </OperatorWaitsContext.Provider>,
    );
    const chip = screen.getByRole("img", { name: "Question: Which environment?" });
    expect(chip.className).toContain("thread-row__chip--question");
  });

  it("opens the thread's newest question from its chip instead of selecting the row", () => {
    const older = sampleWaits().find((wait) => wait.kind === "question")!;
    const [newer] = buildOperatorWaits({
      serverRequests: [],
      questions: [{
        backend: "codex",
        threadId: "thread-b",
        messageId: "msg-2",
        questions: [{ title: "Which region?", options: [] }],
        createdAt: older.createdAt + 60_000,
      }],
      seenKeys: [],
    });
    const openWait = vi.fn();
    const selectRow = vi.fn();
    render(
      <OperatorWaitsContext.Provider
        value={{
          waitsByThreadKey: new Map([["codex:thread-b", [older, newer!]]]),
          seenKeys: new Set(),
          openWait,
        }}
      >
        <div onClick={selectRow} onKeyDown={selectRow}>
          <ThreadMetaChips thread={{ ...thread, id: "thread-b" }} />
        </div>
      </OperatorWaitsContext.Provider>,
    );

    const chip = screen.getByRole("button", { name: "Question: Which region?" });
    // Keyboard focus shows what a hover shows, hint included.
    fireEvent.focus(chip);
    expect(screen.getByText(/Click to show the latest question/)).toBeTruthy();
    fireEvent.blur(chip);
    expect(screen.queryByText(/Click to show the latest question/)).toBeNull();

    fireEvent.click(chip);
    expect(openWait).toHaveBeenCalledTimes(1);
    expect(openWait.mock.calls[0]![0]).toMatchObject({ kind: "question", question: { messageId: "msg-2" } });

    fireEvent.keyDown(chip, { key: "Enter" });
    expect(openWait).toHaveBeenCalledTimes(2);
    // The chip owns the click: the row would open the thread at its bottom.
    expect(selectRow).not.toHaveBeenCalled();
  });

  it("keeps the session's flags while the wait list names nothing for the thread", () => {
    render(
      <OperatorWaitsContext.Provider value={{ waitsByThreadKey: new Map(), seenKeys: new Set() }}>
        <ThreadMetaChips thread={thread} hasApprovalRequest />
      </OperatorWaitsContext.Provider>,
    );
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
  });

  it("falls back to the session's flags without a wait list", () => {
    render(<ThreadMetaChips thread={thread} hasApprovalRequest />);
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
  });
});

describe("federated To-do project scope", () => {
  const peer = { scope: "remote" as const, instanceId: "peer" };
  const other = { scope: "remote" as const, instanceId: "other" };

  it.each([undefined, peer])("counts only the selected project's owner for source and target cards (%j)", (projectOwner) => {
    const cards = [
      todo({ id: "local-source", title: "Local source", sourceProject: AGENT }),
      todo({ id: "local-target", title: "Local target", sourceProject: SNAP, targetProject: AGENT }),
      todo({ id: "peer-source", title: "Peer source", sourceProject: AGENT, federationTarget: peer }),
      todo({ id: "peer-target", title: "Peer target", sourceProject: SNAP, targetProject: AGENT, federationTarget: peer }),
      todo({ id: "other-source", title: "Other source", sourceProject: AGENT, federationTarget: other }),
    ];
    const wait: OperatorWait = { key: "local-wait", kind: "question", backend: "codex", threadId: "wait-thread",
      threadKey: "codex:wait-thread", title: "Local question", createdAt: 1 };
    const peerWait = { ...wait, key: "peer-wait", threadKey: "remote:peer:codex:wait-thread", title: "Peer question", federationTarget: peer };
    const view = createView(cards, { waits: [wait, peerWait], threadProjectForKey: () => AGENT });
    render(<ThreadTodosPanel view={view} threadKey={projectOwner ? "remote:peer:codex:thread-a" : "codex:thread-a"}
      projectKey={AGENT.key} projectOwner={projectOwner} onStartReview={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Project,/ }));
    expect(screen.getByRole("tab", { name: /^Project, 3 open/ })).toBeTruthy();
    expect(screen.queryByText("Other source")).toBeNull();
    for (const title of projectOwner ? ["Peer source", "Peer target", "Peer question"] : ["Local source", "Local target", "Local question"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    for (const title of projectOwner ? ["Local source", "Local target", "Local question"] : ["Peer source", "Peer target", "Peer question"]) {
      expect(screen.queryByText(title)).toBeNull();
    }
    expect(cards.every((card) => card.sourceProject?.key === AGENT.key || card.targetProject?.key === AGENT.key)).toBe(true);
  });

  it("keeps identical project paths in separate All groups and puts the selected owner first", () => {
    const cards = [
      todo({ id: "local", title: "Local card", sourceProject: AGENT }),
      todo({ id: "peer", title: "Peer card", sourceProject: AGENT, federationTarget: peer }),
      todo({ id: "other", title: "Other card", sourceProject: AGENT, federationTarget: other }),
    ];
    render(<ThreadTodosPanel view={createView(cards)} threadKey="remote:peer:codex:thread-a"
      projectKey={AGENT.key} projectOwner={peer} onStartReview={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /^All,/ }));
    const groups = screen.getAllByRole("region", { name: "PwrAgent" });
    expect(groups).toHaveLength(3);
    expect(within(groups[0]!).getByText("Peer card")).toBeTruthy();
    expect(groups.map((group) => group.querySelector(".thread-todos-panel__group-count")?.textContent)).toEqual(["1", "1", "1"]);
  });
});
