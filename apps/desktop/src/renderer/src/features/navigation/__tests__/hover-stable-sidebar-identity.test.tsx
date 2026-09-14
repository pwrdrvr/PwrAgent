import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";
import { memoRenderObserver } from "../../../test/memo-render-observer";
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
 *
 * What that wiring buys is measured here as an absence: with the hydrator in
 * place a hovered row is handed the objects it already has, `ThreadRow`'s memo
 * compares them equal, and further Sidebar renders never reach the row at all.
 * Route the hydrate around the hydrator and every one of them does.
 */

/** The `thread` object handed to each row, keyed by title, most recent last. */
let handed = new Map<string, NavigationThreadSummary[]>();
const rowRenders = memoRenderObserver<{ thread: NavigationThreadSummary }>(
  ThreadRow,
  "ThreadRow",
);

beforeEach(() => {
  handed = new Map();
  rowRenders.install((props) => {
    const seen = handed.get(props.thread.title) ?? [];
    seen.push(props.thread);
    handed.set(props.thread.title, seen);
  });
});

afterEach(() => {
  rowRenders.restore();
  cleanup();
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
  };
}

function sidebar(threads: NavigationThreadSummary[]) {
  return (
    <Sidebar
      backends={[]}
      browseMode="inbox"
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
    const { rerender } = render(sidebar(threads));

    // Park the pointer on a row: from here the Sidebar hydrates a frozen
    // snapshot during every render, which is where the churn lived. Engaging
    // the freeze is itself one hydrate that hands down a new object, so
    // measure from after it settles.
    fireEvent.pointerOver(firstThreadRow(), { pointerType: "mouse" });
    rerender(sidebar(threads));
    handed = new Map();

    // Five more renders with the same values. The Sidebar rebuilds its
    // `value` object inline every time, so nothing upstream is holding these
    // still — only the hydrator is, and `ThreadRow`'s memo bails on what it
    // hands back. Route the hydrate around the hydrator and each of these
    // arrives as a fresh object, so all five reach the row.
    for (let round = 0; round < 5; round += 1) {
      rerender(sidebar(threads));
    }
    expect(handed.get("Alpha") ?? []).toEqual([]);

    // Liveness, so the empty result above cannot pass for the wrong reason:
    // the same loop with one changed value still reaches the row. Without
    // this, an unmounted row would read as a clean bail-out.
    const renamed = [{ ...threads[0]!, title: "Alpha renamed" }, threads[1]!];
    rerender(sidebar(renamed));
    expect(handed.get("Alpha renamed") ?? []).toHaveLength(1);
  });

  it("still delivers changed content to the hovered row", () => {
    // The bail-out must not become "stop hydrating": a row under the pointer
    // still has to see live updates, which is what the freeze is for.
    const threads = [thread("a", "Alpha"), thread("b", "Beta")];
    const { rerender } = render(sidebar(threads));
    fireEvent.pointerOver(firstThreadRow(), { pointerType: "mouse" });
    rerender(sidebar(threads));

    const renamed = [{ ...threads[0]!, title: "Alpha renamed" }, threads[1]!];
    rerender(sidebar(renamed));

    expect(screen.getByText("Alpha renamed")).toBeInTheDocument();
  });
});
