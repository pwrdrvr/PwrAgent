import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FederationPeerSummary, NavigationDirectoryRow, NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { useStarMapInstanceLoad } from "../useStarMapInstanceLoad";
import { useStarMapThreads } from "../useStarMapThreads";
import { useStarMapProjectPages } from "../useStarMapProjectPages";
import { useNavigationQueryResource } from "../../../lib/useNavigationQueryResource";
import { useFederationHealth } from "../../../lib/useFederationHealth";
import { useLocalStarMapThreads } from "../useLocalStarMapThreads";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const options = { wrapper: StrictMode };
const request: NavigationQueryRequest = {
  protocol: 2, consumer: "star-map", query: { kind: "lens", lens: "attention" }, pageSize: 10,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
function queryApi(read = vi.fn(async (query: NavigationQueryRequest, _consumer?: string) => navigationQueryFixture(query, {}))) {
  const release = vi.fn(async () => {});
  const api = { getNavigationQueryPage: read, releaseNavigationQuery: release } as unknown as DesktopApi;
  return { api, read, release };
}
function peer(id: string): FederationPeerSummary {
  return { id, status: "connected", capabilities: ["thread_navigation"], navigationQueryProtocol: 2 } as FederationPeerSummary;
}

it("samples load once on mount and keeps one polling loop across suspension", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({}));
  const desktopApi = { readFederationInstanceLoad: read } as unknown as DesktopApi;
  const view = renderHook(({ active }) => useStarMapInstanceLoad({ desktopApi,
    instanceIds: ["pwr_peer"], active }), { ...options, initialProps: { active: true } });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender({ active: false });
  await act(async () => vi.advanceTimersByTimeAsync(16_000));
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender({ active: true });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(3);
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(16_000));
  expect(read).toHaveBeenCalledTimes(3);
});

it("reads health once on mount while retaining explicit refresh and resume", async () => {
  const read = vi.fn(async () => ({ health: { instanceId: "pwr_local" } }));
  const desktopApi = { readFederationHealth: read } as unknown as DesktopApi;
  const view = renderHook(({ suspended }) => useFederationHealth({ desktopApi, suspended }),
    { ...options, initialProps: { suspended: false } });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  expect(view.result.current.health?.instanceId).toBe("pwr_local");
  await act(async () => view.result.current.refresh());
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender({ suspended: true });
  await act(async () => view.result.current.refresh());
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender({ suspended: false });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(3);
});

it("dispatches one navigation read and releases its actual lease on unmount", async () => {
  const pending = deferred<NavigationQueryPage>();
  const { api, read, release } = queryApi(vi.fn((_query: NavigationQueryRequest, _consumer?: string) => pending.promise));
  const view = renderHook(() => useNavigationQueryResource({ desktopApi: api, request }), options);
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(navigationQueryFixture(request, {})));
  expect(view.result.current.state?.page).toBeDefined();
  await act(async () => view.result.current.refresh());
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(release).toHaveBeenCalledWith(read.mock.calls[0]![1]);
});

it("does not dispatch an unmounted navigation resource or load card", async () => {
  const { api, read } = queryApi();
  const load = vi.fn(async () => ({}));
  const desktopApi = { ...api, readFederationInstanceLoad: load } as DesktopApi;
  const view = renderHook(() => {
    useNavigationQueryResource({ desktopApi, request });
    useStarMapInstanceLoad({ desktopApi, instanceIds: ["pwr_peer"] });
  }, options);
  view.unmount();
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});

it("reads each connected owner's rows and geometry once and still refreshes", async () => {
  const { api, read } = queryApi();
  const view = renderHook(({ peers }) => useStarMapThreads({ desktopApi: api, peers, enabled: true }),
    { ...options, initialProps: { peers: [peer("pwr_first")] } });
  await act(async () => {});
  expect(read.mock.calls.map(([query]) => query.query.kind).sort()).toEqual(["lens", "star-map-geometry"]);
  expect(view.result.current.geometryReadyInstanceIds.has("pwr_first")).toBe(true);
  await act(async () => view.result.current.refreshInstance("pwr_first"));
  expect(read).toHaveBeenCalledTimes(4);
  view.rerender({ peers: [peer("pwr_first"), peer("pwr_second")] });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(6);
  expect(view.result.current.geometryReadyInstanceIds.has("pwr_second")).toBe(true);
});

it("admits local geometry and exact metadata only once", async () => {
  const { api, read } = queryApi();
  renderHook(() => useLocalStarMapThreads({ desktopApi: api, enabled: true, filters: {},
    demandedIdentities: [{ backend: "codex", threadId: "thread" }] }), options);
  await act(async () => {});
  expect(read.mock.calls.map(([query]) => query.query.kind).sort()).toEqual(["exact", "star-map", "star-map-geometry"]);
});

it.each([false, true])("loads project descriptors arriving after mount (Strict Mode=%s)", async (strict) => {
  const { api, read, release } = queryApi();
  const descriptors = new Map([["pwr_peer", [{ key: "project" } as NavigationDirectoryRow]]]);
  const view = renderHook(({ ready, active }) => useStarMapProjectPages({ desktopApi: api, enabled: true, active,
    localInstanceId: "pwr_local", descriptors: ready ? descriptors : new Map(), filters: {} }),
    { initialProps: { ready: false, active: true }, ...(strict ? options : {}) });
  view.rerender({ ready: true, active: true });
  await act(async () => {});
  expect(view.result.current.state.resources.size).toBe(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect([...view.result.current.state.resources.values()][0]!.state.page).toBeDefined();
  await act(async () => view.result.current.controller.refresh());
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender({ ready: true, active: false });
  await act(async () => view.result.current.controller.refresh());
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender({ ready: true, active: true });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(release).toHaveBeenCalledWith(read.mock.calls[2]![1]);
});
