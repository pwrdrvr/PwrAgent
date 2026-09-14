import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { BrowseMode } from "../../../lib/useThreadNavigation";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";
import { ThreadRow } from "../ThreadRow";

/**
 * The Sidebar has to route its hydrate through
 * `createHoverStableSidebarHydrator`, not call
 * `hydrateHoverStableSidebarSnapshot` directly.
 *
 * `hover-stable-sidebar-snapshot.test.ts` proves the hydrator preserves
 * identity, and `hover-stable-sidebar.test.tsx` proves the freeze still
 * behaves — but neither notices if the wiring between them is dropped, since
 * one never renders a Sidebar and the other never looks at object identity.
 * That gap is the whole measured result of this change, so it is pinned here:
 * what a row RECEIVES is what a memo boundary downstream compares.
 */

type MemoComponent = { type: (props: never) => unknown };

/** The `thread` object handed to each row, keyed by title, most recent last. */
let handed = new Map<string, NavigationThreadSummary[]>();
const memoized = ThreadRow as unknown as MemoComponent;
const inner = memoized.type;

beforeEach(() => {
  handed = new Map();
  memoized.type = (props: never) => {
    const thread = (props as { thread: NavigationThreadSummary }).thread;
    const seen = handed.get(thread.title) ?? [];
    seen.push(thread);
    handed.set(thread.title, seen);
    return inner(props);
  };
});

afterEach(() => {
  memoized.type = inner;
});

function thread(id: string, title: string): NavigationThreadSummary {
  return {
    id,
    title,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    createdAt: 1,
    updatedAt: 1,
    inbox: { inInbox: true, reason: "new-thread" },
    linkedDirectories: [],
  } as unknown as NavigationThreadSummary;
}

function sidebar(threads: NavigationThreadSummary[], browseMode: BrowseMode) {
  return (
    <Sidebar
      backends={[]}
      browseMode={browseMode}
      directories={[]}
      inboxThreads={threads}
      loading={false}
      threads={threads}
      onBrowseModeChange={() => undefined}
      onCreateThread={async () => undefined}
      onOpenLaunchpad={async () => undefined}
      onSelectThread={() => undefined}
    />
  );
}

function firstThreadRow(): HTMLElement {
  const browser = screen.getByRole("region", { name: "Thread browser" });
  const row = within(browser)
    .getAllByRole("listitem")
    .find((entry) => entry.querySelector(".thread-row__title"));
  if (!row) throw new Error("Expected a thread row");
  return row;
}

describe("hover-stable sidebar identity", () => {
  it("stops reaching a hovered row once the freeze settles", () => {
    const threads = [thread("a", "Alpha"), thread("b", "Beta")];
    const { rerender } = render(sidebar(threads, "inbox"));

    // Park the pointer on a row: from here the Sidebar hydrates a frozen
    // snapshot during every render, which is where the churn lived. Engaging
    // the freeze is itself one hydrate that hands down a new object, so
    // measure from after it settles.
    fireEvent.pointerOver(firstThreadRow(), { pointerType: "mouse" });
    rerender(sidebar(threads, "inbox"));
    handed = new Map();

    // Five more renders with the same values. The Sidebar rebuilds its
    // `value` object inline every time, so nothing upstream is holding these
    // still — only the hydrator is, and `ThreadRow`'s memo bails on what it
    // hands back. Route the hydrate around the hydrator and each of these
    // arrives as a fresh object, so all five reach the row.
    for (let round = 0; round < 5; round += 1) {
      rerender(sidebar(threads, "inbox"));
    }
    expect(handed.get("Alpha") ?? []).toEqual([]);

    // Liveness, so the empty result above cannot pass for the wrong reason:
    // the same loop with one changed value still reaches the row. Without
    // this, an unmounted row would read as a clean bail-out.
    const renamed = [{ ...threads[0]!, title: "Alpha renamed" }, threads[1]!];
    rerender(sidebar(renamed, "inbox"));
    expect(handed.get("Alpha renamed") ?? []).toHaveLength(1);
  });

  it("still delivers changed content to the hovered row", () => {
    // The bail-out must not become "stop hydrating": a row under the pointer
    // still has to see live updates, which is what the freeze is for.
    const threads = [thread("a", "Alpha"), thread("b", "Beta")];
    const { rerender } = render(sidebar(threads, "inbox"));
    fireEvent.pointerOver(firstThreadRow(), { pointerType: "mouse" });
    rerender(sidebar(threads, "inbox"));

    const renamed = [{ ...threads[0]!, title: "Alpha renamed" }, threads[1]!];
    rerender(sidebar(renamed, "inbox"));

    expect(screen.getByText("Alpha renamed")).toBeInTheDocument();
  });
});
