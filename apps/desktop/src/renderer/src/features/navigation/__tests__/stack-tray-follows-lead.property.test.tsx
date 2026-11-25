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
import { stackGroupSelectionOrder } from "../../stacks/stack-presentation";

// A tray is drawn under the row that owns it, stack or not. Drawing a stack's
// tray above its lead row left it indented under whatever row came before,
// which read as that unrelated thread's sub-threads. Inside the tray, stack
// layers read downward from the lead in layer order, and keyboard range
// selection walks the rows in the order they are drawn.

afterEach(cleanup);

const STACK = "fixture-stack";

const directory: NavigationDirectoryRow = { key: "directory:/repo", label: "Repo", path: "/repo", kind: "directory",
  counts: { total: 2, pinned: 0, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0, unpinnedRootCount: 2,
  launchpadPresent: false };

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

/**
 * `before` is an unrelated root drawn just above the stack's lead; it is the
 * row a misplaced tray would appear to belong to.
 */
function layout(leadPosition: number, childPositions: readonly number[], plainChildren: number) {
  const count = Math.max(leadPosition, ...childPositions);
  const before = navRow("before", { title: "Before", updatedAt: 20, createdAt: 20 });
  const lead = navRow("lead", { title: "Lead", updatedAt: 10, createdAt: 10,
    ordinaryChildCount: childPositions.length + plainChildren, stackMemberships: [membership(leadPosition, count)] });
  const children = [
    ...childPositions.map((position) => navRow(`layer-${position}`, { title: `Layer ${position}`, parentThreadId: "lead",
      stackMemberships: [membership(position, count)] })),
    ...Array.from({ length: plainChildren }, (_, index) => navRow(`plain-${index}`, { title: `Plain ${index}`,
      parentThreadId: "lead" })),
  ];
  return { before, lead, children };
}

function mount(browseMode: "directories" | "inbox", rows: ReturnType<typeof layout>) {
  const { before, lead, children } = rows;
  const roots = [before, lead].map((row, index) => ({ row, placement: { kind: "root" as const }, orderKey: String(index) }));
  const childrenId = 'children:[null,"codex","lead"]';
  const resources = new Map<string, NavigationWindowResource>([
    ["directory-index", resource("directory-index", { kind: "directory-index" }, { directories: [directory] })],
    [`directory-pins:${directory.key}`, resource(`directory-pins:${directory.key}`,
      { kind: "directory", directoryKey: directory.key, roots: "pinned" }, {})],
    [`directory:${directory.key}`, resource(`directory:${directory.key}`,
      { kind: "directory", directoryKey: directory.key, roots: "unpinned" }, { entries: roots })],
    ["lens", resource("lens", { kind: "lens", lens: "inbox", roots: "unpinned" }, { entries: roots })],
    [childrenId, resource(childrenId,
      { kind: "children", parent: lead.ref, directoryKey: browseMode === "directories" ? directory.key : undefined }, {
        entries: children.map((row, index) => ({ row, placement: { kind: "child" as const, parent: lead.ref },
          orderKey: String(index) })),
      })],
  ]);
  const navigation = { resources, presentationReady: true, directories: [directory], selectedDirectoryKeys: [directory.key],
    connected: true, invalidate: () => undefined, refresh: async () => undefined, loadMore: async () => undefined,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined };
  return render(<Sidebar backends={[]} browseMode={browseMode} directories={[directory]}
    threads={[before, lead, ...children]} loading={false} selectedItemKey="codex:before"
    selectedThreadDirectoryKeys={[directory.key]} pagedNavigation={navigation} onBrowseModeChange={() => undefined}
    onSelectThread={() => undefined} onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined}
    onSetSubthreadsCollapsed={async () => undefined} />);
}

const stackLayout = fc.integer({ min: 2, max: 5 }).chain((count) => fc.record({
  leadPosition: fc.integer({ min: 1, max: count }),
  others: fc.shuffledSubarray(Array.from({ length: count }, (_, index) => index + 1), { minLength: 1 }),
  plainChildren: fc.integer({ min: 0, max: 2 }),
})).map(({ leadPosition, others, plainChildren }) => ({
  leadPosition,
  childPositions: others.filter((position) => position !== leadPosition),
  plainChildren,
})).filter(({ childPositions }) => childPositions.length > 0);

function rowKeys(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-hover-stable-row="thread"][data-thread-key]')]
    .map((row) => row.dataset.threadKey!);
}

it("draws a stack tray under its own lead row with layers in order, in every sidebar lens", () => {
  fc.assert(fc.property(stackLayout, fc.constantFrom("directories" as const, "inbox" as const), (shape, browseMode) => {
    const rows = layout(shape.leadPosition, shape.childPositions, shape.plainChildren);
    const view = mount(browseMode, rows);
    try {
      const tray = view.container.querySelector<HTMLElement>('[data-subthread-tray="codex:lead"]');
      expect(tray).not.toBeNull();
      expect(tray).toHaveClass("subthread-list--stack");
      const lead = view.container.querySelector<HTMLElement>('[data-hover-stable-row="thread"][data-thread-key="codex:lead"]')!;
      const beforeRow = view.container.querySelector<HTMLElement>('[data-hover-stable-row="thread"][data-thread-key="codex:before"]')!;
      // The tray sits after its own lead, never between an unrelated row and the lead.
      expect(lead.compareDocumentPosition(tray!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const keys = rowKeys(view.container);
      expect(keys.indexOf("codex:before")).toBe(keys.indexOf("codex:lead") - 1);
      expect(beforeRow.compareDocumentPosition(tray!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const drawnLayers = rowKeys(tray!).filter((key) => key.startsWith("codex:layer-"));
      const ascending = [...shape.childPositions].sort((a, b) => a - b).map((position) => `codex:layer-${position}`);
      expect(drawnLayers).toEqual(ascending);

      // Shift-click ranges walk the same order the rows are drawn in.
      const lensRows = [rows.lead, ...rows.children].map((row) => ({ ...row }));
      const selection = stackGroupSelectionOrder(lensRows[0]!, lensRows.slice(1))
        .map(({ id }) => `codex:${id}`);
      expect(selection).toEqual(keys.slice(keys.indexOf("codex:lead")));
    } finally {
      view.unmount();
    }
  }), { numRuns: 40 });
});
