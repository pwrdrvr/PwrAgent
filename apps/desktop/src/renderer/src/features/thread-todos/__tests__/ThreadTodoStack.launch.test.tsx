import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { threadTodoThreadKey } from "@pwragent/shared/contracts/thread-todos";
import { operatorTodoItemKey } from "@pwragent/shared/contracts/operator-requests";
import { ThreadTodoStack } from "../ThreadTodoStack";
import { THREAD_TODO_LAUNCH_DISMISS_MS } from "../ThreadTodoLaunchTray";
import { resetThreadTodoLaunchesForTests } from "../thread-todo-launches";
import type { ThreadTodosView } from "../thread-todos-view";

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
  it("moves a started card to the tray and shows the card under it, at the same position", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cards = [card("1"), card("2"), card("3")];
    const pending = deferred<ThreadTodo | undefined>();
    const view = createView(cards, {
      run: vi.fn()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementationOnce(() => new Promise<ThreadTodo | undefined>(() => {})),
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

  it("keeps a refused start until Review card returns the card to the top of the deck", async () => {
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

    fireEvent.click(within(row).getByRole("button", { name: "Review card: Card 1" }));
    expect(screen.queryByRole("region", { name: "Started to-dos" })).toBeNull();
    expect(shownCard(container)).toEqual({ title: "Card 1", position: "1/3" });
    expect(container.querySelector(".thread-todo-stack__deck")?.textContent).toContain("access changed");
  });

  it("keeps a thread's rows across a switch to another thread", () => {
    const cards = [card("1")];
    const view = createView(cards, { run: vi.fn(() => new Promise<ThreadTodo | undefined>(() => {})) });
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
});
