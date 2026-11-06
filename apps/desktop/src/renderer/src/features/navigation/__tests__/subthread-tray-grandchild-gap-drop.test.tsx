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
const POINTER_ID = 43;

type Lens = "directories" | "recents";
type Grandchild = "local-grand" | "peer-grand";

/**
 * A local tray owner with two direct children, Alpha and Bravo. Alpha holds
 * two grandchildren: one this machine owns, and one a peer owns whose link
 * names this machine as Alpha's owner. The tray lists them flat:
 * Alpha, Local grand, Peer grand, Bravo.
 */
function mount(browseMode: Lens, saved: boolean | Promise<boolean> = true, grandparent: "alpha" | "bravo" = "alpha") {
  const directory: NavigationDirectoryRow = {
    key: "workspace:/projects", label: "Workspaces", path: "/projects", kind: "workspace",
    counts: { total: 5, active: 0, unread: 0, review: 0 }, pinnedRootCount: 1, unpinnedRootCount: 0, launchpadPresent: false,
  };
  const row = (id: string, patch: Partial<NavigationRow> = {}): NavigationRow => ({
    id, source: "codex", title: id, titleSource: "explicit", rowRevision: "r",
    ref: { backend: "codex", threadId: id },
    linkedDirectories: [{ id: "/projects/app", kind: "local", label: "app", path: "/projects/app" }],
    inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
    queueCount: 0, queueState: "unknown",
    ...patch,
  });
  const root = row("root", { title: "Tray owner", pinnedRank: "1", ordinaryChildCount: 2, createdAt: 1 });
  const alpha = row("alpha", { title: "Alpha", parentThreadId: "root", parentThreadBackend: "codex",
    ordinaryChildCount: grandparent === "alpha" ? 2 : 0, createdAt: 10 });
  const bravo = row("bravo", { title: "Bravo", parentThreadId: "root", parentThreadBackend: "codex",
    ordinaryChildCount: grandparent === "bravo" ? 2 : 0, createdAt: 20 });
  const localGrand = row("local-grand", { title: "Local grand", parentThreadId: grandparent, parentThreadBackend: "codex",
    createdAt: 30 });
  const peerGrand = row("peer-grand", {
    title: "Peer grand", parentThreadId: grandparent, parentThreadBackend: "codex", parentThreadInstanceId: LOCAL, createdAt: 40,
    ref: { backend: "codex", threadId: "peer-grand", ownerInstanceId: PEER },
    federation: { ref: buildFederatedThreadRef({ backend: "codex", instanceId: PEER, threadId: "peer-grand" }),
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
  const childrenOf = { root: [alpha, bravo], [grandparent]: [localGrand, peerGrand] };
  for (const owner of [root, grandparent === "alpha" ? alpha : bravo]) {
    add(`children:${navigationIdentityKey(owner.ref)}`, { kind: "children", parent: owner.ref,
      ...(browseMode === "directories" ? { directoryKey: directory.key } : {}) },
      childrenOf[owner.id as keyof typeof childrenOf].map((child, index) => ({ row: child, orderKey: String(index),
        placement: { kind: "child", parent: { backend: "codex", threadId: owner.id } } })));
  }
  const navigation = {
    resources, presentationReady: true, directories: [directory], selectedDirectoryKeys: [directory.key], connected: true,
    invalidate: () => undefined, refresh: async () => undefined, loadMore: async () => undefined,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined,
  };
  const onUpdateSubthreadOrder = vi.fn(async (_parent: NavigationThreadSummary, _move: unknown) => undefined);
  const onSetThreadParent = vi.fn((..._args: unknown[]) => Promise.resolve(saved));
  render(<Sidebar backends={[]} browseMode={browseMode} directories={[directory]}
    threads={[root, alpha, bravo, localGrand, peerGrand]} loading={false}
    selectedItemKey="codex:root" selectedThreadDirectoryKeys={[directory.key]}
    pagedNavigation={navigation} onUpdateSubthreadOrder={onUpdateSubthreadOrder} onSetThreadParent={onSetThreadParent}
    onBrowseModeChange={() => undefined} onSelectThread={() => undefined}
    onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />);
  layOut(grandparent === "alpha" ? TOPS : LAST_TOPS);
  return { onUpdateSubthreadOrder, onSetThreadParent };
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

const TITLES: Record<Grandchild, string> = { "local-grand": "Local grand", "peer-grand": "Peer grand" };
type Tops = Record<string, number>;
const TOPS: Tops = { "Alpha": 0, "Local grand": 40, "Peer grand": 80, "Bravo": 120 };
/** The grandchildren under Bravo, so they end the tray. */
const LAST_TOPS: Tops = { "Alpha": 0, "Bravo": 40, "Local grand": 80, "Peer grand": 120 };
let tops: Tops = TOPS;

/** Rows are 40px tall; the tray spans 0 to 160. */
function layOut(layout: Tops): void {
  tops = layout;
  rect(document.querySelector("[data-subthread-tray]")!, 0, 160);
  for (const [title, top] of Object.entries(layout)) rect(shell(title), top, 40);
}

async function drag(grandchild: Grandchild, toY: number): Promise<void> {
  const source = shell(TITLES[grandchild]);
  const fromY = tops[TITLES[grandchild]]! + 20;
  expect(source).toHaveAttribute("data-nested-depth", "2");
  expect(source).toHaveClass("is-draggable");
  fireEvent.pointerDown(source, { button: 0, clientX: 50, clientY: fromY, pointerId: POINTER_ID });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 50, clientY: toY, pointerId: POINTER_ID });
}

async function drop(toY: number): Promise<void> {
  await act(async () => {
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: toY, pointerId: POINTER_ID });
  });
}

it.each([
  ["directories", "local-grand"],
  ["directories", "peer-grand"],
  ["recents", "local-grand"],
  ["recents", "peer-grand"],
] as const)(
  "moves a grandchild into the gap between direct children in one drop (%s, %s)",
  async (browseMode, grandchild) => {
    let resolveSaved: (saved: boolean) => void = () => undefined;
    const { onSetThreadParent, onUpdateSubthreadOrder } = mount(browseMode,
      new Promise<boolean>((resolve) => { resolveSaved = resolve; }));

    // Bravo's top third: the gap above it, not its nest band.
    await drag(grandchild, 122);
    await waitFor(() => expect(shell("Bravo")).toHaveClass("is-drop-target-before"));
    expect(shell("Bravo")).not.toHaveClass("is-drop-target-inside");
    await drop(122);

    expect(onSetThreadParent).toHaveBeenCalledWith(
      expect.objectContaining({ id: grandchild }), "root", "codex", true);
    // The move waits for the owner to accept the new parent.
    expect(onUpdateSubthreadOrder).not.toHaveBeenCalled();
    await act(async () => resolveSaved(true));
    await waitFor(() => expect(onUpdateSubthreadOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: "root" }),
      { threadId: grandchild, anchorThreadId: "bravo", placement: "before" },
    ));
  },
);

it.each([
  ["directories", 2, "Alpha", "is-drop-target-before", "alpha", "before"],
  ["recents", 2, "Alpha", "is-drop-target-before", "alpha", "before"],
  ["directories", 165, "Bravo", "is-drop-target-after", "bravo", "after"],
  ["recents", 165, "Bravo", "is-drop-target-after", "bravo", "after"],
] as const)(
  "moves a grandchild to the tray's edge gaps (%s, y=%d)",
  async (browseMode, y, lineTitle, lineClass, anchorThreadId, placement) => {
    const { onSetThreadParent, onUpdateSubthreadOrder } = mount(browseMode);

    await drag("local-grand", y);
    await waitFor(() => expect(shell(lineTitle)).toHaveClass(lineClass));
    await drop(y);

    expect(onSetThreadParent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "local-grand" }), "root", "codex", true);
    await waitFor(() => expect(onUpdateSubthreadOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: "root" }),
      { threadId: "local-grand", anchorThreadId, placement },
    ));
  },
);

it.each(["directories", "recents"] as const)(
  "sends no move when the owner refuses the new parent (%s)",
  async (browseMode) => {
    const { onSetThreadParent, onUpdateSubthreadOrder } = mount(browseMode, false);

    await drag("peer-grand", 122);
    await waitFor(() => expect(shell("Bravo")).toHaveClass("is-drop-target-before"));
    await drop(122);

    await waitFor(() => expect(onSetThreadParent).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(onUpdateSubthreadOrder).not.toHaveBeenCalled();
  },
);

it.each(["directories", "recents"] as const)(
  "still nests a grandchild on a direct child's middle third (%s)",
  async (browseMode) => {
    const { onSetThreadParent, onUpdateSubthreadOrder } = mount(browseMode);

    await drag("local-grand", 140);
    await waitFor(() => expect(shell("Bravo")).toHaveClass("is-drop-target-inside"));
    await drop(140);

    expect(onSetThreadParent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "local-grand" }), "bravo", "codex", true);
    await act(async () => undefined);
    expect(onUpdateSubthreadOrder).not.toHaveBeenCalled();
  },
);

it.each(["directories", "recents"] as const)(
  "shows no line while a grandchild sits over its own row (%s)",
  async (browseMode) => {
    const { onSetThreadParent, onUpdateSubthreadOrder } = mount(browseMode);

    await drag("local-grand", 50);
    await act(async () => undefined);
    expect(document.querySelector("[class*='is-drop-target-']")).toBeNull();
    await drop(50);

    expect(onSetThreadParent).not.toHaveBeenCalled();
    expect(onUpdateSubthreadOrder).not.toHaveBeenCalled();
  },
);

it.each(["directories", "recents"] as const)(
  "draws the end line after the last row that stays when the tray's last row moves up (%s)",
  async (browseMode) => {
    const { onUpdateSubthreadOrder } = mount(browseMode, true, "bravo");

    await drag("peer-grand", 165);
    await waitFor(() => expect(shell("Local grand")).toHaveClass("is-drop-target-after"));
    expect(shell("Peer grand")).not.toHaveClass("is-drop-target-after");
    await drop(165);

    await waitFor(() => expect(onUpdateSubthreadOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: "root" }),
      { threadId: "peer-grand", anchorThreadId: "bravo", placement: "after" },
    ));
  },
);
