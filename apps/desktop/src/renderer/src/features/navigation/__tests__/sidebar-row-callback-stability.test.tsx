import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MessagingThreadBindingSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";
import { ThreadRow, type ThreadRowRef } from "../ThreadRow";

/**
 * `ThreadRow` is memoized, and for a while that bought nothing: a Profiler
 * session over the Directories lens with the pointer parked on a row reported
 * 100-110 renders per row and not one render with nothing changed, every one
 * of them blamed on a callback prop. Seven were unstable — some plain
 * `const fn = ...` in `Sidebar`, some inline arrows in `App`, and two built
 * per row inside `DirectoriesList`.
 *
 * The hovering case is the one that matters. The hover freeze holds the row's
 * DATA still, which is exactly when a moving callback identity is the only
 * thing left re-rendering the row — and an idle assertion would not separate
 * the two.
 *
 * The second half of the file is the risk a stable identity introduces. A
 * handler whose identity never changes can go on calling a closure from the
 * render that created it, and `exhaustive-deps` is a warning here, so nothing
 * fails when one does. Each test re-renders with a fresh parent callback and
 * checks the row still reaches the NEW one.
 */

function thread(index: number): NavigationThreadSummary {
  return {
    id: `thread-${index}`,
    title: `Thread ${index}`,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    createdAt: index,
    updatedAt: index,
    inbox: { inInbox: false },
    linkedDirectories: [],
  } as unknown as NavigationThreadSummary;
}

const THREADS = Array.from({ length: 10 }, (_, index) => thread(index + 1));

const PR: PrSummary = {
  provider: "github.com",
  org: "pwrdrvr",
  repo: "PwrAgent",
  number: 2119,
  state: "pending",
  url: "https://github.com/pwrdrvr/PwrAgent/pull/2119",
};

const BINDING: MessagingThreadBindingSummary = {
  bindingId: "binding-tg-1",
  platform: "telegram",
  conversationKind: "topic",
  conversationTitle: "Row callbacks",
  parentTitle: "PwrDrvr",
};

const DIRECTORY: NavigationDirectorySummary = {
  key: "directory:/repo",
  kind: "directory",
  label: "Repo",
  path: "/repo",
  threadKeys: THREADS.map((entry) => `codex:${entry.id}`),
  needsAttentionCount: 0,
  latestUpdatedAt: THREADS.length,
};

/**
 * The props `Sidebar` forwards to a row untouched are its CALLER's contract,
 * so they are held stable here rather than rebuilt per render — that is what
 * `App` supplies today, and the Profiler confirmed none of them was among the
 * unstable seven. Everything `Sidebar` itself builds or wraps is deliberately
 * a brand new function on every call below.
 */
const stableForwarded = {
  onPrefetchPullRequests: () => undefined,
  onPrefetchGitWorkingState: () => undefined,
  onRevealSelectedThreadComplete: () => undefined,
  onSetThreadReaction: async () => undefined,
};

type SidebarOverrides = {
  browseMode?: "directories" | "inbox";
  onDetachPullRequest?: (
    thread: NavigationThreadSummary,
    pr: PrSummary,
  ) => Promise<void>;
  onReorderThreadPins?: (orderedThreadKeys: string[]) => Promise<void>;
  onSelectThread?: (thread: NavigationThreadSummary) => void;
  onSetThreadPin?: (
    thread: NavigationThreadSummary,
    pinned: boolean,
  ) => Promise<void>;
  onUnbindMessagingBinding?: (
    thread: NavigationThreadSummary,
    binding: MessagingThreadBindingSummary,
  ) => Promise<void>;
  threads?: NavigationThreadSummary[];
};

/** Fresh inline handlers on every call, the way an un-memoized parent renders. */
function sidebar(overrides: SidebarOverrides = {}) {
  return (
    <Sidebar
      backends={[]}
      browseMode={overrides.browseMode ?? "directories"}
      directories={[DIRECTORY]}
      inboxThreads={overrides.threads ?? THREADS}
      loading={false}
      selectedItemKey="codex:thread-1"
      threads={overrides.threads ?? THREADS}
      onBrowseModeChange={() => undefined}
      onCreateThread={async () => undefined}
      onOpenLaunchpad={async () => undefined}
      onDetachPullRequest={async (target, pr) => {
        await overrides.onDetachPullRequest?.(target, pr);
      }}
      onReorderThreadPins={async (orderedThreadKeys) =>
        overrides.onReorderThreadPins?.(orderedThreadKeys)
      }
      onSelectThread={(target) => overrides.onSelectThread?.(target)}
      onSetThreadPin={async (target, pinned) =>
        overrides.onSetThreadPin?.(target, pinned)
      }
      onSetSubthreadsCollapsed={async () => undefined}
      onUnbindMessagingBinding={async (target, binding) =>
        overrides.onUnbindMessagingBinding?.(target, binding)
      }
      {...stableForwarded}
    />
  );
}

type MemoComponent = { type: (props: never) => unknown };

const memoized = ThreadRow as unknown as MemoComponent;
const inner = memoized.type;
let rowRenders = 0;

beforeEach(() => {
  rowRenders = 0;
  memoized.type = (props: never) => {
    rowRenders += 1;
    return inner(props);
  };
});

afterEach(() => {
  memoized.type = inner;
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/** Anchored at both ends: "Thread 1" is a prefix of "Thread 10". */
function rowButtonName(title: string): RegExp {
  return new RegExp(`^${title}(,|$)`);
}

function row(title: string): HTMLElement {
  const shell = screen
    .getByRole("button", { name: rowButtonName(title) })
    .closest<HTMLElement>("[data-hover-stable-row='thread']");
  if (!shell) {
    throw new Error(`Expected a hover-stable row for ${title}`);
  }
  return shell;
}

function renderedTitles(): string[] {
  return within(screen.getByRole("list", { name: "Threads in Repo" }))
    .getAllByRole("listitem")
    .map((entry) => entry.querySelector(".thread-row__title")?.textContent ?? "")
    .filter(Boolean);
}

describe("sidebar thread row callback stability", () => {
  it("stops re-rendering the rows while the pointer rests on one", () => {
    const view = render(sidebar());
    expect(renderedTitles()).toHaveLength(THREADS.length);

    // The freeze is read during render, not installed by the pointer event,
    // so the rows adopt their frozen thread objects on the next render. That
    // one settling render is the state the Profiler measured from.
    fireEvent.pointerOver(row("Thread 1"), { pointerType: "mouse" });
    view.rerender(sidebar());
    const settled = rowRenders;

    // Ten more parent renders. Nothing about the threads changed; every
    // handler the sidebar owns is a brand new function, which is what the
    // real parents hand down on every navigation snapshot.
    for (let round = 0; round < 10; round += 1) view.rerender(sidebar());

    expect(rowRenders).toBe(settled);
  });

  it("stops re-rendering the Inbox rows while the pointer rests on one", () => {
    // The browsing lenses render through `RecentsList`, which built the same
    // per-row closure for `onSelectThread`. Same freeze, same contract.
    const view = render(sidebar({ browseMode: "inbox" }));
    const inboxThreads = THREADS.map((entry) => ({
      ...entry,
      inbox: { inInbox: true, reason: "new-thread" },
    })) as NavigationThreadSummary[];
    view.rerender(sidebar({ browseMode: "inbox", threads: inboxThreads }));
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);

    fireEvent.pointerOver(row("Thread 1"), { pointerType: "mouse" });
    view.rerender(sidebar({ browseMode: "inbox", threads: inboxThreads }));
    const settled = rowRenders;

    for (let round = 0; round < 10; round += 1) {
      view.rerender(sidebar({ browseMode: "inbox", threads: inboxThreads }));
    }

    expect(rowRenders).toBe(settled);
  });

  it("still re-renders a row when its own thread changes", () => {
    // The other half: a bail-out must not outlive the data it was based on.
    const view = render(sidebar());
    fireEvent.pointerOver(row("Thread 1"), { pointerType: "mouse" });
    view.rerender(sidebar());
    const settled = rowRenders;

    view.rerender(
      sidebar({
        threads: THREADS.map((entry) =>
          entry.id === "thread-3" ? { ...entry, title: "Thread 3 renamed" } : entry,
        ),
      }),
    );

    expect(rowRenders).toBeGreaterThan(settled);
    expect(renderedTitles()).toContain("Thread 3 renamed");
  });

  it("keeps selection wired to the newest onSelectThread", () => {
    type Select = (thread: NavigationThreadSummary) => void;
    const first = vi.fn<Select>();
    const second = vi.fn<Select>();
    const view = render(sidebar({ onSelectThread: first }));
    for (let round = 0; round < 3; round += 1) {
      view.rerender(sidebar({ onSelectThread: second }));
    }

    fireEvent.click(within(row("Thread 4")).getByRole("button", { name: rowButtonName("Thread 4") }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[0]).toMatchObject({ id: "thread-4" });
  });

  it("shift-clicks a range using the directory's own selection order", () => {
    // `selectionOrder` used to be captured in a closure built per row. It is
    // now looked up from the directory the row reports back, so a range that
    // still spans exactly the rows between the two clicks is what proves the
    // lookup resolves the right directory.
    render(sidebar());
    const titles = renderedTitles();
    fireEvent.click(
      within(row(titles[0]!)).getByRole("button", { name: rowButtonName(titles[0]!) }),
    );
    fireEvent.click(
      within(row(titles[4]!)).getByRole("button", { name: rowButtonName(titles[4]!) }),
      { shiftKey: true },
    );

    const pressed = titles.filter(
      (title) =>
        within(row(title)).getByRole("button", { name: rowButtonName(title) })
          .getAttribute("aria-pressed") === "true",
    );
    expect(pressed).toEqual(titles.slice(0, 5));
  });

  it("shift-clicks a range against the order the list has NOW", () => {
    // The stale-closure case for the same lookup: the map is rebuilt every
    // render, and a handler holding an earlier one would range over the
    // order the list used to have. One row jumping to the top is what
    // separates the two — a symmetric reshuffle spans the same set either
    // way and would let a stale order through.
    const view = render(sidebar());
    const before = renderedTitles();
    const promoted = THREADS.map((entry) =>
      entry.id === "thread-1"
        ? { ...entry, createdAt: 99, updatedAt: 99 }
        : entry,
    );
    view.rerender(sidebar({ threads: promoted }));
    const titles = renderedTitles();
    expect(titles[0]).toBe("Thread 1");
    expect(titles).not.toEqual(before);

    fireEvent.click(
      within(row(titles[0]!)).getByRole("button", { name: rowButtonName(titles[0]!) }),
    );
    fireEvent.click(
      within(row(titles[2]!)).getByRole("button", { name: rowButtonName(titles[2]!) }),
      { shiftKey: true },
    );

    const pressed = titles.filter(
      (title) =>
        within(row(title)).getByRole("button", { name: rowButtonName(title) })
          .getAttribute("aria-pressed") === "true",
    );
    expect(pressed).toEqual(titles.slice(0, 3));
  });

  it("keeps the pin action wired to the newest onSetThreadPin", () => {
    type SetPin = (
      thread: NavigationThreadSummary,
      pinned: boolean,
    ) => Promise<void>;
    const first = vi.fn<SetPin>(async () => undefined);
    const second = vi.fn<SetPin>(async () => undefined);
    const view = render(sidebar({ onSetThreadPin: first }));
    const target = row("Thread 2");
    fireEvent.pointerOver(target, { pointerType: "mouse" });
    for (let round = 0; round < 3; round += 1) {
      view.rerender(sidebar({ onSetThreadPin: second }));
    }

    fireEvent.click(within(row("Thread 2")).getByRole("button", { name: "Pin thread" }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[0]).toMatchObject({ id: "thread-2" });
    expect(second.mock.calls[0]?.[1]).toBe(true);
  });

  it("keeps the thread context menu opening after the parent re-renders", () => {
    const view = render(sidebar());
    for (let round = 0; round < 3; round += 1) view.rerender(sidebar());

    fireEvent.contextMenu(row("Thread 5"), { clientX: 10, clientY: 20 });

    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Copy Thread Link" })).toBeInTheDocument();
  });

  it("keeps the pull request context menu opening after the parent re-renders", () => {
    const withPr = THREADS.map((entry) =>
      entry.id === "thread-6" ? { ...entry, prs: [PR] } : entry,
    );
    const view = render(sidebar({ threads: withPr }));
    for (let round = 0; round < 3; round += 1) {
      view.rerender(sidebar({ threads: withPr }));
    }

    fireEvent.contextMenu(
      within(row("Thread 6")).getByRole("button", {
        name: /^Open pwrdrvr\/PwrAgent#2119/,
      }),
      { clientX: 10, clientY: 20 },
    );

    const menu = screen.getByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Copy Pull Request URL" }),
    ).toBeInTheDocument();
  });

  it("keeps a PR detach wired to the newest onDetachPullRequest", () => {
    const withPr = THREADS.map((entry) =>
      entry.id === "thread-7" ? { ...entry, prs: [PR] } : entry,
    );
    type Detach = (
      thread: NavigationThreadSummary,
      pr: PrSummary,
    ) => Promise<void>;
    const first = vi.fn<Detach>(async () => undefined);
    const second = vi.fn<Detach>(async () => undefined);
    const view = render(sidebar({ threads: withPr, onDetachPullRequest: first }));
    for (let round = 0; round < 3; round += 1) {
      view.rerender(sidebar({ threads: withPr, onDetachPullRequest: second }));
    }

    fireEvent.click(
      within(row("Thread 7")).getByRole("button", {
        name: "Detach pwrdrvr/PwrAgent#2119 from thread",
      }),
    );
    // Detaching is confirmed once per install; go through the dialog rather
    // than pre-dismissing it, so the test does not encode its storage key.
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Detach PR" }),
    );

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[1]).toMatchObject({ number: 2119 });
  });

  it("keeps an unbind wired to the newest onUnbindMessagingBinding", () => {
    const withBinding = THREADS.map((entry) =>
      entry.id === "thread-8" ? { ...entry, messagingBindings: [BINDING] } : entry,
    );
    type Unbind = (
      thread: NavigationThreadSummary,
      binding: MessagingThreadBindingSummary,
    ) => Promise<void>;
    const first = vi.fn<Unbind>(async () => undefined);
    const second = vi.fn<Unbind>(async () => undefined);
    const view = render(
      sidebar({ threads: withBinding, onUnbindMessagingBinding: first }),
    );
    for (let round = 0; round < 3; round += 1) {
      view.rerender(
        sidebar({ threads: withBinding, onUnbindMessagingBinding: second }),
      );
    }

    const chip = row("Thread 8").querySelector<HTMLElement>(
      ".thread-row__chip--binding",
    );
    if (!chip) throw new Error("Expected a binding chip");
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Unbind from/ }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[1]).toMatchObject({ bindingId: "binding-tg-1" });
  });

  it("keeps a pin drag wired to the newest onReorderThreadPins", async () => {
    // `onPointerDownThread` is the handler that starts this drag, and it is
    // the one that had to give up its per-row closure over the directory and
    // the pinned flag. A reorder that still names the right keys is what
    // proves the row reported both back correctly.
    const pinned = THREADS.slice(0, 2).map((entry, index) => ({
      ...entry,
      pinnedRank: index === 0 ? "1024" : "2048",
    }));
    const threads = [...pinned, ...THREADS.slice(2)];
    type Reorder = (orderedThreadKeys: string[]) => Promise<void>;
    const first = vi.fn<Reorder>(async () => undefined);
    const second = vi.fn<Reorder>(async () => undefined);
    const view = render(sidebar({ threads, onReorderThreadPins: first }));
    for (let round = 0; round < 3; round += 1) {
      view.rerender(sidebar({ threads, onReorderThreadPins: second }));
    }

    const source = row("Thread 1");
    const target = row("Thread 2");
    fireEvent.pointerOver(source, { pointerType: "mouse" });
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
      bottom: 200, height: 100, left: 0, right: 300,
      toJSON: () => ({}), top: 100, width: 300, x: 0, y: 100,
    });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      bottom: 100, height: 100, left: 0, right: 300,
      toJSON: () => ({}), top: 0, width: 300, x: 0, y: 0,
    });
    const elementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => target,
    });
    try {
      fireEvent.pointerDown(source, {
        button: 0, clientX: 50, clientY: 150, pointerId: 41,
      });
      fireEvent.pointerMove(window, {
        buttons: 1, clientX: 50, clientY: 75, pointerId: 41,
      });
      await waitFor(() => {
        expect(target).toHaveClass("is-drop-target-after");
      });
      fireEvent.pointerUp(window, {
        button: 0, clientX: 50, clientY: 75, pointerId: 41,
      });
    } finally {
      if (elementFromPoint) {
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: elementFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    }

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[0]).toEqual(["codex:thread-2", "codex:thread-1"]);
  });
});

/**
 * The contract that replaced those per-row closures: the row reports which
 * row it is, so the list can hold one handler for all of them. Asserted at
 * the row rather than through the sidebar, because a wrong `pinned` or a
 * missing `directoryKey` reaches the list as a silently ignored drag rather
 * than as a visible failure.
 */
describe("thread row identity contract", () => {
  const solo = THREADS[0]!;

  it("reports its directory, key and pinned state on pointer down", () => {
    const onPointerDownThread = vi.fn<(event: unknown, row: ThreadRowRef) => void>();
    const { container } = render(
      <ThreadRow
        directoryKey="directory:/repo"
        thread={solo}
        threadPinState="pinned"
        onSelectThread={() => undefined}
        onOpenContextMenu={() => undefined}
        onPointerDownThread={onPointerDownThread}
      />,
    );

    fireEvent.pointerDown(
      container.querySelector("[data-hover-stable-row='thread']")!,
      { button: 0 },
    );

    expect(onPointerDownThread.mock.calls[0]?.[1]).toEqual({
      directoryKey: "directory:/repo",
      threadKey: threadSummaryIdentityKey(solo),
      pinned: true,
    });
  });

  it("reports an unpinned row as unpinned", () => {
    const onPointerDownThread = vi.fn<(event: unknown, row: ThreadRowRef) => void>();
    const { container } = render(
      <ThreadRow
        directoryKey="directory:/repo"
        thread={solo}
        threadPinState="unpinned"
        onSelectThread={() => undefined}
        onOpenContextMenu={() => undefined}
        onPointerDownThread={onPointerDownThread}
      />,
    );

    fireEvent.pointerDown(
      container.querySelector("[data-hover-stable-row='thread']")!,
      { button: 0 },
    );

    expect(onPointerDownThread.mock.calls[0]?.[1]?.pinned).toBe(false);
  });

  it("reports the same identity when the row is selected", () => {
    const onSelectThread = vi.fn<
      (
        thread: NavigationThreadSummary,
        event: unknown,
        row: ThreadRowRef,
      ) => void
    >();
    render(
      <ThreadRow
        directoryKey="directory:/repo"
        thread={solo}
        onSelectThread={onSelectThread}
        onOpenContextMenu={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: solo.title }));

    expect(onSelectThread.mock.calls[0]?.[2]).toEqual({
      directoryKey: "directory:/repo",
      threadKey: threadSummaryIdentityKey(solo),
      pinned: false,
    });
  });

  it("asks the subthread toggle for the state it wants, not the one it has", () => {
    const onToggleSubthreads = vi.fn();
    const { rerender } = render(
      <ThreadRow
        thread={solo}
        subthreadCount={2}
        subthreadsCollapsed={false}
        onSelectThread={() => undefined}
        onOpenContextMenu={() => undefined}
        onToggleSubthreads={onToggleSubthreads}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Collapse sub-threads/ }));
    expect(onToggleSubthreads).toHaveBeenLastCalledWith(solo, true);

    rerender(
      <ThreadRow
        thread={solo}
        subthreadCount={2}
        subthreadsCollapsed
        onSelectThread={() => undefined}
        onOpenContextMenu={() => undefined}
        onToggleSubthreads={onToggleSubthreads}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Expand sub-threads/ }));
    expect(onToggleSubthreads).toHaveBeenLastCalledWith(solo, false);
  });
});
