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

it("reports admission overflow without silently fetching extra directories", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async () => page());
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const demand = new Map(Array.from({ length: 9 }, (_, index) => [`directory-${index}`, request(String(index))]));
  queries.setDemand(demand);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(8));
  expect(queries.getSnapshot().admissionError).toContain("eight queries");
  demand.delete("directory-0");
  queries.setDemand(demand);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(9));
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
  void queries.refresh();
  pending.resolve(page({ countsRevision: "late-old", complete: true, nextCursor: undefined }));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read.mock.calls[2]?.[0].completeBaselineRevision).toBeUndefined();
  await vi.waitFor(() => expect(queries.getSnapshot().resources.get("lens")?.state.page?.countsRevision).toBe("canonical"));
  queries.dispose();
});

it("retains an expired range until explicit anchor recovery and does not certify a tail as a full baseline", async () => {
  const read = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error("Navigation cursor expired; rebaseline around the visible anchor."))
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
