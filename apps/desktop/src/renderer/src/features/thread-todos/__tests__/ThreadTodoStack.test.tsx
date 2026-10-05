import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, ThreadTodo, ThreadTodoProject } from "@pwragent/shared";
import { copyText } from "../../../lib/copy-text";
import { ThreadMetaChips } from "../../navigation/ThreadMetaChips";
import { ThreadTodoStack } from "../ThreadTodoStack";
import { ThreadTodosPanel } from "../ThreadTodosPanel";
import { ThreadTodoCountsContext } from "../useThreadTodos";
import type { ThreadTodosView } from "../thread-todos-view";

vi.mock("../../../lib/copy-text", () => ({
  copyText: vi.fn(async () => undefined),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(copyText).mockClear();
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
    const key = `${entry.backend}:${entry.threadId}`;
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
    openThread: vi.fn(),
    openStartedThread: vi.fn(),
    ...overrides,
  };
}

describe("ThreadTodoStack", () => {
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

  it("offers a handoff here, on a peer, or as handled elsewhere", async () => {
    const handoff = todo({
      id: "h2",
      kind: "handoff",
      action: { type: "start_thread", prompt: "Build it" },
    });
    const view = createView([handoff], {
      instances: [{ instanceId: "peer-1", label: "Studio Mac" }],
    });
    const onDoHere = vi.fn();
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
    expect(onDoHere).toHaveBeenCalledWith(handoff);

    fireEvent.click(screen.getByRole("button", { name: "Handoff options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start thread on" }));
    expect(screen.getByRole("menu", { name: "Start thread on" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Studio Mac" }));
    expect(view.run).toHaveBeenCalledWith(handoff, { startOnInstanceId: "peer-1" });

    fireEvent.click(screen.getByRole("button", { name: "Handoff options" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Handled elsewhere" }));
    });
    expect(view.resolve).toHaveBeenCalledWith(handoff, "done", "handled_elsewhere");
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
    expect(copyText).toHaveBeenCalledWith("Port the parser");
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
    expect(onStartReview).toHaveBeenCalledWith(review);
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

describe("ThreadTodosPanel", () => {
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
});
