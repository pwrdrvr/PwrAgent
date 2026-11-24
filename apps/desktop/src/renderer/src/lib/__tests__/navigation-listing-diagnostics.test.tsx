import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared/contracts/navigation";
import { navigationListingDiagnostics, NavigationListingDiagnostics, setNavigationListingDiagnosticsEnabled } from "../navigation-listing-diagnostics";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";
import { NavigationWindowQueries, navigationDemandKey } from "../navigation-window-queries";
import type { DesktopApi } from "../desktop-api";

beforeEach(() => setNavigationListingDiagnosticsEnabled(true));
afterEach(() => setNavigationListingDiagnosticsEnabled(false));

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
  expect(events.filter((event) => event.phase === "reply" && event.disposition === "accepted")).toHaveLength(2);
  expect(events.some((event) => event.phase === "dispose" && event.effect === 1)).toBe(true);
  expect(events.length).toBeLessThanOrEqual(17);
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
  await controller.refresh(undefined, undefined, true, undefined, "action/materialize-launchpad");
  const next = read.mock.calls.at(-1)![0];
  expect(next.diagnostic).toMatchObject({ view: 77, effect: 1, cause: "turn", trigger: "turn/completed", invalidations: 2 });
  expect(JSON.stringify(next.diagnostic)).not.toContain("PRIVATE");
  expect(navigationListingDiagnostics.snapshot().events.filter((event) => event.view === 77 && event.phase === "refresh").at(-1))
    .toMatchObject({ caller: "action/materialize-launchpad" });
  expect(navigationDemandKey(next)).toBe(navigationDemandKey({ ...next, diagnostic: undefined }));
  await controller.refresh(undefined, undefined, false, "timer");
  expect(read.mock.calls.at(-1)![0].diagnostic?.cause).toBe("timer");
  controller.dispose();
});

it("bounds renderer ring memory and age without per-event transport", () => {
  vi.useFakeTimers();
  try {
    const diagnostics = new NavigationListingDiagnostics();
    diagnostics.setEnabled(true);
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

const parent = { backend: "codex", threadId: "PRIVATE PARENT" } as const;
const peer = { scope: "remote", instanceId: "PRIVATE PEER" } as const;
const childQuery = { kind: "children", parent, directoryKey: "PRIVATE DIRECTORY" } as const;
const seenThreadId = "PRIVATE SEEN THREAD";
const seenEvent = (threadId: string, federationTarget?: typeof peer): AgentEvent => ({
  backend: "codex", federationTarget, notification: { method: "navigation/thread/seen", params: { threadId, seenUpdatedAt: 1 } },
});
const directory = { key: "PRIVATE DIRECTORY", kind: "directory", label: "PRIVATE TITLE",
  counts: { ...page.counts, unread: 2 }, launchpadPresent: false, pinnedRootCount: 0, unpinnedRootCount: 0 } as const;
const proof = { version: 1, prKeys: [], threadKeys: [JSON.stringify([null, "codex", seenThreadId])],
  workingStatePaths: ["/PRIVATE CHECKOUT"] } satisfies NonNullable<NavigationQueryPage["metadataDependencies"]>;

it.each([
  { reason: "parent-or-row", coverage: "complete", range: "full", matchesParent: true },
  { reason: "selection-directory", coverage: "complete", range: "prefix", remote: true },
  { reason: "thread-dependency", coverage: "complete", range: "prefix", remote: true, dependencies: true },
  { reason: "partial-coverage", coverage: "degraded", range: "offset-partial" },
  { reason: "partial-range", coverage: "complete", range: "offset-complete" },
  { reason: "missing-proof", coverage: "complete", range: "full", lens: true },
] as const)("records the $reason seen branch and accepted unread change after a settled pin refresh", async (fixture) => {
  const options = { remote: false, dependencies: false, matchesParent: false, lens: false, ...fixture };
  let now = 1000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const complete = options.range === "full" || options.range === "offset-complete";
  const baseline: NavigationQueryPage = { ...page, coverage: { state: options.coverage }, complete,
    rangeStart: options.range.startsWith("offset") ? 8 : 0, nextCursor: complete ? undefined : "PRIVATE CURSOR",
    counts: { ...page.counts, unread: 3, providers: ["PRIVATE PROVIDER ACCOUNT"] },
    selectionDirectory: options.remote ? directory : undefined,
    metadataDependencies: options.dependencies ? proof : undefined };
  let response = baseline;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => response);
  const controller = new NavigationWindowQueries({ getNavigationQueryPage: read });
  try {
    const federationTarget = options.remote ? peer : undefined;
    controller.setDemand(new Map([["PRIVATE RESOURCE", { ...request, inventory: options.remote ? "owner" : "viewer",
      query: options.lens ? request.query : childQuery, federationTarget }]]));
    await controller.refresh();
    await controller.refresh(undefined, undefined, false, undefined, "action/remote-pin-add");
    const pinSettled = navigationListingDiagnostics.snapshot().events.find((event) =>
      event.phase === "settled" && event.caller === "action/remote-pin-add")!;
    now += 5_001;
    response = { ...baseline, counts: { ...baseline.counts, unread: options.remote ? 3 : 2 },
      selectionDirectory: options.remote ? { ...directory, counts: { ...directory.counts, unread: 1 } } : undefined };
    controller.invalidate(undefined, undefined, seenEvent(options.matchesParent ? parent.threadId : seenThreadId, federationTarget));
    await controller.refresh(undefined, undefined, true);
    const { events } = navigationListingDiagnostics.snapshot();
    const decision = events.find((event) => event.phase === "seen-decision")!;
    expect(decision).toMatchObject({ seenDecision: "invalidate", seenReason: options.reason,
      coverage: options.coverage, range: options.range, proofAdmitted: options.dependencies });
    expect(decision.at - pinSettled.at).toBe(5_001);
    const dispatch = events.filter((event) => event.phase === "dispatch").at(-1)!;
    expect(dispatch).toMatchObject({ batch: decision.batch, resource: decision.resource, trigger: "navigation/thread/seen" });
    const replyIndex = events.findIndex((event) => event.phase === "reply" && event.read === dispatch.read);
    expect(replyIndex).toBeGreaterThan(events.findIndex((event) => event.phase === "settled" && event.read === dispatch.read));
    expect(events[replyIndex]).toMatchObject({ disposition: "accepted", logical: dispatch.logical, attempt: dispatch.attempt,
      coverage: options.coverage, range: options.range, proofAdmitted: options.dependencies, unreadChanged: !options.remote });
    expect(events[replyIndex]?.selectionUnreadChanged).toBe(options.remote ? true : undefined);
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  } finally { controller.dispose(); clock.mockRestore(); }
});

it.each([true, false])("reports the deciding candidate proof after a mark-seen notice is deferred (proof: %s)", async (returnsProof) => {
  const baseline: NavigationQueryPage = { ...page, metadataDependencies: { version: 1, threadKeys: [], prKeys: [] } };
  const pending = Promise.withResolvers<NavigationQueryPage>();
  const entered = Promise.withResolvers<void>();
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => baseline);
  const controller = new NavigationWindowQueries({ getNavigationQueryPage: read });
  try {
    controller.setDemand(new Map([["child", { ...request, query: childQuery }]]));
    await controller.refresh();
    read.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    controller.invalidate(undefined, undefined, { backend: "codex", notification: {
      method: "thread/parent/set", params: { threadId: seenThreadId, parentThreadId: parent.threadId },
    } });
    const refresh = controller.refresh(undefined, undefined, true);
    await entered.promise;
    controller.invalidate(undefined, undefined, seenEvent(seenThreadId));
    pending.resolve(returnsProof ? baseline : page);
    await refresh;
    const events = navigationListingDiagnostics.snapshot().events;
    const decisions = events.filter((event) => event.phase === "seen-decision");
    expect(decisions).toMatchObject([
      { seenDecision: "defer", seenReason: "uncertain-membership", proofAdmitted: true },
      { seenDecision: returnsProof ? "exclude" : "replace", seenReason: returnsProof ? "proof-excludes" : "missing-proof",
        logical: decisions[0]?.logical, resource: decisions[0]?.resource, proofAdmitted: returnsProof },
    ]);
    const dispatch = events.filter((event) => event.phase === "dispatch")[1]!;
    expect(decisions[0]?.logical).toBe(dispatch.logical);
    expect(events.find((event) => event.phase === "settled" && event.read === dispatch.read)).toMatchObject({ outcome: "ok" });
    const reply = events.find((event) => event.phase === "reply" && event.read === dispatch.read);
    expect(reply).toMatchObject({ disposition: returnsProof ? "accepted" : "discarded", attempt: dispatch.attempt });
    expect(reply?.unreadChanged).toBe(returnsProof ? false : undefined);
    expect(read).toHaveBeenCalledTimes(returnsProof ? 2 : 3);
  } finally { pending.resolve(baseline); controller.dispose(); }
});
