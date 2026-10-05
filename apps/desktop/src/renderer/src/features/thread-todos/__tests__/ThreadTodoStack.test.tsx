import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, ThreadTodo } from "@pwragent/shared";
import { ThreadMetaChips } from "../../navigation/ThreadMetaChips";
import { ThreadTodoStack } from "../ThreadTodoStack";
import { ThreadTodosPanel } from "../ThreadTodosPanel";
import { ThreadTodoCountsContext } from "../useThreadTodos";
import type { ThreadTodosView } from "../thread-todos-view";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
      action: { type: "merge_pull_request", pullRequest: "42", method: "squash" },
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
    expect(view.run).toHaveBeenCalledWith(merge);
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

    const groups = screen.getAllByRole("heading", { level: 4 });
    expect(groups.map((group) => group.textContent)).toEqual(["Alpha1", "Beta1"]);
    // This thread's cards are whole; another thread's are rows.
    expect(screen.getByRole("heading", { level: 3, name: "Mine" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open thread: Elsewhere, in Beta" }));
    expect(view.openThread).toHaveBeenCalledWith(other);
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
