import { act, fireEvent, render, renderHook, screen, waitFor } from "../../test/phase-probes";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import fc from "fast-check";
import { useLayoutEffect } from "react";
import {
  DEFAULT_PROJECT_FORGE_AUTOMATION,
  type ProjectForgeAutomation,
} from "@pwragent/shared/project-forge-automation";
import type { AppServerPendingThreadStartReport } from "@pwragent/shared/contracts/normalized-app-server";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import {
  buildPullRequestStatusKey,
  type NavigationDirectoryRow,
  type NavigationQueryPage,
  type NavigationRow,
  type NavigationSelectedDetailResponse,
  type PrSummary,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";
import { Sidebar } from "../../features/navigation/Sidebar";
import { useHoverStableSnapshot } from "../../features/navigation/useHoverStableSnapshot";
import { navigationIdentityKey } from "../navigation-query-state";

const counts = { total: 1000, active: 40, unread: 90, review: 50 };
const row = (id: string): NavigationRow => ({ id, source: "codex", title: id, titleSource: "fallback", ref: { backend: "codex", threadId: id },
  rowRevision: "r", linkedDirectories: [], inbox: { inInbox: true }, ordinaryChildCount: 0,
  nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" });
function fixture() {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request): Promise<NavigationQueryPage> => {
    const offset = Number(request.cursor ?? 0);
    // An owner serves the rows a request asks for: a paced first page, then
    // the block an explicit continuation asks for.
    const size = request.pageSize ?? 10;
    // No row here is pinned: the Pinned group's page is empty and complete.
    const pinnedSplit = request.query.kind === "lens" && request.query.roots === "pinned";
    if (pinnedSplit) return { protocol: 2, queryKey: JSON.stringify(request.query), generation: "g", ownerEpoch: "owner",
      countsRevision: "r", coverage: { state: "complete" }, counts, entries: [], directories: [], complete: true, collectionSize: 0 };
    const entries = request.query.kind === "lens" ? Array.from({ length: size }, (_, i) => row(`thread-${offset + i}`))
      : request.query.kind === "exact" ? request.query.identities.map((ref) => row(ref.threadId)) : [];
    return { protocol: 2, queryKey: JSON.stringify(request.query), generation: "g", ownerEpoch: "owner", countsRevision: "r",
      coverage: { state: "complete" }, counts, entries: entries.map((row) => ({ row, placement: { kind: "root" }, orderKey: row.id })),
      directories: [], complete: request.query.kind !== "lens", nextCursor: request.query.kind === "lens" ? String(offset + size) : undefined };
  });
  const detail = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>(async (request) => ({
    protocol: 2, ref: request.ref, revision: "detail", readiness: "ready", identity: "present", thread: row(request.ref.threadId),
  }));
  const release = vi.fn(async () => undefined);
  const legacy = vi.fn(async () => { throw new Error("Legacy navigation must not run"); });
  return { read, detail, release, legacy, api: { getNavigationQueryPage: read, getNavigationSelectedDetail: detail,
    getNavigationSnapshot: legacy, releaseNavigationQuery: release, onAgentEvent: () => () => undefined,
  } satisfies DesktopApi };
}
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => vi.restoreAllMocks());

it("opens a start read on mount and follows it to the created thread", async () => {
  const f = fixture();
  const listeners = new Set<(event: AgentEvent) => void>();
  const report: AppServerPendingThreadStartReport = {
    phase: "starting",
    start: {
      startId: "card-start", backend: "codex", submittedAt: 1000, title: "Card title",
      prompt: "Check the recorder.", progressThread: { backend: "codex", threadId: "thread-0" },
    },
  };
  const api: DesktopApi = { ...f.api,
    listPendingThreadStarts: async () => [report],
    onAgentEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const { result } = renderHook(() => useThreadNavigation(api));
  await waitFor(() => expect(result.current.pendingThreadStartRows).toHaveLength(1));
  const [starting] = result.current.pendingThreadStartRows;
  expect(starting?.input).toEqual([{ type: "text", text: "Check the recorder." }]);
  act(() => result.current.selectPendingLaunchpad(starting!.selectionKey));
  expect(result.current.selectedItemKey).toBe(starting!.selectionKey);
  expect(result.current.selectedThreadKey).toBeUndefined();
  await act(async () => {
    for (const listener of listeners) listener({ backend: "codex", notification: {
      method: "thread/start/pending", params: { ...report, phase: "ended", createdThreadId: "thread-1",
        setupFailure: { message: "Setup exited 1", phase: "setup", worktreeCleanupAvailable: true } },
    } });
  });
  expect(result.current.selectedThreadKey).toBe("codex:thread-1");
  expect(result.current.selectedPendingThreadStartFailure).toMatchObject({ message: "Setup exited 1" });
  act(() => result.current.dismissPendingThreadStartFailure());
  expect(result.current.selectedPendingThreadStartFailure).toBeUndefined();
});

it("keeps a refused start gone when its in-flight snapshot arrives late", async () => {
  const f = fixture();
  const listeners = new Set<(event: AgentEvent) => void>();
  const report: AppServerPendingThreadStartReport = {
    phase: "starting", start: { startId: "refused", backend: "codex", submittedAt: 1000, title: "Card title" },
  };
  const snapshot = Promise.withResolvers<AppServerPendingThreadStartReport[]>();
  const api: DesktopApi = { ...f.api,
    listPendingThreadStarts: () => snapshot.promise,
    onAgentEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const { result } = renderHook(() => useThreadNavigation(api));
  const publish = (phase: "starting" | "ended") => {
    for (const listener of listeners) listener({ backend: "codex", notification: {
      method: "thread/start/pending", params: { ...report, phase },
    } });
  };
  act(() => publish("starting"));
  expect(result.current.pendingThreadStartRows).toHaveLength(1);
  await act(async () => {
    publish("ended");
    snapshot.resolve([report]);
  });
  expect(result.current.pendingThreadStartRows).toHaveLength(0);
});

it("does not list the local viewer for repeated births or reconnects from an unmounted owner", async () => {
  const f = fixture();
  const read = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (request, consumer) => ({ ...await read(request, consumer), viewerRowOwners: [] }));
  const listeners = new Set<(event: AgentEvent) => void>();
  const api: DesktopApi = { ...f.api, onAgentEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  vi.useFakeTimers();
  try {
    f.read.mockClear();
    const federationTarget = { scope: "remote" as const, instanceId: "peer" };
    await act(async () => {
      for (const notification of [
        { method: "navigation/invalidated", params: { sourceMethod: "thread/started", threadId: "new" } },
        { method: "federation/peerStatus/changed", params: { instanceId: "peer", status: "connected" } },
        { method: "navigation/invalidated", params: { sourceMethod: "thread/started", threadId: "new" } },
        { method: "navigation/invalidated", params: { sourceMethod: "turn/completed", threadId: "new" } },
        { method: "navigation/invalidated", params: { sourceMethod: "thread/archived", threadId: "new" } },
        { method: "navigation/invalidated", params: { sourceMethod: "thread/unarchived", threadId: "new" } },
      ] as const) for (const listener of listeners) listener({ backend: "codex", federationTarget, notification });
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(f.read).not.toHaveBeenCalled();
  } finally { unmount(); vi.useRealTimers(); }
});

it("keeps settled local directories mounted through local Git probes and notices from an absent peer", async () => {
  const f = fixture();
  const read = f.read.getMockImplementation()!;
  const directories: NavigationDirectoryRow[] = Array.from({ length: 3 }, (_, i) => ({
    key: `directory:/fixture/${i}`, kind: "directory", label: String(i), counts, launchpadPresent: false,
    pinnedRootCount: 1, unpinnedRootCount: 1,
  }));
  const key = directories[0]!.key;
  let branch = "main";
  f.read.mockImplementation(async (request, consumer) => {
    const page = await read(request, consumer);
    return { ...page, viewerRowOwners: [], directories: request.query.kind === "directory-index"
      ? directories.map((dir) => dir.key === key ? { ...dir, gitStatus: { currentBranch: branch } } : dir) : [] };
  });
  const listeners = new Set<(event: AgentEvent) => void>();
  const api: DesktopApi = { ...f.api, onAgentEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const emit = (event: AgentEvent) => { for (const listener of listeners) listener(event); };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  try {
    await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
    act(() => {
      result.current.setBrowseMode("directories");
      result.current.directoryDisclosure.setExpandedByKey(Object.fromEntries(directories.map(({ key }) => [key, true])));
    });
    await waitFor(() => {
      const resources = [...result.current.pagedNavigation.resources.values()];
      expect(resources.filter(({ state }) => state.request.query.kind === "directory")).toHaveLength(6);
      expect(resources.every(({ loading, state }) => !loading && state.page)).toBe(true);
    });
    vi.useFakeTimers();
    // Identical path strings on another machine name that owner's checkout.
    for (const remote of [true, false]) {
      f.read.mockClear();
      f.release.mockClear();
      for (const currentBranch of ["feature", "feature", "main"]) {
        await act(async () => {
          if (remote) emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "absent" },
            notification: { method: "navigation/invalidated", params: { sourceMethod: "navigation/directoryGitStatus/updated", directoryKey: key } } });
          else {
            branch = currentBranch;
            emit({ backend: "codex", notification: { method: "navigation/directoryGitStatus/updated",
              params: { directoryKey: key, gitStatus: { currentBranch }, fetchedAt: Date.now() } } });
          }
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(result.current.directories.find((dir) => dir.key === key)?.gitStatus?.currentBranch).toBe(branch);
      }
      expect.soft(f.read.mock.calls.length, remote ? "absent peer" : "local patch").toBe(0);
      expect(f.release).not.toHaveBeenCalled();
    }
  } finally { unmount(); vi.useRealTimers(); }
});

it("retains unchanged row projections while still publishing changed titles", async () => {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  let title: string | undefined;
  f.read.mockImplementation(async (request, consumer) => {
    const page = await originalRead(request, consumer);
    const updatedTitle = title;
    return updatedTitle ? { ...page, entries: page.entries.map((entry) => entry.row.id === "thread-1"
      ? { ...entry, row: { ...entry.row, title: updatedTitle } } : entry) } : page;
  });
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  const threads = result.current.threads;
  const directories = result.current.directories;

  await act(async () => { await result.current.pagedNavigation.refresh(); });

  expect(result.current.threads).toBe(threads);
  expect(result.current.directories).toBe(directories);
  expect(result.current.pagesAwaitingRows).toEqual([]);

  title = "Updated title";
  await act(async () => { await result.current.pagedNavigation.refresh(); });

  expect(result.current.threads).not.toBe(threads);
  expect(result.current.threads.find((thread) => thread.id === "thread-1")?.title).toBe(title);
  unmount();
});

it("publishes identical accepted pages and freezes hover again after a revealed pin", async () => {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  let pinnedRank: string | undefined;
  let removeLast = false;
  f.read.mockImplementation(async (request, consumer) => {
    const page = await originalRead(request, consumer);
    return { ...page, entries: page.entries
      .filter((entry) => !removeLast || entry.row.id !== "thread-9")
      .map((entry) => entry.row.id === "thread-1"
        ? { ...entry, row: { ...entry.row, pinnedRank } } : entry) };
  });
  const setThreadPin = vi.fn<NonNullable<DesktopApi["setThreadPin"]>>(async (request) => {
    pinnedRank = "1024";
    return { backend: "codex", threadId: request.threadId, pinnedRank };
  });
  const api = { ...f.api, setThreadPin };
  const loadingFlags: Array<{ loading: boolean; refreshing: boolean }> = [];
  let navigation!: ReturnType<typeof useThreadNavigation>;
  let hover!: ReturnType<typeof useHoverStableSnapshot<(typeof navigation)["threads"]>>;
  // Sidebar owns hover state in a child: a reveal render must not rerender
  // the navigation owner and accidentally clear its stale page IDs.
  function HoverRows({ current }: { current: typeof navigation }) {
    hover = useHoverStableSnapshot({
      scope: current.browseMode,
      outstandingReads: [
        ...[...current.pagedNavigation.resources.values()]
          .filter((resource) => resource.state.stale && !resource.state.error)
          .map((resource) => resource.id),
        ...current.pagesAwaitingRows,
      ],
      value: current.threads,
    });
    return <div onPointerOver={hover.onPointerOver}><div data-hover-stable-row>Hovered row</div></div>;
  }
  function NavigationWindow() {
    navigation = useThreadNavigation(api);
    loadingFlags.push({ loading: navigation.loading, refreshing: navigation.refreshing });
    return <HoverRows current={navigation} />;
  }
  const { unmount } = render(<NavigationWindow />);
  await waitFor(() => expect(navigation.selectedThreadConfigurationReady).toBe(true));
  fireEvent.pointerOver(screen.getByText("Hovered row"), { pointerType: "mouse" });

  await act(async () => {
    await hover.reveal(() => navigation.setThreadPin(
      navigation.threads.find((thread) => thread.id === "thread-1")!, true,
    ));
    await navigation.pagedNavigation.refresh();
  });
  expect(setThreadPin).toHaveBeenCalledOnce();
  expect(hover.value.find((thread) => thread.id === "thread-1")?.pinnedRank).toBe("1024");

  const threads = navigation.threads;
  const directories = navigation.directories;
  const pages = [...navigation.pagedNavigation.resources.values()].map((resource) => resource.state.page);
  loadingFlags.length = 0;
  // Immediate read start/completion batch together: row identities and both
  // loading flags stay unchanged, but the newly accepted pages must publish.
  await act(async () => { await navigation.pagedNavigation.refresh(); });
  expect(navigation.loading).toBe(false);
  expect(navigation.refreshing).toBe(false);
  expect(loadingFlags.every(({ loading, refreshing }) => !loading && !refreshing)).toBe(true);
  expect([...navigation.pagedNavigation.resources.values()].some((resource, index) => resource.state.page !== pages[index])).toBe(true);
  expect(navigation.threads).toBe(threads);
  expect(navigation.directories).toBe(directories);
  const awaitingRows = navigation.pagesAwaitingRows;

  removeLast = true;
  await act(async () => { await navigation.pagedNavigation.refresh(); });
  expect(navigation.threads.some((thread) => thread.id === "thread-9")).toBe(false);
  expect(hover.value).toBe(threads);
  expect(hover.value.some((thread) => thread.id === "thread-9")).toBe(true);
  expect(awaitingRows).toEqual([]);
  unmount();
});

it("returns to the loaded lens range without a loading or missing-row frame", async () => {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  let hold = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  f.read.mockImplementation(async (request) => {
    if (hold && request.query.kind === "lens") await pending;
    return originalRead(request);
  });
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.threads.length).toBe(10));
  await act(() => result.current.pagedNavigation.loadMore("lens"));
  expect(result.current.threads.length).toBe(110);
  act(() => result.current.setBrowseMode("recents"));
  await waitFor(() => expect(result.current.pagedNavigation.resources.get("lens")?.loading).toBe(false));
  hold = true;
  act(() => result.current.setBrowseMode("inbox"));
  expect(result.current.loading).toBe(false);
  expect(result.current.threads).toHaveLength(110);
  expect(result.current.pagedNavigation.resources.get("lens")?.state.page?.entries).toHaveLength(110);
  await act(async () => { hold = false; release(); await pending; });
  unmount();
});

it.each([false, true])("waits for New Thread owner authority and respects changed selection=%s", async (changeSelection) => {
  const f = fixture();
  let resolve!: (detail: NavigationSelectedDetailResponse) => void;
  const pending = new Promise<NavigationSelectedDetailResponse>((done) => { resolve = done; });
  f.detail.mockImplementation((request) => request.ref.threadId === "thread-0" ? pending : Promise.resolve({
    protocol: 2, ref: request.ref, revision: "other", readiness: "ready", identity: "present", thread: row(request.ref.threadId),
  }));
  const ensureDirectoryLaunchpad = vi.fn<NonNullable<DesktopApi["ensureDirectoryLaunchpad"]>>(async (request) => ({
    defaults: { backend: "codex", executionMode: "default" },
    launchpad: { ...request, backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1, updatedAt: 1 },
  }));
  const api = { ...f.api, ensureDirectoryLaunchpad };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  await waitFor(() => expect(result.current.selectedThreadKey).toBe("codex:thread-0"));
  let creation!: Promise<void>;
  act(() => { creation = result.current.createThread(); });
  expect(ensureDirectoryLaunchpad).not.toHaveBeenCalled();
  if (changeSelection) act(() => result.current.selectThread(row("thread-1")));
  await act(async () => {
    resolve({ protocol: 2, ref: row("thread-0").ref, revision: "owner", readiness: "ready", identity: "present", thread: row("thread-0") });
    await creation;
  });
  expect(ensureDirectoryLaunchpad).toHaveBeenCalledTimes(changeSelection ? 0 : 1);
  if (changeSelection) expect(result.current.selectedThreadKey).toBe("codex:thread-1");
  expect(f.legacy).not.toHaveBeenCalled();
  unmount();
});

it.each(["reorder", "unpin"])("fences a page started before an accepted pin %s and accepts the next owner baseline", async (operation) => {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  let rank: string | undefined = "1024";
  let hold = false;
  let release!: () => void;
  let captured = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  f.read.mockImplementation(async (request) => {
    const page = await originalRead(request);
    const result = { ...page, entries: page.entries.map((entry) => entry.row.id === "thread-0"
      ? { ...entry, row: { ...entry.row, pinnedRank: rank } } : entry) };
    if (hold && request.query.kind === "lens") { captured = true; await pending; }
    return result;
  });
  const reorderThreadPins = vi.fn<NonNullable<DesktopApi["reorderThreadPins"]>>(async () => {
    rank = "3072";
    return { pinnedRanks: { "codex:thread-0": rank } };
  });
  const setThreadPin = vi.fn<NonNullable<DesktopApi["setThreadPin"]>>(async (request) => {
    rank = undefined;
    return { backend: "codex", threadId: request.threadId };
  });
  const api = { ...f.api, reorderThreadPins, setThreadPin };
  const { result } = renderHook(() => useThreadNavigation(api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  hold = true;
  let refresh!: Promise<void>;
  act(() => { refresh = result.current.refresh(); });
  await waitFor(() => expect(captured).toBe(true));
  await act(() => operation === "reorder"
    ? result.current.reorderThreadPins([], { key: "codex:thread-0", direction: "down" })
    : result.current.setThreadPin(result.current.threads.find((thread) => thread.id === "thread-0")!, false));
  await act(async () => { hold = false; release(); await refresh; });
  expect(result.current.threads.find((thread) => thread.id === "thread-0")?.pinnedRank).toBe(operation === "reorder" ? "3072" : undefined);
  if (operation === "reorder") {
    expect(reorderThreadPins).toHaveBeenCalledWith({ federationTarget: undefined, move: { key: "codex:thread-0", direction: "down" } });
  } else {
    expect(setThreadPin).toHaveBeenCalledWith({ backend: "codex", federationTarget: undefined, threadId: "thread-0", pinned: false });
  }
  rank = "4096";
  await act(() => result.current.refresh());
  expect(result.current.threads.find((thread) => thread.id === "thread-0")?.pinnedRank).toBe("4096");
  expect(f.legacy).not.toHaveBeenCalled();
});

it("rejects partial full-order vectors before sending a pin mutation", async () => {
  const f = fixture();
  const reorderThreadPins = vi.fn(async () => ({ pinnedRanks: {} }));
  const reorderDirectoryPins = vi.fn(async () => ({ pinnedRanks: {} }));
  const api = { ...f.api, reorderThreadPins, reorderDirectoryPins };
  const { result } = renderHook(() => useThreadNavigation(api));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(() => result.current.reorderThreadPins(["codex:thread-0"]));
  await act(() => result.current.reorderDirectoryPins(["directory:one"]));
  expect(reorderThreadPins).not.toHaveBeenCalled();
  expect(reorderDirectoryPins).not.toHaveBeenCalled();
});

it("uses viewer directory disclosure for page demand across owner refresh and preference-save failure", async () => {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  const key = "directory:/project";
  f.read.mockImplementation(async (request) => {
    const page = await originalRead(request);
    return request.query.kind === "directory-index" ? { ...page, directories: [{ key, kind: "directory", label: "Project", path: "/project",
      counts, pinnedRootCount: 1, unpinnedRootCount: 999, launchpadPresent: false, directoryThreadsCollapsed: false }] } : page;
  });
  const setDirectoryThreadsCollapsed = vi.fn<NonNullable<DesktopApi["setDirectoryThreadsCollapsed"]>>(async () => {
    throw new Error("Preference storage unavailable");
  });
  const api = { ...f.api, setDirectoryThreadsCollapsed };
  const { result } = renderHook(() => useThreadNavigation(api));
  await waitFor(() => expect(result.current.directories.some((directory) => directory.key === key)).toBe(true));
  act(() => {
    result.current.setBrowseMode("directories");
    result.current.directoryDisclosure.setExpandedByKey({ [key]: true });
  });
  await waitFor(() => expect(f.read.mock.calls.some(([request]) => request.query.kind === "directory" && request.query.roots === "unpinned")).toBe(true));
  await act(() => result.current.setDirectoryThreadsCollapsed(result.current.directories.find((directory) => directory.key === key)!, true));
  await waitFor(() => expect(f.read.mock.calls.some(([request]) => request.query.kind === "directory" && request.query.roots === "pinned")).toBe(true));
  await act(() => result.current.refresh());
  expect(result.current.directories.find((directory) => directory.key === key)?.directoryThreadsCollapsed).toBe(true);
  expect(result.current.pagedNavigation.resources.get(`directory-pins:${key}`)?.state.request.query).toMatchObject({ roots: "pinned" });
  expect(result.current.pagedNavigation.resources.has(`directory:${key}`)).toBe(false);
  expect(f.legacy).not.toHaveBeenCalled();
});

it("uses one viewer membership read per admitted collection for a remote pin receipt and notice", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(3, 6), fc.constantFrom("notice-settled", "notice-pending", "reply-first"),
    fc.constantFrom("none", "seen", "metadata"), async (size, order, concurrent) => {
    const f = fixture();
    const originalRead = f.read.getMockImplementation()!;
    const directories: NavigationDirectoryRow[] = Array.from({ length: size }, (_, index) => ({
      key: `directory:/project-${index}`, kind: "directory", label: `Project ${index}`, path: `/project-${index}`,
      counts, pinnedRootCount: 1, unpinnedRootCount: 1, launchpadPresent: false,
    }));
    const ref = { backend: "codex", threadId: "new-pin", ownerInstanceId: "peer" } as const;
    const remote: NavigationRow = { ...row(ref.threadId), ref, pinnedRank: "1024",
      federation: { ref: { backend: ref.backend, threadId: ref.threadId, target: { scope: "remote", instanceId: "peer" } }, instanceLabel: "Peer" } };
    const publication = { backend: "codex", instanceId: "peer", threadId: ref.threadId, pinned: true, publicationId: "mount-1" } as const;
    let mounted = false;
    let hold: Promise<void> | undefined;
    let listener: ((event: AgentEvent) => void) | undefined;
    const tasks = new Set<() => void>();
    const scheduleNavigationRefresh = (task: () => void) => {
      tasks.add(task);
      return () => { tasks.delete(task); };
    };
    const publish = () => listener?.({ backend: publication.backend, notification: {
      method: "navigation/remoteThreadPins/changed", params: publication,
    } });
    const dispatch = () => { const pending = [...tasks]; tasks.clear(); pending.forEach((task) => task()); };
    f.read.mockImplementation(async (request, consumer) => {
      const query = request.query;
      const observed = mounted;
      if (observed && query.kind === "directory" && query.roots === "pinned" && query.directoryKey === directories[0]!.key) await hold;
      const page = await originalRead(request, consumer);
      if (query.kind === "directory-index") return { ...page, directories };
      if (query.kind === "directory") {
        const original = { ...row(`${query.directoryKey}/${query.roots}`), ordinaryChildCount: query.roots === "pinned" ? 2 : 0 };
        const hasPin = observed && query.directoryKey === directories[0]!.key;
        const entries = [original, ...(hasPin && query.roots === "pinned" ? [remote] : [])]
          .map((row) => ({ row, placement: { kind: "root" as const }, orderKey: row.id }));
        return { ...page, entries, complete: true, metadataDependencies: { version: 1,
          threadKeys: [navigationIdentityKey(original.ref), ...(hasPin ? [navigationIdentityKey(ref)] : [])], prKeys: [] } };
      }
      if (query.kind === "children") {
        const entries = ["older", "newer"].map((suffix, index) => ({
          row: { ...row(`${query.parent.threadId}/${suffix}`), parentThreadId: query.parent.threadId },
          placement: { kind: "child" as const, parent: query.parent }, orderKey: String(index),
        }));
        return { ...page, entries, selectionDirectory: directories.find(({ key }) => key === query.directoryKey) };
      }
      if (query.kind === "exact" && query.identities.some((identity) => identity.ownerInstanceId === ref.ownerInstanceId && identity.threadId === ref.threadId)) {
        return { ...page, entries: [{ row: remote, placement: { kind: "root" }, orderKey: remote.id }], selectionDirectory: directories[0] };
      }
      return page;
    });
    f.detail.mockImplementation(async ({ ref: selected }) => ({ protocol: 2, ref: selected,
      revision: "detail", readiness: "ready", identity: "present", thread: selected.ownerInstanceId ? remote : row(selected.threadId) }));
    const api: DesktopApi = { ...f.api, onAgentEvent: (callback) => { listener = callback; return () => { listener = undefined; }; } };
    const commits: string[][] = [];
    const readChildren = (value: ReturnType<typeof useThreadNavigation>) => [...value.pagedNavigation.resources.values()]
      .filter(({ state }) => state.request.query.kind === "children")
      .flatMap(({ state }) => state.page?.entries.map(({ row }) => row.id) ?? []);
    const { result, unmount } = renderHook(() => {
      const value = useThreadNavigation(api, { scheduleNavigationRefresh });
      useLayoutEffect(() => { commits.push(readChildren(value)); });
      return value;
    });
    const resources = () => [...result.current.pagedNavigation.resources.values()].filter(({ state }) => state.request.query.kind === "directory");
    const admitted = () => resources().length === size * 2 && resources().every(({ loading, state }) => !loading && state.page);
    try {
      await waitFor(() => expect(result.current.directories).toHaveLength(size));
      act(() => {
        result.current.setBrowseMode("directories");
        result.current.directoryDisclosure.setExpandedByKey(Object.fromEntries(directories.map(({ key }) => [key, true])));
      });
      await waitFor(() => {
        expect(admitted()).toBe(true);
        expect(readChildren(result.current)).toHaveLength(size * 2);
      });
      const childOrder = readChildren(result.current);
      commits.length = 0;
      f.read.mockClear();
      mounted = true;
      let complete = false;
      let reply!: Promise<void>;
      let release!: () => void;
      if (order === "notice-pending") hold = new Promise<void>((resolve) => { release = resolve; });
      if (order !== "reply-first") {
        await act(async () => { publish(); dispatch(); });
        if (order === "notice-settled") await waitFor(() => expect(admitted()).toBe(true));
      }
      await act(async () => {
        reply = result.current.refresh("action/remote-pin-add", publication).then(() => { complete = true; });
      });
      if (order === "notice-pending") {
        expect(complete).toBe(false);
        if (concurrent !== "none") {
          await waitFor(() => expect(resources().filter(({ loading }) => loading)).toHaveLength(1));
          await act(async () => {
            if (concurrent === "seen") listener?.({ backend: "codex", federationTarget: remote.federation!.ref.target, notification: {
              method: "navigation/invalidated", params: { sourceMethod: "navigation/thread/seen", threadId: ref.threadId },
            } });
            else listener?.({ backend: "codex", notification: {
              method: "navigation/remoteThreadPins/changed", params: { instanceId: ref.ownerInstanceId, rowChanges: [ref] },
            } });
            dispatch();
          });
        }
        await act(async () => { release(); await reply; });
      } else {
        await act(async () => { await reply; });
      }
      expect(result.current.threads.map(({ id }) => id)).toContain(ref.threadId);
      await act(async () => { if (order === "reply-first") publish(); dispatch(); });
      const concurrentAffectedReads = order === "notice-pending" && concurrent !== "none" ? 2 : 0;
      expect(f.read.mock.calls.filter(([{ query }]) => query.kind === "directory")).toHaveLength(2 * size + concurrentAffectedReads);
      expect(f.read.mock.calls.filter(([{ query }]) => query.kind === "children")).toHaveLength(size);
      expect(commits).not.toHaveLength(0);
      for (const children of commits) expect(children).toEqual(childOrder);
      expect(f.legacy).not.toHaveBeenCalled();
      act(() => result.current.selectThread(remote));
      await waitFor(() => expect(result.current.selectedThread?.federation?.ref).toEqual(remote.federation?.ref));
      await waitFor(() => expect(result.current.pagedNavigation.resources.get("selected-viewer-mount")?.state.page?.entries[0]?.row.ref).toEqual(ref));
      expect(result.current.pagedNavigation.resources.get("selected-context")?.state.request.federationTarget).toEqual(remote.federation?.ref.target);
    } finally {
      unmount();
    }
  }), { numRuns: 12, examples: [[3, "notice-settled", "none"], [6, "notice-settled", "none"],
    [3, "notice-pending", "seen"], [6, "notice-pending", "metadata"], [3, "reply-first", "none"], [6, "reply-first", "none"]] });
});

/**
 * An owner with one pinned directory. Each index read serves the pin as it
 * was when the read began, and waits on `hold` while one is set.
 */
function pinnedDirectoryOwner() {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  const key = "directory:/project";
  const owner: { rank?: string; hold?: Promise<void> } = { rank: "1024" };
  f.read.mockImplementation(async (request) => {
    const pinnedRank = owner.rank;
    if (owner.hold && request.query.kind === "directory-index") await owner.hold;
    const page = await originalRead(request);
    return request.query.kind === "directory-index" ? { ...page, directories: [{ key, kind: "directory", label: "Project",
      path: "/project", counts, pinnedRootCount: 1, unpinnedRootCount: 999, launchpadPresent: false, pinnedRank }] } : page;
  });
  const setDirectoryPin = vi.fn<NonNullable<DesktopApi["setDirectoryPin"]>>(async () => {
    owner.rank = undefined;
    return { directoryKey: key, pinnedRank: undefined };
  });
  /** Hold every directory index read until the returned release runs. */
  const holdIndexReads = (): (() => void) => {
    let release!: () => void;
    owner.hold = new Promise<void>((resolve) => { release = resolve; });
    return release;
  };
  return { f, key, owner, setDirectoryPin, holdIndexReads };
}

it("keeps an unpinned directory unpinned while another page lands before the index re-read", async () => {
  const { f, key, setDirectoryPin, holdIndexReads } = pinnedDirectoryOwner();
  let finish: (() => void) | undefined;
  let listener: ((event: AgentEvent) => void) | undefined;
  const api = { ...f.api, setDirectoryPin,
    onAgentEvent: (callback: (event: AgentEvent) => void) => { listener = callback; return () => { listener = undefined; }; } };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  const rank = () => result.current.directories.find((directory) => directory.key === key)?.pinnedRank;
  try {
    await waitFor(() => expect(rank()).toBe("1024"));
    act(() => {
      result.current.setBrowseMode("directories");
      result.current.directoryDisclosure.setExpandedByKey({ [key]: true });
    });
    await waitFor(() => expect(result.current.pagedNavigation.resources.get(`directory-pins:${key}`)?.state.page).toBeDefined());

    finish = holdIndexReads();
    await act(() => result.current.setDirectoryPin(result.current.directories.find((directory) => directory.key === key)!, false));
    expect(rank()).toBeUndefined();
    // The owner's event invalidates every page. The directory index reads
    // are held, so the other pages land first.
    act(() => listener?.({ backend: "codex", notification: { method: "directory/pin/removed",
      params: { directoryKey: key } } } as AgentEvent));
    const resources = () => [...result.current.pagedNavigation.resources.values()];
    const indexes = () => resources().filter((resource) => resource.state.request.query.kind === "directory-index");
    await waitFor(() => expect(resources().filter((resource) => !indexes().includes(resource))
      .every((resource) => !resource.state.stale && !resource.loading)).toBe(true));
    expect(indexes().every((resource) => resource.state.stale)).toBe(true);
    expect(rank()).toBeUndefined();

    await act(async () => finish?.());
    await waitFor(() => expect(indexes().some((resource) => resource.state.stale)).toBe(false));
    expect(rank()).toBeUndefined();
  } finally {
    finish?.();
    unmount();
  }
});

it("keeps an unpinned directory unpinned when an index read from before the unpin lands", async () => {
  const { f, key, setDirectoryPin, holdIndexReads } = pinnedDirectoryOwner();
  let finish: (() => void) | undefined;
  const api = { ...f.api, setDirectoryPin };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  const rank = () => result.current.directories.find((directory) => directory.key === key)?.pinnedRank;
  try {
    await waitFor(() => expect(rank()).toBe("1024"));
    act(() => result.current.setBrowseMode("directories"));
    // A background refresh reads the index before the operator unpins.
    finish = holdIndexReads();
    act(() => { void result.current.pagedNavigation.refresh(); });
    await waitFor(() => expect(result.current.pagedNavigation.resources.get("directory-index")?.loading).toBe(true));
    await act(() => result.current.setDirectoryPin(result.current.directories.find((directory) => directory.key === key)!, false));
    expect(rank()).toBeUndefined();

    // The owner's event has not arrived, so nothing fences the earlier read.
    act(() => finish?.());
    await waitFor(() => expect(result.current.pagedNavigation.resources.get("directory-index")?.loading).toBe(false));
    expect(rank()).toBeUndefined();
  } finally {
    finish?.();
    unmount();
  }
});

it("keeps the optimistic unpin while an owner read completes before the command", async () => {
  const { f, key } = pinnedDirectoryOwner();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const setDirectoryPin = vi.fn<NonNullable<DesktopApi["setDirectoryPin"]>>(async () => {
    await pending;
    return { directoryKey: key, pinnedRank: undefined };
  });
  const api = { ...f.api, setDirectoryPin };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  const rank = () => result.current.directories.find((directory) => directory.key === key)?.pinnedRank;
  try {
    await waitFor(() => expect(rank()).toBe("1024"));
    act(() => result.current.setBrowseMode("directories"));
    let command!: Promise<void>;
    act(() => { command = result.current.setDirectoryPin(result.current.directories.find((directory) => directory.key === key)!, false); });
    expect(rank()).toBeUndefined();
    await act(() => result.current.pagedNavigation.refresh());
    expect(rank()).toBeUndefined();
    await act(async () => { finish(); await command; });
    expect(rank()).toBeUndefined();
  } finally {
    finish();
    unmount();
  }
});

it("restores the owner pin when an unpin fails after an intervening read", async () => {
  const { f, key } = pinnedDirectoryOwner();
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, fail) => { reject = fail; });
  const api = { ...f.api, setDirectoryPin: vi.fn<NonNullable<DesktopApi["setDirectoryPin"]>>(() => pending) };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  const rank = () => result.current.directories.find((directory) => directory.key === key)?.pinnedRank;
  try {
    await waitFor(() => expect(rank()).toBe("1024"));
    let command!: Promise<void>;
    act(() => { command = result.current.setDirectoryPin(result.current.directories.find((directory) => directory.key === key)!, false); });
    await act(() => result.current.pagedNavigation.refresh());
    expect(rank()).toBeUndefined();
    await act(async () => { reject(new Error("write failed")); await command; });
    expect(rank()).toBe("1024");
  } finally {
    unmount();
  }
});

async function exerciseDirectoryDescriptorRace(order: "together" | "index-first" | "selection-first", initialRank: string) {
  const { f, key, owner, setDirectoryPin } = pinnedDirectoryOwner();
  owner.rank = initialRank;
  const read = f.read.getMockImplementation()!;
  const held = new Map<string, () => void>();
  let hold = false;
  f.read.mockImplementation(async (request) => {
    const pinnedRank = owner.rank;
    const page = await read(request);
    const kind = request.query.kind;
    if (hold && (kind === "exact" || kind === "directory-index")) {
      await new Promise<void>((resolve) => { held.set(kind, resolve); });
    }
    return kind === "exact" ? { ...page, selectionDirectory: { key, kind: "directory", label: "Project", path: "/project",
      counts, pinnedRootCount: 1, unpinnedRootCount: 999, launchpadPresent: false, pinnedRank } } : page;
  });
  const api = { ...f.api, setDirectoryPin };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  const rank = () => result.current.directories.find((directory) => directory.key === key)?.pinnedRank;
  try {
    await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
    await waitFor(() => expect(rank()).toBe(initialRank));
    await waitFor(() => expect(result.current.pagedNavigation.resources.get("selected-context")?.loading).toBe(false));
    hold = true;
    let selection!: Promise<void>;
    act(() => { selection = result.current.pagedNavigation.restart("selected-context"); });
    await waitFor(() => expect(held.has("exact")).toBe(true));
    await act(() => result.current.setDirectoryPin(result.current.directories.find((directory) => directory.key === key)!, false));
    expect(rank()).toBeUndefined();
    let index!: Promise<void>;
    act(() => { index = result.current.pagedNavigation.restart("directory-index"); });
    await waitFor(() => expect(held.has("directory-index")).toBe(true));
    if (order === "together") {
      await act(async () => { held.get("exact")!(); held.get("directory-index")!(); await Promise.all([selection, index]); });
    } else {
      const first = order === "index-first" ? "directory-index" : "exact";
      await act(async () => { held.get(first)!(); await (first === "exact" ? selection : index); });
      expect(rank()).toBeUndefined();
      await act(async () => { held.get(first === "exact" ? "directory-index" : "exact")!(); await Promise.all([selection, index]); });
    }
    // Oracle: the owner's acknowledged unpin wins over a descriptor read
    // before that command, even when a fresh index page lands beside it.
    expect(rank()).toBe(owner.rank);
    expect(rank()).toBeUndefined();
  } finally {
    for (const release of held.values()) release();
    unmount();
  }
}

it("keeps an acknowledged unpin when fresh index and older selection descriptors land together", async () => {
  await exerciseDirectoryDescriptorRace("together", "1");
});

it("preserves the owner's acknowledged pin across index and selection delivery orders", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("together" as const, "index-first" as const, "selection-first" as const),
    fc.integer({ min: 1, max: 10_000 }), async (order, rank) => {
      await exerciseDirectoryDescriptorRace(order, String(rank));
    }), { numRuns: 9, examples: [["together", 1], ["index-first", 1], ["selection-first", 1]] });
});

it("preserves an optimistic unpin across any sequence of reads before owner acknowledgement", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), async (reads) => {
    const { f, key, owner } = pinnedDirectoryOwner();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const setDirectoryPin = vi.fn<NonNullable<DesktopApi["setDirectoryPin"]>>(async () => {
      await pending;
      owner.rank = undefined;
      return { directoryKey: key, pinnedRank: owner.rank };
    });
    const api = { ...f.api, setDirectoryPin };
    const { result, unmount } = renderHook(() => useThreadNavigation(api));
    const rank = () => result.current.directories.find((directory) => directory.key === key)?.pinnedRank;
    try {
      await waitFor(() => expect(rank()).toBe("1024"));
      act(() => result.current.setBrowseMode("directories"));
      let command!: Promise<void>;
      act(() => { command = result.current.setDirectoryPin(result.current.directories.find((directory) => directory.key === key)!, false); });
      for (const refresh of reads) {
        if (refresh) await act(() => result.current.pagedNavigation.refresh());
        expect(rank()).toBeUndefined();
      }
      await act(async () => { finish(); await command; });
      await act(() => result.current.pagedNavigation.refresh());
      expect(rank()).toBe(owner.rank);
    } finally {
      finish();
      unmount();
    }
  }), { numRuns: 15 });
});

it("loads one owner lens page and exact selection, preserving complete counts independently", async () => {
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  expect(f.legacy).not.toHaveBeenCalled();
  expect(result.current.pagedNavigation.resources.get("lens")?.state.page?.entries).toHaveLength(10);
  expect(result.current.pagedNavigation.resources.get("directory-index")?.state.page?.counts).toEqual(counts);
  // One list page, and the Pinned group's own page beside it.
  expect(f.read.mock.calls.flatMap(([r]) => r.query.kind === "lens" ? [r.query.roots] : []).sort())
    .toEqual(["pinned", "unpinned"]);
  await act(() => result.current.pagedNavigation.loadMore("lens"));
  expect(result.current.pagedNavigation.resources.get("lens")?.state.page?.entries).toHaveLength(110);
  unmount();
  expect(f.release).toHaveBeenCalled();
});

it("selected_action_waits_for_authoritative_detail: preserves an off-page selection until exact owner readiness", async () => {
  const f = fixture();
  let resolve!: (value: NavigationSelectedDetailResponse) => void;
  const pending = new Promise<NavigationSelectedDetailResponse>((done) => { resolve = done; });
  f.detail.mockImplementation(async (request) => request.ref.threadId === "off-page" ? pending : ({
    protocol: 2, ref: request.ref, revision: "detail", readiness: "ready", identity: "present", thread: row(request.ref.threadId),
  }));
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => result.current.selectThread(row("off-page")));
  await waitFor(() => expect(result.current.selectedItemKey).toBe("codex:off-page"));
  expect(result.current.selectedThreadConfigurationReady).toBe(false);
  await act(async () => resolve({ protocol: 2, ref: { backend: "codex", threadId: "off-page" }, revision: "off-page",
    readiness: "ready", identity: "present", thread: row("off-page") }));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  act(() => result.current.setBrowseMode("directories"));
  await waitFor(() => expect(result.current.pagedNavigation.resources.has("lens")).toBe(false));
  expect(result.current.selectedItemKey).toBe("codex:off-page");
  expect(result.current.selectedThread?.id).toBe("off-page");
  expect(f.legacy).not.toHaveBeenCalled();
  unmount();
});


it("keeps loaded sub-threads in place without inserting loading text on refresh", async () => {
  const f = fixture();
  f.detail.mockImplementation(async (request) => ({ protocol: 2, ref: request.ref,
    revision: "detail", readiness: "ready", identity: "present",
    thread: { ...row(request.ref.threadId), ordinaryChildCount: request.ref.threadId === "thread-0" ? 1 : 0 } }));
  const original = f.read.getMockImplementation()!;
  let holdChildren = false;
  let finish!: () => void;
  let childPending = false;
  f.read.mockImplementation(async (request) => {
    const page = await original(request);
    if (request.query.kind === "lens" || request.query.kind === "exact") {
      return { ...page, entries: page.entries.map((entry) => ({ ...entry,
        row: { ...entry.row, ordinaryChildCount: entry.row.id === "thread-0" ? 1 : 0 } })) };
    }
    if (request.query.kind === "children") {
      if (holdChildren) {
        childPending = true;
        await new Promise<void>((resolve) => { finish = resolve; });
      }
      return { ...page, entries: [{ row: { ...row("child"), parentThreadId: "thread-0" },
        placement: { kind: "child", parent: row("thread-0").ref }, orderKey: "child" }] };
    }
    return page;
  });
  let navigation!: ReturnType<typeof useThreadNavigation>;
  function Window() {
    navigation = useThreadNavigation(f.api);
    return <Sidebar backends={[]} browseMode={navigation.browseMode} directories={navigation.directories}
      threads={navigation.threads} inboxThreads={navigation.inboxThreads} pagedNavigation={navigation.pagedNavigation}
      loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
      onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
      onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />;
  }
  let mounted!: ReturnType<typeof render>;
  await act(async () => { mounted = render(<Window />); });
  await screen.findByRole("button", { name: "child" });
  holdChildren = true;
  let refresh!: Promise<void>;
  act(() => { refresh = navigation.pagedNavigation.refresh(); });
  await waitFor(() => expect(childPending).toBe(true));
  expect(screen.getByRole("button", { name: "child" })).toBeTruthy();
  expect(screen.queryByText("Loading sub-threads…")).toBeNull();
  await act(async () => { holdChildren = false; finish(); await refresh; });
  expect(screen.getByRole("button", { name: "child" })).toBeTruthy();
  mounted.unmount();
});

it("renders admitted owner rows in the real Sidebar and requests more only after a click", async () => {
  const f = fixture();
  function Window() {
    const navigation = useThreadNavigation(f.api);
    return <Sidebar backends={[]} browseMode={navigation.browseMode} directories={navigation.directories}
      threads={navigation.threads} inboxThreads={navigation.inboxThreads} pagedNavigation={navigation.pagedNavigation}
      loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
      onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
      onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />;
  }
  const mounted = render(<Window />);
  await screen.findByRole("button", { name: "thread-0" });
  expect(screen.getAllByRole("button", { name: /^thread-\d+$/ })).toHaveLength(10);
  fireEvent.click(screen.getByRole("button", { name: "Load more threads" }));
  // One click is a block of rows. The operator reaches row 109 without
  // clicking, scrolling to the button and clicking again.
  await screen.findByRole("button", { name: "thread-109" });
  expect(screen.getAllByRole("button", { name: /^thread-\d+$/ })).toHaveLength(110);
  // A click reveals a block; it does not retire the control. This owner has
  // more rows, so the operator can ask for the next block without hunting
  // for a button that quietly left.
  expect(screen.getByRole("button", { name: "Load more threads" })).toBeTruthy();
  expect(f.legacy).not.toHaveBeenCalled();
  mounted.unmount();
});

it("reconciles visible pages every five minutes without a sixty-second poll, and stops while hidden", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.selectedThreadConfigurationReady).toBe(true);
  const lensReads = (roots: "pinned" | "unpinned" = "unpinned") => f.read.mock.calls
    .filter(([request]) => request.query.kind === "lens" && request.query.roots === roots).length;
  expect(lensReads()).toBe(1);
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(lensReads()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(240_001); });
    expect(lensReads()).toBe(2);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event("blur")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(lensReads()).toBe(3);
    // The Pinned group reconciles on the same cadence as the list.
    expect(lensReads("pinned")).toBe(3);
    expect(result.current.selectedThreadConfigurationReady).toBe(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    const hiddenReads = f.read.mock.calls.length;
    const hiddenDetails = f.detail.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60_000); });
    expect(f.read).toHaveBeenCalledTimes(hiddenReads);
    expect(f.detail).toHaveBeenCalledTimes(hiddenDetails);
    expect(result.current.selectedThread?.id).toBe("thread-0");
    expect(f.release).toHaveBeenCalled();
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

it("publishes the initial visible rows together with their fallback selection", async () => {
  const f = fixture();
  const frames: Array<{ count: number; selected?: string }> = [];
  const { result, unmount } = renderHook(() => {
    const navigation = useThreadNavigation(f.api);
    frames.push({ count: navigation.threads.length, selected: navigation.selectedThread?.id });
    return navigation;
  });
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  expect(frames.some((frame) => frame.count > 0)).toBe(true);
  expect(frames.filter((frame) => frame.count > 0).every((frame) => frame.selected === "thread-0")).toBe(true);
  // Read once each: the list page and the Pinned group's page.
  expect(f.read.mock.calls.flatMap(([request]) => request.query.kind === "lens" ? [request.query.roots] : []).sort())
    .toEqual(["pinned", "unpinned"]);
  unmount();
});

it("retains an exact selected identity when a refreshed page no longer contains it", async () => {
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  const originalRead = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (request) => {
    const page = await originalRead(request);
    return request.query.kind === "lens" ? { ...page, complete: true, nextCursor: undefined,
      entries: [{ row: row("replacement"), placement: { kind: "root" }, orderKey: "replacement" }] } : page;
  });
  await act(async () => { await result.current.refresh(); });
  expect(result.current.pagedNavigation.resources.get("lens")?.state.page?.entries[0]?.row.id).toBe("replacement");
  expect(result.current.selectedItemKey).toBe("codex:thread-0");
  expect(result.current.selectedThread?.id).toBe("thread-0");
  expect(f.legacy).not.toHaveBeenCalled();
  unmount();
});

it("pauses reconciliation after thirty minutes idle and resumes from user activity", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const { unmount } = renderHook(() => useThreadNavigation(f.api));
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    const idleReads = f.read.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(f.read).toHaveBeenCalledTimes(idleReads);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(f.read.mock.calls.length).toBeGreaterThan(idleReads);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

it("refreshes exact configuration independently of unchanged collection rows", async () => {
  const f = fixture();
  let tokenMiserEnabled = true;
  f.detail.mockImplementation(async (request) => ({ protocol: 2, ref: request.ref, revision: String(tokenMiserEnabled),
    readiness: "ready", identity: "present", thread: { ...row(request.ref.threadId), updatedAt: 1000, tokenMiserEnabled } }));
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  expect(result.current.selectedThread?.tokenMiserEnabled).toBe(true);
  tokenMiserEnabled = false;
  await act(async () => { await result.current.refresh(); });
  expect(result.current.selectedThread?.tokenMiserEnabled).toBe(false);
  expect(result.current.selectedThread?.updatedAt).toBe(1000);
  expect(f.legacy).not.toHaveBeenCalled();
  unmount();
});

it("keeps viewer pins and cross-owner child counts separate from remote owner detail", async () => {
  const f = fixture();
  const target = { scope: "remote" as const, instanceId: "peer" };
  const remote = { ...row("remote"), ref: { backend: "codex" as const, threadId: "remote", ownerInstanceId: "peer" },
    federation: { ref: { backend: "codex" as const, threadId: "remote", target }, instanceLabel: "Peer" } };
  const original = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (request) => {
    const page = await original(request);
    if (request.query.kind !== "exact" || request.query.identities[0]?.ownerInstanceId !== "peer") return page;
    return { ...page, entries: [{ row: { ...remote, title: request.federationTarget ? "Owner title" : "Cached viewer title",
      pinnedRank: request.federationTarget ? "owner-rank" : "viewer-rank",
      ordinaryChildCount: request.federationTarget ? 3 : 2,
      ...(!request.federationTarget ? { viewerChildCount: 2 } : {}) }, placement: { kind: "root" }, orderKey: "r" }] };
  });
  f.detail.mockImplementation(async (request) => ({ protocol: 2, ref: request.ref, revision: "detail",
    readiness: "ready", identity: "present", thread: request.ref.ownerInstanceId ? { ...remote, pinnedRank: "owner-rank" } : row(request.ref.threadId) }));
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  act(() => result.current.selectThread(remote));
  await waitFor(() => expect(result.current.selectedThread?.pinnedRank).toBe("viewer-rank"));
  expect(result.current.selectedThread?.federation?.ref.target).toEqual(target);
  expect(result.current.pagedNavigation.resources.has("selected-viewer-mount")).toBe(true);
  expect(result.current.threads.find((thread) => thread.id === "remote")).toMatchObject({
    title: "Owner title", ordinaryChildCount: 5, viewerChildCount: 2, ownerOrdinaryChildCount: 3,
  });
  unmount();
});

it("selects the first lens row when directory readiness precedes lens publication", async () => {
  const f = fixture();
  const original = f.read.getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  f.read.mockImplementation(async (request, consumer) => {
    if (request.query.kind === "lens") await pending;
    const page = await original(request, consumer);
    if (request.query.kind === "directory-index") page.directories = [{ key: "project", kind: "workspace", label: "Project", path: "/project", counts, pinnedRootCount: 0, unpinnedRootCount: 10, launchpadPresent: true }];
    return page;
  });
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.pagedNavigation.resources.get("directory-index")?.state.page?.coverage.state).toBe("complete"));
  expect(result.current.selectedItemKey).toBeUndefined();
  await act(async () => release());
  await waitFor(() => expect(result.current.threads.length).toBeGreaterThan(0));
  await waitFor(() => expect(result.current.selectedThreadKey).toBe("codex:thread-0"));
  unmount();
});

it("keeps the unlinked directory breadcrumb for an exact selected thread", async () => {
  const f = fixture();
  const original = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (request, consumer) => {
    const page = await original(request, consumer);
    if (request.query.kind === "directory-index") page.directories = [{ key: "unlinked", kind: "unlinked", label: "No linked directory", counts, pinnedRootCount: 0, unpinnedRootCount: 10, launchpadPresent: false }];
    return page;
  });
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  expect(result.current.selectedDirectory?.key).toBe("unlinked");
  expect(result.current.pagedNavigation.selectedDirectoryKeys).toEqual(["unlinked"]);
  unmount();
});

it("does not flash a retained selection's old PR status over the current row", async () => {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  let state: NonNullable<PrSummary["checkState"]> = "passing";
  let hold = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  f.read.mockImplementation(async (request) => {
    if (hold && request.query.kind === "exact" && request.query.identities[0]?.threadId === "thread-0") await pending;
    const page = await originalRead(request);
    return { ...page, entries: page.entries.map((entry) => ({ ...entry, row: { ...entry.row,
      prs: [{ provider: "github.com", org: "fixture", repo: "project", number: 1,
        url: "https://github.com/fixture/project/pull/1", state, checkState: state }],
    } })) };
  });
  const frames: Array<PrSummary["state"] | undefined> = [];
  const { result } = renderHook(() => {
    const navigation = useThreadNavigation(f.api);
    frames.push(navigation.threads.find((thread) => thread.id === "thread-0")?.prs?.[0]?.state);
    return navigation;
  });
  await waitFor(() => expect(result.current.pagedNavigation.resources.get("selected-context")?.state.page).toBeDefined());
  act(() => result.current.selectThread(row("thread-1")));
  await waitFor(() => expect(result.current.selectedThread?.id).toBe("thread-1"));
  state = "pending";
  await act(() => result.current.refresh());
  expect(result.current.threads.find((thread) => thread.id === "thread-0")?.prs?.[0]?.state).toBe("pending");
  hold = true;
  frames.length = 0;
  act(() => result.current.selectThread(row("thread-0")));
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((state) => state === "pending")).toBe(true);
  // A fresh response must still be allowed to change the chip's state.
  state = "failing";
  await act(async () => { release(); await pending; });
  await waitFor(() => expect(result.current.threads.find((thread) => thread.id === "thread-0")?.prs?.[0]?.state).toBe("failing"));
});

it.each([
  { owner: "local", outcome: "success" },
  { owner: "local", outcome: "failure" },
  { owner: "remote", outcome: "success" },
  { owner: "remote", outcome: "failure" },
])("keeps unrelated peer reads out of a $owner Claude archive $outcome", async ({ owner, outcome }) => {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  const peer = { scope: "remote" as const, instanceId: "unrelated-peer" };
  const mounted = { ...row("mounted"), ref: { ...row("mounted").ref, ownerInstanceId: peer.instanceId },
    federation: { ref: { backend: "codex" as const, threadId: "mounted", target: peer }, instanceLabel: "Fixture peer" } };
  const archiveOwner = { scope: "remote" as const, instanceId: "archive-owner" };
  const claude: NavigationRow = { ...row("claude-target"), source: "claude",
    ref: { backend: "claude", threadId: "claude-target", ...(owner === "remote" ? { ownerInstanceId: archiveOwner.instanceId } : {}) },
    ...(owner === "remote" ? { federation: { ref: { backend: "claude" as const, threadId: "claude-target", target: archiveOwner }, instanceLabel: "Archive owner" } } : {}) };
  let archived = false;
  let peerBusy = false;
  f.read.mockImplementation(async (request, consumer) => {
    if (request.federationTarget?.scope === "remote" && request.federationTarget.instanceId === peer.instanceId && peerBusy) {
      throw new Error("handler_failed: [navigation_busy] Navigation read cancelled or its deadline expired.");
    }
    const page = await originalRead(request, consumer);
    if (request.query.kind === "exact" && request.query.identities[0]?.threadId === claude.id) {
      return { ...page, entries: archived ? [] : [{ row: claude, placement: { kind: "root" }, orderKey: "a" }] };
    }
    if (request.query.kind === "lens" && request.query.roots !== "pinned") {
      return { ...page, complete: true, nextCursor: undefined, entries: [
        ...(archived ? [] : [{ row: claude, placement: { kind: "root" as const }, orderKey: "a" }]),
        { row: row("survivor"), placement: { kind: "root" as const }, orderKey: "a2" },
        { row: mounted, placement: { kind: "root" as const }, orderKey: "b" },
      ] };
    }
    return page;
  });
  const archiveThread = vi.fn<NonNullable<DesktopApi["archiveThread"]>>(async () => {
    if (outcome === "failure") throw new Error("Claude archive failed");
    archived = true;
    return { backend: "claude", threadId: claude.id, archivedAt: 1, cleanup: [] };
  });
  const removeRemoteThreadPin = vi.fn(async () => ({ removed: true }));
  const api = { ...f.api, archiveThread, removeRemoteThreadPin };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  await waitFor(() => {
    expect(result.current.threads.some((thread) => thread.id === claude.id)).toBe(true);
    expect([...result.current.pagedNavigation.resources.values()].some((resource) =>
      resource.state.request.federationTarget?.scope === "remote" && resource.state.page && !resource.loading)).toBe(true);
    expect([...result.current.pagedNavigation.resources.values()].every((resource) => !resource.loading)).toBe(true);
  });
  f.read.mockClear();
  peerBusy = true;
  await act(async () => { await result.current.archiveThread(claude); });
  expect(archiveThread).toHaveBeenCalledWith({ backend: "claude", threadId: claude.id,
    ...(owner === "remote" ? { federationTarget: archiveOwner } : { backgroundCleanup: true }) });
  expect(f.read.mock.calls.some(([request]) => request.federationTarget?.scope === "remote"
    && request.federationTarget.instanceId === peer.instanceId)).toBe(false);
  expect(f.read.mock.calls.some(([request]) => request.federationTarget?.scope !== "remote")).toBe(true);
  if (owner === "remote" && outcome === "failure") {
    expect(f.read.mock.calls.some(([request]) => request.federationTarget?.scope === "remote"
      && request.federationTarget.instanceId === archiveOwner.instanceId)).toBe(true);
  }
  expect([...result.current.pagedNavigation.resources.values()].some((resource) => resource.state.error)).toBe(false);
  expect(result.current.threads.some((thread) => thread.id === claude.id)).toBe(outcome === "failure");
  expect(removeRemoteThreadPin).toHaveBeenCalledTimes(owner === "remote" && outcome === "success" ? 1 : 0);
  unmount();
});

/** An owner with one local project whose Forge Automation the test can change. */
function forgeAutomationOwner(row: Partial<NavigationDirectoryRow> = {}) {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  const key = row.key ?? "directory:/openclaw";
  const owner: { automation?: ProjectForgeAutomation } = {};
  f.read.mockImplementation(async (request) => {
    const page = await originalRead(request);
    return request.query.kind === "directory-index" ? { ...page, directories: [{ key, kind: "directory", label: "openclaw",
      path: "/openclaw", counts, pinnedRootCount: 0, unpinnedRootCount: 1, launchpadPresent: false, ...row,
      ...(owner.automation ? { forgeAutomation: owner.automation } : {}) }] } : page;
  });
  return { f, key, owner };
}

const PAUSED: ProjectForgeAutomation = { ...DEFAULT_PROJECT_FORGE_AUTOMATION, paused: true, pausedAt: 1_000 };

it("saves a project's Forge Automation without a federation target and shows what the owner stored", async () => {
  const { f, key, owner } = forgeAutomationOwner();
  const setProjectForgeAutomation = vi.fn<NonNullable<DesktopApi["setProjectForgeAutomation"]>>(async (request) => {
    owner.automation = request.automation;
    return { directoryKey: request.directoryKey, automation: request.automation };
  });
  const api = { ...f.api, setProjectForgeAutomation };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  const project = () => result.current.directories.find((directory) => directory.key === key);
  await waitFor(() => expect(project()).toBeDefined());
  expect(project()?.forgeAutomation).toBeUndefined();

  await act(() => result.current.setProjectForgeAutomation(project()!, PAUSED));
  expect(setProjectForgeAutomation).toHaveBeenCalledWith({ directoryKey: key, automation: PAUSED });
  expect(project()?.forgeAutomation).toEqual(PAUSED);

  // Back to the defaults: the row carries nothing, as the owner sends it.
  await act(() => result.current.setProjectForgeAutomation(project()!, { ...DEFAULT_PROJECT_FORGE_AUTOMATION }));
  expect(project()?.forgeAutomation).toBeUndefined();
  unmount();
});

it("names a peer window's owner on every Forge Automation request", async () => {
  const { f, key } = forgeAutomationOwner();
  const target = { scope: "remote" as const, instanceId: "peer-owner" };
  const setProjectForgeAutomation = vi.fn<NonNullable<DesktopApi["setProjectForgeAutomation"]>>(async (request) => ({
    directoryKey: request.directoryKey, automation: request.automation,
  }));
  const listProjectHeldWakeups = vi.fn<NonNullable<DesktopApi["listProjectHeldWakeups"]>>(async (request) => ({
    directoryKey: request.directoryKey, wakeups: [],
  }));
  const resolveProjectHeldWakeups = vi.fn<NonNullable<DesktopApi["resolveProjectHeldWakeups"]>>(async () => ({ results: [] }));
  const api = { ...f.api, setProjectForgeAutomation, listProjectHeldWakeups, resolveProjectHeldWakeups };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  const project = () => result.current.directories.find((directory) => directory.key === key);
  await waitFor(() => expect(project()).toBeDefined());
  const targetWindow = window as unknown as { __pwragentFederationTarget?: unknown };
  targetWindow.__pwragentFederationTarget = target;
  onTestFinished(() => { delete targetWindow.__pwragentFederationTarget; });

  await act(() => result.current.setProjectForgeAutomation(project()!, PAUSED));
  await act(async () => { await result.current.listProjectHeldWakeups(project()!); });
  await act(async () => { await result.current.resolveProjectHeldWakeups(project()!, []); });

  expect(setProjectForgeAutomation).toHaveBeenCalledWith({ directoryKey: key, automation: PAUSED, federationTarget: target });
  expect(listProjectHeldWakeups).toHaveBeenCalledWith({ directoryKey: key, federationTarget: target });
  expect(resolveProjectHeldWakeups).toHaveBeenCalledWith({ directoryKey: key, resolutions: [], federationTarget: target });
  unmount();
});

it("sends a placeholder's Forge Automation to the peer that owns its project, and updates the placeholder", async () => {
  const target = { scope: "remote" as const, instanceId: "peer-owner" };
  const peerKey = "directory:/peer/openclaw";
  const { f, key } = forgeAutomationOwner({ key: "unconfigured-directory:openclaw",
    localAvailability: "unconfigured", peerProject: { target, directoryKey: peerKey } });
  const setProjectForgeAutomation = vi.fn<NonNullable<DesktopApi["setProjectForgeAutomation"]>>(async (request) => ({
    directoryKey: request.directoryKey, automation: request.automation,
  }));
  const listProjectHeldWakeups = vi.fn<NonNullable<DesktopApi["listProjectHeldWakeups"]>>(async (request) => ({
    directoryKey: request.directoryKey, wakeups: [],
  }));
  const resolveProjectHeldWakeups = vi.fn<NonNullable<DesktopApi["resolveProjectHeldWakeups"]>>(async () => ({ results: [] }));
  const api = { ...f.api, setProjectForgeAutomation, listProjectHeldWakeups, resolveProjectHeldWakeups };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  const project = () => result.current.directories.find((directory) => directory.key === key);
  await waitFor(() => expect(project()?.peerProject).toEqual({ target, directoryKey: peerKey }));

  await act(() => result.current.setProjectForgeAutomation(project()!, PAUSED));
  await act(async () => { await result.current.listProjectHeldWakeups(project()!); });
  await act(async () => { await result.current.resolveProjectHeldWakeups(project()!, []); });

  expect(setProjectForgeAutomation).toHaveBeenCalledWith({ directoryKey: peerKey, automation: PAUSED, federationTarget: target });
  expect(listProjectHeldWakeups).toHaveBeenCalledWith({ directoryKey: peerKey, federationTarget: target });
  expect(resolveProjectHeldWakeups).toHaveBeenCalledWith({ directoryKey: peerKey, resolutions: [], federationTarget: target });
  // The owner answers with its key; the placeholder row is the one shown.
  expect(project()?.forgeAutomation).toEqual(PAUSED);
  unmount();
});

it("raises a failed Forge Automation save as a toast unless the caller shows it", async () => {
  const { f, key } = forgeAutomationOwner();
  const onThreadActionError = vi.fn();
  const api = { ...f.api, setProjectForgeAutomation: vi.fn(async () => {
    throw new Error("Owner refused");
  }) };
  const { result, unmount } = renderHook(() => useThreadNavigation(api, { onThreadActionError }));
  const project = () => result.current.directories.find((directory) => directory.key === key);
  await waitFor(() => expect(project()).toBeDefined());

  await act(async () => {
    await expect(result.current.setProjectForgeAutomation(project()!, PAUSED, { reportError: false }))
      .rejects.toThrow("Owner refused");
  });
  expect(onThreadActionError).not.toHaveBeenCalledWith(expect.objectContaining({ message: "Owner refused" }));

  await act(async () => {
    await expect(result.current.setProjectForgeAutomation(project()!, PAUSED)).rejects.toThrow("Owner refused");
  });
  expect(onThreadActionError).toHaveBeenLastCalledWith({ kind: "forge-automation", message: "Owner refused" });
  expect(project()?.forgeAutomation).toBeUndefined();
  unmount();
});

it("applies the owner's directory/forgeAutomation/updated event, and null clears it", async () => {
  const { f, key, owner } = forgeAutomationOwner();
  // The hook subscribes more than once, so every subscriber hears the event.
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent) => listeners.forEach((listener) => listener(event));
  const api = { ...f.api,
    onAgentEvent: (callback: (event: AgentEvent) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; } };
  const { result, unmount } = renderHook(() => useThreadNavigation(api));
  const project = () => result.current.directories.find((directory) => directory.key === key);
  await waitFor(() => expect(project()).toBeDefined());

  owner.automation = PAUSED;
  act(() => emit({ backend: "codex", notification: { method: "directory/forgeAutomation/updated",
    params: { directoryKey: key, automation: PAUSED } } } as AgentEvent));
  expect(project()?.forgeAutomation).toEqual(PAUSED);

  owner.automation = undefined;
  act(() => emit({ backend: "codex", notification: { method: "directory/forgeAutomation/updated",
    params: { directoryKey: key, automation: null } } } as AgentEvent));
  expect(project()?.forgeAutomation).toBeUndefined();
  await waitFor(() => expect([...result.current.pagedNavigation.resources.values()]
    .every((resource) => !resource.loading && !resource.state.stale)).toBe(true));
  expect(project()?.forgeAutomation).toBeUndefined();
  unmount();
});

it("keeps one PR burst bounded across 36 open project collections and preserves the selection", async () => {
  const f = fixture();
  const defaultRead = f.read.getMockImplementation()!;
  const directories: NavigationDirectoryRow[] = Array.from({ length: 12 }, (_, index) => ({
    key: `directory:/project-${index}`, kind: "directory", label: `Project ${index}`, path: `/project-${index}`,
    counts: { ...counts, total: 25 }, pinnedRootCount: 1, unpinnedRootCount: 23, launchpadPresent: false,
  }));
  const target = { scope: "remote", instanceId: "fixture-peer" } as const;
  const pr: PrSummary = { provider: "github.com", org: "fixture", repo: "unified", number: 71,
    url: "https://github.com/fixture/unified/pull/71", state: "pending" };
  const selected = row("selection");
  let prState: PrSummary["state"] = "pending";
  const responses: Array<() => void> = [];
  let staggerResponses = false;
  const projectRows = (directoryKey: string, pinned: boolean) => {
    if (pinned) return [{ ...row(`${directoryKey}/root`), pinnedRank: "1024", ordinaryChildCount: 1 }];
    return Array.from({ length: 23 }, (_, index) => ({ ...row(`${directoryKey}/thread-${index}`),
      ...(index === 0 ? { prs: [{ ...pr, number: 72, url: "https://github.com/fixture/unified/pull/72" }] } : {}),
    }));
  };
  const peerChild = (threadId: string, parentThreadId?: string): NavigationRow => ({
    ...row(threadId), parentThreadId, rowRevision: prState,
    ref: { backend: "codex", threadId, ownerInstanceId: target.instanceId },
    federation: { ref: { backend: "codex", threadId, target }, instanceLabel: "Fixture peer" },
    prs: [{ ...pr, state: prState }],
  });
  f.read.mockImplementation(async (request, consumer) => {
    const baseline = await defaultRead(request, consumer);
    if (staggerResponses) await new Promise<void>((resolve) => { responses.push(resolve); });
    const query = request.query;
    if (query.kind === "directory-index") return { ...baseline, directories, viewerRowOwners: [target.instanceId] };
    const directoryKey = query.kind === "directory" || query.kind === "children" ? query.directoryKey : undefined;
    let members: NavigationRow[];
    if (query.kind === "directory" && directoryKey) members = projectRows(directoryKey, query.roots === "pinned");
    else if (query.kind === "children") {
      const child = { ...row(`${query.parent.threadId}/child`), parentThreadId: query.parent.threadId };
      members = [directoryKey === directories[0]!.key ? peerChild(child.id, child.parentThreadId) : child];
    } else if (query.kind === "exact" && request.federationTarget?.scope === "remote") {
      members = query.identities.map(({ threadId }) => peerChild(threadId));
    } else if (query.kind === "exact" && query.identities.some(({ threadId }) => threadId === selected.id)) {
      members = [selected];
    } else return baseline;
    const nativeViewerRows = request.federationTarget?.scope !== "remote" && members.every((member) => !member.federation);
    const proof = nativeViewerRows ? { prKeysComplete: true as const, prKeys: members.flatMap((member) =>
      member.prs?.map(buildPullRequestStatusKey) ?? []) } : { prKeys: [] };
    const entries = members.map((row) => ({ row, placement: { kind: "root" as const }, orderKey: row.id }));
    return { ...baseline, entries, complete: true, nextCursor: undefined, viewerRowOwners: [target.instanceId],
      metadataDependencies: { version: 1, threadKeys: members.map(({ ref }) => navigationIdentityKey(ref)),
        ...proof },
    };
  });
  let listener: ((event: AgentEvent) => void) | undefined;
  let task: (() => void) | undefined;
  const scheduleNavigationRefresh = (callback: () => void) => { task = callback; return () => { task = undefined; }; };
  const api: DesktopApi = { ...f.api, onAgentEvent: (callback) => { listener = callback; return () => { listener = undefined; }; } };
  let commits = 0;
  const { result, unmount } = renderHook(() => {
    const navigation = useThreadNavigation(api, { scheduleNavigationRefresh });
    useLayoutEffect(() => { commits++; });
    return navigation;
  });
  const projectQueries = () => [...result.current.pagedNavigation.resources.values()].filter(({ state }) =>
    state.request.query.kind === "directory" || state.request.query.kind === "children");
  try {
    await waitFor(() => expect(result.current.directories).toHaveLength(12));
    act(() => {
      result.current.setBrowseMode("directories");
      result.current.directoryDisclosure.setExpandedByKey(Object.fromEntries(directories.map(({ key }) => [key, true])));
      result.current.selectThread(selected);
    });
    await waitFor(() => {
      expect(projectQueries()).toHaveLength(36);
      expect(projectQueries().every(({ state, loading }) => state.page && !loading)).toBe(true);
      expect(result.current.selectedThreadConfigurationReady).toBe(true);
    });
    f.read.mockClear();
    commits = 0;
    staggerResponses = true;
    await act(async () => {
      prState = "passing";
      for (let index = 0; index < 4; index++) listener?.({ backend: "codex", federationTarget: target,
        notification: { method: "navigation/invalidated", params: { sourceMethod: "pullRequest/status/updated" } } });
      const dispatch = task;
      task = undefined;
      dispatch?.();
    });
    // Cross-process responses can land in separate turns and each cause a
    // commit. Advance one response at a time without using wall-clock delay.
    while (responses.length) await act(async () => { responses.shift()!(); });
    expect({ reads: f.read.mock.calls.length, commits,
      row: result.current.threads.find((thread) => thread.federation)?.prs?.[0]?.state,
      page: projectQueries().flatMap(({ state }) => state.page?.entries ?? []).find(({ row }) => row.federation)?.row.prs?.[0]?.state })
      .toEqual({ reads: 2, commits: 6, row: "passing", page: "passing" });
    expect(result.current.selectedThreadKey).toBe("codex:selection");
  } finally { unmount(); }
});
