import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationRow, NavigationSelectedDetailResponse } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";
import { Sidebar } from "../../features/navigation/Sidebar";

const counts = { total: 1000, active: 40, unread: 90, review: 50 };
const row = (id: string): NavigationRow => ({ id, source: "codex", title: id, titleSource: "fallback", ref: { backend: "codex", threadId: id },
  rowRevision: "r", linkedDirectories: [], inbox: { inInbox: true }, ordinaryChildCount: 0,
  nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" });
function fixture() {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request): Promise<NavigationQueryPage> => {
    const offset = Number(request.cursor ?? 0);
    const entries = request.query.kind === "lens" ? Array.from({ length: 10 }, (_, i) => row(`thread-${offset + i}`))
      : request.query.kind === "exact" ? request.query.identities.map((ref) => row(ref.threadId)) : [];
    return { protocol: 2, queryKey: JSON.stringify(request.query), generation: "g", ownerEpoch: "owner", countsRevision: "r",
      coverage: { state: "complete" }, counts, entries: entries.map((row) => ({ row, placement: { kind: "root" }, orderKey: row.id })),
      directories: [], complete: request.query.kind !== "lens", nextCursor: request.query.kind === "lens" ? String(offset + 10) : undefined };
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

it("fences a page started before an accepted relative pin move and accepts the next owner baseline", async () => {
  const f = fixture();
  const originalRead = f.read.getMockImplementation()!;
  let rank = "1024";
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
  const api = { ...f.api, reorderThreadPins };
  const { result } = renderHook(() => useThreadNavigation(api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  hold = true;
  let refresh!: Promise<void>;
  act(() => { refresh = result.current.refresh(); });
  await waitFor(() => expect(captured).toBe(true));
  await act(() => result.current.reorderThreadPins([], { key: "codex:thread-0", direction: "down" }));
  await act(async () => { hold = false; release(); await refresh; });
  expect(result.current.threads.find((thread) => thread.id === "thread-0")?.pinnedRank).toBe("3072");
  expect(reorderThreadPins).toHaveBeenCalledWith({ federationTarget: undefined, move: { key: "codex:thread-0", direction: "down" } });
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
  await waitFor(() => expect(f.read.mock.calls.some(([request]) => request.query.kind === "directory" && request.query.roots === "all")).toBe(true));
  await act(() => result.current.setDirectoryThreadsCollapsed(result.current.directories.find((directory) => directory.key === key)!, true));
  await waitFor(() => expect(f.read.mock.calls.some(([request]) => request.query.kind === "directory" && request.query.roots === "pinned")).toBe(true));
  await act(() => result.current.refresh());
  expect(result.current.directories.find((directory) => directory.key === key)?.directoryThreadsCollapsed).toBe(true);
  expect(result.current.pagedNavigation.resources.get(`directory:${key}`)?.state.request.query).toMatchObject({ roots: "pinned" });
  expect(f.legacy).not.toHaveBeenCalled();
});

it("loads one owner lens page and exact selection, preserving complete counts independently", async () => {
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  expect(f.legacy).not.toHaveBeenCalled();
  expect(result.current.pagedNavigation.resources.get("lens")?.state.page?.entries).toHaveLength(10);
  expect(result.current.pagedNavigation.resources.get("directory-index")?.state.page?.counts).toEqual(counts);
  expect(f.read.mock.calls.filter(([r]) => r.query.kind === "lens")).toHaveLength(1);
  await act(() => result.current.pagedNavigation.loadMore("lens"));
  expect(result.current.pagedNavigation.resources.get("lens")?.state.page?.entries).toHaveLength(20);
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
  await screen.findByRole("button", { name: "thread-19" });
  expect(screen.getAllByRole("button", { name: /^thread-\d+$/ })).toHaveLength(20);
  expect(f.legacy).not.toHaveBeenCalled();
  mounted.unmount();
});

it("reconciles visible pages every five minutes without a sixty-second poll, and stops while hidden", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.selectedThreadConfigurationReady).toBe(true);
  const lensReads = () => f.read.mock.calls.filter(([request]) => request.query.kind === "lens").length;
  expect(lensReads()).toBe(1);
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(lensReads()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(240_001); });
    expect(lensReads()).toBe(2);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event("blur")); });
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
  expect(f.read.mock.calls.filter(([request]) => request.query.kind === "lens")).toHaveLength(1);
  unmount();
});

it("retains an exact selected identity when a refreshed page no longer contains it", async () => {
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  const originalRead = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (request) => {
    const page = await originalRead(request);
    return request.query.kind === "lens" ? { ...page, entries: [{ row: row("replacement"), placement: { kind: "root" }, orderKey: "replacement" }] } : page;
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
