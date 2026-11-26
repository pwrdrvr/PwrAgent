import { act, fireEvent, render, waitFor } from "../../test/phase-probes";
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { NavigationIdentity, NavigationRow } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";
import { useNavigationDirectoryDisclosure } from "../useNavigationDirectoryDisclosure";
import { navigationThreadSelectionKey } from "../navigation-query-state";
import { Sidebar } from "../../features/navigation/Sidebar";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import { settleFakeTimers } from "../../test/settle-fake-timers";

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
    vi.useFakeTimers();
    try {
      act(() => {
        const event: AgentEvent = { backend: "codex", federationTarget: target,
          notification: ownership === "mounted"
            ? { method: "navigation/remoteThreadPins/changed", params: { threadId: created.id, instanceId: "peer", pinned: true } }
            : { method: "thread/pin/added", params: { threadId: created.id, pinnedRank: created.pinnedRank! } } };
        for (const listener of listeners) listener(event);
      });
      await settleFakeTimers(250);
    } finally {
      vi.useRealTimers();
    }
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
    // Returning to Directories restores the retained pin page as stale and
    // re-reads it. A stale page already counts as presentable, and the
    // re-read can queue behind other reads, so wait for the re-read itself.
    await waitFor(() => expect(navigation.resources.get(pinsId)).toMatchObject({ loading: false, state: { stale: false } }));
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

it.each(["codex", "claude", "acp:grok", "acp:antigravity"] as const)(
  "keeps a newly pinned thread visible above Directory threads instead of folding it under Load more pinned threads (%s)",
  async (backend) => {
    const { buildPrependPinRank, KEEP_AT_TOP_RANK_BOUNDARY } = await import("@pwragent/shared/thread-pins");
    const home = { key: "directory:/fixture/project", kind: "directory" as const, label: "Fixture project", path: "/fixture/project" };
    const keptRank = String(KEEP_AT_TOP_RANK_BOUNDARY - 1024);
    const makeRow = (id: string, title: string, pinnedRank?: string): NavigationRow => ({
      id, source: backend, title, titleSource: "explicit",
      ref: { backend, threadId: id }, rowRevision: pinnedRank ?? "unpinned",
      ...(pinnedRank ? { pinnedRank } : {}),
      linkedDirectories: [{ id: home.path, path: home.path, label: home.label, kind: "local" }],
      inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
    });
    let threads: NavigationRow[] = [
      makeRow("kept-0", "Kept pin 0", keptRank),
      ...Array.from({ length: 14 }, (_, index) => makeRow(`pin-${index}`, `Existing pin ${index}`, String((index + 1) * 1024))),
      makeRow("unpinned-target", "Unpinned directory thread"),
    ];
    const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => ({
      ...navigationQueryFixture(request, { directories: [home], threads }),
      ...(request.query.kind === "exact" ? { selectionDirectory: { ...home,
        counts: { total: threads.length, active: 0, unread: 0, review: 0 },
        pinnedRootCount: threads.filter((row) => row.pinnedRank).length,
        unpinnedRootCount: threads.filter((row) => !row.pinnedRank).length,
        launchpadPresent: false } } : {}),
    }));
    const api: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: vi.fn(async () => undefined) };
    let navigation!: ReturnType<typeof useBoundedNavigationWindow>;
    function Window({ selected }: { selected: NavigationIdentity }) {
      const disclosure = useNavigationDirectoryDisclosure();
      navigation = useBoundedNavigationWindow({ desktopApi: api, enabled: true, visible: true,
        browseMode: "directories", attentionView: { id: "pin-visibility-window", promoteOnTurnEnd: true }, selectedRef: selected,
        expandedByKey: disclosure.expandedByKey, unpinnedExpandedByKey: disclosure.unpinnedExpandedByKey });
      return <Sidebar backends={[]} browseMode="directories" directories={navigation.directories} threads={threads}
        directoryDisclosure={disclosure} pagedNavigation={navigation} selectedItemKey={navigationThreadSelectionKey(selected)}
        selectedThreadDirectoryKeys={navigation.selectedDirectoryKeys} loading={false}
        onBrowseModeChange={() => undefined} onSelectThread={() => undefined}
        onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />;
    }
    const pinsId = `directory-pins:${home.key}`;
    const view = render(<Window selected={threads[0]!.ref} />);
    try {
      await waitFor(() => expect(navigation.resources.get(pinsId)?.state.page?.entries).toHaveLength(10));
      expect(view.getByRole("button", { name: "Load more pinned threads" })).toBeTruthy();

      const newRank = buildPrependPinRank(threads.map((row) => row.pinnedRank));
      threads = threads.map((row) => row.id === "unpinned-target" ? { ...row, pinnedRank: newRank, rowRevision: newRank } : row);
      act(() => navigation.invalidate());
      await act(() => navigation.refresh());
      await waitFor(() => expect(navigation.resources.get(pinsId)?.loading).toBe(false));

      const pinIds = navigation.resources.get(pinsId)?.state.page?.entries.map(({ row }) => row.id) ?? [];
      expect(pinIds[0]).toBe("kept-0");
      expect(pinIds[1]).toBe("unpinned-target");
      expect(view.getByRole("button", { name: /Unpinned directory thread, pinned/ })).toBeTruthy();
      expect(view.getByRole("button", { name: "Load more pinned threads" })).toBeTruthy();
    } finally { view.unmount(); }
  },
);

it("reveals Load more pinned threads even when the pointer moves inside the directory while the read is in flight", async () => {
  const home = { key: "directory:/fixture/project", kind: "directory" as const, label: "Fixture project", path: "/fixture/project" };
  const threads: NavigationRow[] = Array.from({ length: 15 }, (_, index) => ({
    id: `pin-${index}`, source: "codex" as const, title: `Hover pin ${index}`, titleSource: "explicit" as const,
    ref: { backend: "codex" as const, threadId: `pin-${index}` }, rowRevision: `pin-${index}`,
    pinnedRank: String((index + 1) * 1024),
    linkedDirectories: [{ id: home.path, path: home.path, label: home.label, kind: "local" as const }],
    inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" as const,
  }));
  let releaseContinuation: (() => void) | undefined;
  const continuationGate = new Promise<void>((resolve) => { releaseContinuation = resolve; });
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    if (request.query.kind === "directory" && request.query.roots === "pinned" && request.cursor) {
      await continuationGate;
    }
    return {
      ...navigationQueryFixture(request, { directories: [home], threads }),
      ...(request.query.kind === "exact" ? { selectionDirectory: { ...home,
        counts: { total: threads.length, active: 0, unread: 0, review: 0 },
        pinnedRootCount: threads.length, unpinnedRootCount: 0, launchpadPresent: false } } : {}),
    };
  });
  const api: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: vi.fn(async () => undefined) };
  let navigation!: ReturnType<typeof useBoundedNavigationWindow>;
  function Window() {
    const disclosure = useNavigationDirectoryDisclosure();
    navigation = useBoundedNavigationWindow({ desktopApi: api, enabled: true, visible: true,
      browseMode: "directories", attentionView: { id: "hover-load-more-window", promoteOnTurnEnd: true }, selectedRef: threads[0]!.ref,
      expandedByKey: disclosure.expandedByKey, unpinnedExpandedByKey: disclosure.unpinnedExpandedByKey });
    return <Sidebar backends={[]} browseMode="directories" directories={navigation.directories} threads={threads}
      directoryDisclosure={disclosure} pagedNavigation={navigation} selectedItemKey={navigationThreadSelectionKey(threads[0]!.ref)}
      selectedThreadDirectoryKeys={navigation.selectedDirectoryKeys} loading={false}
      onBrowseModeChange={() => undefined} onSelectThread={() => undefined}
      onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />;
  }
  const view = render(<Window />);
  try {
    const loadMoreButton = await view.findByRole("button", { name: "Load more pinned threads" });
    const firstPin = view.getByRole("button", { name: /Hover pin 0, pinned/ });
    // Freeze the directory under the pointer, click Load more, then move the
    // pointer while the async continuation read is still in flight.
    fireEvent.pointerOver(firstPin, { pointerType: "mouse" });
    fireEvent.click(loadMoreButton);
    fireEvent.pointerOver(firstPin, { pointerType: "mouse" });
    expect(view.queryByRole("button", { name: /Hover pin 14, pinned/ })).toBeNull();

    await act(async () => {
      releaseContinuation?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("button", { name: /Hover pin 14, pinned/ })).toBeTruthy());
    expect(view.queryByRole("button", { name: "Load more pinned threads" })).toBeNull();
  } finally { view.unmount(); }
});
