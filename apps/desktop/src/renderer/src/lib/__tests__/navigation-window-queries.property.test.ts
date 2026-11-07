import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";
import { NavigationWindowQueries, navigationResumeQueryKey } from "../navigation-window-queries";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// The owner is a fixed ordered list. A metadata event can fence a read but
// cannot revoke the operator's saved Load more demand for that list.
async function interruptedResume(firstPage: number, extraRows: number, interruptedPage: number) {
  const total = firstPage + extraRows;
  const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "viewer",
    pageSize: firstPage, query: { kind: "directory", directoryKey: "project", roots: "unpinned" } };
  const rows: NavigationRow[] = Array.from({ length: total }, (_, index) => ({
    id: `thread-${index}`, source: "codex", ref: { backend: "codex", threadId: `thread-${index}` },
    title: `Thread ${index}`, titleSource: "explicit", rowRevision: "row", linkedDirectories: [],
    inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
    queueCount: 0, queueState: "unknown",
  }));
  const dispatched = deferred<void>();
  const delivery = deferred<void>();
  const read = vi.fn(async (sent: NavigationQueryRequest): Promise<NavigationQueryPage> => {
    if (read.mock.calls.length === interruptedPage + 1) {
      dispatched.resolve();
      await delivery.promise;
    }
    const start = Number(sent.cursor ?? 0);
    const end = Math.min(total, start + (sent.pageSize ?? firstPage));
    return { protocol: 2, queryKey: "project", generation: "generation", ownerEpoch: "owner", countsRevision: "revision",
      counts: { total, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" },
      entries: rows.slice(start, end).map((row) => ({ row, placement: { kind: "root" }, orderKey: row.id })),
      rangeStart: start, complete: end === total, nextCursor: end < total ? String(end) : undefined };
  });
  const onRangeReset = vi.fn();
  const onLoadMore = vi.fn();
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read }, undefined, {
    loadedRowsByQuery: { [navigationResumeQueryKey(request)]: firstPage + 100 }, onRangeReset, onLoadMore,
  });
  try {
    queries.setDemand(new Map([["project", request]]));
    await dispatched.promise;
    queries.invalidate();
    const refresh = queries.refresh();
    delivery.resolve();
    await refresh;
    expect(queries.getSnapshot().resources.get("project")?.state.page?.entries.map(({ row }) => row.id))
      .toEqual(rows.map((row) => row.id));
    expect(onRangeReset).not.toHaveBeenCalled();
    expect(onLoadMore).not.toHaveBeenCalled();
  } finally { queries.dispose(); }
}

it("restores saved rows after metadata fences the opening read", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 1, max: 40 }),
    fc.integer({ min: 0, max: 1 }), interruptedResume));
});

it("keeps a second row when the one-row opening page is invalidated before delivery", async () => {
  await interruptedResume(1, 1, 0);
});

it("shares one continuation budget across metadata replacements", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async (interruptions) => {
      const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 1,
        query: { kind: "directory-index" } };
      let cursors = 0;
      const read = vi.fn(async (sent: NavigationQueryRequest): Promise<NavigationQueryPage> => {
        if (sent.cursor && ++cursors <= interruptions) queries.invalidate();
        const start = Number(sent.cursor ?? 0);
        return { protocol: 2, queryKey: "project", generation: "generation", ownerEpoch: "owner", countsRevision: "revision",
          counts: { total: 1000, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, complete: false,
          entries: [], nextCursor: String(start + 1), directories: [{ key: String(start), label: String(start), kind: "directory",
            counts: { total: 0, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false }] };
      });
      const queries = new NavigationWindowQueries({ getNavigationQueryPage: read }, undefined,
        { loadedRowsByQuery: { [navigationResumeQueryKey(request)]: 110 } });
      try {
        queries.setDemand(new Map([["project", request]]));
        await queries.refresh();
        expect(cursors).toBe(8);
        expect(read.mock.calls.filter(([sent]) => sent.cursor).map(([sent]) => sent.deadlineAt)).toEqual(Array(8).fill(10_000));
        expect(queries.getSnapshot().resources.get("project")).toMatchObject({ loading: false, state: { error: undefined } });
      } finally { queries.dispose(); }
    }));
  } finally { clock.mockRestore(); }
});
