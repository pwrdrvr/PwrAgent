import { describe, expect, it } from "vitest";
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
