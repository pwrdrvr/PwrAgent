import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { navigationListingDiagnostics, NavigationListingDiagnostics } from "../navigation-listing-diagnostics";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";
import { NavigationWindowQueries, navigationDemandKey } from "../navigation-window-queries";
import type { DesktopApi } from "../desktop-api";

const page: NavigationQueryPage = { protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "o", countsRevision: "r",
  coverage: { state: "complete" }, counts: { total: 0, active: 0, unread: 0, review: 0 }, entries: [], complete: true };
const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" } };

it("records StrictMode effect replay but only the surviving effect dispatches", async () => {
  const before = navigationListingDiagnostics.snapshot().recorded;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page);
  const api = { getNavigationQueryPage: read, releaseNavigationQuery: vi.fn(async () => {}) };
  // One lens page, so the event budget below measures replay, not lens shape.
  const { result, rerender, unmount } = renderHook(() => useBoundedNavigationWindow({ desktopApi: api,
    enabled: true, visible: true, browseMode: "inbox", attentionView: { id: "fixture", promoteOnTurnEnd: true },
    expandedByKey: {}, unpinnedExpandedByKey: {}, pinnedThreadsOnTop: false,
  }), { wrapper: StrictMode });
  await waitFor(() => expect(result.current.presentationReady).toBe(true));
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.map(([request]) => request.query.kind).sort()).toEqual(["directory-index", "lens"]);
  const diagnostic = read.mock.calls[0]![0].diagnostic!;
  expect(diagnostic).toMatchObject({ effect: 2, logical: 1, attempt: 1, cause: "demand" });
  rerender();
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(2);
  const snapshot = navigationListingDiagnostics.snapshot();
  const events = snapshot.events.slice(-(snapshot.recorded - before));
  expect(events.filter((event) => event.phase === "effect").map((event) => [event.view, event.effect]))
    .toEqual([[diagnostic.view, 1], [diagnostic.view, 2]]);
  expect(events.filter((event) => event.phase === "dispatch")).toHaveLength(2);
  expect(events.some((event) => event.phase === "dispose" && event.effect === 1)).toBe(true);
  expect(events.length).toBeLessThanOrEqual(10);
  unmount();
});

it("carries invalidation cause through a coalesced refresh without changing demand identity", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page);
  const controller = new NavigationWindowQueries({ getNavigationQueryPage: read }, { view: 77, effect: 1 });
  controller.setDemand(new Map([["inbox", request]]));
  await controller.refresh();
  const event = { backend: "codex", notification: { method: "navigation/invalidated",
    params: { sourceMethod: "turn/completed", threadId: "PRIVATE THREAD" } } } as AgentEvent;
  controller.invalidate(undefined, undefined, event);
  controller.invalidate(undefined, undefined, event);
  await controller.refresh(undefined, undefined, true);
  const next = read.mock.calls.at(-1)![0];
  expect(next.diagnostic).toMatchObject({ view: 77, effect: 1, cause: "turn", trigger: "turn/completed", invalidations: 2 });
  expect(JSON.stringify(next.diagnostic)).not.toContain("PRIVATE");
  expect(navigationDemandKey(next)).toBe(navigationDemandKey({ ...next, diagnostic: undefined }));
  await controller.refresh(undefined, undefined, false, "timer");
  expect(read.mock.calls.at(-1)![0].diagnostic?.cause).toBe("timer");
  controller.dispose();
});

it("bounds renderer ring memory and age without per-event transport", () => {
  vi.useFakeTimers();
  try {
    const diagnostics = new NavigationListingDiagnostics();
    for (let view = 0; view < 10_000; view++) diagnostics.record({ view, effect: 1, phase: "demand", count: 4 });
    const snapshot = diagnostics.snapshot();
    expect(snapshot).toMatchObject({ capacity: 1024, recorded: 10_000, overwritten: 8976 });
    expect(snapshot.events).toHaveLength(1024);
    expect(snapshot.events[0]!.view).toBe(8976);
    expect(JSON.stringify(snapshot).length).toBeLessThan(128 * 1024);
    vi.advanceTimersByTime(120_001);
    expect(diagnostics.snapshot().events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
