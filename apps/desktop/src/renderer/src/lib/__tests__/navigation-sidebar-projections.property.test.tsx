import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationRow } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";
import { useThreadNavigation } from "../useThreadNavigation";

function owner() {
  let coverage: NavigationQueryPage["coverage"] = { state: "complete" };
  const row = (id: string): NavigationRow => ({
    id, source: "codex", title: id, titleSource: "explicit", ref: { backend: "codex", threadId: id },
    rowRevision: "r", linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0,
    nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
  });
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    const rows = request.query.kind === "exact" ? request.query.identities.map((ref) => row(ref.threadId))
      : request.query.kind === "lens" && request.query.roots !== "pinned" ? [row("one"), row("two")] : [];
    return { protocol: 2, queryKey: JSON.stringify(request.query), generation: "g", ownerEpoch: "owner", countsRevision: "r",
      counts: { total: rows.length, active: 0, unread: 0, review: 0 }, coverage: { ...coverage },
      entries: rows.map((entry) => ({ row: entry, placement: { kind: "root" }, orderKey: entry.id })), directories: [], complete: true };
  });
  const release = vi.fn(async () => undefined);
  const api: DesktopApi = {
    getNavigationQueryPage: read, releaseNavigationQuery: release,
    getNavigationSelectedDetail: async (request) => ({ protocol: 2, ref: request.ref, revision: "r", readiness: "ready", identity: "present", thread: row(request.ref.threadId) }),
    onAgentEvent: () => () => undefined,
  };
  return { api, read, release, coverage: (next: typeof coverage) => { coverage = next; } };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps the bounded window projection stable through generated unrelated renders", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer(), { minLength: 1, maxLength: 20 }), async (actions) => {
    const f = owner();
    const view = renderHook(() => useBoundedNavigationWindow({ desktopApi: f.api, enabled: true, visible: true,
      browseMode: "inbox", attentionView: { id: "fixture", promoteOnTurnEnd: true }, expandedByKey: {}, unpinnedExpandedByKey: {} }));
    try {
      await waitFor(() => expect(view.result.current.presentationReady).toBe(true));
      const before = view.result.current;
      const reads = f.read.mock.calls.length;
      for (const _action of actions) {
        view.rerender();
        expect(view.result.current).toBe(before);
        expect(f.read).toHaveBeenCalledTimes(reads);
      }
    } finally { view.unmount(); }
  }), { numRuns: 25 });
});

it("keeps sidebar data wrappers stable after the rows have accepted their pages", async () => {
  const f = owner();
  const view = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  await waitFor(() => expect(view.result.current.pagesAwaitingRows).toEqual([]));
  const before = view.result.current;
  const reads = f.read.mock.calls.length;
  for (let action = 0; action < 20; action++) {
    view.rerender();
    expect(view.result.current.pagedNavigation).toBe(before.pagedNavigation);
    expect(view.result.current.pagesAwaitingRows).toBe(before.pagesAwaitingRows);
    expect(view.result.current.providerRefresh).toBe(before.providerRefresh);
    expect(f.read).toHaveBeenCalledTimes(reads);
  }
});

it("publishes changed owner coverage immediately while preserving accepted-row readiness", async () => {
  const f = owner();
  const view = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(view.result.current.providerRefresh?.state).toBe("ready"));
  f.coverage({ state: "degraded", failedProviders: 2 });
  await act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.providerRefresh).toEqual({ state: "degraded", failedProviders: 2 }));
  f.coverage({ state: "complete" });
  await act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.providerRefresh?.state).toBe("ready"));
  await waitFor(() => expect(view.result.current.pagesAwaitingRows).toEqual([]));
  const current = view.result.current.providerRefresh;
  view.rerender();
  expect(view.result.current.providerRefresh).toBe(current);
});
