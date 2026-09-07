import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { NavigationDirectoryRow, NavigationQueryPage, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";
import { Sidebar } from "../Sidebar";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";

const directory: NavigationDirectoryRow = { key: "directory:/repo", label: "Repo", path: "/repo", kind: "directory",
  counts: { total: 12, pinned: 12, active: 0, unread: 0, review: 0 }, pinnedRootCount: 12, unpinnedRootCount: 0, launchpadPresent: false };
const rows: NavigationRow[] = [5, 6].map((index) => ({ id: `pin-${index}`, source: "codex", title: `Pin ${index}`, titleSource: "explicit",
  ref: { backend: "codex", threadId: `pin-${index}` }, rowRevision: "r", pinnedRank: String(index + 1),
  linkedDirectories: [{ id: "/repo", kind: "local", label: "Repo", path: "/repo" }], inbox: { inInbox: false },
  ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" }));
function resource(id: string, query: NavigationQueryRequest["query"], patch: Partial<NavigationQueryPage>): NavigationWindowResource {
  const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 10, query };
  return { id, loading: false, state: { ...createNavigationPageState(request), page: {
    protocol: 2, queryKey: id, generation: "g", ownerEpoch: "owner", countsRevision: "r", coverage: { state: "complete" },
    counts: directory.counts, entries: [], directories: [], complete: true, ...patch,
  } } };
}
function mount() {
  const reorder = vi.fn(async () => undefined);
  const resources = new Map<string, NavigationWindowResource>([
    ["directory-index", resource("directory-index", { kind: "directory-index" }, { directories: [directory] })],
    [`directory:${directory.key}`, resource(`directory:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "all" },
      { rangeStart: 5, complete: false, nextCursor: "next", entries: rows.map((row) => ({ row, placement: { kind: "root" }, orderKey: row.pinnedRank! })) })],
  ]);
  const navigation = { resources, directories: [directory], selectedDirectoryKeys: [directory.key], connected: true,
    invalidate: () => undefined, refresh: async () => undefined, loadMore: async () => undefined,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined };
  const mounted = render(<Sidebar backends={[]} browseMode="directories" directories={[directory]} threads={rows}
    loading={false} selectedItemKey="codex:pin-5" selectedThreadDirectoryKeys={[directory.key]} pagedNavigation={navigation}
    onBrowseModeChange={() => undefined} onSelectThread={() => undefined} onCreateThread={async () => undefined}
    onOpenLaunchpad={async () => undefined} onSetThreadPin={async () => undefined} onReorderThreadPins={reorder} />);
  return { reorder, unmount: mounted.unmount };
}

it("keeps moves enabled at a loaded pin boundary and asks the owner for its adjacent pin", () => {
  const f = mount();
  fireEvent.contextMenu(screen.getByRole("button", { name: /^Pin 5/ }));
  const move = screen.getByRole("menuitem", { name: /Move Up/ });
  expect(move).not.toBeDisabled();
  fireEvent.click(move);
  expect(f.reorder).toHaveBeenCalledWith([], { key: "codex:pin-5", direction: "up" });
  f.unmount();
});

it("keyboard moves use owner-relative direction even when visible pins have an unloaded gap", () => {
  const f = mount();
  fireEvent.keyDown(screen.getByRole("button", { name: /^Pin 5/ }), { key: "ArrowUp", metaKey: true, shiftKey: true });
  expect(f.reorder).toHaveBeenCalledWith([], { key: "codex:pin-5", direction: "up" });
  f.unmount();
});
