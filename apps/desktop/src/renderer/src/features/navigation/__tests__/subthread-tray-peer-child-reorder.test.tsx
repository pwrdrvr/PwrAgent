import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  NavigationDirectoryRow,
  NavigationQueryEntry,
  NavigationQueryRequest,
  NavigationRow,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { createNavigationPageState, navigationIdentityKey } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { Sidebar } from "../Sidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LOCAL = "pwr_local";
const PEER = "pwr_peer";
const POINTER_ID = 41;

/**
 * A local parent whose tray holds a local child and a child that a peer
 * owns: started on the peer from this machine's tray, so its link names
 * this machine as the parent's owner. The viewer's child page lists both.
 */
function mount(browseMode: "directories" | "recents") {
  const directory: NavigationDirectoryRow = {
    key: "workspace:/projects", label: "Workspaces", path: "/projects", kind: "workspace",
    counts: { total: 3, active: 0, unread: 0, review: 0 }, pinnedRootCount: 1, unpinnedRootCount: 0, launchpadPresent: false,
  };
  const row = (id: string, patch: Partial<NavigationRow> = {}): NavigationRow => ({
    id, source: "codex", title: id, titleSource: "explicit", rowRevision: "r",
    ref: { backend: "codex", threadId: id },
    linkedDirectories: [{ id: "/projects/app", kind: "local", label: "app", path: "/projects/app" }],
    inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
    queueCount: 0, queueState: "unknown",
    ...patch,
  });
  const root = row("root", { title: "Local parent", pinnedRank: "1", ordinaryChildCount: 2, createdAt: 1 });
  const localChild = row("local-child", { title: "Local child", parentThreadId: "root", parentThreadBackend: "codex", createdAt: 10 });
  const peerChild = row("peer-child", {
    title: "Peer child", parentThreadId: "root", parentThreadBackend: "codex", parentThreadInstanceId: LOCAL, createdAt: 20,
    ref: { backend: "codex", threadId: "peer-child", ownerInstanceId: PEER },
    federation: { ref: buildFederatedThreadRef({ backend: "codex", instanceId: PEER, threadId: "peer-child" }),
      instanceLabel: "Win PC / dev", capabilities: ["thread_grouping"] },
  });
  const resources = new Map<string, NavigationWindowResource>();
  const add = (id: string, query: NavigationQueryRequest["query"], entries: NavigationQueryEntry[]) => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 10, query };
    resources.set(id, { id, loading: false, state: { ...createNavigationPageState(request), page: {
      protocol: 2, queryKey: id, generation: "g", ownerEpoch: "owner", countsRevision: "r",
      coverage: { state: "complete" }, counts: directory.counts, entries, complete: true,
    } } });
  };
  const rootEntry: NavigationQueryEntry = { row: root, placement: { kind: "root" }, orderKey: "0" };
  if (browseMode === "directories") {
    add(`directory-pins:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "pinned" }, [rootEntry]);
  } else {
    add("lens-pins", { kind: "lens", lens: "recents", roots: "pinned" }, [rootEntry]);
  }
  // The owner's saved order: the local child first.
  add(`children:${navigationIdentityKey(root.ref)}`, { kind: "children", parent: root.ref },
    [localChild, peerChild].map((child, index) => ({ row: child, orderKey: String(index),
      placement: { kind: "child", parent: { backend: "codex", threadId: "root" } } })));
  const navigation = {
    resources, presentationReady: true, directories: [directory], selectedDirectoryKeys: [directory.key], connected: true,
    invalidate: () => undefined, refresh: async () => undefined, loadMore: async () => undefined,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined,
  };
  const onUpdateSubthreadOrder = vi.fn(async (_parent: NavigationThreadSummary, _move: unknown) => undefined);
  render(<Sidebar backends={[]} browseMode={browseMode} directories={[directory]}
    threads={[root, localChild, peerChild]} loading={false}
    selectedItemKey="codex:root" selectedThreadDirectoryKeys={[directory.key]}
    pagedNavigation={navigation} onUpdateSubthreadOrder={onUpdateSubthreadOrder}
    onBrowseModeChange={() => undefined} onSelectThread={() => undefined}
    onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />);
  return { onUpdateSubthreadOrder };
}

function rect(element: Element, top: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    bottom: top + height, height, left: 0, right: 300, top, width: 300, x: 0, y: top, toJSON: () => ({}),
  });
}

function shell(title: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>("[data-subthread-tray] .thread-row-shell")]
    .find((element) => element.querySelector(`.thread-row button[aria-pressed][aria-label^="${title}"]`));
  if (!row) throw new Error(`No tray row for ${title}`);
  return row;
}

it.each(["directories", "recents"] as const)(
  "reorders a peer-owned child among a local parent's children (%s)",
  async (browseMode) => {
    const { onUpdateSubthreadOrder } = mount(browseMode);
    const tray = document.querySelector<HTMLElement>("[data-subthread-tray]")!;
    expect(shell("Peer child")).toHaveClass("is-draggable");
    rect(tray, 0, 80);
    rect(shell("Local child"), 0, 40);
    rect(shell("Peer child"), 40, 40);

    fireEvent.pointerDown(shell("Peer child"), { button: 0, clientX: 50, clientY: 60, pointerId: POINTER_ID });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 50, clientY: 5, pointerId: POINTER_ID });
    await waitFor(() => expect(shell("Local child")).toHaveClass("is-drop-target-before"));
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 5, pointerId: POINTER_ID });
    });

    expect(onUpdateSubthreadOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: "root" }),
      { threadId: "peer-child", anchorThreadId: "local-child", placement: "before" },
    );
  },
);
