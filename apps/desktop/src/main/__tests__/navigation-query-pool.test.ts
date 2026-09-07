import { describe, expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { NavigationQueryPool } from "../app-server/navigation-query-pool";

const request: NavigationQueryRequest = {
  protocol: 2,
  consumer: "main-sidebar",
  query: { kind: "lens", lens: "inbox" },
};
const page: NavigationQueryPage = {
  protocol: 2,
  queryKey: "query",
  generation: "generation",
  ownerEpoch: "owner",
  countsRevision: "revision",
  coverage: { state: "complete" },
  counts: { total: 0, active: 0, unread: 0, review: 0 },
  entries: [],
  complete: true,
};

describe("NavigationQueryPool", () => {
  it("returns at the transaction deadline while retaining an unresponsive provider's physical slot", async () => {
    vi.useFakeTimers();
    try {
      const pool = new NavigationQueryPool();
      let resolve!: (value: NavigationQueryPage) => void;
      const pending = pool.read({ consumerId: "window", request: { ...request, deadlineAt: Date.now() + 20 },
        load: () => new Promise((done) => { resolve = done; }) });
      const rejected = expect(pending).rejects.toMatchObject({ code: "navigation_busy" });
      await vi.advanceTimersByTimeAsync(21);
      await rejected;
      expect(pool.getBudgetUsage().activeReads).toBe(1);
      resolve(page);
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.getBudgetUsage().activeReads).toBe(0);
      expect(pool.getBudgetUsage().retainedBytes).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("honors a coalesced consumer's shorter deadline without cancelling the shared owner read", async () => {
    vi.useFakeTimers();
    try {
      const pool = new NavigationQueryPool();
      let resolve!: (value: NavigationQueryPage) => void;
      const load = vi.fn(() => new Promise<NavigationQueryPage>((done) => { resolve = done; }));
      const first = pool.read({ consumerId: "first", request, load });
      const second = pool.read({ consumerId: "second", request: { ...request, deadlineAt: Date.now() + 5 }, load });
      const rejected = expect(second).rejects.toMatchObject({ code: "navigation_busy" });
      await vi.advanceTimersByTimeAsync(6);
      await rejected;
      expect(load).toHaveBeenCalledTimes(1);
      resolve(page);
      await expect(first).resolves.toEqual(page);
    } finally { vi.useRealTimers(); }
  });

  it("reconnect_deduplicates_consumer_cold_reads", async () => {
    const pool = new NavigationQueryPool();
    let resolve!: (value: NavigationQueryPage) => void;
    let calls = 0;
    const load = () => {
      calls += 1;
      return new Promise<NavigationQueryPage>((done) => { resolve = done; });
    };
    const a = pool.read({ consumerId: "window-a", request, load });
    const b = pool.read({ consumerId: "window-b", request: { ...request, consumer: "star-map" }, load });
    expect(calls).toBe(1);
    pool.release("window-a");
    resolve(page);
    expect(await a).toEqual(page);
    expect(await b).toEqual(page);
    expect(pool.getBudgetUsage().retainedBytes).toBe(Buffer.byteLength(JSON.stringify(page)));
  });

  it("aborts the owner read only after the last consumer releases", async () => {
    const pool = new NavigationQueryPool();
    let ownerSignal!: AbortSignal;
    const load = ({ signal }: { signal: AbortSignal }) => {
      ownerSignal = signal;
      return new Promise<NavigationQueryPage>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const a = pool.read({ consumerId: "a", request, load });
    const b = pool.read({ consumerId: "b", request, load });
    const settled = Promise.allSettled([a, b]);
    pool.release("a");
    expect(ownerSignal.aborted).toBe(false);
    pool.release("b");
    expect(ownerSignal.aborted).toBe(true);
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(pool.getBudgetUsage().activeReads).toBe(0);
  });

  it("queues a ninth query and admits it after an unreferenced query releases", async () => {
    const pool = new NavigationQueryPool();
    for (let index = 0; index < 8; index += 1) {
      await pool.read({
        consumerId: String(index),
        request: { ...request, query: { kind: "search", text: String(index) } },
        load: async () => page,
      });
    }
    let loaded = false;
    const ninth = pool.read({
      consumerId: "ninth",
      request: { ...request, query: { kind: "search", text: "ninth" } },
      load: async () => { loaded = true; return page; },
    });
    expect(loaded).toBe(false);
    expect(pool.getBudgetUsage().queries).toBe(8);
    pool.release("0");
    await ninth;
    expect(loaded).toBe(true);
    expect(pool.getBudgetUsage().queries).toBe(8);
  });

  it("cancels waiting admission without issuing an owner read", async () => {
    const pool = new NavigationQueryPool();
    for (let index = 0; index < 8; index += 1) {
      await pool.read({
        consumerId: String(index),
        request: { ...request, query: { kind: "search", text: String(index) } },
        load: async () => page,
      });
    }
    let called = false;
    const waiting = pool.read({
      consumerId: "closed",
      request: { ...request, query: { kind: "search", text: "closed" } },
      load: async () => { called = true; return page; },
    });
    pool.release("closed");
    await expect(waiting).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("serializes distinct page reads for the same query", async () => {
    const pool = new NavigationQueryPool();
    let finish!: (page: NavigationQueryPage) => void;
    const first = pool.read({
      consumerId: "view", request,
      load: () => new Promise((resolve) => { finish = resolve; }),
    });
    let secondStarted = false;
    const second = pool.read({
      consumerId: "view", request: { ...request, cursor: "next" },
      load: async () => { secondStarted = true; return page; },
    });
    expect(secondStarted).toBe(false);
    finish(page);
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });
});

it("does not coalesce different visible anchors into the same page transaction", async () => {
  const pool = new NavigationQueryPool();
  let resolve!: (value: NavigationQueryPage) => void;
  const first = pool.read({ consumerId: "a", request: { ...request,
    anchor: { kind: "thread", ref: { backend: "codex", threadId: "a" } },
  }, load: () => new Promise((done) => { resolve = done; }) });
  const loadSecond = vi.fn(async () => ({ ...page, rangeStart: 50 }));
  const second = pool.read({ consumerId: "b", request: { ...request,
    anchor: { kind: "thread", ref: { backend: "codex", threadId: "b" } },
  }, load: loadSecond });
  expect(loadSecond).not.toHaveBeenCalled();
  resolve(page);
  await first;
  await expect(second).resolves.toMatchObject({ rangeStart: 50 });
  expect(loadSecond).toHaveBeenCalledTimes(1);
  pool.release("a"); pool.release("b");
});

it("does not coalesce viewer mounts with the otherwise identical owner inventory", async () => {
  const pool = new NavigationQueryPool();
  let resolveOwner!: (value: NavigationQueryPage) => void;
  const owner = pool.read({ consumerId: "owner", request,
    load: () => new Promise((resolve) => { resolveOwner = resolve; }) });
  const viewerLoad = vi.fn(async () => ({ ...page, counts: { ...page.counts, total: 1 } }));
  const viewer = await pool.read({ consumerId: "viewer", request: { ...request, inventory: "viewer" }, load: viewerLoad });
  expect(viewerLoad).toHaveBeenCalledTimes(1);
  expect(viewer.counts.total).toBe(1);
  resolveOwner(page);
  expect((await owner).counts.total).toBe(0);
  pool.release("owner");
  pool.release("viewer");
});
