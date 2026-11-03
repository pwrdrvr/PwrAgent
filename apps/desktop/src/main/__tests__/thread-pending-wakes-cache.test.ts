import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadPendingWakesCache } from "../app-server/thread-pending-wakes-cache";
import type { ThreadPendingWakesList } from "@pwragent/shared";

const THREAD = { backend: "codex" as const, threadId: "waiting" };
const EMPTY: ThreadPendingWakesList = { wakes: [], ended: [] };
afterEach(() => { vi.useRealTimers(); });

describe("owner pending wake admission", () => {
  it("shares concurrent reads and reuses completed reads across history demand and peer watches", async () => {
    vi.useFakeTimers();
    let finish!: (value: ThreadPendingWakesList) => void;
    const load = vi.fn(() => new Promise<ThreadPendingWakesList>((resolve) => { finish = resolve; }));
    const cache = new ThreadPendingWakesCache(load);
    const requests = Array.from({ length: 80 }, () => cache.read(THREAD, { endedLimit: 8, activePrWatches: [] }));
    expect(load).toHaveBeenCalledExactlyOnceWith(THREAD, { endedLimit: 8, activePrWatches: [] });
    finish(EMPTY);
    await Promise.all(requests);
    await cache.read(THREAD, { endedLimit: 0 });
    await cache.read(THREAD, { endedLimit: 3 });
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    const active = cache.read(THREAD, { endedLimit: 0 });
    expect(load).toHaveBeenLastCalledWith(THREAD, { endedLimit: 0 });
    finish(EMPTY);
    await active;
    cache.clear();
  });

  it("fences a source mutation during a read and admits one shared replacement after the interval", async () => {
    vi.useFakeTimers();
    let finish!: (value: ThreadPendingWakesList) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<ThreadPendingWakesList>((resolve) => { finish = resolve; }))
      .mockResolvedValue(EMPTY);
    const cache = new ThreadPendingWakesCache(load);
    const initial = cache.read(THREAD, { endedLimit: 0, activePrWatches: [] });
    cache.invalidate(THREAD);
    const later = Array.from({ length: 80 }, () => cache.read(THREAD, { endedLimit: 0 }));
    finish({ ...EMPTY, incomplete: true });
    await vi.advanceTimersByTimeAsync(199);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await initial).toEqual(EMPTY);
    await Promise.all(later);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(THREAD, { endedLimit: 0 });
  });

  it("shares the thread's interval across ended-limit changes and invalidations", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => EMPTY);
    const cache = new ThreadPendingWakesCache(load);
    await cache.read(THREAD, { endedLimit: 0 });
    const history = Array.from({ length: 30 }, (_, endedLimit) => cache.read(THREAD, { endedLimit }));
    cache.invalidate(THREAD);
    await vi.advanceTimersByTimeAsync(199);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(history);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(THREAD, { endedLimit: 20 });
    expect(await cache.read(THREAD, { endedLimit: 0 })).toEqual(EMPTY);
  });

  it("does not let one failed load amplify retries and can recover", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(EMPTY);
    const cache = new ThreadPendingWakesCache(load);
    await expect(cache.read(THREAD, { endedLimit: 8 })).rejects.toThrow("unavailable");
    const retry = cache.read(THREAD, { endedLimit: 0 });
    await vi.advanceTimersByTimeAsync(199);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await retry).toEqual(EMPTY);
    expect(load).toHaveBeenLastCalledWith(THREAD, { endedLimit: 0 });
    cache.clear();
  });

  it("bounds callers waiting on one slow source without starting another build", async () => {
    let finish!: (value: ThreadPendingWakesList) => void;
    const load = vi.fn(() => new Promise<ThreadPendingWakesList>((resolve) => { finish = resolve; }));
    const cache = new ThreadPendingWakesCache(load);
    const waiting = Array.from({ length: 512 }, () => cache.read(THREAD, { endedLimit: 0 }));
    await expect(cache.read(THREAD, { endedLimit: 0 })).rejects.toThrow("capacity");
    expect(load).toHaveBeenCalledTimes(1);
    finish(EMPTY);
    await Promise.all(waiting);
    cache.clear();
  });

  it("answers oversized results without retaining them or bypassing the rebuild interval", async () => {
    vi.useFakeTimers();
    const large: ThreadPendingWakesList = { wakes: [{ kind: "monitor", key: "monitor:large", monitorId: "large", monitorBackend: "codex",
      task: "x".repeat(129 * 1024), createdAt: 1, lastActivityAt: 1, pollIntervalSeconds: 60, durable: false }], ended: [] };
    const load = vi.fn(async () => large);
    const cache = new ThreadPendingWakesCache(load);
    expect(await cache.read(THREAD, { endedLimit: 0 })).toEqual(large);
    const again = cache.read(THREAD, { endedLimit: 0 });
    await vi.advanceTimersByTimeAsync(199);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await again).toEqual(large);
    expect(load).toHaveBeenCalledTimes(2);
    cache.clear();
  });

  it("bounds retained threads, rejects saturated demand, and cancels delayed work on close", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => EMPTY);
    const cache = new ThreadPendingWakesCache(load);
    for (let i = 0; i < 80; i += 1) await cache.read({ ...THREAD, threadId: String(i) }, { endedLimit: 0 });
    // The oldest idle entry was evicted; visiting it must build again.
    await cache.read({ ...THREAD, threadId: "0" }, { endedLimit: 0 });
    expect(load).toHaveBeenCalledTimes(81);
    cache.invalidate();
    const waiting = cache.read({ ...THREAD, threadId: "0" }, { endedLimit: 0 });
    const rejected = expect(waiting).rejects.toThrow("closed");
    cache.clear();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);

    const finishes: Array<(value: ThreadPendingWakesList) => void> = [];
    const blocked = new ThreadPendingWakesCache(() => new Promise((resolve) => { finishes.push(resolve); }));
    const admitted = Array.from({ length: 64 }, (_, i) => blocked.read({ ...THREAD, threadId: String(i) }));
    await expect(blocked.read({ ...THREAD, threadId: "overflow" })).rejects.toThrow("capacity");
    for (const finish of finishes) finish(EMPTY);
    await Promise.all(admitted);
    blocked.clear();
  });
});
