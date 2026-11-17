import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__pwragentFederationTarget");
});

function thread(index: number, unread: boolean, remote = false): NavigationThreadSummary {
  return {
    id: `thread-${index}`,
    title: `Batch thread ${index}`,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    updatedAt: index + 1,
    // A read thread can still belong to Attention while its turn is active.
    threadStatus: "active",
    inbox: { inInbox: unread, reason: unread ? "updated-since-seen" : undefined },
    linkedDirectories: [],
    ...(remote ? { federation: {
      ref: { backend: "codex" as const, threadId: `thread-${index}`,
        target: { scope: "remote" as const, instanceId: "peer" } },
      peerStatus: "connected" as const,
      capabilities: ["thread_navigation" as const],
      instanceLabel: "Peer",
    } } : {}),
  };
}

function openSelection(
  threads: NavigationThreadSummary[],
  onMarkThreadsSeen?: (threads: NavigationThreadSummary[]) => Promise<void>,
): void {
  render(<Sidebar
    backends={[]}
    browseMode="attention"
    directories={[]}
    threads={threads}
    loading={false}
    onBrowseModeChange={() => undefined}
    onCreateThread={async () => undefined}
    onOpenLaunchpad={async () => undefined}
    onSelectThread={() => undefined}
    onMarkThreadsSeen={onMarkThreadsSeen}
  />);
  // The last row stays unselected, even when it is unread.
  for (const [index, candidate] of threads.slice(0, -1).entries()) {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${candidate.title}(?:,|$)`) }),
      index === 0 ? {} : { metaKey: true, ctrlKey: true });
  }
  fireEvent.contextMenu(screen.getByRole("button", { name: new RegExp(`^${threads[0].title}(?:,|$)`) }));
}

describe("bulk Mark Read", () => {
  it.each([false, true])("marks only selected unread Attention threads (first row unread: %s)", async (firstUnread) => {
    // false is the property's smallest counterexample: one read row and
    // one unread row still need a bulk Mark Read action.
    const threads = [thread(0, firstUnread), thread(1, true), thread(2, true)];
    const onMarkThreadsSeen = vi.fn(async (_threads: NavigationThreadSummary[]) => undefined);
    openSelection(threads, onMarkThreadsSeen);

    const action = screen.queryByRole("menuitem", { name: firstUnread ? "Mark 2 Threads Read" : "Mark 1 Thread Read" });
    expect(action).not.toBeNull();
    await act(async () => { fireEvent.click(action!); });

    expect(onMarkThreadsSeen).toHaveBeenCalledExactlyOnceWith(threads.slice(firstUnread ? 0 : 1, 2));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("marks exactly the selected unread rows supported by the window's read action", async () => {
    // The bulk action must have the same eligibility as Mark Read on each
    // individual row: unread, callback present, and owned by this window.
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ unread: fc.boolean(), remote: fc.boolean() }), { minLength: 2, maxLength: 4 }),
      fc.boolean(),
      async (rows, hasHandler) => {
        try {
          const threads = [...rows.map((row, index) => thread(index, row.unread, row.remote)), thread(99, true)];
          const onMarkThreadsSeen = vi.fn(async (_threads: NavigationThreadSummary[]) => undefined);
          openSelection(threads, hasHandler ? onMarkThreadsSeen : undefined);
          const expected = threads.slice(0, -1).filter((row) => row.inbox.inInbox && !row.federation);
          const action = screen.queryByRole("menuitem", { name: /^Mark \d+ Threads? Read$/ });
          expect(Boolean(action)).toBe(hasHandler && expected.length > 0);
          if (action) {
            expect(action.textContent).toBe(`Mark ${expected.length} ${expected.length === 1 ? "Thread" : "Threads"} Read`);
            await act(async () => { fireEvent.click(action); });
            const actual = onMarkThreadsSeen.mock.calls[0]?.[0] ?? [];
            expect(onMarkThreadsSeen).toHaveBeenCalledTimes(1);
            expect(actual).toHaveLength(expected.length);
            expect(actual).toEqual(expect.arrayContaining(expected));
            expect(screen.queryByRole("menu")).toBeNull();
          } else {
            expect(onMarkThreadsSeen).not.toHaveBeenCalled();
          }
        } finally {
          cleanup();
        }
      },
    ), { numRuns: 25 });
  });

  it("marks selected peer threads read in a window mounted on their owner", async () => {
    const threads = [thread(0, true, true), thread(1, true, true), thread(2, true, true)];
    Object.defineProperty(window, "__pwragentFederationTarget", {
      configurable: true,
      value: threads[0].federation!.ref.target,
    });
    const onMarkThreadsSeen = vi.fn(async (_threads: NavigationThreadSummary[]) => undefined);
    openSelection(threads, onMarkThreadsSeen);

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Mark 2 Threads Read" }));
    });

    expect(onMarkThreadsSeen).toHaveBeenCalledExactlyOnceWith(threads.slice(0, 2));
  });
});
