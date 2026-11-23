import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { threadTodoThreadKey } from "@pwragent/shared/contracts/thread-todos";
import { operatorTodoItemKey } from "@pwragent/shared/contracts/operator-requests";
import { ThreadTodoStack } from "../ThreadTodoStack";
import { THREAD_TODO_LAUNCH_DISMISS_MS } from "../ThreadTodoLaunchTray";
import { resetThreadTodoLaunchesForTests } from "../thread-todo-launches";
import type { ThreadTodoRunHooks, ThreadTodoRunOptions, ThreadTodosView } from "../thread-todos-view";

afterEach(() => {
  cleanup();
  resetThreadTodoLaunchesForTests();
  vi.useRealTimers();
});

const THREAD_KEY = "codex:thread-a";

function card(id: string, overrides: Partial<ThreadTodo> = {}): ThreadTodo {
  return {
    id,
    backend: "codex",
    threadId: "thread-a",
    kind: "handoff",
    status: "open",
    title: `Card ${id}`,
    action: { type: "start_thread", prompt: `Do ${id}` },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createView(open: ThreadTodo[], overrides: Partial<ThreadTodosView> = {}): ThreadTodosView {
  return {
    open,
    openByThreadKey: new Map([[THREAD_KEY, open]]),
    revision: 0,
    runningIds: new Set(),
    instances: [],
    threadTitle: () => "Alpha",
    resolve: vi.fn(async (entry, status) => ({ ...entry, status })),
    run: vi.fn(async (entry) => entry),
    setItemChecked: vi.fn(async (entry) => entry),
    openThread: vi.fn(),
    openStartedThread: vi.fn(),
    waits: [],
    waitsByThreadKey: new Map(),
    seenKeys: new Set(open.map((entry) => operatorTodoItemKey(entry.id))),
    markSeen: vi.fn(),
    respond: vi.fn(async () => undefined),
    dismissQuestion: vi.fn(async () => undefined),
    dismissedQuestionKeys: new Set(),
    openWait: vi.fn(),
    threadTitleForKey: () => "Alpha",
    threadProjectForKey: () => undefined,
    ...overrides,
  };
}

/** A run that goes to the owner at once, as App's does without a Full Access prompt. */
function begun(result: (entry: ThreadTodo) => Promise<ThreadTodo | undefined>) {
  return (entry: ThreadTodo, _options?: ThreadTodoRunOptions, hooks?: ThreadTodoRunHooks) => {
    hooks?.onBegin?.();
    return result(entry);
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/** The deck's card title and pager, or undefined without a deck. */
function shownCard(container: HTMLElement): { title: string; position?: string } | undefined {
  const deck = container.querySelector<HTMLElement>(".thread-todo-stack__deck");
  if (!deck) return undefined;
  const title = within(deck).getByRole("heading").textContent ?? "";
  const position = deck.querySelector(".thread-todo-card__position")?.textContent ?? undefined;
  return { title, ...(position ? { position } : {}) };
}

function tray(): HTMLElement {
  return screen.getByRole("region", { name: "Started to-dos" });
}

describe("ThreadTodoStack deck position", () => {
  // The broken rule: the deck remembered its card by id only, so when that
  // card left (started, done, resolved elsewhere) it fell back to card 1,
  // the one the operator had paged past.
  it("shows the card after the one that left, else the nearest before it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }).chain((size) => fc.record({
          size: fc.constant(size),
          shown: fc.integer({ min: 0, max: size - 1 }),
          // Other cards that leave in the same update; the shown one always does.
          alsoLeaving: fc.array(fc.boolean(), { minLength: size, maxLength: size }),
        })),
        ({ size, shown, alsoLeaving }) => {
          const cards = Array.from({ length: size }, (_, index) => card(`c${index}`, { kind: "reminder", action: undefined }));
          const view = createView(cards);
          const { container, rerender, unmount } = render(
            <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
          );
          try {
            for (let step = 0; step < shown; step += 1) {
              fireEvent.click(screen.getByRole("button", { name: "Next to-do" }));
            }
            expect(shownCard(container)?.title).toBe(`Card c${shown}`);

            const survives = (index: number) => index !== shown && !alsoLeaving[index];
            const left = cards.filter((_, index) => survives(index));
            rerender(<ThreadTodoStack threadKey={THREAD_KEY} todos={left} view={view} onStartReview={vi.fn()} />);

            const after = cards.slice(shown + 1).filter((_, offset) => survives(shown + 1 + offset));
            const before = cards.slice(0, shown).filter((_, index) => survives(index));
            const expected = after[0] ?? before.at(-1);
            expect(shownCard(container)?.title).toBe(expected?.title);
          } finally {
            unmount();
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

describe("ThreadTodoStack launches", () => {
  it("returns a hung start to the deck after 60 seconds with its run still pending", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cards = [card("1"), card("2")];
    const runningIds = new Set<string>();
    const run = vi.fn(begun((entry) => {
      runningIds.add(entry.id);
      return new Promise<ThreadTodo>(() => {});
    }));
    const view = createView(cards, { run, runningIds });
    const { container, unmount } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    act(() => { vi.advanceTimersByTime(59_999); });
    expect(within(tray()).queryByRole("button", { name: /^Show card/ })).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    const show = within(tray()).getByRole("button", { name: /^Show card/ });
    act(() => { show.focus(); });
    fireEvent.click(show);

    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
    expect(shownCard(container)).toEqual({ title: "Card 1", position: "1/2" });
    expect(screen.getByRole("status").textContent).toBe("Starting…");
    expect(document.activeElement).toBe(screen.getByRole("article", { name: "Card 1" }));
    expect(run).toHaveBeenCalledTimes(1);

    unmount();
    render(<ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Starting…");
  });

  it.each([false, true])("disables Dismiss on a returned card while the launch is pending (controller running: %s)", (running) => {
    vi.useFakeTimers();
    const todo = card("1");
    const view = createView([todo], {
      run: vi.fn(begun(() => new Promise<ThreadTodo>(() => {}))),
    });
    const { rerender } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={[todo]} view={view} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    if (running) {
      const runningView = { ...view, runningIds: new Set([todo.id]) };
      rerender(<ThreadTodoStack threadKey={THREAD_KEY} todos={[todo]} view={runningView} onStartReview={vi.fn()} />);
    }
    act(() => { vi.advanceTimersByTime(60_000); });
    fireEvent.click(within(tray()).getByRole("button", { name: "Show card: Card 1" }));

    const dismiss = screen.getByRole("button", { name: "Dismiss to-do: Card 1" });
    expect(dismiss).toHaveProperty("disabled", true);
    fireEvent.click(dismiss);
    expect(view.resolve).not.toHaveBeenCalled();
  });

  // Model the owner's result and snapshot arriving independently of where the
  // operator moved focus after showing the pending card.
  it.each([
    { outcome: "started", focus: "card" },
    { outcome: "started", focus: "outside" },
    { outcome: "failed", focus: "card" },
    { outcome: "failed", focus: "outside" },
    { outcome: "snapshot-first", focus: "card" },
    { outcome: "snapshot-first", focus: "outside" },
  ] as const)("preserves focus on $focus when a returned launch is $outcome", async ({ outcome, focus }) => {
    vi.useFakeTimers();
    const cards = [card("1"), card("2")];
    const pending = deferred<ThreadTodo>();
    const view = createView(cards, { run: vi.fn(begun(() => pending.promise)) });
    const stack = (todos: ThreadTodo[], runningIds: ReadonlySet<string>) => (
      <>
        <button type="button">Outside the stack</button>
        <ThreadTodoStack threadKey={THREAD_KEY} todos={todos} view={{ ...view, runningIds }} onStartReview={vi.fn()} />
      </>
    );
    const { rerender } = render(stack(cards, new Set()));
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    rerender(stack(cards, new Set(["1"])));
    act(() => { vi.advanceTimersByTime(60_000); });
    fireEvent.click(within(tray()).getByRole("button", { name: "Show card: Card 1" }));
    const outside = screen.getByRole("button", { name: "Outside the stack" });
    if (focus === "outside") act(() => { outside.focus(); });
    else expect(document.activeElement).toBe(screen.getByRole("article", { name: "Card 1" }));

    if (outcome === "snapshot-first") rerender(stack(cards.slice(1), new Set(["1"])));
    const ended = outcome === "failed"
      ? { ...cards[0]!, error: "The project moved." }
      : { ...cards[0]!, status: "done" as const, startedThread: { backend: "codex" as const, threadId: "child-1" } };
    await act(async () => { pending.resolve(ended); });
    const rowAction = within(tray()).getByRole("button", {
      name: outcome === "failed" ? "Review card: Card 1" : "Open thread: Card 1",
    });
    const expected = focus === "outside" ? outside
      : outcome === "snapshot-first" ? screen.getByRole("button", { name: "Start thread" })
      : rowAction;
    expect(document.activeElement).toBe(expected);
  });

  it("starts a late success's countdown after the hovered tray was removed", async () => {
    vi.useFakeTimers();
    const cards = [card("1"), card("2")];
    const pending = deferred<ThreadTodo>();
    const view = createView(cards, { run: vi.fn(begun(() => pending.promise)) });
    render(<>
      <button type="button">Outside the stack</button>
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />
    </>);
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    act(() => { vi.advanceTimersByTime(60_000); });
    fireEvent.pointerEnter(tray());
    fireEvent.click(within(tray()).getByRole("button", { name: "Show card: Card 1" }));
    // Removing the hovered section does not dispatch pointerleave.
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
    act(() => { screen.getByRole("button", { name: "Outside the stack" }).focus(); });
    await act(async () => {
      pending.resolve({ ...cards[0]!, status: "done", startedThread: { backend: "codex", threadId: "child-1" } });
    });
    act(() => { vi.advanceTimersByTime(THREAD_TODO_LAUNCH_DISMISS_MS); });
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
  });

  // Returning a pending card preserves the owner's outcome across view lifetimes.
  it.each([
    { status: "done", label: "Started" },
    { status: "done", setupFailure: "Setup script exited 1.", label: "Started · setup failed" },
    { status: "open", error: "The project moved.", label: "Could not start" },
    { status: "dismissed", label: undefined },
  ] as const)("reports a late $label after Show card and unmount", async ({ status, label, ...details }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const todo = card("1");
    const pending = deferred<ThreadTodo>();
    const view = createView([todo], { run: vi.fn(begun(() => pending.promise)) });
    const { unmount } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={[todo]} view={view} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    act(() => { vi.advanceTimersByTime(60_000); });
    fireEvent.click(within(tray()).getByRole("button", { name: /^Show card/ }));
    unmount();

    const ended: ThreadTodo = { ...todo, status };
    if (status === "done") {
      ended.startedThread = { backend: "codex", threadId: "child-1" };
      if ("setupFailure" in details) ended.startedThread.setupFailure = details.setupFailure;
    }
    if ("error" in details) ended.error = details.error;
    await act(async () => { pending.resolve(ended); });
    render(<ThreadTodoStack threadKey={THREAD_KEY} todos={status === "open" ? [ended] : []} view={view} onStartReview={vi.fn()} />);

    if (label) {
      expect(within(tray()).getByText(label, { exact: true })).toBeTruthy();
    } else {
      expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
    }
  });

  it("moves a started card to the tray and shows the card under it, at the same position", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cards = [card("1"), card("2"), card("3")];
    const pending = deferred<ThreadTodo | undefined>();
    const view = createView(cards, {
      run: vi.fn()
        .mockImplementationOnce(begun(() => pending.promise))
        .mockImplementationOnce(begun(() => new Promise<ThreadTodo | undefined>(() => {}))),
    });
    const { container, rerender } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next to-do" }));
    expect(shownCard(container)).toEqual({ title: "Card 2", position: "2/3" });

    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(view.run).toHaveBeenCalledTimes(1);
    expect(shownCard(container)).toEqual({ title: "Card 3", position: "2/2" });
    const row = within(tray()).getByRole("listitem");
    expect(row.textContent).toContain("Card 2");
    expect(row.textContent).toContain("Starting…");
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(row.textContent).toContain("3s");

    // The next card can be started while the first is still running.
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(view.run).toHaveBeenCalledTimes(2);
    expect(shownCard(container)).toEqual({ title: "Card 1" });
    expect(within(tray()).getAllByRole("listitem")).toHaveLength(2);

    await act(async () => {
      pending.resolve({ ...cards[1]!, status: "done", result: "Started thread",
        startedThread: { backend: "codex", threadId: "child-2" } });
    });
    // The owner's delta drops the done cards from the open list.
    rerender(<ThreadTodoStack threadKey={THREAD_KEY} todos={[cards[0]!]} view={view} onStartReview={vi.fn()} />);
    const started = within(tray()).getAllByRole("listitem")[0]!;
    expect(started.textContent).toContain("Started");
    fireEvent.click(within(started).getByRole("button", { name: "Open thread: Card 2" }));
    expect(view.openStartedThread).toHaveBeenCalledWith(expect.objectContaining({ id: "2", status: "done" }));

    act(() => { vi.advanceTimersByTime(THREAD_TODO_LAUNCH_DISMISS_MS); });
    expect(within(tray()).getAllByRole("listitem")).toHaveLength(1);
    expect(tray().textContent).not.toContain("Card 2");
  });

  it("pauses a success's countdown while the pointer is on the tray", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cards = [card("1"), card("2")];
    const view = createView(cards, {
      run: vi.fn(async (entry: ThreadTodo) => ({ ...entry, status: "done" as const,
        startedThread: { backend: "codex" as const, threadId: `child-${entry.id}` } })),
    });
    render(<ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    act(() => { vi.advanceTimersByTime(THREAD_TODO_LAUNCH_DISMISS_MS - 1_000); });
    fireEvent.pointerEnter(tray());
    act(() => { vi.advanceTimersByTime(THREAD_TODO_LAUNCH_DISMISS_MS * 3); });
    expect(tray().textContent).toContain("Card 1");
    fireEvent.pointerLeave(tray());
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
  });

  it("keeps a start whose setup failed, with a way to the thread", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cards = [card("1")];
    const view = createView(cards, {
      run: vi.fn(async (entry: ThreadTodo) => ({ ...entry, status: "done" as const,
        startedThread: { backend: "codex" as const, threadId: "child", setupFailure: "Setup script exited 1." } })),
    });
    const { container } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    expect(shownCard(container)).toBeUndefined();
    act(() => { vi.advanceTimersByTime(THREAD_TODO_LAUNCH_DISMISS_MS * 2); });
    const row = within(tray()).getByRole("listitem");
    expect(row.textContent).toContain("Started · setup failed");
    expect(row.textContent).toContain("Setup script exited 1.");
    fireEvent.click(within(row).getByRole("button", { name: "Open thread: Card 1" }));
    expect(view.openStartedThread).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row).getByRole("button", { name: "Close: Card 1" }));
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
  });

  it.each(["Review card", "Close"])("returns a refused start and focuses Retry after %s", async (action) => {
    const cards = [card("1"), card("2"), card("3")];
    const refused = { ...cards[0]!, error: "This card's access changed after you saw it." };
    const view = createView(cards, { run: vi.fn(async () => refused) });
    const { container, rerender } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    // The owner's delta carries the card's error; it stays out of the deck.
    const withError = [refused, cards[1]!, cards[2]!];
    rerender(<ThreadTodoStack threadKey={THREAD_KEY} todos={withError} view={view} onStartReview={vi.fn()} />);
    expect(shownCard(container)).toEqual({ title: "Card 2", position: "1/2" });
    const row = within(tray()).getByRole("listitem");
    expect(row.textContent).toContain("Could not start");
    expect(row.textContent).toContain("access changed");

    const button = within(row).getByRole("button", { name: `${action}: Card 1` });
    act(() => { button.focus(); });
    fireEvent.click(button);
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
    expect(shownCard(container)).toEqual({ title: "Card 1", position: "1/3" });
    expect(container.querySelector(".thread-todo-stack__deck")?.textContent).toContain("access changed");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
  });

  it("keeps a thread's rows across a switch to another thread", () => {
    const cards = [card("1")];
    const view = createView(cards, { run: vi.fn(begun(() => new Promise<ThreadTodo | undefined>(() => {}))) });
    const { rerender } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(tray().textContent).toContain("Card 1");
    const other = card("9", { threadId: "thread-b" });
    rerender(<ThreadTodoStack threadKey={threadTodoThreadKey(other)} todos={[other]} view={view} onStartReview={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
    cleanup();
    render(<ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />);
    expect(tray().textContent).toContain("Starting…");
  });

  it("keeps a card in the deck while its start waits on the Full Access prompt, and after a cancel", () => {
    // App's gate holds the run behind the risk dialog and never settles a
    // cancelled one, so nothing may leave the deck until the run begins.
    const cards = [card("1"), card("2")];
    const view = createView(cards, { run: vi.fn(() => new Promise<ThreadTodo | undefined>(() => {})) });
    const { container } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(view.run).toHaveBeenCalledTimes(1);
    expect(shownCard(container)).toEqual({ title: "Card 1", position: "1/2" });
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
  });

  it("reports a run that throws before it returns, so the card is not stranded", async () => {
    const cards = [card("1"), card("2")];
    const view = createView(cards, { run: vi.fn(() => { throw new Error("The owner is gone."); }) });
    const { container } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    const row = within(tray()).getByRole("listitem");
    expect(row.textContent).toContain("Could not start");
    expect(row.textContent).toContain("The owner is gone.");
    fireEvent.click(within(row).getByRole("button", { name: "Review card: Card 1" }));
    expect(shownCard(container)?.title).toBe("Card 1");
  });

  it.each([undefined, "Setup script exited 1."])("focuses the next row after Close (setup error: %s)", async (setupFailure) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cards = [card("1"), card("2")];
    const view = createView(cards, {
      run: vi.fn(begun(async (entry: ThreadTodo) => ({ ...entry, status: "done" as const,
        startedThread: { backend: "codex" as const, threadId: `child-${entry.id}`,
          ...(entry.id === "1" && setupFailure ? { setupFailure } : {}) } }))),
    });
    const { rerender } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    rerender(<ThreadTodoStack threadKey={THREAD_KEY} todos={cards.slice(1)} view={view} onStartReview={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    rerender(<ThreadTodoStack threadKey={THREAD_KEY} todos={cards.slice(2)} view={view} onStartReview={vi.fn()} />);
    expect(within(tray()).getAllByRole("listitem")).toHaveLength(2);

    // Keyboard: focus the first row's Close and press it.
    const close = within(tray()).getByRole("button", { name: "Close: Card 1" });
    act(() => { close.focus(); });
    fireEvent.click(close);
    const open = within(tray()).getByRole("button", { name: "Open thread: Card 2" });
    expect(document.activeElement).toBe(open);
    act(() => { vi.advanceTimersByTime(THREAD_TODO_LAUNCH_DISMISS_MS); });
    expect(document.activeElement).toBe(open);
  });

  it.each([false, true])("focuses the deck after Close removes the last started row (tracked review: %s)", async (trackedReview) => {
    const cards = [card("1"), card("2", trackedReview ? { kind: "review", action: undefined, reviewId: "review-2" } : {})];
    const view = createView(cards, {
      run: vi.fn(begun(async (entry) => ({ ...entry, status: "done" as const,
        startedThread: { backend: "codex" as const, threadId: "child-1" } }))),
    });
    const { rerender } = render(
      <ThreadTodoStack threadKey={THREAD_KEY} todos={cards} view={view} onStartReview={vi.fn()} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    });
    rerender(<ThreadTodoStack threadKey={THREAD_KEY} todos={cards.slice(1)} view={view} onStartReview={vi.fn()} />);

    const close = within(tray()).getByRole("button", { name: "Close: Card 1" });
    act(() => { close.focus(); });
    fireEvent.click(close);
    expect(document.activeElement).toBe(trackedReview
      ? screen.getByRole("article", { name: "Card 2" })
      : screen.getByRole("button", { name: "Start thread" }));
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
  });

  it("focuses the deck when the neighboring tray action is still landing", async () => {
    const previousAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    const animation = { cancel: vi.fn(), onfinish: () => {} };
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: () => animation });
    try {
      const cards = [card("1"), card("2"), card("3")];
      const view = createView(cards, {
        run: vi.fn(begun(async (entry) => ({ ...entry, status: "done" as const,
          startedThread: { backend: "codex" as const, threadId: `child-${entry.id}` } }))),
      });
      const stack = (todos: ThreadTodo[]) => (
        <ThreadTodoStack threadKey={THREAD_KEY} todos={todos} view={view} onStartReview={vi.fn()} />
      );
      const { rerender } = render(stack(cards));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start thread" })); });
      act(() => { animation.onfinish(); });
      rerender(stack(cards.slice(1)));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start thread" })); });
      rerender(stack(cards.slice(2)));
      const landing = within(tray()).getByRole("button", { name: "Open thread: Card 2" }).closest("li");
      expect(landing?.classList.contains("is-landing")).toBe(true);

      const close = within(tray()).getByRole("button", { name: "Close: Card 1" });
      act(() => { close.focus(); });
      fireEvent.click(close);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start thread" }));
    } finally {
      if (previousAnimate) Object.defineProperty(HTMLElement.prototype, "animate", previousAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });
});
