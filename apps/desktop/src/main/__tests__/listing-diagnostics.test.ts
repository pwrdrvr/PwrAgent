import { describe, expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { ListingDiagnostics, listingDiagnostics, listingRequestFields } from "../diagnostics/listing-diagnostics";
import { NavigationQueryPool } from "../app-server/navigation-query-pool";
import { NavigationIndexReadPool } from "../app-server/navigation-index-read-pool";
import { readRendererListingDiagnostics } from "../diagnostics/renderer-listing-diagnostics";
import type { HotCpuTarget } from "../diagnostics/hot-cpu-profiler";

const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" },
  diagnostic: { origin: "68ca84ce-8d32-4230-a10f-76bc96eb2f33", view: 1, effect: 2, logical: 3, attempt: 1, cause: "turn", trigger: "turn/completed", invalidations: 2 } };
const page: NavigationQueryPage = { protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "o", countsRevision: "r",
  coverage: { state: "complete" }, counts: { total: 0, active: 0, unread: 0, review: 0 }, entries: [], complete: true };
const eventsSince = (before: number) => {
  const snapshot = listingDiagnostics.snapshot();
  return snapshot.events.slice(-(snapshot.recorded - before));
};

describe("bounded listing diagnostics", () => {
  it("bounds retention and copies only fixed vocabulary/numeric fields", () => {
    let now = 100;
    const diagnostics = new ListingDiagnostics(() => now);
    const secret = "PRIVATE title prompt payload path";
    for (let i = 0; i < 10_000; i++) diagnostics.record("ipc", "start", {
      origin: secret, reason: secret, caller: secret, consumer: secret, query: secret, trigger: secret,
      view: i, rows: NaN, logical: Infinity, ...({ payload: secret } as object),
    });
    const snapshot = diagnostics.snapshot();
    expect(snapshot).toMatchObject({ capacity: 4096, recorded: 10_000, overwritten: 5904, totals: { "ipc:start": 10_000 } });
    expect(snapshot.events).toHaveLength(4096);
    expect(snapshot.events[0]!.view).toBe(5904);
    expect(snapshot.events.at(-1)!.view).toBe(9999);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain("payload");
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(1024 * 1024);
    snapshot.events[0]!.view = -1;
    expect(diagnostics.snapshot().events[0]!.view).toBe(5904);
    now += 120_001;
    expect(diagnostics.snapshot().events).toEqual([]);
  });

  it("keeps async causes isolated and links reused promises without retaining them", async () => {
    const diagnostics = new ListingDiagnostics();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const physical = diagnostics.trace("provider", { caller: "thread-list" }, async () => {
      await gate;
      return diagnostics.trace("provider-rpc", {}, async () => 42);
    });
    const reader = diagnostics.trace("navigation", { reason: "timer" }, async () => {
      diagnostics.link("provider", "coalesced", physical);
      return physical;
    });
    finish();
    expect(await reader).toBe(42);
    const events = diagnostics.snapshot().events;
    const provider = events.find((event) => event.stage === "provider" && event.phase === "start")!;
    const navigation = events.find((event) => event.stage === "navigation" && event.phase === "start")!;
    expect(events.find((event) => event.phase === "coalesced")).toMatchObject({ id: navigation.id, targetId: provider.id });
    expect(events.find((event) => event.stage === "provider-rpc" && event.phase === "start")).toMatchObject({ parentId: provider.id });
    expect(events).toHaveLength(7);
  });

  it("correlates two logical IPC readers with one owner/index execution and a completed index cache hit", async () => {
    const before = listingDiagnostics.snapshot().recorded;
    const pool = new NavigationQueryPool();
    const indexPool = new NavigationIndexReadPool(1000);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const index = { threads: [], directories: [] };
    const loadIndex = vi.fn(async () => { await gate; return index; });
    const load = vi.fn(async () => { await indexPool.read("fixture", loadIndex); return page; });
    const read = (consumerId: string, logical: number) => {
      const next = { ...request, diagnostic: { ...request.diagnostic!, logical } };
      return listingDiagnostics.trace("ipc", { ...listingRequestFields(next), sender: 7 }, () => pool.read({ consumerId, request: next, load }));
    };
    const first = read("one", 1);
    const second = read("two", 2);
    finish();
    await Promise.all([first, second]);
    await read("one", 3);
    const events = eventsSince(before);
    expect(load).toHaveBeenCalledTimes(2);
    expect(loadIndex).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.stage === "ipc" && event.phase === "start")).toHaveLength(3);
    expect(events.filter((event) => event.stage === "owner-read" && event.phase === "start")).toHaveLength(2);
    const owner = events.find((event) => event.stage === "owner-page" && event.phase === "start")!;
    expect(events.find((event) => event.stage === "navigation" && event.phase === "coalesced")).toMatchObject({ targetId: owner.id });
    const indexStart = events.find((event) => event.stage === "index" && event.phase === "start")!;
    expect(events.find((event) => event.stage === "index" && event.phase === "cache-hit")).toMatchObject({ targetId: indexStart.id });
    expect(events.filter((event) => event.phase === "start" && event.stage === "navigation").map((event) => event.logical)).toEqual([1, 2, 3]);
    expect(events.find((event) => event.stage === "ipc")).toMatchObject({ origin: request.diagnostic!.origin, view: 1, effect: 2, reason: "turn", trigger: "turn/completed", invalidations: 2 });
    // Exact deterministic operation budget, independent of rows in the fixture.
    expect(events).toHaveLength(24);
    pool.release("one"); pool.release("two"); indexPool.invalidate("fixture");
  });

  it("records invalidation retries and cancellation separately from provider settlement", async () => {
    const before = listingDiagnostics.snapshot().recorded;
    const pool = new NavigationQueryPool();
    let finish!: (value: NavigationQueryPage) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(page);
    const first = pool.read({ consumerId: "a", request, load });
    pool.invalidateQueryOwner(undefined, "turn", "turn/completed");
    finish(page);
    await first;
    expect(load).toHaveBeenCalledTimes(2);
    const pending = pool.read({ consumerId: "b", request: { ...request, consumer: "star-map", query: { kind: "directory-index" } },
      load: () => new Promise((resolve) => { finish = resolve; }) });
    pool.release("b");
    await expect(pending).rejects.toThrow("cancelled");
    finish(page);
    await new Promise((resolve) => setImmediate(resolve));
    const events = eventsSince(before);
    expect(events.some((event) => event.phase === "retry" && event.reason === "owner-invalidated")).toBe(true);
    expect(events.some((event) => event.phase === "cancel" && event.targetId !== undefined)).toBe(true);
    expect(events.some((event) => event.stage === "navigation" && event.phase === "invalidate" && event.trigger === "turn/completed")).toBe(true);
    pool.release("a");
  });

  it("marks incoming Federation owner reads and remote viewer demand separately", async () => {
    const before = listingDiagnostics.snapshot().recorded;
    const pool = new NavigationQueryPool();
    await pool.read({ consumerId: "owner", scopeKey: "federation:fixture", request, load: async () => page });
    await pool.read({ consumerId: "viewer", request: { ...request, federationTarget: { scope: "remote", instanceId: "private-machine" } }, load: async () => page });
    const starts = eventsSince(before).filter((event) => event.stage === "navigation" && event.phase === "start");
    expect(starts.map((event) => event.source)).toEqual(["owner", "remote"]);
    expect(JSON.stringify(starts)).not.toContain("private-machine");
    pool.release("owner"); pool.release("viewer");
  });

  it("reads a renderer ring once per capture and bounds an unresponsive renderer", async () => {
    vi.useFakeTimers();
    try {
      const sendCommand = vi.fn().mockResolvedValueOnce({ result: { value: { events: [{ view: 1, phase: "effect" }] } } })
        .mockImplementationOnce(() => new Promise(() => {})).mockRejectedValueOnce(new Error("detached"));
      const target = { debugger: { sendCommand } } as unknown as HotCpuTarget;
      expect(await readRendererListingDiagnostics(target)).toMatchObject({ rendererListings: { events: [{ view: 1, phase: "effect" }] } });
      const timeout = readRendererListingDiagnostics(target);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await timeout).toMatchObject({ rendererListings: null });
      expect(await readRendererListingDiagnostics(target)).toMatchObject({ rendererListings: null });
      expect(sendCommand).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
