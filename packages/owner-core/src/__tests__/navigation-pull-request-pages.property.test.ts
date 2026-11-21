import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { NavigationQueryRequest, NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared/contracts/navigation";
import { NavigationQueryStore, type NavigationPullRequestProjection } from "../navigation-query-store";

function pullRequest(number: number): PrSummary {
  return { number, org: "fixture", repo: "project", provider: "github.com", state: "passing",
    url: `https://github.com/fixture/project/pull/${number}` };
}

function thread(index: number, prs = [pullRequest(index + 1)]): NavigationThreadSummary {
  return { id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    updatedAt: 10_000 - index, linkedDirectories: [], inbox: { inInbox: false }, prs };
}

function attachments(
  threads: NavigationThreadSummary[],
  verify: NavigationPullRequestProjection["verify"],
): NavigationPullRequestProjection {
  const byId = new Map(threads.map((row) => [row.id, row.prs ?? []]));
  return { verify, read: (refs) => verify(refs.map(({ threadId }) => byId.get(threadId) ?? [])) };
}

it("validates at most one page of new rows and keeps each cursor's observed PR chips stable", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (pageSize) => {
    const threads = Array.from({ length: 3 * pageSize }, (_, index) => thread(index));
    const store = new NavigationQueryStore();
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize,
      query: { kind: "lens", lens: "inbox" } };
    let removed: number | undefined;
    const loadPullRequests = vi.fn(async (batches: PrSummary[][]) => batches.map((prs) => prs.filter((pr) => pr.number !== removed)));
    const read = (options?: Partial<NavigationQueryRequest>) => store.readPage({
      loadIndex: async () => ({ threads, directories: [] }), pullRequests: attachments(threads, loadPullRequests), request: { ...request, ...options }, scopeKey: "viewer",
    });
    const first = await read();
    expect(first.entries.map(({ row }) => row.prs?.[0]?.number)).toEqual(threads.slice(0, pageSize).map((row) => row.prs![0]!.number));
    expect(loadPullRequests.mock.calls.map(([rows]) => rows.length)).toEqual([pageSize]);
    const second = await read({ cursor: first.nextCursor });
    expect(second.generation).toBe(first.generation);
    expect(second.countsRevision).toBe(first.countsRevision);
    expect(loadPullRequests.mock.calls.map(([rows]) => rows.length)).toEqual([pageSize, pageSize]);
    const range = { revision: first.countsRevision, ownerEpoch: first.ownerEpoch, start: 0, count: 2 * pageSize };
    expect((await read({ retainedRange: range })).rangeUnchanged).toEqual({ start: 0, count: 2 * pageSize });
    removed = pageSize + 1;
    const updated = await read({ retainedRange: range });
    expect(updated.rangeUnchanged).toBeUndefined();
    expect(updated.countsRevision).not.toBe(first.countsRevision);
    const oldSecond = await read({ cursor: first.nextCursor });
    expect(oldSecond.entries).toEqual(second.entries);
    const newSecond = await read({ cursor: updated.nextCursor });
    expect(newSecond.entries[0]?.row.prs).toBeUndefined();
    expect(newSecond.entries.map(({ row }) => row.id)).toEqual(second.entries.map(({ row }) => row.id));
  }), { numRuns: 25 });
});

it("projects PR counts and byte admission after validating full attachments, and preserves remote previews", async () => {
  const prs = Array.from({ length: 21 }, (_, index) => pullRequest(index + 1));
  prs[0]!.title = "💡".repeat(NAVIGATION_QUERY_MAX_RESULT_BYTES);
  const peer: NavigationThreadSummary = { ...thread(1), pinnedRank: "a", federation: {
    ref: { backend: "codex", threadId: "thread-1", target: { scope: "remote", instanceId: "peer" } },
    instanceLabel: "Peer", peerStatus: "connected",
  } };
  const store = new NavigationQueryStore();
  const loadPullRequests = vi.fn(async (batches: PrSummary[][]) => batches.map((rows) => rows.slice(4)));
  const threads = [thread(0, prs), peer];
  const page = await store.readPage({ scopeKey: "viewer", pullRequests: attachments(threads, loadPullRequests),
    loadIndex: async () => ({ threads, directories: [] }),
    request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query: { kind: "exact", identities: [
      { backend: "codex", threadId: "thread-0" }, { backend: "codex", threadId: "thread-1", ownerInstanceId: "peer" },
    ] } },
  });
  expect(loadPullRequests).toHaveBeenCalledTimes(1);
  expect(loadPullRequests).toHaveBeenCalledWith([prs]);
  expect(page.entries[0]?.row).toMatchObject({ prCount: 17, prsTruncated: true });
  expect(page.entries[0]?.row.prs).toHaveLength(16);
  expect(page.entries[1]?.row.prs).toEqual(peer.prs);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
});

it("uses verified membership for a Star Map PR filter before choosing its first row", async () => {
  const threads = [thread(0), thread(1), thread(2)];
  const loadPullRequests = vi.fn(async (batches: PrSummary[][]) => batches.map((prs) => prs.filter((pr) => pr.number === 3)));
  const read = await new NavigationQueryStore().readPage({ scopeKey: "owner", pullRequests: attachments(threads, loadPullRequests),
    loadIndex: async () => ({ threads, directories: [] }),
    request: { protocol: 2, consumer: "star-map", pageSize: 1, query: { kind: "star-map", filters: { pr: "include" } } },
  });
  expect(read.entries.map(({ row }) => row.id)).toEqual(["thread-2"]);
  expect(read.complete).toBe(true);
  expect(loadPullRequests).toHaveBeenCalledWith(threads.map((row) => row.prs));
});

it("refreshes a tail after an unproven read while retaining its old cursor observations", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 12 }), fc.boolean(), async (count, proveFront) => {
    const threads = Array.from({ length: count }, (_, index) => thread(index));
    const store = new NavigationQueryStore();
    let removed: number | undefined;
    const loadPullRequests = async (batches: PrSummary[][]) => batches.map((prs) => prs.filter((pr) => pr.number !== removed));
    const read = (options?: Partial<NavigationQueryRequest>) => store.readPage({ scopeKey: "remote-owner", pullRequests: attachments(threads, loadPullRequests),
      loadIndex: async () => ({ threads, directories: [] }),
      request: { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" }, pageSize: 1, ...options },
    });
    const first = await read();
    const oldTail = await read({ cursor: first.nextCursor });
    removed = 2;
    const refreshed = await read(proveFront ? { retainedRange: {
      revision: first.countsRevision, ownerEpoch: first.ownerEpoch, start: 0, count: 1,
    } } : undefined);
    expect(refreshed.generation).not.toBe(first.generation);
    expect((await read({ cursor: refreshed.nextCursor })).entries[0]?.row.prs).toBeUndefined();
    expect((await read({ cursor: first.nextCursor })).entries).toEqual(oldTail.entries);
  }), { numRuns: 25 });
});

it("keeps oversized off-page PR history outside cursor backing and the first-page read", async () => {
  const history = Array.from({ length: 544 }, (_, index) => ({ ...pullRequest(index + 2), state: "merged" as const,
    title: "x".repeat(64 * 1024) }));
  const store = new NavigationQueryStore();
  const loadPullRequests = vi.fn(async (batches: PrSummary[][]) => batches);
  const threads = [thread(0), thread(1, history)];
  const pullRequests = attachments(threads, loadPullRequests);
  const read = vi.spyOn(pullRequests, "read");
  const page = await store.readPage({ scopeKey: "viewer", pullRequests,
    loadIndex: async () => ({ threads, directories: [] }),
    request: { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" }, pageSize: 1 },
  });
  expect(page.entries[0]?.row.prs).toEqual([pullRequest(1)]);
  expect(page.nextCursor).toBeTruthy();
  expect(read).toHaveBeenCalledExactlyOnceWith([{ backend: "codex", threadId: "thread-0" }]);
  expect(loadPullRequests).toHaveBeenCalledExactlyOnceWith([[pullRequest(1)]]);
});

it("lets a failed oversized continuation reuse its cursor with a new observation", async () => {
  const threads = [thread(0), thread(1)];
  const store = new NavigationQueryStore();
  let oversized = true;
  const loadPullRequests = async (batches: PrSummary[][]) => batches.map((prs) => prs.map((pr) =>
    pr.number === 2 && oversized ? { ...pr, title: "x".repeat(NAVIGATION_QUERY_MAX_RESULT_BYTES) } : pr));
  const read = (cursor?: string) => store.readPage({ scopeKey: "viewer", pullRequests: attachments(threads, loadPullRequests),
    loadIndex: async () => ({ threads, directories: [] }),
    request: { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" }, pageSize: 1, cursor },
  });
  const first = await read();
  await expect(read(first.nextCursor)).rejects.toMatchObject({ code: "navigation_item_too_large" });
  oversized = false;
  const tail = await read(first.nextCursor);
  expect(tail.entries[0]?.row.prs).toEqual([pullRequest(2)]);
  expect(tail.generation).toBe(first.generation);
});

it("retains only PR observations for rows that fit in the returned page", async () => {
  const threads = [thread(0), thread(1)];
  const store = new NavigationQueryStore();
  let title = "x".repeat(Math.ceil(NAVIGATION_QUERY_MAX_RESULT_BYTES * 0.6));
  const loadPullRequests = async (batches: PrSummary[][]) => batches.map((prs) => prs.map((pr) => ({ ...pr, title })));
  const read = (cursor?: string) => store.readPage({ scopeKey: "viewer", pullRequests: attachments(threads, loadPullRequests),
    loadIndex: async () => ({ threads, directories: [] }),
    request: { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" }, pageSize: 2, cursor },
  });
  const first = await read();
  expect(first.entries.map(({ row }) => row.id)).toEqual(["thread-0"]);
  expect(first.nextCursor).toBeDefined();
  title = "Updated before first delivery";
  const tail = await read(first.nextCursor);
  expect(tail.entries[0]?.row.prs?.[0]?.title).toBe(title);
});
