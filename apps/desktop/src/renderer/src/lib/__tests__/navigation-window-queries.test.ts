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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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
  expect(read.mock.calls[1]?.[0]).toMatchObject({ cursor: "next" });
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
  const directories = (start: number, end: number, revision: string, nextCursor?: string) => page({
    generation: revision, countsRevision: revision, complete: !nextCursor, nextCursor,
    directories: Array.from({ length: end - start }, (_, i) => ({ key: String(start + i), label: String(start + i),
      kind: "directory" as const, counts: { total: 0, active: 0, unread: 0, review: 0 },
      pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false })),
  });
  const read = vi.fn()
    .mockResolvedValueOnce(directories(0, 10, "old", "old-10"))
    .mockResolvedValueOnce(directories(10, 20, "old", "old-20"))
    .mockResolvedValueOnce(directories(0, 10, "fresh", "fresh-10"))
    .mockResolvedValueOnce(directories(10, 20, "fresh", "fresh-20"))
    .mockRejectedValueOnce(new Error("[navigation_cursor_expired] Navigation cursor expired"))
    .mockResolvedValueOnce(directories(0, 10, "rebuilt", "rebuilt-10"))
    .mockResolvedValueOnce(directories(10, 20, "rebuilt", "rebuilt-20"))
    .mockResolvedValueOnce(directories(20, 30, "rebuilt"));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["directory-index", request()]]));
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("directory-index")?.loading).toBe(false));
  await queries.loadMore("directory-index");
  const sizes: number[] = [];
  queries.subscribe(() => sizes.push(queries.getSnapshot().resources.get("directory-index")?.state.page?.directories?.length ?? 0));
  queries.invalidate();
  await queries.refresh();
  expect(queries.getSnapshot().resources.get("directory-index")?.state.page?.directories).toHaveLength(20);
  await queries.loadMore("directory-index");
  const state = queries.getSnapshot().resources.get("directory-index")!.state;
  expect(state.page?.directories?.map((directory) => directory.key)).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
  expect(state.error).toBeUndefined();
  expect(Math.min(...sizes)).toBe(20);
  expect(read).toHaveBeenCalledTimes(8);
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
