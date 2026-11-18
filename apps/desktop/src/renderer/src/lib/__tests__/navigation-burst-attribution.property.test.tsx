import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES, type AgentEvent, type NavigationQueryPage, type NavigationQueryRequest } from "@pwragent/shared";
import { NavigationWindowQueries } from "../navigation-window-queries";
import { navigationListingDiagnostics as ring, setNavigationListingDiagnosticsEnabled } from "../navigation-listing-diagnostics";

afterEach(() => { setNavigationListingDiagnosticsEnabled(false); vi.useRealTimers(); });
const page: NavigationQueryPage = { protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "o", countsRevision: "r",
  coverage: { state: "complete" }, counts: { total: 0, active: 0, unread: 0, review: 0 }, entries: [], complete: true };
const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" } };

it("accounts for event fan-out independently of nearby scrolling and loaded query count", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(4, 8, 16), fc.constantFrom(0, 100, 1000), async (queries, scrolls) => {
    setNavigationListingDiagnosticsEnabled(false);
    setNavigationListingDiagnosticsEnabled(true);
    const api = vi.fn(async () => page);
    const controller = new NavigationWindowQueries({ getNavigationQueryPage: api }, { view: 22, effect: 1 });
    try {
      controller.setDemand(new Map(Array.from({ length: queries }, (_, index) => [String(index), request])));
      await controller.refresh();
      api.mockClear();
      const before = ring.snapshot().recorded;
      for (let i = 0; i < scrolls; i++) {
        window.dispatchEvent(new Event("scroll"));
        controller.setVisibleAnchor("0", undefined);
      }
      expect(api).not.toHaveBeenCalled();
      const event = { backend: "codex", federationTarget: { scope: "remote", instanceId: "PRIVATE OWNER" },
        notification: { method: "navigation/invalidated", params: { sourceMethod: "navigation/directoryGitStatus/updated" } } } as AgentEvent;
      controller.invalidate(undefined, undefined, event);
      await controller.refresh(undefined, undefined, true);
      expect(api).toHaveBeenCalledTimes(queries);
      const snapshot = ring.snapshot();
      const events = snapshot.events.slice(-(snapshot.recorded - before));
      const invalidation = events.find((event) => event.phase === "invalidate")!;
      const refresh = events.find((event) => event.phase === "refresh")!;
      expect(invalidation).toMatchObject({ count: queries, trigger: "navigation/directoryGitStatus/updated", source: "remote" });
      expect(refresh).toMatchObject({ count: queries, invalidatedOnly: true });
      const dispatches = events.filter((event) => event.phase === "dispatch");
      expect(dispatches).toHaveLength(queries);
      expect(events.filter((event) => event.phase === "settled")).toHaveLength(queries);
      expect(events.filter((event) => event.phase === "queued")).toHaveLength(queries);
      for (const dispatch of dispatches) {
        expect(dispatch).toMatchObject({ batch: invalidation.batch, refreshBatch: refresh.batch,
          trigger: invalidation.trigger, query: "lens", source: "local", inventory: "owner", invalidations: 1 });
        expect(events.find((event) => event.phase === "queued" && event.read === dispatch.read)).toBeDefined();
        expect(events.find((event) => event.phase === "settled" && event.logical === dispatch.logical))
          .toMatchObject({ attempt: dispatch.attempt, outcome: "ok" });
      }
      // Three summary records at most, plus exactly three per page; no row events.
      expect(events.length).toBeLessThanOrEqual(3 + queries * 3);
      expect(JSON.stringify(events)).not.toContain("PRIVATE");
    } finally { controller.dispose(); }
  }), { numRuns: 12 });
});

it("measures admission wait separately from the API duration", async () => {
  setNavigationListingDiagnosticsEnabled(true);
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { complete = resolve; });
  let entered!: () => void;
  const fourStarted = new Promise<void>((resolve) => { entered = resolve; });
  let started = 0;
  const api = vi.fn(async () => { if (++started === 4) entered(); if (started <= 4) await gate; return page; });
  const controller = new NavigationWindowQueries({ getNavigationQueryPage: api });
  try {
    controller.setDemand(new Map(Array.from({ length: 5 }, (_, i) => [String(i), request])));
    await fourStarted;
    now += 75;
    complete();
    await controller.refresh("4");
    const dispatch = ring.snapshot().events.filter((event) => event.phase === "dispatch").at(-1)!;
    expect(dispatch.waitMs).toBe(75);
    expect(ring.snapshot().events.find((event) => event.phase === "settled" && event.read === dispatch.read))
      .toMatchObject({ durationMs: 0 });
  } finally { complete(); controller.dispose(); vi.restoreAllMocks(); }
});

it("does not charge prior API time as queue wait on a page-size retry", async () => {
  setNavigationListingDiagnosticsEnabled(true);
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let calls = 0;
  const api = vi.fn(async () => {
    now += ++calls === 1 ? 100 : 75;
    return calls === 1 ? { ...page, generation: "x".repeat(NAVIGATION_QUERY_MAX_RESULT_BYTES) } : page;
  });
  const controller = new NavigationWindowQueries({ getNavigationQueryPage: api });
  try {
    controller.setDemand(new Map([["inbox", request]]));
    await controller.refresh();
    expect(api).toHaveBeenCalledTimes(2);
    const events = ring.snapshot().events;
    expect(events.filter((event) => event.phase === "dispatch").map((event) => event.waitMs)).toEqual([0, 0]);
    expect(events.filter((event) => event.phase === "settled").map((event) => event.durationMs)).toEqual([100, 75]);
  } finally { controller.dispose(); vi.restoreAllMocks(); }
});
