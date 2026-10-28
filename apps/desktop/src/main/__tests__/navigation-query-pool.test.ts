import { describe, expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest, NavigationLaunchpadConfigResponse } from "@pwragent/shared";
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
  it("bounds coalesced waiters even when all requests reuse one consumer token", async () => {
    const pool = new NavigationQueryPool();
    let finish!: (value: NavigationLaunchpadConfigResponse) => void;
    const load = vi.fn(() => new Promise<NavigationLaunchpadConfigResponse>((resolve) => { finish = resolve; }));
    const params = { kind: "launchpad" as const, consumerId: "same-window", identity: "directory", operation: "full", load };
    const pending = Array.from({ length: 256 }, () => pool.readExact(params));
    await expect(pool.readExact(params)).rejects.toMatchObject({ code: "navigation_busy" });
    expect(load).toHaveBeenCalledTimes(1);
    finish({ protocol: 2, revision: "complete" });
    expect(await Promise.all(pending)).toHaveLength(256);
    pool.release("same-window");
  });

  it("replaces exact backing across conditional revisions instead of retaining the window's read history", async () => {
    const pool = new NavigationQueryPool();
    const value: NavigationLaunchpadConfigResponse = { protocol: 2, revision: "config" };
    for (let revision = 0; revision < 20; revision++) {
      await pool.readExact({ kind: "launchpad", consumerId: "window", identity: "directory", operation: String(revision), load: async () => value });
      expect(pool.getBudgetUsage().retainedBytes).toBe(Buffer.byteLength(JSON.stringify(value)));
    }
    pool.release("window");
    expect(pool.getBudgetUsage().retainedBytes).toBe(0);
  });

  it("serves invalidated exact results to their own readers without rejecting demand or rereading unrelated owners", async () => {
    const pool = new NavigationQueryPool();
    const ref = { backend: "codex" as const, threadId: "same" };
    const pending: Array<Promise<unknown>> = [];
    const signals: AbortSignal[] = [];
    const finish: Array<() => void> = [];
    const loads: Array<ReturnType<typeof vi.fn>> = [];
    const detailLoads: Array<Parameters<typeof pool.readExact<"detail">>[0]["load"]> = [];
    for (const instanceId of ["a", "b"]) {
      let reads = 0;
      const load = vi.fn(({ signal }: { signal: AbortSignal }) => {
        reads += 1;
        signals.push(signal);
        const value = { protocol: 2 as const, ref, revision: reads === 1 ? "stale" : "canonical",
          readiness: "ready" as const, identity: "unresolved" as const };
        return reads === 1 ? new Promise<typeof value>((resolve) => finish.push(() => resolve(value))) : Promise.resolve(value);
      });
      loads.push(load);
      detailLoads.push(load);
      pending.push(pool.readExact({ kind: "detail", consumerId: instanceId, identity: "same", operation: "full", ref,
        owner: { scope: "remote", instanceId }, load }));
    }
    pending.push(pool.readExact({ kind: "launchpad", consumerId: "config", identity: "directory", operation: "full",
      owner: { scope: "remote", instanceId: "a" }, load: ({ signal }) => {
        signals.push(signal);
        return new Promise((resolve) => finish.push(() => resolve({ protocol: 2, revision: "config" })));
      } }));
    pool.invalidateExactOwner({ scope: "remote", instanceId: "a" }, ref);
    pool.invalidateExactOwner({ scope: "remote", instanceId: "a" }, ref);
    // A reader admitted after the change waits for a read that starts after it.
    pending.push(pool.readExact({ kind: "detail", consumerId: "a", identity: "same", operation: "full", ref,
      owner: { scope: "remote", instanceId: "a" }, load: detailLoads[0]! }));
    const settled = Promise.allSettled(pending);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false, false]);
    for (const done of finish) done();
    expect((await settled).map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    await expect(pending[0]).resolves.toMatchObject({ revision: "stale" });
    await expect(pending[3]).resolves.toMatchObject({ revision: "canonical" });
    expect(loads.map((load) => load.mock.calls.length)).toEqual([2, 1]);
    for (const consumer of ["a", "b", "config"]) pool.release(consumer);
    expect(pool.getBudgetUsage().retainedBytes).toBe(0);
  });

  it("gives a selected detail joined after a branch check its own read without rereading its queue", async () => {
    const pool = new NavigationQueryPool();
    const ref = { backend: "codex" as const, threadId: "branch-thread" };
    let finishStale!: () => void;
    let reads = 0;
    const loadDetail = vi.fn(async () => {
      const read = ++reads;
      if (read === 1) await new Promise<void>((resolve) => { finishStale = resolve; });
      return { protocol: 2 as const, ref, revision: read === 1 ? "stale" : "current",
        readiness: "ready" as const, identity: "unresolved" as const };
    });
    const loadQueue = vi.fn(async () => ({
      protocol: 2 as const, ref, revision: "queue", readiness: "ready" as const,
      complete: true, entries: [],
    }));
    const detailParams = { kind: "detail" as const, consumerId: "selected", identity: "branch-thread",
      operation: "full", ref, load: loadDetail };
    const stale = pool.readExact(detailParams);
    const queue = pool.readExact({ kind: "queue", consumerId: "queue", identity: "branch-thread",
      operation: "full", ref, load: loadQueue });
    pool.invalidateExactOwner(undefined, ref, "detail");
    const joined = pool.readExact(detailParams);
    expect(loadDetail).toHaveBeenCalledTimes(1);
    finishStale();
    await expect(stale).resolves.toMatchObject({ revision: "stale" });
    await expect(joined).resolves.toMatchObject({ revision: "current" });
    await expect(queue).resolves.toMatchObject({ revision: "queue" });
    expect(loadDetail).toHaveBeenCalledTimes(2);
    expect(loadQueue).toHaveBeenCalledTimes(1);
    pool.release("selected");
    pool.release("queue");
  });

  it("serves a pre-event page to its own reader and gives a post-event refresh a page built after it", async () => {
    const pool = new NavigationQueryPool();
    let finish!: (value: NavigationQueryPage) => void;
    let finishStarted!: (value: NavigationQueryPage) => void;
    const started = { ...page, counts: { ...page.counts, active: 1 }, countsRevision: "started" };
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<NavigationQueryPage>((resolve) => { finish = resolve; }))
      .mockImplementationOnce(() => new Promise<NavigationQueryPage>((resolve) => { finishStarted = resolve; }));
    const first = pool.read({ consumerId: "sidebar", request, load });
    let finishRemote!: (value: NavigationQueryPage) => void;
    const remoteLoad = vi.fn(() => new Promise<NavigationQueryPage>((resolve) => { finishRemote = resolve; }));
    const remote = pool.read({ consumerId: "remote", request: {
      ...request, federationTarget: { scope: "remote", instanceId: "other-owner" },
    }, load: remoteLoad });
    pool.invalidateQueryOwner();
    const refreshed = pool.read({ consumerId: "map", request, load });
    const joined = pool.read({ consumerId: "star-map", request, load });
    finish(page);
    finishRemote(page);
    await expect(remote).resolves.toEqual(page);
    expect(remoteLoad).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toEqual(page);
    // An overtaken page is served, never kept as the query's current backing.
    expect(pool.getBudgetUsage().retainedBytes).toBe(Buffer.byteLength(JSON.stringify(page)));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    finishStarted(started);
    await expect(Promise.all([refreshed, joined])).resolves.toEqual([started, started]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[0]![0].signal).not.toBe(load.mock.calls[1]![0].signal);
    expect(pool.getBudgetUsage().retainedBytes)
      .toBe(Buffer.byteLength(JSON.stringify(page)) + Buffer.byteLength(JSON.stringify(started)));
    pool.release("sidebar");
    pool.release("map");
    pool.release("star-map");
    pool.release("remote");
    expect(pool.getBudgetUsage().retainedBytes).toBe(0);
  });

  it("never reloads a page for its own readers while invalidations land during every load", async () => {
    const pool = new NavigationQueryPool();
    const gates: Array<(value: NavigationQueryPage) => void> = [];
    const load = vi.fn(() => new Promise<NavigationQueryPage>((resolve) => { gates.push(resolve); }));
    const reads = [pool.read({ consumerId: "reader-0", request, load })];
    for (let attempt = 0; attempt < 3; attempt++) {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(attempt + 1));
      pool.invalidateQueryOwner();
      // Two later readers share one follow-up, however many changes land.
      reads.push(pool.read({ consumerId: `reader-${attempt + 1}`, request, load }));
      pool.invalidateQueryOwner();
      reads.push(pool.read({ consumerId: `joined-${attempt + 1}`, request, load }));
      gates[attempt]!({ ...page, generation: `load-${attempt}` });
    }
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4));
    gates[3]!({ ...page, generation: "load-3" });
    expect((await Promise.all(reads)).map((result) => result.generation))
      .toEqual(["load-0", "load-1", "load-1", "load-2", "load-2", "load-3", "load-3"]);
    expect(load).toHaveBeenCalledTimes(4);
    // Only the page no change overtook is the query's current backing.
    expect(pool.getBudgetUsage().retainedBytes).toBe(Buffer.byteLength(JSON.stringify({ ...page, generation: "load-3" })));
    for (const consumer of ["reader-0", "reader-1", "joined-1", "reader-2", "joined-2", "reader-3", "joined-3"]) pool.release(consumer);
    expect(pool.getBudgetUsage()).toEqual({ queries: 0, exactResources: 0, retainedBytes: 0, activeReads: 0 });
  });

  it("returns an overtaken read's own failure to its readers without retrying it", async () => {
    const pool = new NavigationQueryPool();
    let fail!: (error: Error) => void;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<NavigationQueryPage>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue(page);
    const first = pool.read({ consumerId: "first", request, load });
    pool.invalidateQueryOwner();
    const later = pool.read({ consumerId: "later", request, load });
    fail(new Error("earlier owner failure"));
    await expect(first).rejects.toThrow("earlier owner failure");
    await expect(later).resolves.toEqual(page);
    expect(load).toHaveBeenCalledTimes(2);
    pool.release("first");
    pool.release("later");
  });

  it("cancels an overtaken read and its follow-up only after the query's last consumer leaves", async () => {
    const pool = new NavigationQueryPool();
    const signals: AbortSignal[] = [];
    const load = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise<NavigationQueryPage>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const first = pool.read({ consumerId: "first", request, load });
    pool.invalidateQueryOwner();
    const later = pool.read({ consumerId: "later", request: { ...request, consumer: "star-map" }, load });
    const settled = Promise.allSettled([first, later]);
    pool.release("first");
    expect(signals[0]!.aborted).toBe(false);
    pool.release("later");
    expect(signals[0]!.aborted).toBe(true);
    expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    // The follow-up was cancelled while it waited, before it read anything.
    expect(load).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(pool.getBudgetUsage())
      .toEqual({ queries: 0, exactResources: 0, retainedBytes: 0, activeReads: 0 }));
  });

  it("shares eight physical slots between collection and exact configuration reads", async () => {
    const pool = new NavigationQueryPool();
    const resolve: Array<(page: NavigationQueryPage) => void> = [];
    const pending = Array.from({ length: 8 }, (_, index) => pool.read({ consumerId: `page-${index}`,
      request: { ...request, query: { kind: "search", text: String(index) } },
      load: () => new Promise<NavigationQueryPage>((done) => { resolve.push(done); }),
    }));
    const config: NavigationLaunchpadConfigResponse = { protocol: 2, revision: "config" };
    const load = vi.fn(async () => config);
    const exact = pool.readExact({ kind: "launchpad", consumerId: "selected-config", identity: "local-directory", operation: "full", load });
    expect(load).not.toHaveBeenCalled();
    expect(pool.getBudgetUsage().activeReads).toBe(8);
    resolve[0]!(page);
    await pending[0];
    await expect(exact).resolves.toEqual(config);
    expect(load).toHaveBeenCalledTimes(1);
    for (const done of resolve.slice(1)) done(page);
    await Promise.all(pending);
    for (let index = 0; index < 8; index++) pool.release(`page-${index}`);
    pool.release("selected-config");
    expect(pool.getBudgetUsage().retainedBytes).toBe(0);
  });

  it("releases exact consumers independently and never rejoins an aborted physical read", async () => {
    const pool = new NavigationQueryPool();
    const config: NavigationLaunchpadConfigResponse = { protocol: 2, revision: "config" };
    let finish!: (value: NavigationLaunchpadConfigResponse) => void;
    let signal!: AbortSignal;
    const load = vi.fn(({ signal: current }: { signal: AbortSignal }) => {
      signal = current;
      return new Promise<NavigationLaunchpadConfigResponse>((resolve) => { finish = resolve; });
    });
    const params = { kind: "launchpad" as const, identity: "owner-directory", operation: "full", load };
    const a = pool.readExact({ ...params, consumerId: "window-a" });
    const b = pool.readExact({ ...params, consumerId: "window-b" });
    const old = Promise.allSettled([a, b]);
    pool.release("window-a");
    expect(signal.aborted).toBe(false);
    pool.release("window-b");
    expect(signal.aborted).toBe(true);
    const freshLoad = vi.fn(async () => ({ ...config, revision: "fresh" }));
    const fresh = pool.readExact({ ...params, consumerId: "window-c", load: freshLoad });
    expect(freshLoad).not.toHaveBeenCalled();
    expect((await old).every((result) => result.status === "rejected")).toBe(true);
    expect(pool.getBudgetUsage().activeReads).toBe(1);
    finish(config);
    await expect(fresh).resolves.toMatchObject({ revision: "fresh" });
    expect(freshLoad).toHaveBeenCalledTimes(1);
    pool.release("window-c");
    expect(pool.getBudgetUsage().retainedBytes).toBe(0);
  });

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

  it("shares physical admission but never shares results across authenticated requester scopes", async () => {
    const pool = new NavigationQueryPool();
    const completions: (() => void)[] = [];
    const load = vi.fn(() => new Promise<NavigationQueryPage>((resolve) => completions.push(() => resolve(page))));
    const first = pool.read({ consumerId: "peer-a-1", scopeKey: "federation:a", request, load });
    const duplicate = pool.read({ consumerId: "peer-a-2", scopeKey: "federation:a", request, load });
    const other = pool.read({ consumerId: "peer-b", scopeKey: "federation:b", request, load });
    const local = pool.read({ consumerId: "window", request, load });
    expect(load).toHaveBeenCalledTimes(3);
    expect(pool.getBudgetUsage().activeReads).toBe(3);
    for (const complete of completions) complete();
    await Promise.all([first, duplicate, other, local]);
    for (const consumer of ["peer-a-1", "peer-a-2", "peer-b", "window"]) pool.release(consumer);
    expect(pool.getBudgetUsage().activeReads).toBe(0);
    expect(pool.getBudgetUsage().retainedBytes).toBe(0);
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

  it("admits a ninth mounted query by evicting idle backing without requiring a view to close", async () => {
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
    expect(loaded).toBe(true);
    expect(pool.getBudgetUsage().queries).toBe(8);
    await ninth;
    expect(loaded).toBe(true);
    expect(pool.getBudgetUsage().queries).toBe(8);
  });

  it("cancels waiting admission without issuing an owner read", async () => {
    const pool = new NavigationQueryPool();
    const pending: Array<Promise<NavigationQueryPage>> = [];
    const finish: Array<() => void> = [];
    for (let index = 0; index < 8; index += 1) {
      pending.push(pool.read({
        consumerId: String(index),
        request: { ...request, query: { kind: "search", text: String(index) } },
        load: () => new Promise((resolve) => finish.push(() => resolve(page))),
      }));
    }
    let called = false;
    const waiting = pool.read({
      consumerId: "closed",
      request: { ...request, query: { kind: "search", text: "closed" } },
      load: async () => { called = true; return page; },
    });
    pool.release("closed");
    await expect(waiting).rejects.toMatchObject({ code: "navigation_busy" });
    expect(called).toBe(false);
    for (const done of finish) done();
    await Promise.all(pending);
  });

  it.each(["detail", "queue"] as const)("returns expected cancellation for a %s waiting behind physical reads", async (kind) => {
    const pool = new NavigationQueryPool();
    const finish: Array<() => void> = [];
    const active = Array.from({ length: 8 }, (_, index) => pool.readExact({
      kind: "launchpad", consumerId: `active-${index}`, identity: String(index), operation: "full",
      load: () => new Promise<NavigationLaunchpadConfigResponse>((resolve) => finish.push(() => resolve({ protocol: 2, revision: "ready" }))),
    }));
    const load = vi.fn();
    const waiting = pool.readExact({ kind, consumerId: "closed", identity: "waiting", operation: "full", load });
    const settled = Promise.allSettled([waiting]);
    pool.release("closed");
    const [result] = await settled;
    for (const done of finish) done();
    await Promise.all(active);
    for (let index = 0; index < 8; index += 1) pool.release(`active-${index}`);
    expect(result).toMatchObject({ status: "rejected", reason: { code: "navigation_busy" } });
    expect(load).not.toHaveBeenCalled();
    expect(pool.getBudgetUsage()).toEqual({ queries: 0, exactResources: 0, retainedBytes: 0, activeReads: 0 });
  });

  it("retains the consumer admission budget when inactive backing is evicted", async () => {
    const pool = new NavigationQueryPool();
    for (let i = 0; i < 256; i += 1) await pool.read({ consumerId: String(i),
      request: { ...request, query: { kind: "search", text: String(i) } }, load: async () => page });
    expect(pool.getBudgetUsage().queries).toBe(8);
    await expect(pool.read({ consumerId: "extra", request, load: async () => page })).rejects.toMatchObject({ code: "navigation_busy" });
    pool.release("0");
    await expect(pool.read({ consumerId: "extra", request, load: async () => page })).resolves.toEqual(page);
    for (let i = 1; i < 256; i += 1) pool.release(String(i));
    pool.release("extra");
    expect(pool.getBudgetUsage()).toEqual({ queries: 0, exactResources: 0, retainedBytes: 0, activeReads: 0 });
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
