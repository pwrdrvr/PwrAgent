import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { NavigationDirectoryRow, NavigationQueryEntry, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { createNavigationPageState, navigationIdentityKey } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { Sidebar } from "../Sidebar";

afterEach(cleanup);

const OWNER = "pwr_owner";
const target = { scope: "remote", instanceId: OWNER } as const;

/**
 * A remote viewer's tray, shaped like the group that reported "The owning
 * instance no longer places that child in this group": a pinned root whose
 * children were reordered on the owner, one of which has children of its own
 * (one on another provider).
 */
function mount(browseMode: "directories" | "recents") {
  const directory: NavigationDirectoryRow = {
    key: "workspace:/projects", label: "Workspaces", path: "/projects", kind: "workspace",
    counts: { total: 6, active: 0, unread: 0, review: 0 }, pinnedRootCount: 1, unpinnedRootCount: 0, launchpadPresent: false,
  };
  const row = (id: string, patch: Partial<NavigationRow> = {}): NavigationRow => {
    const source = patch.source ?? "codex";
    return {
      id, source, title: id, titleSource: "explicit", rowRevision: "r",
      ref: { backend: source, threadId: id, ownerInstanceId: OWNER },
      linkedDirectories: [{ id: "/projects/okc", kind: "local", label: "okc", path: "/projects/okc" }],
      inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
      queueCount: 0, queueState: "unknown",
      federation: { ref: buildFederatedThreadRef({ backend: source, instanceId: OWNER, threadId: id }),
        instanceLabel: "M2", capabilities: ["thread_grouping"] },
      ...patch,
    };
  };
  const root = row("root", { pinnedRank: "1", ordinaryChildCount: 3, createdAt: 1 });
  // The owner's saved order puts the oldest child first.
  const children = [
    row("runpod", { parentThreadId: "root", parentThreadBackend: "codex", createdAt: 10, ordinaryChildCount: 2 }),
    row("isolated", { parentThreadId: "root", parentThreadBackend: "codex", createdAt: 30 }),
    row("exact", { parentThreadId: "root", parentThreadBackend: "codex", createdAt: 20 }),
  ];
  const grandchildren = [
    row("decoder", { parentThreadId: "runpod", parentThreadBackend: "codex", createdAt: 40 }),
    row("counters", { source: "acp:grok", parentThreadId: "runpod", parentThreadBackend: "codex", createdAt: 25 }),
  ];
  const resources = new Map<string, NavigationWindowResource>();
  const add = (id: string, query: NavigationQueryRequest["query"], entries: NavigationQueryEntry[]) => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 10, query, federationTarget: target };
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
  for (const [owner, descendants] of [[root, children], [children[0]!, grandchildren]] as const) {
    add(`children:${navigationIdentityKey(owner.ref)}`, { kind: "children", parent: owner.ref },
      descendants.map((child, index) => ({ row: child, orderKey: String(index),
        placement: { kind: "child", parent: { backend: owner.source, threadId: owner.id, ownerInstanceId: OWNER } } })));
  }
  const navigation = {
    resources, presentationReady: true, directories: [directory], selectedDirectoryKeys: [directory.key], connected: true,
    invalidate: () => undefined, refresh: async () => undefined, loadMore: async () => undefined,
    rebaseline: async () => undefined, restart: async () => undefined, setVisibleAnchor: () => undefined,
  };
  render(<Sidebar backends={[]} browseMode={browseMode} directories={[directory]}
    threads={[root, ...children, ...grandchildren]} loading={false}
    selectedItemKey={`remote:${OWNER}:codex:root`} selectedThreadDirectoryKeys={[directory.key]}
    pagedNavigation={navigation} onUpdateSubthreadOrder={async () => undefined}
    onBrowseModeChange={() => undefined} onSelectThread={() => undefined}
    onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />);
  return [...document.querySelectorAll<HTMLElement>("[data-subthread-tray] .thread-row-shell")]
    .map((shell) => `${shell.querySelector(".thread-row button[aria-pressed]")?.getAttribute("aria-label")}@${shell.dataset.nestedDepth}`);
}

it.each(["directories", "recents"] as const)("shows a remote tray in the owner's saved order (%s)", (browseMode) => {
  // Newest-first would read isolated, exact, runpod: the order before the
  // operator's drag, so the drag appears to do nothing.
  expect(mount(browseMode)).toEqual([
    "runpod@1",
    "decoder@2",
    "counters@2",
    "isolated@1",
    "exact@1",
  ]);
});
