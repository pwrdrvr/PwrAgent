import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationDirectoryRow, NavigationQueryPage, NavigationRow } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";

const directory: NavigationDirectoryRow = { key: "directory:off-page", kind: "directory", label: "Project",
  counts: { total: 1000, active: 20, unread: 30, review: 10 }, pinnedRootCount: 4, unpinnedRootCount: 996, launchpadPresent: false };
const base = { browseMode: "directories" as const, attentionView: { id: "window", promoteOnTurnEnd: true },
  expandedByKey: {}, unpinnedExpandedByKey: {}, enabled: true, visible: true };
function page(patch: Partial<NavigationQueryPage> = {}): NavigationQueryPage {
  return { protocol: 2, queryKey: "query", generation: "g", ownerEpoch: "owner", countsRevision: "r",
    counts: { total: 1000, active: 20, unread: 30, review: 10 }, coverage: { state: "complete" }, entries: [], complete: true, ...patch };
}
function api() {
  let listener: ((event: AgentEvent) => void) | undefined;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => page({
    directories: request.query.kind === "directory-index" ? request.query.keys ? [directory] : [] : undefined,
  }));
  const release = vi.fn(async () => undefined);
  return { read, release, emit: (event: AgentEvent) => act(() => listener?.(event)),
    desktopApi: { getNavigationQueryPage: read, releaseNavigationQuery: release,
      onAgentEvent: (callback: (event: AgentEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
    } satisfies DesktopApi };
}

it.each([5, 35])("restores selected root %s without discarding the first page when it already contains that root", async (index) => {
  const fixture = api();
  const selectedRef = { backend: "codex" as const, threadId: `thread-${index}` };
  const row = (position: number): NavigationRow => ({
    id: `thread-${position}`, source: "codex", title: `Thread ${position}`, titleSource: "fallback",
    ref: { backend: "codex", threadId: `thread-${position}` }, rowRevision: "row", linkedDirectories: [],
    inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
    queueCount: 0, queueState: "unknown", ...(position === 0 ? { pinnedRank: "1024" } : {}),
  });
  fixture.read.mockImplementation(async (request) => {
    if (request.query.kind === "directory-index") return page({ directories: [directory] });
    if (request.query.kind === "exact") return page({ entries: [{ row: row(index), placement: { kind: "root" }, orderKey: "selected" }] });
    if (request.query.kind === "directory" && request.query.roots === "pinned") return page({ entries: [{ row: row(0), placement: { kind: "root" }, orderKey: "0" }] });
    const offset = request.cursor ? Number(request.cursor) : request.anchor?.kind === "thread" ? Number(request.anchor.ref.threadId.slice("thread-".length)) : 1;
    return page({ complete: false, nextCursor: String(offset + 10), ...(offset ? { rangeStart: offset } : {}),
      entries: Array.from({ length: 10 }, (_, i) => ({ row: row(offset + i), placement: { kind: "root" as const }, orderKey: String(offset + i) })),
    });
  });
  const { result, unmount } = renderHook(() => useBoundedNavigationWindow({ ...base, desktopApi: fixture.desktopApi,
    selectedRef, selectedDirectoryKeys: [directory.key],
  }));
  const id = `directory:${directory.key}`;
  await waitFor(() => expect(result.current.resources.get(id)?.state.page?.entries.some((entry) => entry.row.id === selectedRef.threadId)).toBe(true));
  const reads = fixture.read.mock.calls.map(([request]) => request).filter((request) => request.query.kind === "directory" && request.query.roots === "unpinned");
  expect(reads[0]?.anchor).toBeUndefined();
  expect(reads).toHaveLength(index < 10 ? 1 : 2);
  expect(result.current.resources.get(id)?.state.page?.entries[0]?.row.id).toBe(index < 10 ? "thread-1" : "thread-35");
  if (index >= 10) expect(reads[1]?.anchor).toEqual({ kind: "thread", ref: selectedRef });
  const pinsId = `directory-pins:${directory.key}`;
  const pins = () => result.current.resources.get(pinsId)?.state.page?.entries.map((entry) => entry.row.id);
  expect(pins()).toEqual(["thread-0"]);
  await act(() => result.current.loadMore(id));
  expect(result.current.resources.get(id)?.state.page?.entries).toHaveLength(20);
  expect(pins()).toEqual(["thread-0"]);
  await act(() => result.current.refresh());
  expect(result.current.resources.get(id)?.state.page?.entries).toHaveLength(20);
  expect(pins()).toEqual(["thread-0"]);
  unmount();
});

it("retains twelve loaded pages while a new selection in an explicitly expanded folder resolves", async () => {
  const fixture = api();
  const row = (position: number): NavigationRow => ({ id: `thread-${position}`, source: "codex", title: `Thread ${position}`,
    titleSource: "fallback", ref: { backend: "codex", threadId: `thread-${position}` }, rowRevision: "r", linkedDirectories: [],
    inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" });
  let finishSelection!: () => void;
  const pendingSelection = new Promise<void>((resolve) => { finishSelection = resolve; });
  fixture.read.mockImplementation(async (request) => {
    if (request.query.kind === "directory-index") return page({ directories: [directory] });
    if (request.query.kind === "exact") {
      const position = Number(request.query.identities[0]!.threadId.slice(7));
      if (position === 119) await pendingSelection;
      return page({ entries: [{ row: row(position), placement: { kind: "root" }, orderKey: "selected" }] });
    }
    if (request.query.kind === "directory" && request.query.roots === "pinned") return page();
    const offset = Number(request.cursor ?? 0);
    return page({ complete: false, nextCursor: String(offset + 10), entries: Array.from({ length: 10 }, (_, i) => ({
      row: row(offset + i), placement: { kind: "root" as const }, orderKey: String(offset + i),
    })) });
  });
  const { result, rerender, unmount } = renderHook(({ selected }) => useBoundedNavigationWindow({ ...base,
    desktopApi: fixture.desktopApi, expandedByKey: { [directory.key]: true }, selectedDirectoryKeys: [directory.key],
    selectedRef: { backend: "codex", threadId: `thread-${selected}` },
  }), { initialProps: { selected: 0 } });
  const id = `directory:${directory.key}`;
  await waitFor(() => expect(result.current.resources.get(id)?.state.page?.entries).toHaveLength(10));
  for (let i = 0; i < 11; i++) await act(() => result.current.loadMore(id));
  const retained = result.current.resources.get(id)?.state.page;
  expect(retained?.entries).toHaveLength(120);
  fixture.release.mockClear();
  rerender({ selected: 119 });
  expect(result.current.resources.get(id)?.state.page).toBe(retained);
  await act(async () => finishSelection());
  await waitFor(() => expect(result.current.resources.get("selected-context")?.loading).toBe(false));
  expect(result.current.resources.get(id)?.state.page).toBe(retained);
  // Only selected-context is replaced, never either directory section.
  expect(fixture.release).toHaveBeenCalledTimes(1);
  unmount();
});

it("resolves selected off-page descriptors exactly without repeatedly dropping their demand", async () => {
  const fixture = api();
  const { result, unmount } = renderHook(() => useBoundedNavigationWindow({ ...base, desktopApi: fixture.desktopApi,
    selectedDirectoryKeys: [directory.key],
  }));
  await waitFor(() => expect(result.current.resources.get(`directory:${directory.key}`)?.loading).toBe(false));
  expect(result.current.directories).toEqual([directory]);
  expect(fixture.read.mock.calls.map(([request]) => request.query)).toEqual([
    { kind: "directory-index" }, { kind: "directory-index", keys: [directory.key] },
    { kind: "directory", directoryKey: directory.key, roots: "pinned" },
    { kind: "directory", directoryKey: directory.key, roots: "unpinned" },
  ]);
  expect(result.current.resources.has("selected-directories")).toBe(true);
  unmount();
  expect(fixture.release).toHaveBeenCalledTimes(4);
});

it("does not fetch hidden demand, survives StrictMode restart, and retains pages when hidden", async () => {
  const fixture = api();
  const { result, rerender, unmount } = renderHook(({ visible }) => useBoundedNavigationWindow({ ...base,
    desktopApi: fixture.desktopApi, visible,
  }), { initialProps: { visible: false }, wrapper: StrictMode });
  await act(async () => undefined);
  expect(fixture.read).not.toHaveBeenCalled();
  rerender({ visible: true });
  await waitFor(() => expect(result.current.resources.get("directory-index")?.state.page).toBeDefined());
  expect(fixture.read).toHaveBeenCalledTimes(1);
  rerender({ visible: false });
  expect(result.current.resources.get("directory-index")?.state.page?.counts.total).toBe(1000);
  await act(() => result.current.refresh());
  expect(fixture.read).toHaveBeenCalledTimes(1);
  unmount();
});

it("deduplicates connected events and refreshes only the affected owner after a reconnect", async () => {
  const fixture = api();
  const { result, unmount } = renderHook(() => useBoundedNavigationWindow({ ...base, desktopApi: fixture.desktopApi,
    target: { scope: "remote", instanceId: "owner" },
  }));
  await waitFor(() => expect(result.current.resources.get("directory-index")?.loading).toBe(false));
  const peer = (instanceId: string, status: "connected" | "disconnected") => ({ backend: "codex" as const,
    notification: { method: "federation/peerStatus/changed" as const, params: { instanceId, status } },
  }) as AgentEvent;
  fixture.emit(peer("other", "disconnected"));
  fixture.emit(peer("owner", "connected"));
  fixture.emit(peer("owner", "connected"));
  expect(fixture.read).toHaveBeenCalledTimes(1);
  fixture.emit(peer("owner", "disconnected"));
  expect(result.current.connected).toBe(false);
  fixture.emit(peer("owner", "connected"));
  fixture.emit(peer("owner", "connected"));
  await waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(2));
  expect(result.current.connected).toBe(true);
  unmount();
});

it("coalesces canonical owner row changes and ignores stream events and another owner", async () => {
  const fixture = api();
  const { result, unmount } = renderHook(() => useBoundedNavigationWindow({ ...base, desktopApi: fixture.desktopApi }));
  await waitFor(() => expect(result.current.resources.get("directory-index")?.loading).toBe(false));
  for (const method of ["thread/pullRequests/updated", "navigation/threadDirectories/updated", "thread/pin/added"]) {
    fixture.emit({ backend: "codex", notification: { method, params: { threadId: "off-page" } } } as AgentEvent);
  }
  fixture.emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "other" },
    notification: { method: "thread/status/changed", params: { threadId: "off-page", status: { type: "active" } } },
  } as AgentEvent);
  fixture.emit({ backend: "codex", notification: { method: "item/agentMessage/delta", params: {} } } as AgentEvent);
  expect(result.current.resources.get("directory-index")?.state.stale).toBe(true);
  await waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(2));
  expect(fixture.read.mock.calls[1]?.[0].completeBaselineRevision).toBeUndefined();
  unmount();
});

it.each([false, true])("preserves thirty loaded pins when selecting a new last pin during refresh=%s", async (race) => {
  const fixture = api();
  const row = (position: number): NavigationRow => ({ id: `pin-${position}`, source: "codex", title: `Pin ${position}`,
    titleSource: "explicit", ref: { backend: "codex", threadId: `pin-${position}` }, rowRevision: "r",
    pinnedRank: String((position + 1) * 1024), linkedDirectories: [], inbox: { inInbox: false },
    ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" });
  let finishRefresh!: () => void;
  const gate = new Promise<void>((resolve) => { finishRefresh = resolve; });
  let hold = false;
  fixture.read.mockImplementation(async (request) => {
    if (request.query.kind === "directory-index") return page({ directories: [directory] });
    if (request.query.kind === "exact") {
      const position = Number(request.query.identities[0]!.threadId.slice(4));
      return page({ selectionDirectory: directory, entries: [{ row: row(position), placement: { kind: "root" }, orderKey: String(position) }] });
    }
    if (request.query.kind !== "directory" || request.query.roots !== "pinned") return page();
    if (hold && !request.cursor) { hold = false; await gate; }
    const start = request.anchor?.kind === "thread" ? Number(request.anchor.ref.threadId.slice(4)) : Number(request.cursor ?? 0);
    const end = Math.min(start + 10, 31);
    return page({ rangeStart: start, complete: end === 31, nextCursor: end < 31 ? String(end) : undefined,
      entries: Array.from({ length: end - start }, (_, i) => ({ row: row(start + i), placement: { kind: "root" as const }, orderKey: String(start + i) })) });
  });
  const { result, rerender, unmount } = renderHook(({ selected }) => useBoundedNavigationWindow({ ...base,
    desktopApi: fixture.desktopApi, expandedByKey: { [directory.key]: true }, selectedDirectoryKeys: [directory.key],
    selectedRef: { backend: "codex", threadId: `pin-${selected}` },
  }), { initialProps: { selected: 0 } });
  const id = `directory-pins:${directory.key}`;
  await waitFor(() => expect(result.current.resources.get(id)?.state.page?.entries).toHaveLength(10));
  await act(() => result.current.loadMore(id));
  await act(() => result.current.loadMore(id));
  let refreshing: Promise<void> | undefined;
  if (race) { hold = true; act(() => { refreshing = result.current.refresh(); }); }
  rerender({ selected: 30 });
  await waitFor(() => expect(result.current.resources.get("selected-context")?.state.page?.entries[0]?.row.id).toBe("pin-30"));
  if (race) await act(async () => { finishRefresh(); await refreshing; });
  await waitFor(() => expect(result.current.resources.get(id)?.loading).toBe(false));
  expect(result.current.resources.get(id)?.state.page?.entries.map((entry) => entry.row.id)).toEqual(Array.from({ length: 30 }, (_, i) => `pin-${i}`));
  expect(result.current.resources.get(id)?.state.page?.nextCursor).toBe("30");
  expect(fixture.read.mock.calls.some(([request]) => request.query.kind === "directory" && request.anchor)).toBe(false);
  await act(() => result.current.loadMore(id));
  expect(result.current.resources.get(id)?.state.page?.entries).toHaveLength(31);
  unmount();
});


it("bounds React renders for separately delivered navigation events before the refresh timer", async () => {
  const fixture = api();
  const render = vi.fn();
  const { result, unmount } = renderHook(() => {
    render();
    return useBoundedNavigationWindow({ ...base, desktopApi: fixture.desktopApi });
  });
  try {
    await waitFor(() => expect(result.current.resources.get("directory-index")?.loading).toBe(false));
    vi.useFakeTimers();
    render.mockClear();
    fixture.read.mockClear();
    for (let index = 0; index < 100; index += 1) {
      // Separate act boundaries model separately delivered IPC events, not
      // one React batch that would conceal redundant snapshot notifications.
      fixture.emit({ backend: "codex", notification: { method: "thread/status/changed",
        params: { threadId: `thread-${index}`, status: { type: "active" } } } });
    }
    expect(render).toHaveBeenCalledTimes(1);
    expect(fixture.read).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect(result.current.resources.get("directory-index")?.state.stale).toBe(false);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
