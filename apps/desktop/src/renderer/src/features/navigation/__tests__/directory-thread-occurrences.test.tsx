import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationDirectoryRow, NavigationQueryEntry, NavigationQueryRequest, NavigationRow, NavigationThreadSummary } from "@pwragent/shared";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { Sidebar } from "../Sidebar";
import { ThreadRow } from "../ThreadRow";
import { threadRowInstanceKey } from "../thread-row-instance";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

function fixture() {
  const directories: NavigationDirectoryRow[] = ["PwrSnap", "Workspaces"].map((label) => ({
    key: `directory:/${label}`, label, path: `/${label}`, kind: "directory",
    counts: { total: 2, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 1, unpinnedRootCount: 0, launchpadPresent: false,
  }));
  const row = (id: string, patch: Partial<NavigationRow> = {}): NavigationRow => ({
    id, source: "codex", title: id, titleSource: "explicit",
    ref: { backend: "codex", threadId: id }, rowRevision: "r",
    linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0,
    nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown", ...patch,
  });
  const parent = row("parent", {
    pinnedRank: "1", ordinaryChildCount: 1,
    linkedDirectories: [{ id: "/Workspaces", kind: "local", label: "Workspaces", path: "/Workspaces" }],
  });
  const child = row("research", {
    parentThreadId: "parent", pinnedRank: "2",
    linkedDirectories: [{ id: "/PwrSnap", kind: "worktree", label: "PwrSnap", path: "/PwrSnap", worktreePath: "/worktrees/PwrSnap" }],
  });
  const resources = new Map<string, NavigationWindowResource>();
  const add = (id: string, query: NavigationQueryRequest["query"], entries: NavigationQueryEntry[]) => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 10, query };
    resources.set(id, { id, loading: false, state: { ...createNavigationPageState(request), page: {
      protocol: 2, queryKey: id, generation: "g", ownerEpoch: "owner", countsRevision: "r",
      coverage: { state: "complete" }, counts: directories[0]!.counts, entries, complete: true,
    } } });
  };
  for (const [index, directory] of directories.entries()) {
    add(`directory-pins:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "pinned" },
      [{ row: index === 0 ? child : parent, placement: { kind: "root" }, orderKey: "0" }]);
    add(`directory:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "unpinned" }, []);
  }
  add("children:codex:parent", { kind: "children", parent: parent.ref },
    [{ row: child, placement: { kind: "child", parent: parent.ref }, orderKey: "0" }]);
  add("selected-context", { kind: "exact", identities: [child.ref], includeAncestry: true },
    [{ row: child, placement: { kind: "root" }, orderKey: "0" }]);
  const navigation = {
    resources, presentationReady: true, directories, selectedDirectoryKeys: [directories[0]!.key], connected: true,
    invalidate: () => undefined, refresh: async () => undefined, loadMore: async () => undefined,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined,
  };
  function Harness({ reveal = 0, selection }: { reveal?: number; selection?: string }) {
    const [selected, setSelected] = useState("codex:parent");
    return <Sidebar backends={[]} browseMode="directories" directories={directories}
      threads={[parent, child]} loading={false} selectedItemKey={selection ?? selected}
      selectedThreadDirectoryKeys={[directories[0]!.key]} pagedNavigation={navigation}
      revealSelectedThreadRequest={reveal}
      onBrowseModeChange={() => undefined} onSelectThread={(thread) => setSelected(`codex:${thread.id}`)}
      onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />;
  }
  return { Harness, child };
}

it.each([0, 1])("keeps the clicked thread occurrence in place (occurrence %s)", (index) => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const { Harness } = fixture();
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
  const rows = screen.getAllByRole("button", { name: /research/ });
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((button) => button.closest("[data-thread-row-key]")?.getAttribute("data-thread-row-key"))).size).toBe(2);
  expect(rows[0]!.closest(".subthread-list")).toBeNull();
  expect(rows[1]!.closest(".subthread-list")).not.toBeNull();
  scroll.mockClear();
  fireEvent.click(rows[index]!);
  expect(scroll).not.toHaveBeenCalled();
  // Clicking the already open thread is also a selection of this occurrence.
  fireEvent.click(rows[1 - index]!);
  expect(scroll).not.toHaveBeenCalled();
});

it("reveals one occurrence for a thread-only jump after a row click", () => {
  const scrolled: Element[] = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true, value: function (this: Element) { scrolled.push(this); },
  });
  const { Harness } = fixture();
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
  fireEvent.click(screen.getAllByRole("button", { name: /research/ })[1]!);
  scrolled.length = 0;
  view.rerender(<Harness reveal={1} />);
  const revealedRows = scrolled.filter((element) => element.closest("[data-thread-key]")?.getAttribute("data-thread-key") === "codex:research");
  expect(revealedRows.length).toBeGreaterThan(0);
  expect(new Set(revealedRows).size).toBe(1);
  expect(revealedRows[0]!.closest(".subthread-list")).toBeNull();
});

it("can reveal a previously clicked thread again after navigating away", () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const { Harness } = fixture();
  const view = render(<Harness />);
  fireEvent.click(screen.getAllByRole("button", { name: /research/ })[0]!);
  view.rerender(<Harness selection="codex:parent" />);
  scroll.mockClear();
  view.rerender(<Harness selection="codex:research" />);
  expect(scroll).toHaveBeenCalled();
});

it.each([0, 1, 2])("can reveal a specific project / parent occurrence: %s", (index) => {
  const scrolled: Element[] = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true, value: function (this: Element) { scrolled.push(this); },
  });
  const { child } = fixture();
  const instances = [
    { threadKey: "codex:research", directoryKey: "PwrSnap" },
    { threadKey: "codex:research", directoryKey: "Workspaces", parentThreadKey: "codex:parent" },
    { threadKey: "codex:research", directoryKey: "PwrSnap", parentThreadKey: "codex:other" },
  ];
  const target = threadRowInstanceKey(instances[index]!);
  render(<>{instances.map((instance) => <ThreadRow key={threadRowInstanceKey(instance)}
    thread={child} directoryKey={instance.directoryKey} parentThreadKey={instance.parentThreadKey}
    selectedThreadKey="codex:research" revealThreadRowKey={target}
    onSelectThread={() => undefined} onOpenContextMenu={() => undefined} />)}</>);
  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]!.closest("[data-thread-row-key]")).toHaveAttribute("data-thread-row-key", target);
});

it("keeps another project collapsed when selecting a child in its parent's tray", () => {
  const { Harness } = fixture();
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
  fireEvent.click(screen.getByRole("button", { name: "PwrSnap" }));
  expect(screen.getByRole("button", { name: "PwrSnap" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: /research/ }));
  expect(screen.getByRole("button", { name: "PwrSnap" })).toHaveAttribute("aria-expanded", "false");
});

it.each([undefined, "peer-a", "peer-b"])("scopes occurrence reveals to their federation owner: %s", (ownerInstanceId) => {
  const scrolled: Element[] = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true, value: function (this: Element) { scrolled.push(this); },
  });
  const { child } = fixture();
  const threads: NavigationThreadSummary[] = [undefined, "peer-a", "peer-b"].map((owner) => ({
    ...child,
    ...(owner ? { federation: {
      instanceLabel: owner,
      peerStatus: "connected" as const,
      ref: { backend: "codex" as const, threadId: child.id, target: { scope: "remote" as const, instanceId: owner } },
    } } : {}),
  }));
  const selectedThread = threads.find((thread) =>
    (thread.federation?.ref.target.scope === "remote" ? thread.federation.ref.target.instanceId : undefined) === ownerInstanceId)!;
  const selectedThreadKey = threadSummaryIdentityKey(selectedThread);
  // All three owners use the same thread ID, project, and parent ID. Only
  // their owner-scoped identities distinguish the displayed occurrences.
  const rows = threads.flatMap((thread) => [undefined, "parent"].map((parentId) => ({
    thread,
    instance: {
      threadKey: threadSummaryIdentityKey(thread),
      directoryKey: "directory:/shared-project",
      parentThreadKey: parentId ? threadSummaryIdentityKey({ ...thread, id: parentId,
        ...(thread.federation ? { federation: { ...thread.federation, ref: { ...thread.federation.ref, threadId: parentId } } } : {}),
      }) : undefined,
    },
  })));
  const targetRow = rows.find(({ instance }) => instance.threadKey === selectedThreadKey && instance.parentThreadKey)!;
  const target = threadRowInstanceKey(targetRow.instance);
  expect(new Set(rows.map(({ instance }) => threadRowInstanceKey(instance))).size).toBe(6);
  render(<>{rows.map(({ thread, instance }) => <ThreadRow key={threadRowInstanceKey(instance)}
    thread={thread} directoryKey={instance.directoryKey} parentThreadKey={instance.parentThreadKey}
    selectedThreadKey={selectedThreadKey} revealThreadRowKey={target}
    onSelectThread={() => undefined} onOpenContextMenu={() => undefined} />)}</>);
  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]!.closest("[data-thread-row-key]")).toHaveAttribute("data-thread-row-key", target);
});
