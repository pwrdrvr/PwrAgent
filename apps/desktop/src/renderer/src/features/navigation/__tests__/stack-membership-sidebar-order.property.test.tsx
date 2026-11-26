import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import type {
  NavigationDirectoryRow,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationRow,
} from "@pwragent/shared/contracts/navigation";
import type { CompactStackMembership } from "@pwragent/shared/stacks/stack-status";
import { Sidebar } from "../Sidebar";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";

// PR stacks show in the thread list only through each row's M/N chip and its
// hover. Stack membership never moves, reorders or restyles a sub-thread tray:
// a stack-aware tray was drawn above its lead row, where it read as the
// sub-threads of whichever unrelated row came before. The oracle is the same
// sidebar rendered with every stack membership stripped.

afterEach(cleanup);

const STACK = "fixture-stack";

const directory: NavigationDirectoryRow = { key: "directory:/repo", label: "Repo", path: "/repo", kind: "directory",
  counts: { total: 2, pinned: 0, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0, unpinnedRootCount: 2,
  launchpadPresent: false };
const pinnedDirectory: NavigationDirectoryRow = { ...directory, counts: { ...directory.counts, pinned: 2 },
  pinnedRootCount: 2, unpinnedRootCount: 0 };

function membership(position: number, count: number): CompactStackMembership {
  return { key: STACK, name: "fixture/stack", inferred: true, position, count, health: "in_sync" };
}

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

type Shape = {
  leadPosition: number;
  childPositions: number[];
  plainChildren: number;
  order: number[];
  /** Pinned roots render through their own path in both lenses. */
  pinned: boolean;
};

/**
 * `before` is an unrelated root drawn just above the stack's lead; it is the
 * row a misplaced tray would appear to belong to.
 */
function layout(shape: Shape, withStacks: boolean) {
  const count = Math.max(shape.leadPosition, ...shape.childPositions);
  const stacked = (position: number) => withStacks ? { stackMemberships: [membership(position, count)] } : {};
  const before = navRow("before", { title: "Before", updatedAt: 20, createdAt: 20,
    ...(shape.pinned ? { pinnedRank: "1" } : {}) });
  const lead = navRow("lead", { title: "Lead", updatedAt: 10, createdAt: 10, ...(shape.pinned ? { pinnedRank: "2" } : {}),
    ordinaryChildCount: shape.childPositions.length + shape.plainChildren, ...stacked(shape.leadPosition) });
  const unordered = [
    ...shape.childPositions.map((position) => navRow(`layer-${position}`, { title: `Layer ${position}`,
      parentThreadId: "lead", ...stacked(position) })),
    ...Array.from({ length: shape.plainChildren }, (_, index) => navRow(`plain-${index}`, { title: `Plain ${index}`,
      parentThreadId: "lead" })),
  ];
  const children = shape.order.map((index) => unordered[index]!);
  return { before, lead, children, pinned: shape.pinned };
}

function mount(browseMode: "directories" | "inbox", rows: ReturnType<typeof layout>) {
  const { before, lead, children, pinned } = rows;
  const roots = [before, lead].map((row, index) => ({ row, placement: { kind: "root" as const }, orderKey: String(index) }));
  const pinnedRoots = pinned ? roots : [];
  const unpinnedRoots = pinned ? [] : roots;
  const owningDirectory = pinned ? pinnedDirectory : directory;
  const childrenId = 'children:[null,"codex","lead"]';
  const resources = new Map<string, NavigationWindowResource>([
    ["directory-index", resource("directory-index", { kind: "directory-index" }, { directories: [owningDirectory] })],
    [`directory-pins:${directory.key}`, resource(`directory-pins:${directory.key}`,
      { kind: "directory", directoryKey: directory.key, roots: "pinned" }, { entries: pinnedRoots })],
    [`directory:${directory.key}`, resource(`directory:${directory.key}`,
      { kind: "directory", directoryKey: directory.key, roots: "unpinned" }, { entries: unpinnedRoots })],
    ["lens-pins", resource("lens-pins", { kind: "lens", lens: "inbox", roots: "pinned" }, { entries: pinnedRoots })],
    ["lens", resource("lens", { kind: "lens", lens: "inbox", roots: "unpinned" }, { entries: unpinnedRoots })],
    [childrenId, resource(childrenId,
      { kind: "children", parent: lead.ref, directoryKey: browseMode === "directories" ? directory.key : undefined }, {
        entries: children.map((row, index) => ({ row, placement: { kind: "child" as const, parent: lead.ref },
          orderKey: String(index) })),
      })],
  ]);
  const navigation = { resources, presentationReady: true, directories: [owningDirectory], selectedDirectoryKeys: [directory.key],
    connected: true, invalidate: () => undefined, refresh: async () => undefined, loadMore: async () => undefined,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined };
  return render(<Sidebar backends={[]} browseMode={browseMode} directories={[owningDirectory]}
    threads={[before, lead, ...children]} loading={false} selectedItemKey="codex:before"
    selectedThreadDirectoryKeys={[directory.key]} pagedNavigation={navigation} onBrowseModeChange={() => undefined}
    onSelectThread={() => undefined} onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined}
    onSetSubthreadsCollapsed={async () => undefined} />);
}

const shapes: fc.Arbitrary<Shape> = fc.integer({ min: 2, max: 5 }).chain((count) => fc.record({
  leadPosition: fc.integer({ min: 1, max: count }),
  others: fc.shuffledSubarray(Array.from({ length: count }, (_, index) => index + 1), { minLength: 1 }),
  plainChildren: fc.integer({ min: 0, max: 2 }),
})).map(({ leadPosition, others, plainChildren }) => ({
  leadPosition,
  childPositions: others.filter((position) => position !== leadPosition),
  plainChildren,
})).filter(({ childPositions }) => childPositions.length > 0).chain((shape) => {
  const size = shape.childPositions.length + shape.plainChildren;
  const indices = Array.from({ length: size }, (_, index) => index);
  return fc.record({
    order: fc.shuffledSubarray(indices, { minLength: size, maxLength: size }),
    pinned: fc.boolean(),
  }).map(({ order, pinned }) => ({ ...shape, order, pinned }));
});

/** Row and tray order plus tray markup, without the rows' own chips. */
function structure(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-hover-stable-row="thread"][data-thread-key], [data-subthread-tray]')]
    .map((element) => element.dataset.subthreadTray
      ? `tray:${element.dataset.subthreadTray}:${element.className}`
      : `row:${element.dataset.threadKey}:${element.className}`);
}

it("draws stacked sub-threads exactly as it draws plain ones, in every sidebar lens", () => {
  fc.assert(fc.property(shapes, fc.constantFrom("directories" as const, "inbox" as const), (shape, browseMode) => {
    const plain = mount(browseMode, layout(shape, false));
    const expected = structure(plain.container);
    plain.unmount();
    const stacked = mount(browseMode, layout(shape, true));
    try {
      const drawn = structure(stacked.container);
      expect(drawn).toEqual(expected);
      // The oracle itself: the tray follows its own lead, children in loaded order.
      const keys = drawn.map((entry) => entry.split(":").slice(0, 3).join(":"));
      expect(keys).toEqual([
        "row:codex:before",
        "row:codex:lead",
        "tray:codex:lead",
        ...layout(shape, true).children.map(({ id }) => `row:codex:${id}`),
      ]);
    } finally {
      stacked.unmount();
    }
  }), { numRuns: 12 });
});
