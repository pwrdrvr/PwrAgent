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
async function interruptedResume(firstPage: number, extraRows: number) {
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
    if (read.mock.calls.length === 1) {
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
    interruptedResume));
});

it("keeps a second row when the one-row opening page is invalidated before delivery", async () => {
  await interruptedResume(1, 1);
});
