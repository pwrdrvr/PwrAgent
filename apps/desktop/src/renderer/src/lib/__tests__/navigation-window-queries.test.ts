import type { DesktopApi } from "../desktop-api";
import { expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
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
