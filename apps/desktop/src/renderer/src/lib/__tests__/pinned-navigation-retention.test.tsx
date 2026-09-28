import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AgentEvent, FederationTarget, NavigationIdentity, NavigationRow } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";
import { useNavigationDirectoryDisclosure } from "../useNavigationDirectoryDisclosure";
import { navigationThreadSelectionKey } from "../navigation-query-state";
import { Sidebar } from "../../features/navigation/Sidebar";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";

it.each(["local", "remote", "mounted"] as const)("retains expanded pins after creation, deselection and refresh (%s)", async (ownership) => {
  const home = { key: "directory:/fixture/project", kind: "directory" as const, label: "Fixture project", path: "/fixture/project" };
  const target: FederationTarget | undefined = ownership === "remote" ? { scope: "remote", instanceId: "peer" } : undefined;
  const row = (index: number): NavigationRow => ({
    id: `pin-${index}`, source: "codex", title: `Fixture pin ${index}`, titleSource: "explicit",
    ref: { backend: "codex", threadId: `pin-${index}`, ...(ownership === "local" ? {} : { ownerInstanceId: "peer" }) },
    rowRevision: "fixture", pinnedRank: String((index + 1) * 1024),
    linkedDirectories: [{ id: home.path, path: home.path, label: home.label, kind: "local" }],
    inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
    ...(ownership === "local" ? {} : { federation: {
      ref: { backend: "codex" as const, threadId: `pin-${index}`, target: { scope: "remote" as const, instanceId: "peer" } },
      instanceLabel: "Fixture peer", peerStatus: "connected" as const,
    } }),
  });
  let threads = Array.from({ length: 20 }, (_, index) => row(index));
  const listeners = new Set<(event: AgentEvent) => void>();
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    // Mounted rows get their pin rank from the viewer; their owner has no pins.
    const population = ownership === "mounted" && request.federationTarget?.scope === "remote"
      ? threads.map((thread) => ({ ...thread, pinnedRank: undefined })) : threads;
    return { ...navigationQueryFixture(request, { directories: [home], threads: population }),
      ...(request.query.kind === "exact" ? { selectionDirectory: { ...home,
        counts: { total: threads.length, active: 0, unread: 0, review: 0 },
        pinnedRootCount: threads.length, unpinnedRootCount: 0, launchpadPresent: false } } : {}) };
  });
  const api: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: vi.fn(async () => undefined),
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  let navigation!: ReturnType<typeof useBoundedNavigationWindow>;
  function Window({ selected, mode = "directories" }: { selected: NavigationIdentity; mode?: "directories" | "inbox" }) {
    const disclosure = useNavigationDirectoryDisclosure();
    navigation = useBoundedNavigationWindow({ desktopApi: { ...api }, enabled: true, visible: true,
      browseMode: mode, target, attentionView: { id: "fixture-window", promoteOnTurnEnd: true }, selectedRef: selected,
      expandedByKey: disclosure.expandedByKey, unpinnedExpandedByKey: disclosure.unpinnedExpandedByKey });
    return <Sidebar backends={[]} browseMode={mode} directories={navigation.directories} threads={threads}
      directoryDisclosure={disclosure} pagedNavigation={navigation} selectedItemKey={navigationThreadSelectionKey(selected)}
      selectedThreadDirectoryKeys={navigation.selectedDirectoryKeys} loading={false}
      onBrowseModeChange={() => undefined} onSelectThread={() => undefined}
      onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />;
  }
  const pinsId = `directory-pins:${home.key}`;
  const pinReads = () => read.mock.calls.filter(([request]) => request.query.kind === "directory" && request.query.roots === "pinned");
  const pinIds = () => navigation.resources.get(pinsId)?.state.page?.entries.map(({ row }) => row.id);
  const view = render(<Window selected={threads[0]!.ref} />);
  try {
    await waitFor(() => expect(pinIds()).toHaveLength(10));
    fireEvent.click(view.getByRole("button", { name: "Load more pinned threads" }));
    await waitFor(() => expect(pinIds()).toHaveLength(20));
    expect(view.queryByRole("button", { name: "Load more pinned threads" })).toBeNull();

    const created = row(20);
    threads = [...threads, created];
    view.rerender(<Window selected={created.ref} />);
    await waitFor(() => expect(view.getByRole("button", { name: /Fixture pin 20, pinned/ })).toBeTruthy());
    const beforeRefresh = pinReads().length;
    act(() => {
      const event: AgentEvent = { backend: "codex", federationTarget: target,
        notification: ownership === "mounted"
          ? { method: "navigation/remoteThreadPins/changed", params: { threadId: created.id, instanceId: "peer", pinned: true } }
          : { method: "thread/pin/added", params: { threadId: created.id, pinnedRank: created.pinnedRank! } } };
      for (const listener of listeners) listener(event);
    });
    await waitFor(() => expect(pinReads().length).toBeGreaterThan(beforeRefresh));
    await waitFor(() => expect(navigation.resources.get(pinsId)?.loading).toBe(false));
    view.rerender(<Window selected={threads[0]!.ref} />);
    await waitFor(() => expect(navigation.presentationReady).toBe(true));
    expect(view.queryByRole("button", { name: /Fixture pin 20, pinned/ })).toBeTruthy();
    expect(pinIds()).toEqual(threads.map((thread) => thread.id));
    expect(view.queryByRole("button", { name: "Load more pinned threads" })).toBeNull();

    // Selection and bridge-wrapper identity changes do not redispatch the
    // unchanged pinned collection. Necessary owner refreshes still happen.
    const settledReads = pinReads().length;
    for (let index = 0; index < 3; index++) view.rerender(<Window selected={threads[index]!.ref} />);
    await act(async () => {});
    expect(pinReads()).toHaveLength(settledReads);
    await act(() => navigation.refresh());
    expect(pinReads().length).toBeGreaterThan(settledReads);
    expect(pinIds()).toEqual(threads.map((thread) => thread.id));

    view.rerender(<Window selected={threads[0]!.ref} mode="inbox" />);
    await waitFor(() => expect(navigation.presentationReady).toBe(true));
    threads = [...threads, row(21)];
    view.rerender(<Window selected={threads[0]!.ref} />);
    await waitFor(() => expect(navigation.presentationReady).toBe(true));
    expect(pinIds()).toEqual(threads.map((thread) => thread.id));
    expect(view.queryByRole("button", { name: "Load more pinned threads" })).toBeNull();

    // A real owner removal still wins over remembered expansion demand.
    threads = threads.filter((thread) => thread.id !== created.id);
    act(() => navigation.invalidate());
    await act(() => navigation.refresh());
    expect(pinIds()).toEqual(threads.map((thread) => thread.id));
    expect(view.queryByRole("button", { name: /Fixture pin 20, pinned/ })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: /Fixture project/, expanded: true }));
    await waitFor(() => expect(navigation.resources.has(pinsId)).toBe(false));
    const collapsedReads = pinReads().length;
    await act(() => navigation.refresh());
    expect(pinReads()).toHaveLength(collapsedReads);
    expect(view.queryByRole("button", { name: /Fixture pin 21, pinned/ })).toBeNull();
  } finally { view.unmount(); }
});
