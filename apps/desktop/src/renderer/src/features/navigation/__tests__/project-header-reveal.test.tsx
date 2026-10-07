import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import { expect, it } from "vitest";
import type {
  NavigationDirectoryRow,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationRow,
} from "@pwragent/shared";
import { Sidebar } from "../Sidebar";
import type { ProjectRevealRequest } from "../DirectoriesList";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";

/**
 * The thread header's project name reveals its project in Directories. Unlike
 * ⌘K's project jump, which waits for the project's launchpad, this reveal is
 * made from a thread: it waits for that thread to be selected, keeps the
 * thread's row in view after scrolling the section to the top, and outlines
 * the project's summary for a moment.
 *
 * The fixture is directory-reveal-readiness.test.tsx's, with every page
 * already loaded.
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
    // Every demanded page is present in both phases. `rootLoaded: false` is a
    // re-read of a page this lens already has — the reveal's own rebaseline —
    // which is exactly the case `presentationReady` alone cannot see.
    presentationReady: true,
    invalidate: () => undefined,
    refresh: async () => undefined,
    loadMore: async () => undefined,
    rebaseline: async () => undefined,
    restart: async () => undefined,
    setVisibleAnchor: () => undefined,
  };
}

/**
 * The patch has to live on the prototype — ThreadRow scrolls whatever its ref
 * points at — so the receiver is recorded with each call. Asserting only that
 * *something* scrolled would let a scroll from any other element stand in for
 * the one this file exists to protect.
 */
function withMockScrollIntoView(): {
  restore: () => void;
  scrolls: Array<{ options: unknown; target: HTMLElement }>;
} {
  const scrolls: Array<{ options: unknown; target: HTMLElement }> = [];
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: function scrollIntoView(this: HTMLElement, options: unknown): void {
      scrolls.push({ options, target: this });
    },
  });
  return {
    restore: () => {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    },
    scrolls,
  };
}

function sidebar(request: ProjectRevealRequest, selectedItemKey: string) {
  return (
    <Sidebar
      backends={[]}
      browseMode="directories"
      directories={[directory]}
      loading={false}
      pagedNavigation={pagedNavigation(true)}
      projectRevealRequest={request}
      selectedItemKey={selectedItemKey}
      selectedThreadDirectoryKeys={[directoryKey]}
      threads={[pinnedAnchor, filler, parent, child]}
      onBrowseModeChange={() => undefined}
      onCreateThread={async () => undefined}
      onOpenLaunchpad={async () => undefined}
      onSelectThread={() => undefined}
      onSetSubthreadsCollapsed={async () => undefined}
      onSetDirectoryThreadsCollapsed={async () => undefined}
    />
  );
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function summary(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".directory-row__summary");
  if (!element) throw new Error("The project summary is not rendered.");
  return element;
}

function fillerRow(): HTMLElement {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>(".thread-row:not(.directory-row__summary)"),
  ).find((candidate) => (candidate.textContent ?? "").includes(filler.title));
  if (!row) throw new Error("The selected thread row is not rendered.");
  return row;
}

it("scrolls the project to the top, keeps the thread in view, and outlines the project", async () => {
  const mocked = withMockScrollIntoView();
  try {
    render(sidebar({ key: directoryKey, selectedThreadKey: "codex:filler" }, "codex:filler"));
    await flushFrame();

    const scrolls = mocked.scrolls.map((scroll) => ({
      options: scroll.options,
      target: scroll.target,
    }));
    const sectionScroll = scrolls.findIndex((scroll) =>
      scroll.target.classList.contains("directory-row"));
    expect(scrolls[sectionScroll]).toEqual(
      expect.objectContaining({ options: { block: "start" } }),
    );
    // After the section, so the sticky header stays put and the row lands at
    // an edge. (The row also scrolls itself as it mounts selected; that one
    // comes first and is not the reveal's.)
    expect(scrolls.slice(sectionScroll + 1)).toContainEqual(
      expect.objectContaining({ options: { block: "nearest" }, target: fillerRow() }),
    );
    // The summary is a `.thread-row` too; it must not stand in for the row.
    expect(scrolls.some((scroll) => scroll.target === summary())).toBe(false);

    expect(summary()).toHaveClass("is-revealed");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1300));
    });
    expect(summary()).not.toHaveClass("is-revealed");
  } finally {
    mocked.restore();
  }
});

it("waits for the thread it names to be selected", async () => {
  const mocked = withMockScrollIntoView();
  try {
    const request = { key: directoryKey, selectedThreadKey: "codex:filler" };
    const { rerender } = render(sidebar(request, "codex:parent"));
    await flushFrame();
    expect(
      mocked.scrolls.some((scroll) => scroll.target.classList.contains("directory-row")),
    ).toBe(false);
    expect(summary()).not.toHaveClass("is-revealed");

    await act(async () => {
      rerender(sidebar(request, "codex:filler"));
    });
    await flushFrame();
    expect(
      mocked.scrolls.some((scroll) => scroll.target.classList.contains("directory-row")),
    ).toBe(true);
    expect(summary()).toHaveClass("is-revealed");
  } finally {
    mocked.restore();
  }
});
