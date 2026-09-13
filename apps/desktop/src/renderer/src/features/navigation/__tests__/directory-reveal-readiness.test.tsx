import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  NavigationDirectoryRow,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationRow,
} from "@pwragent/shared";
import { Sidebar } from "../Sidebar";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";

/**
 * Revealing a selected row inside a closed directory puts reads in flight for
 * pages the directory never demanded. Those pages land in a later commit and
 * insert rows ABOVE the selected row, and ThreadRow's reveal is one-shot: it
 * scrolls when the row first renders active and once more on the next frame.
 * Whichever of those two scrolls runs before the page arrives aims at a
 * position the row is about to lose, which left the row 85% clipped on the
 * Linux Desktop E2E lane (`thread-title-reveal.spec.ts`, PwrAgent #2098).
 *
 * Both halves are asserted, because the fix is the pair: the reveal is not
 * consumed while a read is outstanding, and it reaches the row in the commit
 * where the page has landed.
 */

const directoryKey = "directory:/repo";
const directory: NavigationDirectoryRow = {
  key: directoryKey,
  label: "Repo",
  path: "/repo",
  kind: "directory",
  counts: { total: 4, pinned: 1, active: 0, unread: 0, review: 0 },
  pinnedRootCount: 1,
  unpinnedRootCount: 2,
  launchpadPresent: false,
};

function navigationRow(
  id: string,
  title: string,
  patch: Partial<NavigationRow> = {},
): NavigationRow {
  return {
    id,
    source: "codex",
    title,
    titleSource: "explicit",
    ref: { backend: "codex", threadId: id },
    rowRevision: "r",
    linkedDirectories: [
      { id: "/repo", kind: "local", label: "Repo", path: "/repo" },
    ],
    inbox: { inInbox: false },
    ordinaryChildCount: 0,
    nativeSubAgentGroupPresent: false,
    queueCount: 0,
    queueState: "unknown",
    ...patch,
  };
}

const pinnedAnchor = navigationRow("anchor", "Pinned anchor", {
  pinnedRank: "1",
});
const filler = navigationRow("filler", "Filler thread");
const parent = navigationRow("parent", "Parent thread", {
  ordinaryChildCount: 1,
});
const child = navigationRow("child", "Hidden linked child", {
  parentThreadId: "parent",
});

function resource(
  id: string,
  query: NavigationQueryRequest["query"],
  patch: Partial<NavigationQueryPage>,
  loading = false,
): NavigationWindowResource {
  const request: NavigationQueryRequest = {
    protocol: 2,
    consumer: "main-sidebar",
    pageSize: 10,
    query,
  };
  return {
    id,
    loading,
    state: {
      ...createNavigationPageState(request),
      page: {
        protocol: 2,
        queryKey: id,
        generation: "g",
        ownerEpoch: "owner",
        countsRevision: "r",
        coverage: { state: "complete" },
        counts: directory.counts,
        entries: [],
        directories: [],
        complete: true,
        ...patch,
      },
    },
  };
}

/**
 * `rootLoaded: false` is the moment the reveal opens the directory: the root
 * range is being read, so the only unpinned row on screen is the selected
 * thread's own ancestor. `true` is the commit that read lands in, where the
 * filler that sorts above it finally exists.
 */
function pagedNavigation(rootLoaded: boolean) {
  const resources = new Map<string, NavigationWindowResource>([
    [
      "directory-index",
      resource(
        "directory-index",
        { kind: "directory-index" },
        { directories: [directory] },
      ),
    ],
    [
      `directory-pins:${directoryKey}`,
      resource(
        `directory-pins:${directoryKey}`,
        { kind: "directory", directoryKey, roots: "pinned" },
        {
          entries: [
            {
              row: pinnedAnchor,
              placement: { kind: "root" },
              orderKey: pinnedAnchor.pinnedRank!,
            },
          ],
        },
      ),
    ],
    [
      `directory:${directoryKey}`,
      resource(
        `directory:${directoryKey}`,
        { kind: "directory", directoryKey, roots: "unpinned" },
        {
          entries: [
            ...(rootLoaded
              ? [
                  {
                    row: filler,
                    placement: { kind: "root" as const },
                    orderKey: "a",
                  },
                ]
              : []),
            { row: parent, placement: { kind: "root" }, orderKey: "b" },
          ],
        },
        !rootLoaded,
      ),
    ],
    [
      "children:codex:parent",
      resource(
        "children:codex:parent",
        { kind: "children", parent: parent.ref },
        {
          entries: [
            {
              row: child,
              placement: { kind: "child", parent: parent.ref },
              orderKey: "a",
            },
          ],
        },
      ),
    ],
  ]);
  return {
    resources,
    directories: [directory],
    selectedDirectoryKeys: [directoryKey],
    connected: true,
    invalidate: () => undefined,
    refresh: async () => undefined,
    loadMore: async () => undefined,
    rebaseline: async () => undefined,
    restart: async () => undefined,
    setVisibleAnchor: () => undefined,
  };
}

function withMockScrollIntoView(): {
  restore: () => void;
  scrollIntoView: ReturnType<typeof vi.fn>;
} {
  const scrollIntoView = vi.fn();
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return {
    restore: () => {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    },
    scrollIntoView,
  };
}

/** Let ThreadRow's reveal frame run, so a premature completion is observable. */
async function flushRevealFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

it("holds a reveal until the directory's own page read lands", async () => {
  const mocked = withMockScrollIntoView();
  cleanups.push(mocked.restore);
  const onRevealSelectedThreadComplete = vi.fn();
  const sidebar = (rootLoaded: boolean) => (
    <Sidebar
      backends={[]}
      browseMode="directories"
      directories={[directory]}
      loading={false}
      pagedNavigation={pagedNavigation(rootLoaded)}
      revealSelectedThreadRequest={1}
      selectedItemKey="codex:child"
      selectedThreadDirectoryKeys={[directoryKey]}
      threads={[pinnedAnchor, filler, parent, child]}
      onBrowseModeChange={() => undefined}
      onCreateThread={async () => undefined}
      onOpenLaunchpad={async () => undefined}
      onRevealSelectedThreadComplete={onRevealSelectedThreadComplete}
      onSelectThread={() => undefined}
      onSetSubthreadsCollapsed={async () => undefined}
      onSetDirectoryThreadsCollapsed={async () => undefined}
    />
  );

  const { rerender } = render(sidebar(false));
  await flushRevealFrame();

  // The row is on screen, but above a filler that has not arrived yet.
  // Scrolling to it here would scroll to a position it is about to lose.
  expect(onRevealSelectedThreadComplete).not.toHaveBeenCalled();

  mocked.scrollIntoView.mockClear();
  await act(async () => {
    rerender(sidebar(true));
  });

  // The page landed: the reveal reaches the row in that same commit, so its
  // synchronous scroll measures the layout the row actually keeps.
  expect(mocked.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  await flushRevealFrame();
  expect(onRevealSelectedThreadComplete).toHaveBeenCalledWith(1);
});
