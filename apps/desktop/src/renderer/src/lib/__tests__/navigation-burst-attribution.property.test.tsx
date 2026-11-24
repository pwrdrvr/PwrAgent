import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import {
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  type NavigationQueryPage,
  type NavigationQueryRequest,
} from "@pwragent/shared/contracts/navigation";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import { NavigationWindowQueries } from "../navigation-window-queries";
import { navigationListingDiagnostics as ring, setNavigationListingDiagnosticsEnabled } from "../navigation-listing-diagnostics";
import type { DesktopApi } from "../desktop-api";

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
      // Three summary records at most, plus four per page; no row events.
      expect(events.length).toBeLessThanOrEqual(3 + queries * 4);
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

it("records settlement and renderer disposition only in the interval that recorded dispatch", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.array(fc.boolean(), { maxLength: 6 }),
    async (initiallyEnabled, failed, controls) => {
      setNavigationListingDiagnosticsEnabled(false);
      setNavigationListingDiagnosticsEnabled(initiallyEnabled);
      const dispatched = Promise.withResolvers<void>();
      const response = Promise.withResolvers<NavigationQueryPage>();
      const getNavigationQueryPage = vi.fn(() => {
        dispatched.resolve();
        return response.promise;
      });
      const controller = new NavigationWindowQueries({ getNavigationQueryPage });
      try {
        controller.setDemand(new Map([["inbox", request]]));
        const refreshed = controller.refresh();
        await dispatched.promise;
        for (const enabled of controls) setNavigationListingDiagnosticsEnabled(enabled);
        if (failed) response.reject(new Error("simulated navigation read failure"));
        else response.resolve(page);
        await refreshed;

        const phases = ring.snapshot().events.filter((event) => ["dispatch", "settled", "reply"].includes(event.phase));
        if (initiallyEnabled && controls.every(Boolean)) {
          expect(phases).toMatchObject([{ phase: "dispatch" }, { phase: "settled", outcome: failed ? "error" : "ok" },
            ...failed ? [] : [{ phase: "reply", disposition: "accepted" }]]);
          for (const event of phases.slice(1)) {
            expect(event).toMatchObject({ read: phases[0]?.read, logical: phases[0]?.logical, attempt: phases[0]?.attempt });
          }
        } else {
          expect(phases).toEqual([]);
        }
      } finally {
        response.resolve(page);
        controller.dispose();
      }
    }), { examples: [[true, false, []], [true, false, [false, true]], [true, true, [false, true]], [false, false, [true]]] });
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
    expect(events.filter((event) => event.phase === "reply")).toMatchObject([
      { attempt: 1, disposition: "discarded" }, { attempt: 2, disposition: "accepted" },
    ]);
  } finally { controller.dispose(); vi.restoreAllMocks(); }
});

const parent = { backend: "codex", threadId: "PRIVATE PARENT" } as const;
const childRequest: NavigationQueryRequest = { ...request, inventory: "viewer", query: { kind: "children", parent } };
const seen = (threadId: string): AgentEvent => ({
  backend: "codex", notification: { method: "navigation/thread/seen", params: { threadId, seenUpdatedAt: 1 } },
});

it("correlates every visible deferral with one proof outcome across monitor transitions", async () => {
  await fc.assert(fc.asyncProperty(
    fc.boolean(),
    fc.array(fc.record({ enabled: fc.boolean(), thread: fc.integer({ min: 0, max: 2 }) }), { minLength: 1, maxLength: 8 }),
    fc.boolean(),
    fc.constantFrom("exclude", "replace", "covered"),
    async (initiallyEnabled, notices, finishEnabled, outcome) => {
      setNavigationListingDiagnosticsEnabled(false);
      setNavigationListingDiagnosticsEnabled(initiallyEnabled);
      const baseline = { ...page, metadataDependencies: { version: 1 as const, threadKeys: [], prKeys: [] } };
      const dispatched = Promise.withResolvers<void>();
      const response = Promise.withResolvers<NavigationQueryPage>();
      const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => baseline);
      const controller = new NavigationWindowQueries({ getNavigationQueryPage: read });
      try {
        controller.setDemand(new Map([["child", childRequest]]));
        await controller.refresh();
        read.mockImplementationOnce(() => { dispatched.resolve(); return response.promise; });
        const membershipEvent: AgentEvent = { backend: "codex", notification: {
          method: "thread/parent/set", params: { threadId: "PRIVATE MOVED CHILD", parentThreadId: parent.threadId },
        } };
        controller.invalidate(undefined, undefined, membershipEvent);
        const refreshed = controller.refresh(undefined, undefined, true);
        await dispatched.promise;
        const logical = read.mock.calls[1]![0].diagnostic!.logical;
        for (const notice of notices) {
          setNavigationListingDiagnosticsEnabled(notice.enabled);
          controller.invalidate(undefined, undefined, seen(`PRIVATE CHILD ${notice.thread}`));
        }
        setNavigationListingDiagnosticsEnabled(finishEnabled);
        if (outcome === "covered") controller.invalidate(undefined, undefined, membershipEvent);
        response.resolve(outcome === "replace" ? page : baseline);
        await refreshed;

        const visibleNotices = finishEnabled ? notices.slice(notices.findLastIndex(({ enabled }) => !enabled) + 1) : [];
        const { events } = ring.snapshot();
        const deferrals = events.filter((event) => event.seenDecision === "defer");
        expect(deferrals).toHaveLength(visibleNotices.length);
        expect(new Set(deferrals.map(({ batch }) => batch)).size).toBe(visibleNotices.length);
        const outcomes = events.filter((event) => event.seenDecision === "exclude" || event.seenDecision === "replace" || event.seenDecision === "covered");
        expect(outcomes).toMatchObject(visibleNotices.length ? [{ logical, resource: deferrals[0]?.resource,
          seenDecision: outcome }] : []);
        for (const deferral of deferrals) expect(deferral.logical).toBe(logical);
        const transport = events.filter((event) => event.logical === logical && ["dispatch", "settled", "reply"].includes(event.phase));
        expect(transport.map(({ phase }) => phase)).toEqual(initiallyEnabled && notices.every(({ enabled }) => enabled) && finishEnabled
          ? ["dispatch", "settled", "reply"] : []);
        expect(read).toHaveBeenCalledTimes(outcome === "exclude" ? 2 : 3);
        expect(JSON.stringify(events)).not.toContain("PRIVATE");
      } finally { response.resolve(baseline); controller.dispose(); }
    },
  ), { numRuns: 40, examples: [
    [true, [{ enabled: true, thread: 0 }, { enabled: true, thread: 1 }], true, "exclude"],
    [false, [{ enabled: true, thread: 0 }], true, "replace"],
    [true, [{ enabled: true, thread: 0 }, { enabled: false, thread: 1 }, { enabled: true, thread: 0 }], true, "exclude"],
    [true, [{ enabled: true, thread: 0 }, { enabled: false, thread: 1 }], true, "exclude"],
    [false, [{ enabled: true, thread: 0 }, { enabled: true, thread: 1 }], true, "covered"],
  ] });
});

it.each([false, true])("validates inline proof only when invalidation needs it (capture: %s)", async (enabled) => {
  setNavigationListingDiagnosticsEnabled(enabled);
  const validates = vi.fn();
  const inline = { version: 1 as const, threadKeys: [], prKeys: [], toJSON(key: string) {
    // Normal whole-page byte accounting serializes this as a named field.
    if (!key) validates();
    return this;
  } };
  const controller = new NavigationWindowQueries({ getNavigationQueryPage: async () => ({ ...page, metadataDependencies: inline }) });
  try {
    controller.setDemand(new Map([["child", childRequest]]));
    await controller.refresh();
    expect(validates).not.toHaveBeenCalled();
    if (enabled) {
      const reply = ring.snapshot().events.find((event) => event.phase === "reply");
      expect(reply).toMatchObject({ proofPresent: true });
      expect(reply).not.toHaveProperty("proofAdmitted");
    }
    controller.invalidate(undefined, undefined, seen("PRIVATE OFF-PAGE CHILD"));
    expect(validates).toHaveBeenCalledTimes(1);
  } finally { controller.dispose(); }
});
