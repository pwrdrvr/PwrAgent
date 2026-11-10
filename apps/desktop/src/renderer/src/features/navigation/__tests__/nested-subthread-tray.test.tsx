import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { NavigationDirectoryRow, NavigationQueryPage, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";
import { Sidebar } from "../Sidebar";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";

// A sub-thread can own sub-threads. The tray renders the whole subtree flat
// under the top-level row, so the middle row is the only place that can say
// "these grandchildren are mine": it needs its own chevron, and its own child
// page needs its own "Load more". Without the latter a mid-level parent shows
// its first 10 children and nothing else — archiving them pulls the next 10
// in, which reads as archive not working.

const directory: NavigationDirectoryRow = { key: "directory:/repo", label: "Repo", path: "/repo", kind: "directory",
  counts: { total: 1, pinned: 1, active: 0, unread: 0, review: 0 }, pinnedRootCount: 1, unpinnedRootCount: 0, launchpadPresent: false };

function navRow(id: string, extra: Partial<NavigationRow> = {}): NavigationRow {
  return { id, source: "codex", title: id, titleSource: "explicit", ref: { backend: "codex", threadId: id }, rowRevision: "r",
    linkedDirectories: [{ id: "/repo", kind: "local", label: "Repo", path: "/repo" }], inbox: { inInbox: false },
    ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown", ...extra };
}

function resource(id: string, query: NavigationQueryRequest["query"], patch: Partial<NavigationQueryPage>): NavigationWindowResource {
  const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 10, query };
  return { id, loading: false, state: { ...createNavigationPageState(request), page: {
    protocol: 2, queryKey: id, generation: "g", ownerEpoch: "owner", countsRevision: "r", coverage: { state: "complete" },
    counts: directory.counts, entries: [], directories: [], complete: true, ...patch,
  } } };
}

function mount(params: { browseMode: "directories" | "inbox"; middleCollapsed?: boolean }) {
  const root = navRow("root", { title: "Root", pinnedRank: "1", ordinaryChildCount: 2 });
  const middle = navRow("middle", { title: "Middle", parentThreadId: "root", ordinaryChildCount: 12,
    subthreadsCollapsed: params.middleCollapsed });
  const sibling = navRow("sibling", { title: "Sibling", parentThreadId: "root" });
  const grandchildren = Array.from({ length: 10 }, (_, index) =>
    navRow(`grandchild-${index}`, { title: `Grandchild ${index}`, parentThreadId: "middle", createdAt: 100 - index }));
  const rootChildrenId = 'children:[null,"codex","root"]';
  const middleChildrenId = 'children:[null,"codex","middle"]';
  // Directories pages a project's mounted children; the browsing lenses page the owner's.
  const directoryKey = params.browseMode === "directories" ? directory.key : undefined;
  const resources = new Map<string, NavigationWindowResource>([
    ["directory-index", resource("directory-index", { kind: "directory-index" }, { directories: [directory] })],
    [`directory-pins:${directory.key}`, resource(`directory-pins:${directory.key}`,
      { kind: "directory", directoryKey: directory.key, roots: "pinned" },
      { entries: [{ row: root, placement: { kind: "root" }, orderKey: "0" }] })],
    ["lens", resource("lens", { kind: "lens", lens: "inbox" },
      { entries: [{ row: root, placement: { kind: "root" }, orderKey: "0" }] })],
    [rootChildrenId, resource(rootChildrenId, { kind: "children", parent: root.ref, directoryKey }, {
      entries: [middle, sibling].map((row, index) => ({ row, placement: { kind: "child" as const, parent: root.ref }, orderKey: String(index) })),
    })],
  ]);
  // Kept even when folded: a page loaded before the fold stays retained, and
  // the fold must hide its rows rather than rely on the page going away.
  resources.set(middleChildrenId, resource(middleChildrenId, { kind: "children", parent: middle.ref, directoryKey }, {
    complete: false, nextCursor: "more",
    entries: grandchildren.map((row, index) => ({ row, placement: { kind: "child" as const, parent: middle.ref }, orderKey: String(index) })),
  }));
  const loadMore = vi.fn(async () => undefined);
  const setCollapsed = vi.fn(async () => undefined);
  const navigation = { resources, presentationReady: true, directories: [directory], selectedDirectoryKeys: [directory.key], connected: true,
    invalidate: () => undefined, refresh: async () => undefined, loadMore,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined };
  const view = render(<Sidebar backends={[]} browseMode={params.browseMode} directories={[directory]}
    threads={[root, middle, sibling, ...grandchildren]}
    loading={false} selectedItemKey="codex:root" selectedThreadDirectoryKeys={[directory.key]}
    pagedNavigation={navigation} onBrowseModeChange={() => undefined} onSelectThread={() => undefined}
    onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined}
    onSetSubthreadsCollapsed={setCollapsed} />);
  return { view, loadMore, setCollapsed, middle, middleChildrenId };
}

for (const browseMode of ["directories", "inbox"] as const) {
  it(`${browseMode}: a sub-thread with its own sub-threads has a chevron that folds them`, () => {
    const f = mount({ browseMode });
    const toggle = screen.getByRole("button", { name: "Collapse sub-threads for Middle" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(f.setCollapsed).toHaveBeenCalledWith(expect.objectContaining({ id: "middle" }), true);
    f.view.unmount();
  });

  it(`${browseMode}: a folded sub-thread hides its own sub-threads and keeps its siblings`, () => {
    const f = mount({ browseMode, middleCollapsed: true });
    expect(screen.getByRole("button", { name: "Expand sub-threads for Middle" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Grandchild 0")).not.toBeInTheDocument();
    expect(screen.getByText("Sibling")).toBeInTheDocument();
    f.view.unmount();
  });

  it(`${browseMode}: a sub-thread's own child page offers Load more right after its last loaded child`, () => {
    const f = mount({ browseMode });
    const more = screen.getByRole("button", { name: "Load more sub-threads" });
    fireEvent.click(more);
    expect(f.loadMore).toHaveBeenCalledWith(f.middleChildrenId);

    // Inside the same flat tray, between the grandchildren and the next
    // sibling — below the tray it would read as the top-level row's page.
    const tray = f.view.container.querySelector<HTMLElement>('[data-subthread-tray="codex:root"]')!;
    expect(tray).toContainElement(more);
    const items = [...tray.children];
    const moreAt = items.findIndex((item) => item.contains(more));
    const lastGrandchildAt = items.findIndex((item) => within(item as HTMLElement).queryByText("Grandchild 9"));
    const siblingAt = items.findIndex((item) => within(item as HTMLElement).queryByText("Sibling"));
    expect(moreAt).toBe(lastGrandchildAt + 1);
    expect(siblingAt).toBe(moreAt + 1);
    // The tray stays a valid list: its paging control is a listitem too.
    expect(items.map((item) => item.getAttribute("role"))).toEqual(items.map(() => "listitem"));
    f.view.unmount();
  });
}
