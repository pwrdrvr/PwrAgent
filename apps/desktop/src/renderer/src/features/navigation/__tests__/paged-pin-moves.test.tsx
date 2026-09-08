import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { NavigationDirectoryRow, NavigationQueryPage, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";
import { Sidebar } from "../Sidebar";
import { buildPagedDirectoryPresentation } from "../paged-directory-presentation";
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
function mount(terminal = false) {
  const reorder = vi.fn(async () => undefined);
  const restart = vi.fn(async () => undefined);
  const resources = new Map<string, NavigationWindowResource>([
    ["directory-index", resource("directory-index", { kind: "directory-index" }, { directories: [directory] })],
    [`directory-pins:${directory.key}`, resource(`directory-pins:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "pinned" },
      { rangeStart: 5, complete: false, nextCursor: terminal ? undefined : "next", entries: rows.map((row) => ({ row, placement: { kind: "root" }, orderKey: row.pinnedRank! })) })],
  ]);
  const navigation = { resources, directories: [directory], selectedDirectoryKeys: [directory.key], connected: true,
    invalidate: () => undefined, refresh: async () => undefined, loadMore: async () => undefined,
    rebaseline: async () => undefined, restart, setVisibleAnchor: () => undefined };
  const mounted = render(<Sidebar backends={[]} browseMode="directories" directories={[directory]} threads={rows}
    loading={false} selectedItemKey="codex:pin-5" selectedThreadDirectoryKeys={[directory.key]} pagedNavigation={navigation}
    onBrowseModeChange={() => undefined} onSelectThread={() => undefined} onCreateThread={async () => undefined}
    onOpenLaunchpad={async () => undefined} onSetThreadPin={async () => undefined} onReorderThreadPins={reorder} />);
  return { reorder, restart, unmount: mounted.unmount };
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

it("offers a way back from a terminal anchored pin range", () => {
  const f = mount(true);
  expect(screen.queryByRole("button", { name: "Load more pinned threads" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show pinned threads from beginning" }));
  expect(f.restart).toHaveBeenCalledWith(`directory-pins:${directory.key}`);
  f.unmount();
});

it("reveals an exact off-page pin without changing the retained page or duplicating continuation rows", () => {
  const selected = { ...rows[1]!, id: "pin-last", title: "Last pin", pinnedRank: "1000",
    ref: { backend: "codex" as const, threadId: "pin-last" } };
  const pinId = `directory-pins:${directory.key}`;
  const pins = resource(pinId, { kind: "directory", directoryKey: directory.key, roots: "pinned" }, {
    complete: false, nextCursor: "more", entries: rows.map((row) => ({ row, placement: { kind: "root" }, orderKey: row.pinnedRank! })),
  });
  const exact = resource("selected-context", { kind: "exact", identities: [selected.ref] }, {
    selectionDirectory: directory, entries: [{ row: selected, placement: { kind: "root" }, orderKey: selected.pinnedRank }],
  });
  const resources = new Map([[pinId, pins], ["selected-context", exact]]);
  const threadsByKey = new Map([...rows, selected].map((row) => [`codex:${row.id}`, row]));
  const present = () => buildPagedDirectoryPresentation({ directory, resources, threadsByKey }).directoryPinnedThreads.map((row) => row.id);
  expect(present()).toEqual(["pin-5", "pin-6", "pin-last"]);
  expect(pins.state.page?.entries).toHaveLength(2);
  expect(pins.state.page?.nextCursor).toBe("more");
  pins.state.page!.entries.push(exact.state.page!.entries[0]!);
  expect(present()).toEqual(["pin-5", "pin-6", "pin-last"]);
});


it("reveals a selected multi-project pin only in its owner-reported home", () => {
  const projects = [directory, ...["snap", "git"].map((name) => ({
    ...directory, key: `directory:/${name}`, path: `/${name}`, label: name,
  }))];
  const selected = { ...rows[0]!, linkedDirectories: projects.map((project) => ({
    id: project.path!, kind: "local" as const, path: project.path!, label: project.label,
  })) };
  const exact = resource("selected-context", { kind: "exact", identities: [selected.ref] }, {
    selectionDirectory: directory,
    entries: [{ row: selected, placement: { kind: "root" }, orderKey: selected.pinnedRank! }],
  });
  const resources = new Map(projects.map((project) => {
    const id = `directory-pins:${project.key}`;
    return [id, resource(id, { kind: "directory", directoryKey: project.key, roots: "pinned" }, {})] as const;
  }));
  resources.set("selected-context", exact);
  const threadsByKey = new Map([[`codex:${selected.id}`, selected]]);
  const visible = () => projects.map((project) => buildPagedDirectoryPresentation({
    directory: project, resources, threadsByKey,
  }).directoryPinnedThreads.map((row) => row.id));
  expect(visible()).toEqual([[selected.id], [], []]);
  // An exact row without authoritative placement must not infer a home from links.
  exact.state.page!.selectionDirectory = undefined;
  expect(visible()).toEqual([[], [], []]);
});
