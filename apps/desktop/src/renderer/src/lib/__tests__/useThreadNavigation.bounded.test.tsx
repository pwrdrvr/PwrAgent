import { act, fireEvent, render, renderHook, screen, waitFor } from "../../test/phase-probes";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_FORGE_AUTOMATION, type AgentEvent, type NavigationQueryPage, type NavigationRow, type NavigationSelectedDetailResponse, type PrSummary, type ProjectForgeAutomation } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";
import { Sidebar } from "../../features/navigation/Sidebar";
import { useHoverStableSnapshot } from "../../features/navigation/useHoverStableSnapshot";

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
  return { f, key, setDirectoryPin, holdIndexReads };
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
function forgeAutomationOwner() {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  const key = "directory:/openclaw";
  const owner: { automation?: ProjectForgeAutomation } = {};
  f.read.mockImplementation(async (request) => {
    const page = await originalRead(request);
    return request.query.kind === "directory-index" ? { ...page, directories: [{ key, kind: "directory", label: "openclaw",
      path: "/openclaw", counts, pinnedRootCount: 0, unpinnedRootCount: 1, launchpadPresent: false,
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
