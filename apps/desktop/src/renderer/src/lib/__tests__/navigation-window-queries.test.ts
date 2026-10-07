import type { DesktopApi } from "../desktop-api";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationQueryEntry, NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { NavigationWindowQueries } from "../navigation-window-queries";

function request(filter = ""): NavigationQueryRequest {
  return { protocol: 2, consumer: "main-sidebar", pageSize: 10, query: { kind: "lens", lens: "inbox", filter } };
}
function page(patch: Partial<NavigationQueryPage> = {}): NavigationQueryPage {
  return { protocol: 2, queryKey: "query", generation: "generation", ownerEpoch: "owner", countsRevision: "revision",
    counts: { total: 100, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, entries: [], complete: false, nextCursor: "next", ...patch };
}
function directoryRows(start: number, end: number) {
  return Array.from({ length: end - start }, (_, index) => ({
    key: String(start + index), label: String(start + index), kind: "directory" as const,
    counts: { total: 0, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false,
  }));
}
/** An owner serves the rows a request asks for, from its cursor's offset. */
function owner(revision: string, total: number, expiredCursor?: string) {
  return async (request: NavigationQueryRequest): Promise<NavigationQueryPage> => {
    if (expiredCursor && request.cursor === expiredCursor) {
      throw new Error("[navigation_cursor_expired] Navigation cursor expired");
    }
    const start = request.cursor ? Number(request.cursor.split(":")[1]) : 0;
    const end = Math.min(total, start + (request.pageSize ?? 10));
    return page({ generation: revision, countsRevision: revision, complete: end >= total,
      nextCursor: end < total ? `${revision}:${end}` : undefined, directories: directoryRows(start, end) });
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("restores a lens range synchronously while a fresh lease refreshes it in place", async () => {
  const refreshed = deferred<NavigationQueryPage>();
  const read = vi.fn().mockResolvedValueOnce(page({ queryKey: "inbox", complete: true, nextCursor: undefined }))
    .mockResolvedValueOnce(page({ queryKey: "recents" }))
    .mockReturnValueOnce(refreshed.promise);
  const release = vi.fn(async () => undefined);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read, releaseNavigationQuery: release });
  const inbox = new Map([["lens", request()]]);
  const recents = new Map([["lens", { ...request(), query: { kind: "lens" as const, lens: "recents" as const } }]]);
  queries.setDemand(inbox);
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
  queries.setDemand(recents);
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.state.page?.queryKey).toBe("recents"));
  queries.setDemand(inbox);
  expect(queries.getSnapshot().resources.get("lens")?.state.page?.queryKey).toBe("inbox");
  expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(true);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read.mock.calls[2]?.[1]).not.toBe(read.mock.calls[0]?.[1]);
  expect(read.mock.calls[2]?.[0].completeBaselineRevision).toBeUndefined();
  refreshed.resolve(page({ queryKey: "inbox-updated" }));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.state.page?.queryKey).toBe("inbox-updated"));
  queries.dispose();
});

it("does not restore another owner's lens even with the same resource id", async () => {
  const pending = deferred<NavigationQueryPage>();
  const read = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(pending.promise);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["lens", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
  queries.setDemand(new Map([["lens", { ...request(), federationTarget: { scope: "remote", instanceId: "other" } }]]));
  expect(queries.getSnapshot().resources.get("lens")?.state.page).toBeUndefined();
  queries.dispose();
  pending.resolve(page());
});

it("requests only demanded first pages and loads continuation only on explicit demand", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page());
  const release = vi.fn(async () => undefined);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read, releaseNavigationQuery: release });
  queries.setDemand(new Map([["lens", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0]).toMatchObject({ pageSize: 10, cursor: undefined });
  read.mockResolvedValue(page({ complete: true, nextCursor: undefined }));
  await queries.loadMore("lens");
  // One click is a block of rows, not one transport page.
  expect(read.mock.calls[1]?.[0]).toMatchObject({ cursor: "next", pageSize: 100 });
  queries.setDemand(new Map());
  expect(release).toHaveBeenCalledTimes(1);
  expect(queries.getSnapshot().resources.size).toBe(0);
});

it("rejects a late response after query replacement and releases the exact old lease", async () => {
  const old = deferred<NavigationQueryPage>();
  const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(page({ queryKey: "new" }));
  const release = vi.fn(async () => undefined);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read, releaseNavigationQuery: release });
  queries.setDemand(new Map([["lens", request("old")]]));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  queries.setDemand(new Map([["lens", request("new")]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.state.page?.queryKey).toBe("new"));
  old.resolve(page());
  await old.promise;
  expect(queries.getSnapshot().resources.get("lens")?.state.page?.queryKey).toBe("new");
  expect(release).toHaveBeenCalledWith(read.mock.calls[0]?.[1]);
  expect(read.mock.calls[0]?.[1]).not.toBe(read.mock.calls[1]?.[1]);
  queries.dispose();
});

it("hidden demand never fetches and reconnect resumes with a new lease", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page());
  const release = vi.fn(async () => undefined);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read, releaseNavigationQuery: release });
  queries.setVisible(false);
  queries.setDemand(new Map([["lens", request()]]));
  await queries.refresh();
  expect(read).not.toHaveBeenCalled();
  queries.setVisible(true);
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.state.page).toBeDefined());
  const first = read.mock.calls[0]?.[1];
  queries.setVisible(false);
  expect(release).toHaveBeenCalledWith(first);
  expect(queries.getSnapshot().resources.get("lens")?.state.page?.counts.total).toBe(100);
  queries.setVisible(true);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls[1]?.[1]).not.toBe(first);
  queries.dispose();
});

it("coalesces invalidations during a pending read into one following refresh", async () => {
  const first = deferred<NavigationQueryPage>();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(page());
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["lens", request()]]));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  void queries.refresh(); void queries.refresh(); void queries.refresh();
  first.resolve(page());
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read).toHaveBeenCalledTimes(2);
  queries.dispose();
});

it("schedules every expanded resource with four physical reads instead of dropping demand after eight", async () => {
  const gates: ReturnType<typeof deferred<NavigationQueryPage>>[] = [];
  const read = vi.fn(() => { const gate = deferred<NavigationQueryPage>(); gates.push(gate); return gate.promise; });
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const demand = new Map(Array.from({ length: 20 }, (_, index) => [`directory-${index}`, request(String(index))]));
  queries.setDemand(demand);
  for (let end = 4; end <= 20; end += 4) {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(end));
    for (const gate of gates.slice(end - 4, end)) gate.resolve(page());
  }
  await vi.waitFor(() => expect([...queries.getSnapshot().resources.values()].every((resource) => resource.state.page && !resource.loading)).toBe(true));
  expect(queries.getSnapshot().resources.size).toBe(20);
  expect(queries.getSnapshot().admissionError).toBeUndefined();
  queries.dispose();
});

it("enforces the aggregate retained range budget while keeping the accepted baseline", async () => {
  let cursor = 0;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page({
    nextCursor: `cursor-${++cursor}`, directories: [{ key: `directory:${cursor}`, kind: "directory", label: "x".repeat(240_000),
      counts: { total: 0, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false }],
  }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["directory-index", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory-index")?.loading).toBe(false));
  for (let index = 0; index < 34; index += 1) await queries.loadMore("directory-index");
  const state = queries.getSnapshot().resources.get("directory-index")!.state;
  expect(state.page?.directories).toHaveLength(34);
  expect(state.stale).toBe(true);
  expect(state.error).toContain("retained-page budget");
  expect(new TextEncoder().encode(JSON.stringify(state.page)).byteLength).toBeLessThan(8 * 1024 * 1024);
  queries.dispose();
});

it("evicts inactive ranges before they consume the active view's byte budget", async () => {
  const read = vi.fn(async () => page({ complete: true, nextCursor: undefined,
    directories: [{ key: "directory", kind: "directory" as const, label: "x".repeat(240_000),
      counts: { total: 0, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false }],
  }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  for (let index = 0; index < 37; index += 1) {
    queries.setDemand(new Map([["lens", request(String(index))]]));
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
    expect(queries.getSnapshot().resources.get("lens")?.state.error).toBeUndefined();
  }
  queries.setVisible(false);
  queries.setDemand(new Map([["lens", request("0")]]));
  expect(queries.getSnapshot().resources.get("lens")?.state.page).toBeUndefined();
  queries.setDemand(new Map([["lens", request("36")]]));
  expect(queries.getSnapshot().resources.get("lens")?.state.page).toBeDefined();
  queries.dispose();
});

it("does not begin transport after the window closes before its scheduled read", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page());
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["lens", request()]]));
  queries.dispose();
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
});

it("rejects a late page after canonical invalidation and never certifies its stale baseline unchanged", async () => {
  const pending = deferred<NavigationQueryPage>();
  const read = vi.fn().mockResolvedValueOnce(page({ complete: true, nextCursor: undefined }))
    .mockReturnValueOnce(pending.promise).mockResolvedValue(page({ countsRevision: "canonical", complete: true, nextCursor: undefined }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["lens", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
  void queries.refresh();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  queries.invalidate();
  pending.resolve(page({ countsRevision: "late-old", complete: true, nextCursor: undefined }));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read.mock.calls[2]?.[0].completeBaselineRevision).toBeUndefined();
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.state.page?.countsRevision).toBe("canonical"));
  queries.dispose();
});

it("replaces an invalidated initial page once without polling settled pages", async () => {
  const pending = deferred<NavigationQueryPage>();
  const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(page({ countsRevision: "canonical" }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["directory:project", request()]]));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  // Git chip events patch accepted rows directly. They do not schedule a
  // collection refresh, but must not strand the page they invalidate.
  queries.invalidate();
  queries.invalidate();
  pending.resolve(page({ countsRevision: "late-old" }));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory:project")?.state.page?.countsRevision).toBe("canonical"));
  expect(read).toHaveBeenCalledTimes(2);
  queries.invalidate();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  queries.dispose();
});

it("retains a range with a removed anchor until explicit recovery and does not certify a tail as a full baseline", async () => {
  const read = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error("[navigation_anchor_missing] The visible anchor was removed."))
    .mockResolvedValue(page({ rangeStart: 80, complete: true, nextCursor: undefined }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["lens", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
  await queries.loadMore("lens");
  expect(queries.getSnapshot().resources.get("lens")?.state.rebaselineRequired).toBe(true);
  await queries.refresh();
  await queries.loadMore("lens");
  expect(read).toHaveBeenCalledTimes(2);
  const anchor = { kind: "thread" as const, ref: { backend: "codex" as const, threadId: "visible" } };
  await queries.rebaseline("lens", anchor);
  expect(read.mock.calls[2]?.[0]).toMatchObject({ anchor, cursor: undefined, completeBaselineRevision: undefined });
  expect(queries.getSnapshot().resources.get("lens")?.state.rebaselineRequired).toBe(false);
  await queries.refresh();
  expect(read.mock.calls[3]?.[0]).toMatchObject({ anchor, completeBaselineRevision: undefined });
  queries.dispose();
});

it("forgets a remembered missing anchor once, without an error, and keeps refreshing from the top", async () => {
  const read = vi.fn().mockResolvedValueOnce(page())
    .mockRejectedValueOnce(new Error("[navigation_anchor_missing] The visible anchor was removed."))
    .mockResolvedValue(page({ complete: true, nextCursor: undefined }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["lens", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
  const anchor = { kind: "thread" as const, ref: { backend: "codex" as const, threadId: "removed" } };
  queries.setVisibleAnchor("lens", anchor);
  const states: { loading: boolean; error?: string; rebaselineRequired?: boolean }[] = [];
  queries.subscribe(() => {
    const resource = queries.getSnapshot().resources.get("lens");
    if (resource) states.push({ loading: resource.loading, error: resource.state.error, rebaselineRequired: resource.state.rebaselineRequired });
  });
  await queries.refresh();
  // The anchored read and its replacement from the top share one logical read.
  expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.calls[1]?.[0].anchor).toEqual(anchor);
  expect(read.mock.calls[2]?.[0]).toMatchObject({ anchor: undefined, retainedRange: undefined });
  for (let index = 0; index < 3; index += 1) {
    queries.invalidate();
    await queries.refresh();
  }
  expect(read).toHaveBeenCalledTimes(6);
  expect(read.mock.calls.slice(2).every(([sent]) => sent.anchor === undefined)).toBe(true);
  expect(states.every((state) => !state.error && !state.rebaselineRequired)).toBe(true);
  queries.dispose();
});

it.each(["local", "viewer", "owner"] as const)("moves the %s directory anchor when pinning or unpinning changes its section", async (scope) => {
  const federationTarget = scope === "owner" ? { scope: "remote" as const, instanceId: "peer" } : undefined;
  const ref = { backend: "codex" as const, threadId: "selected", ...(scope !== "local" ? { ownerInstanceId: "peer" } : {}) };
  const entry = (threadId: string): NavigationQueryEntry => ({
    row: { id: threadId, source: "codex", title: threadId, titleSource: "explicit", ref: { ...ref, threadId },
      rowRevision: "r", linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0,
      nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" },
    placement: { kind: "root" }, orderKey: threadId,
  });
  for (const pinned of [true, false]) {
    for (const hasNeighbor of [true, false]) {
      const oldEntries = [entry("selected"), ...(hasNeighbor ? [entry("neighbor")] : [])];
      let moved = false;
      const read = vi.fn(async (request: NavigationQueryRequest) => {
        if (moved && request.anchor?.kind === "thread" && request.anchor.ref.threadId === ref.threadId) {
          throw new Error("[navigation_anchor_missing] The visible anchor was removed.");
        }
        return page({ complete: true, nextCursor: undefined, entries: moved ? oldEntries.slice(1) : oldEntries });
      });
      const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
      queries.setDemand(new Map([["directory", { ...request(), federationTarget,
        query: { kind: "directory", directoryKey: "project", roots: pinned ? "unpinned" : "pinned" } }]]));
      await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory")?.loading).toBe(false));
      queries.setVisibleAnchor("directory", { kind: "thread", ref });
      const event: AgentEvent = { backend: "codex", federationTarget, notification: scope === "viewer"
        ? { method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer", threadId: ref.threadId, pinned } }
        : scope === "owner"
          ? { method: "navigation/invalidated", params: { sourceMethod: pinned ? "thread/pin/added" : "thread/pin/removed", threadId: ref.threadId } }
          : pinned ? { method: "thread/pin/added", params: { threadId: ref.threadId, pinnedRank: "1024" } }
            : { method: "thread/pin/removed", params: { threadId: ref.threadId } } };
      moved = true;
      // A prior background event must not suppress the pin's anchor change.
      queries.invalidate();
      queries.invalidate(undefined, undefined, event);
      await queries.refresh();
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls[1]?.[0].anchor).toEqual(hasNeighbor ? { kind: "thread", ref: { ...ref, threadId: "neighbor" } } : undefined);
      const state = queries.getSnapshot().resources.get("directory")!.state;
      expect(state.error).toBeUndefined();
      expect(state.page?.entries).toEqual(oldEntries.slice(1));
      queries.dispose();
    }
  }
});

it("keeps a mounted viewer anchor when only the owner's pin changes", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page({ complete: true, nextCursor: undefined }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["directory", { ...request(),
    query: { kind: "directory", directoryKey: "project", roots: "unpinned" } }]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory")?.loading).toBe(false));
  const anchor = { kind: "thread" as const, ref: { backend: "codex" as const, threadId: "selected", ownerInstanceId: "peer" } };
  queries.setVisibleAnchor("directory", anchor);
  queries.invalidate(undefined, undefined, { backend: "codex", federationTarget: { scope: "remote", instanceId: "peer" },
    notification: { method: "navigation/invalidated", params: { sourceMethod: "thread/pin/added", threadId: "selected" } } });
  await queries.refresh();
  expect(read.mock.calls[1]?.[0].anchor).toEqual(anchor);
  queries.dispose();
});

it("replaces an in-flight read of a pin's old section without publishing its late missing-anchor error", async () => {
  const pending = deferred<NavigationQueryPage>();
  const read = vi.fn().mockResolvedValueOnce(page({ complete: true, nextCursor: undefined }))
    .mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error("[navigation_anchor_missing] The visible anchor was removed.");
    }).mockResolvedValue(page({ complete: true, nextCursor: undefined }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["directory", { ...request(),
    query: { kind: "directory", directoryKey: "project", roots: "unpinned" } }]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory")?.loading).toBe(false));
  queries.setVisibleAnchor("directory", { kind: "thread", ref: { backend: "codex", threadId: "selected", ownerInstanceId: "peer" } });
  const refresh = queries.refresh();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  queries.invalidate(undefined, undefined, { backend: "codex", notification: {
    method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer", threadId: "selected", pinned: true },
  } });
  const errors: (string | undefined)[] = [];
  queries.subscribe(() => errors.push(queries.getSnapshot().resources.get("directory")?.state.error));
  pending.resolve(page());
  await refresh;
  expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.calls[2]?.[0].anchor).toBeUndefined();
  expect(errors.every((error) => error === undefined)).toBe(true);
  queries.dispose();
});

it("honors explicit recovery queued behind a failing anchor read", async () => {
  const pending = deferred<NavigationQueryPage>();
  const read = vi.fn().mockResolvedValueOnce(page())
    .mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error("[navigation_anchor_missing] The visible anchor was removed.");
    }).mockResolvedValue(page({ complete: true, nextCursor: undefined }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["lens", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
  queries.setVisibleAnchor("lens", { kind: "thread", ref: { backend: "codex", threadId: "old" } });
  const refresh = queries.refresh();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  const anchor = { kind: "thread" as const, ref: { backend: "codex" as const, threadId: "new" } };
  const recovery = queries.rebaseline("lens", anchor);
  pending.resolve(page());
  await Promise.all([refresh, recovery]);
  // The failing read falls back to the top, then the explicit anchor runs.
  expect(read).toHaveBeenCalledTimes(4);
  expect(read.mock.calls[2]?.[0].anchor).toBeUndefined();
  expect(read.mock.calls[3]?.[0].anchor).toEqual(anchor);
  expect(queries.getSnapshot().resources.get("lens")?.state.error).toBeUndefined();
  queries.dispose();
});

/**
 * A directory's unpinned roots as their owner serves them: ten-row pages, an
 * anchor seeks the page start, and an anchor outside the query is refused the
 * way `NavigationQueryStore.readPage` refuses it across Electron IPC.
 */
function directoryOwner(state: { threads: string[]; revision: string; expiredCursors?: Set<string> }) {
  const entry = (threadId: string): NavigationQueryEntry => ({
    row: { id: threadId, source: "codex", title: threadId, titleSource: "explicit", ref: { backend: "codex", threadId },
      rowRevision: "r", linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0,
      nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" },
    placement: { kind: "root" }, orderKey: threadId,
  });
  return vi.fn(async (request: NavigationQueryRequest): Promise<NavigationQueryPage> => {
    if (request.cursor && state.expiredCursors?.has(request.cursor)) {
      throw new Error("Error invoking remote method 'navigation:get-query-page': NavigationQueryError: [navigation_cursor_expired] Navigation cursor expired; rebaseline around the visible anchor.");
    }
    let start = request.cursor ? Number(request.cursor.split(":")[1]) : 0;
    if (!request.cursor && request.anchor?.kind === "thread") {
      start = state.threads.indexOf(request.anchor.ref.threadId);
      if (start < 0) {
        throw new Error("Error invoking remote method 'navigation:get-query-page': NavigationQueryError: [navigation_anchor_missing] The visible navigation anchor is no longer in this query (reason: not-indexed). Choose another item or restart this list explicitly.");
      }
    }
    const end = Math.min(state.threads.length, start + (request.pageSize ?? 10));
    return page({ generation: state.revision, countsRevision: state.revision, ...(start ? { rangeStart: start } : {}),
      complete: end >= state.threads.length, nextCursor: end < state.threads.length ? `${state.revision}:${end}` : undefined,
      entries: state.threads.slice(start, end).map(entry) });
  });
}
const threadNames = (count: number) => Array.from({ length: count }, (_, index) => `thread-${index}`);
const unpinnedDirectory = () => new Map([["directory:project", { ...request(),
  query: { kind: "directory" as const, directoryKey: "project", roots: "unpinned" as const } }]]);
const loadedThreads = (queries: NavigationWindowQueries) =>
  queries.getSnapshot().resources.get("directory:project")?.state.page?.entries.map(({ row }) => row.ref.threadId);

it("keeps a directory list working after the selected root it was revealed at leaves the directory", async () => {
  // Twelve threads: the selected thread's root is on the second page, so
  // selection reveals it with an anchored rebaseline. That anchor is then
  // remembered for every later refresh of this directory.
  const owned = { threads: threadNames(12), revision: "initial" };
  const read = directoryOwner(owned);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(unpinnedDirectory());
  await vi.waitFor(() => expect(loadedThreads(queries)).toHaveLength(10));
  await queries.rebaseline("directory:project", { kind: "thread", ref: { backend: "codex", threadId: "thread-11" } });
  expect(loadedThreads(queries)).toEqual(["thread-11"]);

  // The revealed root is archived, moved, or reparented. Its canonical event
  // refreshes the directory, which still carries the remembered anchor.
  owned.threads = owned.threads.filter((threadId) => threadId !== "thread-11");
  owned.revision = "archived";
  queries.invalidate();
  await queries.refresh();

  const state = queries.getSnapshot().resources.get("directory:project")!.state;
  expect(state.error).toBeUndefined();
  expect(state.rebaselineRequired).toBeFalsy();
  expect(loadedThreads(queries)).toEqual(threadNames(10));
  expect(state.page?.rangeStart ?? 0).toBe(0);

  // The list keeps following its owner without an explicit restart.
  owned.threads = ["thread-new", ...owned.threads];
  owned.revision = "created";
  queries.invalidate();
  await queries.refresh();
  expect(loadedThreads(queries)?.[0]).toBe("thread-new");
  expect(queries.getSnapshot().resources.get("directory:project")?.state.error).toBeUndefined();
  queries.dispose();
});

it("re-anchors a mid-list window on the nearest surviving row when its anchor leaves", async () => {
  const owned = { threads: threadNames(30), revision: "initial" };
  const read = directoryOwner(owned);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(unpinnedDirectory());
  await vi.waitFor(() => expect(loadedThreads(queries)).toHaveLength(10));
  await queries.rebaseline("directory:project", { kind: "thread", ref: { backend: "codex", threadId: "thread-12" } });
  expect(loadedThreads(queries)?.[0]).toBe("thread-12");

  owned.threads = owned.threads.filter((threadId) => threadId !== "thread-12");
  owned.revision = "archived";
  queries.invalidate();
  await queries.refresh();

  const state = queries.getSnapshot().resources.get("directory:project")!.state;
  expect(state.error).toBeUndefined();
  // The window stays where the operator was reading instead of jumping to the top.
  expect(loadedThreads(queries)).toEqual(threadNames(23).slice(13));
  expect(state.page?.rangeStart).toBe(12);
  queries.dispose();
});

it("loads more after an idle cursor expires even when the remembered anchor has left", async () => {
  const owned = { threads: threadNames(12), revision: "initial", expiredCursors: new Set<string>() };
  const read = directoryOwner(owned);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(unpinnedDirectory());
  await vi.waitFor(() => expect(loadedThreads(queries)).toHaveLength(10));
  await queries.rebaseline("directory:project", { kind: "thread", ref: { backend: "codex", threadId: "thread-0" } });
  expect(queries.getSnapshot().resources.get("directory:project")?.state.page?.nextCursor).toBe("initial:10");

  // Owners keep a cursor for 60 seconds. The remembered anchor also left
  // while the operator read the page.
  owned.threads = owned.threads.filter((threadId) => threadId !== "thread-0");
  owned.revision = "archived";
  owned.expiredCursors.add("initial:10");
  await queries.loadMore("directory:project");

  const state = queries.getSnapshot().resources.get("directory:project")!.state;
  expect(state.error).toBeUndefined();
  expect(state.rebaselineRequired).toBeFalsy();
  expect(loadedThreads(queries)).toEqual(threadNames(12).slice(1));
  queries.dispose();
});

it("preserves loaded rows through refresh and transparently rebuilds an evicted continuation", async () => {
  let serve = owner("old", 130);
  const read = vi.fn(async (request: NavigationQueryRequest) => serve(request));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["directory-index", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory-index")?.loading).toBe(false));
  await queries.loadMore("directory-index");
  expect(queries.getSnapshot().resources.get("directory-index")?.state.page?.directories).toHaveLength(110);
  const sizes: number[] = [];
  queries.subscribe(() => sizes.push(queries.getSnapshot().resources.get("directory-index")?.state.page?.directories?.length ?? 0));
  serve = owner("fresh", 130);
  queries.invalidate();
  await queries.refresh();
  expect(queries.getSnapshot().resources.get("directory-index")?.state.page?.directories).toHaveLength(110);
  serve = owner("rebuilt", 130, "fresh:110");
  await queries.loadMore("directory-index");
  const state = queries.getSnapshot().resources.get("directory-index")!.state;
  expect(state.page?.directories?.map((directory) => directory.key)).toEqual(Array.from({ length: 130 }, (_, index) => String(index)));
  expect(state.error).toBeUndefined();
  expect(Math.min(...sizes)).toBe(110);
  // Demand, one continuation, two to restore the range, then the expired
  // cursor, its rebaseline and two more to rebuild the range with the block.
  expect(read).toHaveBeenCalledTimes(8);
  queries.dispose();
});

it("finishes one click across a clamped owner's pages instead of returning the button", async () => {
  let clamped = 0;
  const read = vi.fn(async (request: NavigationQueryRequest) => {
    const start = request.cursor ? Number(request.cursor.split(":")[1]) : 0;
    const end = start + Math.min(25, request.pageSize ?? 10);
    clamped += 1;
    return page({ nextCursor: `owner:${end}`, directories: directoryRows(start, end) });
  });
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["directory-index", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory-index")?.loading).toBe(false));
  expect(clamped).toBe(1);
  await queries.loadMore("directory-index");
  const state = queries.getSnapshot().resources.get("directory-index")!.state;
  expect(state.page?.directories).toHaveLength(110);
  expect(state.error).toBeUndefined();
  // Four owner pages of 25 rows, asked for in one click; the last asks for
  // exactly the rows the block still wants.
  expect(read).toHaveBeenCalledTimes(5);
  expect(read.mock.calls.map(([sent]) => sent.pageSize)).toEqual([10, 100, 75, 50, 25]);
  queries.dispose();
});

it("retains a short continuation's bounded demand across release, growth and filtering", async () => {
  let serve = owner("initial", 20);
  const read = vi.fn(async (request: NavigationQueryRequest) => serve(request));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const demand = new Map([["pins", request()]]);
  const loaded = () => queries.getSnapshot().resources.get("pins")?.state.page?.directories;
  try {
    queries.setDemand(demand);
    await vi.waitFor(() => expect(loaded()).toHaveLength(10));
    await queries.loadMore("pins");
    expect(loaded()).toHaveLength(20);
    queries.setDemand(new Map());
    const releasedReads = read.mock.calls.length;
    serve = owner("grown", 1000);
    await queries.refresh();
    expect(read).toHaveBeenCalledTimes(releasedReads);
    queries.setDemand(demand);
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("pins")?.loading).toBe(false));
    expect(loaded()).toHaveLength(110);
    expect(queries.getSnapshot().resources.get("pins")?.state.page?.complete).toBe(false);

    // A different filter has independent demand, while returning restores
    // the operator's earlier expansion. Explicit restart resets that demand.
    queries.setDemand(new Map([["pins", request("other")]]));
    await vi.waitFor(() => expect(loaded()).toHaveLength(10));
    queries.setDemand(demand);
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("pins")?.loading).toBe(false));
    expect(loaded()).toHaveLength(110);
    await queries.restart("pins");
    expect(loaded()).toHaveLength(10);
    await queries.refresh();
    expect(loaded()).toHaveLength(10);
  } finally { queries.dispose(); }
});

it.each([10, 20, 30])("commits a failed refresh only after restoring its displayed range (failure at %s)", async (failureAt) => {
  let serve = owner("initial", 20);
  const read = vi.fn(async (request: NavigationQueryRequest) => serve(request));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const state = () => queries.getSnapshot().resources.get("pins")!.state;
  try {
    queries.setDemand(new Map([["pins", request()]]));
    await vi.waitFor(() => expect(state().page?.directories).toHaveLength(10));
    await queries.loadMore("pins");
    const baseline = state().page;
    expect(baseline?.directories).toHaveLength(20);
    for (const revision of ["fresh", "newer"]) {
      serve = async (request) => {
        if (Number(request.cursor?.split(":")[1] ?? 0) >= failureAt) throw new Error("Extension unavailable");
        const next = await owner(revision, 100)({ ...request, pageSize: 10 });
        return { ...next, directories: next.directories?.map((directory) => ({ ...directory,
          key: `${revision}:${directory.key}`, label: `${revision} label ${directory.key}`,
        })) };
      };
      queries.invalidate();
      await queries.refresh();
      expect(state().error).toBe("Extension unavailable");
      if (failureAt < 20) {
        // An incomplete restoration must not shrink the displayed range.
        expect(state().page).toBe(baseline);
      } else {
        // Failure while admitting extra rows must not discard fresh
        // membership/metadata, even when the next refresh fails there too.
        expect(state().page?.countsRevision).toBe(revision);
        expect(state().page?.directories).toEqual(directoryRows(0, failureAt).map((directory) => ({ ...directory,
          key: `${revision}:${directory.key}`, label: `${revision} label ${directory.key}`,
        })));
        expect(state().page?.nextCursor).toBe(`${revision}:${failureAt}`);
      }
    }
  } finally { queries.dispose(); }
});

it.each(["reads", "time"] as const)("bounds newly admitted growth on refresh by %s while restoring existing rows", async (budget) => {
  let grow = false;
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const serve = owner("initial", 20);
  const read = vi.fn(async (request: NavigationQueryRequest) => {
    if (!grow) return serve(request);
    // Tiny transport pages must restore the existing 20 even when that
    // consumes the extension budget; they must not then scan to capacity.
    if (budget === "time") now += 10_000;
    return owner("grown", 1000)({ ...request, pageSize: 1 });
  });
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  try {
    queries.setDemand(new Map([["pins", request()]]));
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("pins")?.loading).toBe(false));
    await queries.loadMore("pins");
    grow = true;
    read.mockClear();
    queries.invalidate();
    await queries.refresh();
    expect(queries.getSnapshot().resources.get("pins")?.state.page?.directories).toHaveLength(20);
    expect(read).toHaveBeenCalledTimes(20);
  } finally { queries.dispose(); clock.mockRestore(); }
});

it("halves an oversized page instead of failing the same way on every press", async () => {
  // The owner clamps a page to its own copy of the byte budget; a remote page
  // is then stamped with federation metadata on every row it served, so it can
  // arrive here over that budget. The request is deterministic, so without the
  // retry the operator's only continuation control fails forever.
  const fat = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({
    key: String(start + index), label: "x".repeat(4_000), kind: "directory" as const,
    counts: { total: 0, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false,
  }));
  const read = vi.fn(async (request: NavigationQueryRequest) => {
    const start = request.cursor ? Number(request.cursor.split(":")[1]) : 0;
    const end = start + (request.pageSize ?? 100);
    return page({ nextCursor: `owner:${end}`, directories: fat(start, end) });
  });
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["directory-index", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory-index")?.loading).toBe(false));
  await queries.loadMore("directory-index");
  const state = queries.getSnapshot().resources.get("directory-index")!.state;
  expect(state.error).toBeUndefined();
  // 100 rows of these do not fit; 50 do, and that halved page is what lands.
  // The block is still delivered, in one more read than an owner that clamps
  // itself would have needed.
  expect(read.mock.calls.slice(1).map(([sent]) => sent.pageSize)).toEqual([100, 50, 50]);
  expect(state.page?.directories).toHaveLength(110);
  queries.dispose();
});

it("ends a click on its time budget with the rows it delivered", async () => {
  // Only Date is faked: the reads below still settle on real microtasks.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    let served = 0;
    const read = vi.fn(async () => {
      served += 1;
      // A slow owner. The first continuation lands inside the budget; the
      // next one carries the click past it.
      if (served > 1) vi.advanceTimersByTime(6_000);
      return page({ nextCursor: `owner:${served}`, directories: directoryRows(served, served + 1) });
    });
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    queries.setDemand(new Map([["directory-index", request()]]));
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory-index")?.loading).toBe(false));
    await queries.loadMore("directory-index");
    const state = queries.getSnapshot().resources.get("directory-index")!.state;
    // Demand, then two extensions: the second ends the budget, and the read
    // cap of eight is never reached.
    expect(read).toHaveBeenCalledTimes(3);
    expect(state.page?.directories).toHaveLength(3);
    expect(state.page?.nextCursor).toBeDefined();
    expect(state.error).toBeUndefined();
    queries.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("bounds one click to a few reads when an owner serves one row at a time", async () => {
  let served = 0;
  const read = vi.fn(async () => {
    served += 1;
    return page({ nextCursor: `owner:${served}`, directories: directoryRows(served, served + 1) });
  });
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["directory-index", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory-index")?.loading).toBe(false));
  await queries.loadMore("directory-index");
  const state = queries.getSnapshot().resources.get("directory-index")!.state;
  // A degenerate owner never reaches the block. The click stops at a bounded
  // number of reads and leaves the button rather than scanning the owner.
  expect(read).toHaveBeenCalledTimes(10);
  expect(state.page?.nextCursor).toBeDefined();
  expect(state.error).toBeUndefined();
  queries.dispose();
});

it("honors Load more when a refresh starts before the click is handled", async () => {
  const pending = deferred<NavigationQueryPage>();
  const read = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(pending.promise)
    .mockResolvedValue(page({ generation: "fresh", countsRevision: "fresh", complete: true, nextCursor: undefined }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["lens", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
  const refreshing = queries.refresh();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  const loadingMore = queries.loadMore("lens");
  pending.resolve(page({ generation: "fresh", countsRevision: "fresh", nextCursor: "fresh-next" }));
  await Promise.all([refreshing, loadingMore]);
  expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.calls[2]?.[0].cursor).toBe("fresh-next");
  expect(queries.getSnapshot().resources.get("lens")?.state.page?.complete).toBe(true);
  queries.dispose();
});

it("explicit restart drops tail acknowledgments even when requested during a refresh", async () => {
  const pending = deferred<NavigationQueryPage>();
  const read = vi.fn().mockResolvedValueOnce(page({ rangeStart: 30, complete: true, nextCursor: undefined }))
    .mockReturnValueOnce(pending.promise).mockResolvedValue(page({ rangeStart: 0 }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["pins", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("pins")?.loading).toBe(false));
  queries.setVisibleAnchor("pins", { kind: "thread", ref: { backend: "codex", threadId: "last" } });
  const refreshing = queries.refresh("pins");
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  const restarting = queries.restart("pins");
  pending.resolve(page({ rangeStart: 30, complete: true, nextCursor: undefined }));
  await Promise.all([refreshing, restarting]);
  expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.calls[2]?.[0]).toMatchObject({ anchor: undefined, cursor: undefined,
    retainedRange: undefined, completeBaselineRevision: undefined });
  expect(queries.getSnapshot().resources.get("pins")?.state.page?.rangeStart).toBe(0);
  queries.dispose();
});


it("publishes one invalidation per read generation across a hundred-event burst", async () => {
  const gates: ReturnType<typeof deferred<NavigationQueryPage>>[] = [];
  const read = vi.fn(() => { const gate = deferred<NavigationQueryPage>(); gates.push(gate); return gate.promise; });
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const notify = vi.fn();
  queries.subscribe(notify);
  try {
    queries.setDemand(new Map([["lens", request()]]));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    notify.mockClear();
    queries.invalidate();
    const invalidated = queries.getSnapshot();
    for (let index = 0; index < 99; index += 1) queries.invalidate();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(queries.getSnapshot()).toBe(invalidated);
    gates[0]!.resolve(page({ countsRevision: "late-first" }));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    // A new event must fence the replacement even though its baseline is stale.
    notify.mockClear();
    for (let index = 0; index < 100; index += 1) queries.invalidate();
    expect(notify).toHaveBeenCalledTimes(1);
    gates[1]!.resolve(page({ countsRevision: "late-second" }));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(queries.getSnapshot().resources.get("lens")?.state.page).toBeUndefined();
    gates[2]!.resolve(page({ countsRevision: "fresh" }));
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
    expect(queries.getSnapshot().resources.get("lens")?.state.page?.countsRevision).toBe("fresh");
    notify.mockClear();
    for (let index = 0; index < 100; index += 1) queries.invalidate();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    queries.dispose();
    for (const gate of gates) gate.resolve(page());
  }
});

it("does not publish or refetch for identical demand or absent-resource invalidations", async () => {
  const read = vi.fn(async () => page());
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  try {
    queries.setDemand(new Map([["lens", request()]]));
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
    const snapshot = queries.getSnapshot();
    const notify = vi.fn();
    queries.subscribe(notify);
    for (let index = 0; index < 100; index += 1) {
      queries.setDemand(new Map([["lens", request()]]));
      queries.invalidate("removed-directory");
    }
    expect(queries.getSnapshot()).toBe(snapshot);
    expect(notify).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    queries.setDemand(new Map());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(queries.getSnapshot().resources.size).toBe(0);
  } finally { queries.dispose(); }
});


it("keeps another owner's pending page and conditional baseline across a local invalidation", async () => {
  const remote = deferred<NavigationQueryPage>();
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (query) =>
    query.federationTarget?.scope === "remote" ? remote.promise : page({ complete: true, nextCursor: undefined }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([
    ["local", request()],
    ["remote", { ...request(), federationTarget: { scope: "remote", instanceId: "peer" } }],
  ]));
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    queries.invalidate(undefined, [{ scope: "local" }]);
    await queries.refresh(undefined, [{ scope: "local" }]);
    expect(read.mock.calls.filter(([query]) => query.federationTarget?.scope === "remote")).toHaveLength(1);
    remote.resolve(page({ queryKey: "remote", complete: true, nextCursor: undefined }));
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("remote")?.loading).toBe(false));
    expect(queries.getSnapshot().resources.get("remote")?.state.page?.queryKey).toBe("remote");
    expect(read.mock.calls.filter(([query]) => query.federationTarget?.scope === "remote")).toHaveLength(1);
    queries.invalidate(undefined, [{ scope: "local" }]);
    await queries.refresh("remote");
    expect(read.mock.calls.at(-1)?.[0].completeBaselineRevision).toBe("revision");
  } finally {
    queries.dispose();
    remote.resolve(page());
  }
});

it("does not recreate a remote resource for equivalent object and identity-set order", async () => {
  const read = vi.fn(async () => page({ complete: true, nextCursor: undefined }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const target = { scope: "remote" as const, instanceId: "owner" };
  const a = { backend: "codex" as const, threadId: "a", ownerInstanceId: "owner" };
  const b = { backend: "codex" as const, threadId: "b", ownerInstanceId: "owner" };
  try {
    queries.setDemand(new Map([["exact", { ...request(), federationTarget: target, query: { kind: "exact", identities: [a, b] } }]]));
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("exact")?.loading).toBe(false));
    read.mockClear();
    for (let i = 0; i < 20; i++) queries.setDemand(new Map([["exact", {
      federationTarget: { instanceId: "owner", scope: "remote" }, ...request(),
      query: { identities: [{ threadId: "b", ownerInstanceId: "owner", backend: "codex" }, a], kind: "exact" },
    }]]));
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("exact")?.loading).toBe(false));
    expect(read).not.toHaveBeenCalled();
  } finally { queries.dispose(); }
});

it("consumes an invalidation once when a scheduled refresh overlaps its replacement", async () => {
  const first = deferred<NavigationQueryPage>();
  const second = deferred<NavigationQueryPage>();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const owners = [{ scope: "remote" as const, instanceId: "owner" }];
  try {
    queries.setDemand(new Map([["lens", { ...request(), federationTarget: owners[0] }]]));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 27; i++) queries.invalidate(undefined, owners);
    first.resolve(page());
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    // The timer scheduled by those events fires after the replacement began.
    const scheduled = queries.refresh(undefined, owners, true);
    second.resolve(page());
    await scheduled;
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.loading).toBe(false));
    expect(read).toHaveBeenCalledTimes(2);
  } finally { queries.dispose(); }
});

// Complete expanded child ranges know their membership. Row-only changes must
// refresh the affected disclosure, not every expanded group in the window.
it.each(["thread/name/updated", "thread/pin/added", "navigation/thread/seen", "turn/started"])(
  "budgets one child read for %s across twelve expanded groups", async (method) => {
    const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
      const parent = request.query.kind === "children" ? request.query.parent.threadId : "";
      return page({ complete: true, nextCursor: undefined, entries: [{ placement: { kind: "root" }, orderKey: parent,
        row: { id: `${parent}-child`, source: "codex", title: "fresh", titleSource: "explicit",
          linkedDirectories: [], inbox: { inInbox: true }, rowRevision: "r", ordinaryChildCount: 0,
          nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown", ref: { backend: "codex", threadId: `${parent}-child` } },
      }] });
    });
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    queries.setDemand(new Map(Array.from({ length: 12 }, (_, index) => [`group-${index}`, {
      protocol: 2 as const, consumer: "main-sidebar" as const,
      query: { kind: "children" as const, parent: { backend: "codex", threadId: `parent-${index}` } },
    }])));
    try {
      await vi.waitFor(() => expect([...queries.getSnapshot().resources.values()].every((resource) => !resource.loading)).toBe(true));
      expect(read).toHaveBeenCalledTimes(12);
      read.mockClear();
      const event = { backend: "codex", notification: { method, params: { threadId: "parent-0-child" } } } as AgentEvent;
      queries.invalidate(undefined, undefined, event);
      await queries.refresh(undefined, undefined, true);
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0]?.[0].query).toMatchObject({ parent: { threadId: "parent-0" } });
      expect(queries.getSnapshot().resources.get("group-0")?.state.page?.entries[0]?.row.title).toBe("fresh");
      // New children can be unknown to a complete baseline. Keep discovery.
      read.mockClear();
      queries.invalidate(undefined, undefined, { backend: "codex", notification: {
        method: "thread/started", params: { thread: { id: "new-child" } },
      } } as AgentEvent);
      await queries.refresh(undefined, undefined, true);
      expect(read).toHaveBeenCalledTimes(12);
    } finally {
      queries.dispose();
    }
  },
);

it("keeps child invalidation scoped to federation identity", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    const ownerInstanceId = request.query.kind === "children" ? request.query.parent.ownerInstanceId : undefined;
    return page({ complete: true, nextCursor: undefined, entries: [{ placement: { kind: "root" }, orderKey: "child",
      row: { id: "shared-child", source: "codex", title: "Fresh", titleSource: "explicit", ref: {
        backend: "codex", threadId: "shared-child", ownerInstanceId,
      }, rowRevision: "r", linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0,
      nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" },
    }] });
  });
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map(["peer-a", "peer-b"].map((ownerInstanceId) => [ownerInstanceId, {
    protocol: 2 as const, consumer: "main-sidebar" as const, inventory: "viewer" as const,
    query: { kind: "children" as const, parent: { backend: "codex", threadId: "parent", ownerInstanceId } },
  }])));
  try {
    await vi.waitFor(() => expect([...queries.getSnapshot().resources.values()].every((resource) => !resource.loading)).toBe(true));
    read.mockClear();
    queries.invalidate(undefined, undefined, { backend: "codex", federationTarget: { scope: "remote", instanceId: "peer-a" },
      notification: { method: "navigation/invalidated", params: { sourceMethod: "thread/name/updated", threadId: "shared-child" } },
    });
    await queries.refresh(undefined, undefined, true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0].query).toMatchObject({ parent: { ownerInstanceId: "peer-a" } });
  } finally { queries.dispose(); }
});

it.each([
  { complete: false, nextCursor: "next" },
  { complete: true, nextCursor: undefined, rangeStart: 10 },
])("keeps child discovery conservative for incomplete ranges %j", async (range) => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page(range));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["children", { protocol: 2, consumer: "main-sidebar",
    query: { kind: "children", parent: { backend: "codex", threadId: "parent" } },
  }]]));
  try {
    await vi.waitFor(() => expect(queries.getSnapshot().resources.get("children")?.loading).toBe(false));
    read.mockClear();
    queries.invalidate(undefined, undefined, { backend: "codex", notification: {
      method: "thread/name/updated", params: { threadId: "off-page-child", threadName: "Changed" },
    } });
    await queries.refresh(undefined, undefined, true);
    expect(read).toHaveBeenCalledTimes(1);
  } finally { queries.dispose(); }
});

it.each(["thread/started", "thread/parent/set"])(
  "refreshes a newly discovered child's status during a pending %s read", async (method) => {
    const membership = deferred<NavigationQueryPage>();
    const fresh = deferred<NavigationQueryPage>();
    const empty = page({ complete: true, nextCursor: undefined, counts: { total: 0, active: 0, unread: 0, review: 0 } });
    const childPage = (threadStatus: "idle" | "active") => page({ complete: true, nextCursor: undefined,
      counts: { total: 1, active: threadStatus === "active" ? 1 : 0, unread: 0, review: 0 },
      entries: [{ orderKey: "new-child", placement: { kind: "root" }, row: {
        id: "new-child", source: "codex", title: "New child", titleSource: "explicit", threadStatus,
        ref: { backend: "codex", threadId: "new-child" }, rowRevision: threadStatus, linkedDirectories: [],
        inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
        queueCount: 0, queueState: "unknown",
      } }],
    });
    const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>()
      .mockResolvedValueOnce(empty).mockReturnValueOnce(membership.promise).mockReturnValueOnce(fresh.promise);
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    queries.setDemand(new Map([["children", { protocol: 2, consumer: "main-sidebar",
      query: { kind: "children", parent: { backend: "codex", threadId: "parent" } },
    }]]));
    try {
      await vi.waitFor(() => expect(queries.getSnapshot().resources.get("children")?.loading).toBe(false));
      queries.invalidate(undefined, undefined, { backend: "codex", notification: { method,
        params: { threadId: "new-child", thread: { id: "new-child" }, parentThreadId: "parent" },
      } } as AgentEvent);
      const refreshing = queries.refresh(undefined, undefined, true);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      // The old complete baseline has no new-child yet. Its status event must
      // still fence this in-flight membership response and coalesce a replacement.
      for (let index = 0; index < 2; index++) queries.invalidate(undefined, undefined, { backend: "codex", notification: {
        method: "thread/status/changed", params: { threadId: "new-child", status: { type: "active" } },
      } });
      membership.resolve(childPage("idle"));
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      expect(queries.getSnapshot().resources.get("children")?.state.page?.entries).toEqual([]);
      fresh.resolve(childPage("active"));
      await refreshing;
      expect(queries.getSnapshot().resources.get("children")?.state.page?.entries[0]?.row.threadStatus).toBe("active");
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      queries.dispose();
      membership.resolve(empty);
      fresh.resolve(empty);
    }
  },
);
