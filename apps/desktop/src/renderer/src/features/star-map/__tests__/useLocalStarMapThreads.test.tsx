import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationQueryPage, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { useLocalStarMapThreads } from "../useLocalStarMapThreads";

function thread(id: string): NavigationThreadSummary {
  return { id, source: "codex", title: id, titleSource: "derived", linkedDirectories: [], inbox: { inInbox: false } };
}
function page(request: NavigationQueryRequest, ids: string[] = []): NavigationQueryPage {
  return navigationQueryFixture(request, { threads: ids.map(thread) });
}

it("reads local pages and complete geometry without a snapshot, and releases all leases on close", async () => {
  let completeGeometry!: (page: NavigationQueryPage) => void;
  const geometry = new Promise<NavigationQueryPage>((resolve) => { completeGeometry = resolve; });
  const read = vi.fn(async (request: NavigationQueryRequest) => {
    if (request.query.kind === "star-map-geometry") {
      if (request.cursor) return geometry;
      return { ...page(request), complete: false, nextCursor: "geometry-next" };
    }
    return { ...page(request, [request.cursor ? "later" : "first"]),
      counts: { total: 1000, active: 100, unread: 200, review: 100 },
      complete: Boolean(request.cursor), nextCursor: request.cursor ? undefined : "rows-next" };
  });
  const release = vi.fn().mockResolvedValue(undefined);
  const snapshot = vi.fn(() => { throw new Error("Legacy snapshot forbidden"); });
  const api = { getNavigationQueryPage: read, releaseNavigationQuery: release, getNavigationSnapshot: snapshot } as unknown as DesktopApi;
  const hook = renderHook(() => useLocalStarMapThreads({ desktopApi: api, enabled: true, filters: {}, demandedIdentities: [] }));
  await waitFor(() => expect(hook.result.current.threads.map((row) => row.id)).toEqual(["first"]));
  expect(hook.result.current.geometryReady).toBe(false);
  expect(hook.result.current.counts?.total).toBe(1000);
  await act(async () => completeGeometry(page({ protocol: 2, consumer: "star-map", query: { kind: "star-map-geometry" } })));
  await waitFor(() => expect(hook.result.current.geometryReady).toBe(true));
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.threads.map((row) => row.id)).toEqual(["first", "later"]);
  expect(snapshot).not.toHaveBeenCalled();
  hook.unmount();
  expect(release.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it("resolves more than one selector batch without dropping demanded cards", async () => {
  const read = vi.fn(async (request: NavigationQueryRequest) => page(request,
    request.query.kind === "exact" ? request.query.identities.map((ref) => ref.threadId) : []));
  const api = { getNavigationQueryPage: read } as unknown as DesktopApi;
  const identities = Array.from({ length: 105 }, (_, index) => ({ backend: "codex" as const, threadId: String(index) }));
  const hook = renderHook(() => useLocalStarMapThreads({ desktopApi: api, enabled: true, filters: {}, demandedIdentities: identities }));
  await waitFor(() => expect(hook.result.current.threads).toHaveLength(105));
  const queries = read.mock.calls.map(([request]) => request).filter((request) => request.query.kind === "exact");
  expect(queries).toHaveLength(2);
  expect(queries[0]?.deadlineAt).toBe(queries[1]?.deadlineAt);
});

it("does not refresh metadata for streamed token updates", async () => {
  let notify!: (event: AgentEvent) => void;
  const read = vi.fn(async (request: NavigationQueryRequest) => page(request));
  const api = { getNavigationQueryPage: read, onAgentEvent: (listener: typeof notify) => { notify = listener; return () => undefined; } } as unknown as DesktopApi;
  renderHook(() => useLocalStarMapThreads({ desktopApi: api, enabled: true, filters: {}, demandedIdentities: [] }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  act(() => {
    for (let index = 0; index < 1000; index += 1) {
      notify({ backend: "codex", notification: { method: "thread/tokenUsage/updated", params: { threadId: "thread" } } } as AgentEvent);
    }
  });
  expect(read).toHaveBeenCalledTimes(2);
});
