import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { NavigationDirectoryRow, NavigationQueryEntry, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";
import { createNavigationPageState, navigationIdentityKey } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { Sidebar } from "../Sidebar";

afterEach(cleanup);

function mount(collapsed = false) {
  const directory: NavigationDirectoryRow = {
    key: "directory:/repo", label: "Repo", path: "/repo", kind: "directory",
    counts: { total: 9, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 1, unpinnedRootCount: 1, launchpadPresent: false,
  };
  const row = (id: string, patch: Partial<NavigationRow> = {}): NavigationRow => ({
    id, source: "codex", title: id, titleSource: "explicit",
    ref: { backend: "codex", threadId: id }, rowRevision: "r",
    linkedDirectories: [{ id: "/repo", kind: "local", label: "Repo", path: "/repo" }],
    inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
    queueCount: 0, queueState: "unknown", ...patch,
  });
  const parent = row("parent", {
    pinnedRank: "1", ordinaryChildCount: 5, subthreadsCollapsed: collapsed,
  });
  // The incoming page and the newest-created-first display order disagree.
  const displayedChildren = ["above", "gap", "first", "middle", "last"];
  const children = ["first", "above", "middle", "last", "gap"].map((id) => row(id, {
    parentThreadId: parent.id,
    createdAt: 100 - displayedChildren.indexOf(id),
    ...(id === "middle" ? { ordinaryChildCount: 2 } : {}),
  }));
  const grandchildren = ["grandchild-1", "grandchild-2"].map((id, index) => row(id, { parentThreadId: "middle", createdAt: index + 1 }));
  const tail = row("tail");
  const resources = new Map<string, NavigationWindowResource>();
  const add = (id: string, query: NavigationQueryRequest["query"], entries: NavigationQueryEntry[]) => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 10, query };
    resources.set(id, { id, loading: false, state: { ...createNavigationPageState(request), page: {
      protocol: 2, queryKey: id, generation: "g", ownerEpoch: "owner", countsRevision: "r",
      coverage: { state: "complete" }, counts: directory.counts, entries, complete: true,
    } } });
  };
  add(`directory-pins:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "pinned" },
    [{ row: parent, placement: { kind: "root" }, orderKey: "0" }]);
  add(`directory:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "unpinned" },
    [{ row: tail, placement: { kind: "root" }, orderKey: "0" }]);
  for (const [owner, descendants] of [[parent, children], [children[2]!, grandchildren]] as const) {
    add(`children:${navigationIdentityKey(owner.ref)}`, { kind: "children", parent: owner.ref },
      descendants.map((child, index) => ({ row: child, placement: { kind: "child", parent: owner.ref }, orderKey: String(index) })));
  }
  const navigation = {
    resources, presentationReady: true, directories: [directory], selectedDirectoryKeys: [directory.key], connected: true,
    invalidate: () => undefined, refresh: async () => undefined, loadMore: async () => undefined,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined,
  };
  render(<Sidebar backends={[]} browseMode="directories" directories={[directory]}
    threads={[parent, ...children, ...grandchildren, tail]} loading={false}
    selectedItemKey="codex:parent" selectedThreadDirectoryKeys={[directory.key]} pagedNavigation={navigation}
    onBrowseModeChange={() => undefined} onSelectThread={() => undefined}
    onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />);
  return [...document.querySelectorAll<HTMLButtonElement>(".thread-row button[aria-pressed]")];
}

it("does not select a subthread above the clicked range when page order differs from display order", () => {
  const buttons = mount();
  fireEvent.click(screen.getByRole("button", { name: "first" }));
  fireEvent.click(screen.getByRole("button", { name: "last" }), { shiftKey: true });
  expect(screen.getByRole("button", { name: "above" })).toHaveAttribute("aria-pressed", "false");
  expect(buttons.filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.getAttribute("aria-label")))
    .toEqual(["first", "middle", "grandchild-2", "grandchild-1", "last"]);
});

it.each([false, true])("matches every forward and reverse visible range (collapsed=%s)", (collapsed) => {
  const buttons = mount(collapsed);
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(collapsed
    ? ["parent, pinned", "tail"]
    : ["parent, pinned", "above", "gap", "first", "middle", "grandchild-2", "grandchild-1", "last", "tail"]);
  for (let anchor = 0; anchor < buttons.length; anchor += 1) {
    for (let target = 0; target < buttons.length; target += 1) {
      fireEvent.click(buttons[anchor]!);
      fireEvent.click(buttons[target]!, { shiftKey: true });
      expect(buttons.filter((button) => button.getAttribute("aria-pressed") === "true"))
        .toEqual(buttons.slice(Math.min(anchor, target), Math.max(anchor, target) + 1));
    }
  }
});
