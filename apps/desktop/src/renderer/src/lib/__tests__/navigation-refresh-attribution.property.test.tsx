import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { NavigationWindowQueries, navigationDemandKey } from "../navigation-window-queries";
import type { DesktopApi } from "../desktop-api";

const page: NavigationQueryPage = { protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "o", countsRevision: "r",
  coverage: { state: "complete" }, counts: { total: 0, active: 0, unread: 0, review: 0 }, entries: [], complete: true };
const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 100, query: { kind: "lens", lens: "inbox" } };

it("keeps the refresh caller independent of the invalidating event and query identity", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("navigation/refresh", "scheduled/thread-lifecycle", "action/materialize-launchpad",
      "action/pr-detach", "action/messaging-unbind", "action/remote-pin-add", "action/remote-pin-remove",
      "action/reply-refresh", "action/automation-refresh"),
    fc.constantFrom("turn/completed", "navigation/thread/seen", "thread/status/changed"),
    fc.integer({ min: 1, max: 4 }),
    async (caller, method, invalidations) => {
      const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page);
      const controller = new NavigationWindowQueries({ getNavigationQueryPage: read });
      try {
        controller.setDemand(new Map([["inbox", request]]));
        await controller.refresh();
        read.mockClear();
        const event = { backend: "codex", notification: { method: "navigation/invalidated",
          params: { sourceMethod: method, threadId: "PRIVATE THREAD" } } } as AgentEvent;
        for (let i = 0; i < invalidations; i++) controller.invalidate(undefined, undefined, event);
        await controller.refresh(undefined, undefined, true, undefined, caller);
        expect(read).toHaveBeenCalledTimes(1);
        const next = read.mock.calls[0]![0];
        expect(next.diagnostic).toMatchObject({ caller, trigger: method, invalidations });
        expect(JSON.stringify(next.diagnostic)).not.toContain("PRIVATE");
        expect(navigationDemandKey(next)).toBe(navigationDemandKey(request));
        await controller.refresh();
        expect(read.mock.calls.at(-1)![0].diagnostic).not.toHaveProperty("caller", caller);
      } finally { controller.dispose(); }
    },
  ), { numRuns: 25 });
});

it("attributes a pending read and its coalesced replacement to their own refresh callers", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page);
  const controller = new NavigationWindowQueries({ getNavigationQueryPage: read });
  try {
    controller.setDemand(new Map([["inbox", request]]));
    await controller.refresh();
    read.mockClear();
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    read.mockImplementationOnce(async () => { started(); await gate; return page; });
    const first = controller.refresh(undefined, undefined, false, undefined, "navigation/refresh");
    await entered;
    const second = controller.refresh(undefined, undefined, false, undefined, "scheduled/thread-lifecycle");
    finish();
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.map(([next]) => next.diagnostic?.caller))
      .toEqual(["navigation/refresh", "scheduled/thread-lifecycle"]);
  } finally { controller.dispose(); }
});
