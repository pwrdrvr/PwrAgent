import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, FederationPeerSummary, NavigationDirectoryRow, NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useFederationHealth } from "../../../lib/useFederationHealth";
import { useStarMapForeground } from "../useStarMapForeground";
import { useStarMapProjectPages } from "../useStarMapProjectPages";
import { useStarMapThreads } from "../useStarMapThreads";
import { useStarMapInstanceLoad } from "../useStarMapInstanceLoad";

const project = (key: string): NavigationDirectoryRow => ({ key, label: key, kind: "directory", launchpadPresent: false,
  pinnedRootCount: 0, unpinnedRootCount: 23, counts: { total: 23, active: 1, unread: 0, review: 0 } });
const descriptors = new Map([["peer", [project("directory:/a"), project("directory:/b")]], ["other", [project("directory:/c")]]]);
const peers = ["peer", "other"].map((id) => ({ id, label: id, role: "client", status: "connected",
  capabilities: ["thread_navigation"], navigationQueryProtocol: 2 })) as FederationPeerSummary[];
function page(request: NavigationQueryRequest): NavigationQueryPage {
  const key = request.query.kind === "star-map" ? request.query.projectKey : undefined;
  return { protocol: 2, queryKey: JSON.stringify(request.query), generation: "g", ownerEpoch: "e", countsRevision: "r",
    coverage: { state: "complete" }, counts: project("").counts, complete: true,
    directories: request.query.kind === "star-map-geometry" ? descriptors.get(request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : "") : undefined,
    entries: key ? [{ placement: { kind: "root" }, orderKey: "0", row: {
      ref: { backend: "codex", threadId: key }, id: key, source: "codex", title: "Cached card", titleSource: "explicit",
      rowRevision: "r", linkedDirectories: [{ id: key, kind: "local", label: key, path: key.slice(10) }],
      inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
    } }] : [] };
}
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("attributes zero inactive map reads, coalesces restoration, and scopes project events", async () => {
  vi.useFakeTimers();
  let focused = true;
  let visibility = "visible";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  const listeners = new Set<(event: AgentEvent) => void>();
  const read = vi.fn(async (request: NavigationQueryRequest) => page(request));
  const release = vi.fn(async () => undefined);
  const load = vi.fn(async () => ({ load: undefined }));
  const api = { getNavigationQueryPage: read, releaseNavigationQuery: release, readFederationInstanceLoad: load,
    releaseNavigationAttentionView: vi.fn(async () => undefined),
    onAgentEvent: (fn: (event: AgentEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  } as DesktopApi;
  const view = renderHook(() => {
    const active = useStarMapForeground();
    const projects = useStarMapProjectPages({ desktopApi: api, enabled: true, active, localInstanceId: "local", descriptors, filters: {} });
    const remote = useStarMapThreads({ desktopApi: api, enabled: active, peers });
    useStarMapInstanceLoad({ desktopApi: api, active, instanceIds: ["peer"] });
    return { projects, remote };
  });
  await settle();
  expect(read).toHaveBeenCalledTimes(7); // Three project pages + two metadata reads per owner.
  expect(load).toHaveBeenCalledTimes(1);
  const retained = view.result.current.projects.state.resources.values().next().value!.state.page;
  const emit = (owner: string | undefined, threadId = "directory:/a") => {
    for (const fn of listeners) fn({ backend: "codex", ...(owner ? { federationTarget: { scope: "remote", instanceId: owner } } : {}),
      notification: { method: "thread/status/changed", params: { threadId, status: { type: "active" } } } });
  };
  read.mockClear(); load.mockClear();
  act(() => { focused = false; window.dispatchEvent(new Event("blur")); });
  await settle();
  expect(release).toHaveBeenCalled();
  // Query consumers are released on blur; Attention IDs are terminal once
  // closed, so keep their bounded ordering state until the map unmounts.
  expect(api.releaseNavigationAttentionView).not.toHaveBeenCalled();
  act(() => { for (let i = 0; i < 30; i++) emit("peer"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(read).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  expect(view.result.current.projects.state.resources.values().next().value!.state.page).toBe(retained);
  act(() => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); focused = true; window.dispatchEvent(new Event("focus")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(read).not.toHaveBeenCalled();
  act(() => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
  await settle();
  expect(read).toHaveBeenCalledTimes(7); expect(load).toHaveBeenCalledTimes(1);
  read.mockClear();
  act(() => { emit("unrelated"); emit(undefined); });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(read).not.toHaveBeenCalled();
  act(() => { for (let i = 0; i < 20; i++) emit("peer"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  const projectReads = read.mock.calls.map(([request]) => request).filter((request) => request.query.kind === "star-map");
  expect(projectReads).toHaveLength(1);
  expect(projectReads[0]!.query).toMatchObject({ projectKey: "directory:/a" });
  expect(read).toHaveBeenCalledTimes(3); // One project, plus that owner's rows/geometry.
  view.unmount();
  expect(api.releaseNavigationAttentionView).toHaveBeenCalled();
});

it("does not resurrect a released project read or its continuation after blur", async () => {
  let finish!: (value: NavigationQueryPage) => void;
  const pending = new Promise<NavigationQueryPage>((resolve) => { finish = resolve; });
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>().mockReturnValueOnce(pending)
    .mockImplementation(async (request) => page(request));
  const release = vi.fn(async () => undefined);
  const api = { getNavigationQueryPage: read, releaseNavigationQuery: release };
  const single = new Map([["peer", [project("directory:/a")]]]);
  const view = renderHook(({ active }) => useStarMapProjectPages({ desktopApi: api, enabled: true, active,
    localInstanceId: "local", descriptors: single, filters: {} }), { initialProps: { active: true } });
  await act(async () => undefined);
  expect(read).toHaveBeenCalledTimes(1);
  view.rerender({ active: false });
  view.rerender({ active: true });
  await act(async () => undefined);
  const current = view.result.current.state.resources.values().next().value!.state.page;
  await act(async () => finish({ ...page(read.mock.calls[0]![0]), entries: [], complete: false, nextCursor: "stale" }));
  expect(view.result.current.state.resources.values().next().value!.state.page).toBe(current);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0]![1]).not.toBe(read.mock.calls[1]![1]);
  view.unmount();
});

it("admits no project demand when first opened inactive", async () => {
  const read = vi.fn(async (request: NavigationQueryRequest) => page(request));
  const api = { getNavigationQueryPage: read };
  const view = renderHook(({ active }) => useStarMapProjectPages({ desktopApi: api,
    enabled: true, active, localInstanceId: "local", descriptors, filters: {} }), { initialProps: { active: false } });
  await act(async () => undefined);
  expect(read).not.toHaveBeenCalled();
  view.rerender({ active: true });
  await act(async () => undefined);
  expect(read).toHaveBeenCalledTimes(3);
  view.unmount();
});

it("fences old load samples and waits for completion before another poll", async () => {
  vi.useFakeTimers();
  type Response = Awaited<ReturnType<NonNullable<DesktopApi["readFederationInstanceLoad"]>>>;
  let finish!: (value: Response) => void;
  const stale = new Promise<Response>((resolve) => { finish = resolve; });
  const fresh = { load: { loadAvg1: 1, loadAvg5: 1, loadAvg15: 1, availableMemoryBytes: 100, sampledAt: 2 } };
  const read = vi.fn<NonNullable<DesktopApi["readFederationInstanceLoad"]>>().mockReturnValueOnce(stale)
    .mockResolvedValue(fresh);
  const api = { readFederationInstanceLoad: read };
  const view = renderHook(({ active }) => useStarMapInstanceLoad({ desktopApi: api, instanceIds: ["peer"], active }),
    { initialProps: { active: true } });
  await act(async () => { await vi.advanceTimersByTimeAsync(24_000); });
  expect(read).toHaveBeenCalledTimes(1);
  view.rerender({ active: false });
  view.rerender({ active: true });
  await settle();
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.result.current.get("peer")).toEqual(fresh.load);
  await act(async () => finish({ load: { ...fresh.load, sampledAt: 1 } }));
  expect(view.result.current.get("peer")).toEqual(fresh.load);
  await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
  expect(read).toHaveBeenCalledTimes(3);
  view.unmount();
});

it("ignores late remote geometry after releasing and restoring the owner", async () => {
  const finishes: (() => void)[] = [];
  let old = true;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>((request) => {
    if (old) return new Promise((resolve) => finishes.push(() => resolve({ ...page(request),
      directories: request.query.kind === "star-map-geometry" ? [project("directory:/stale")] : undefined,
      complete: false, nextCursor: "stale-continuation" })));
    return Promise.resolve(page(request));
  });
  const release = vi.fn(async () => undefined);
  const api = { getNavigationQueryPage: read, releaseNavigationQuery: release };
  const view = renderHook(({ active }) => useStarMapThreads({ desktopApi: api, enabled: active, peers: peers.slice(0, 1) }),
    { initialProps: { active: true } });
  await act(async () => undefined);
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender({ active: false });
  old = false;
  view.rerender({ active: true });
  await act(async () => undefined);
  expect(read).toHaveBeenCalledTimes(4);
  const retained = view.result.current.directoriesByInstance.get("peer");
  await act(async () => { finishes.forEach((finish) => finish()); });
  expect(view.result.current.directoriesByInstance.get("peer")).toEqual(retained);
  expect(read).toHaveBeenCalledTimes(4);
  expect(release).toHaveBeenCalled();
  view.unmount();
});


it("restores the full remote Lanes range after focus changes", async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({ ...page({ protocol: 2, consumer: "star-map", query: { kind: "star-map", projectKey: "directory:/a", filters: {} } }).entries[0]!,
    row: { ...page({ protocol: 2, consumer: "star-map", query: { kind: "star-map", projectKey: "directory:/a", filters: {} } }).entries[0]!.row, id: `card-${i}`, ref: { backend: "codex" as const, threadId: `card-${i}` } } }));
  const read = vi.fn(async (request: NavigationQueryRequest) => {
    if (request.query.kind !== "lens") return page(request);
    const start = request.cursor ? Number(request.cursor) : request.retainedRange?.start ?? 0;
    const count = request.retainedRange?.count ?? 10;
    return { ...page(request), entries: entries.slice(start, start + count), rangeStart: start,
      complete: start + count >= entries.length, nextCursor: start + count < entries.length ? String(start + count) : undefined };
  });
  const api = { getNavigationQueryPage: read, releaseNavigationQuery: vi.fn(async () => undefined) };
  const view = renderHook(({ active }) => useStarMapThreads({ desktopApi: api, enabled: active, peers: peers.slice(0, 1) }),
    { initialProps: { active: true } });
  await act(async () => undefined);
  await act(async () => { await view.result.current.loadMoreInstance("peer"); });
  expect(view.result.current.threadsByInstance.get("peer")).toHaveLength(20);
  view.rerender({ active: false });
  view.rerender({ active: true });
  await act(async () => undefined);
  expect(view.result.current.threadsByInstance.get("peer")).toHaveLength(20);
  await act(async () => { await view.result.current.loadMoreInstance("peer"); });
  expect(view.result.current.threadsByInstance.get("peer")).toHaveLength(25);
  view.unmount();
});

it("allows explicit health refresh without subscriptions but suspends all inactive map reads", async () => {
  const read = vi.fn(async () => ({ health: { peers: [] } }));
  const subscribe = vi.fn(() => vi.fn());
  const api = { readFederationHealth: read, onAgentEvent: subscribe } as unknown as DesktopApi;
  const view = renderHook(({ suspended }) => useFederationHealth({ desktopApi: api, enabled: false, suspended }),
    { initialProps: { suspended: false } });
  expect(read).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
  await act(async () => view.result.current.refresh());
  expect(read).toHaveBeenCalledTimes(1);
  const retained = view.result.current.health;
  view.rerender({ suspended: true });
  await act(async () => view.result.current.refresh());
  expect(read).toHaveBeenCalledTimes(1);
  expect(view.result.current.health).toBe(retained);
  view.rerender({ suspended: false });
  await act(async () => view.result.current.refresh());
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount();
});
