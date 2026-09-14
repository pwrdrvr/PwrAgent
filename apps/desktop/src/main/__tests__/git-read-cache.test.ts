import { describe, expect, it, vi } from "vitest";
import { GitReadCache, GitUserRefreshBudget } from "../git-info/read-cache";

describe("Git store admission", () => {
  it("bounds 120 user refreshes across caches to ten, refills one per second, and caps at ten", async () => {
    let now = 0;
    const report = vi.fn();
    const budget = new GitUserRefreshBudget(() => now, report);
    const caches = Array.from({ length: 2 }, () => new GitReadCache<number>({
      ttlMs: 1_000_000, now: () => now, budget,
    }));
    const load = vi.fn(async () => 42);
    for (let index = 0; index < 120; index += 1) {
      await caches[index % 2].read(`repo-${index}`, load);
    }
    load.mockClear();
    for (let index = 0; index < 120; index += 1) {
      await caches[index % 2].read(`repo-${index}`, load, { userAction: true, caller: "buggy-hover" });
    }
    expect(load).toHaveBeenCalledTimes(10);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ caller: "buggy-hover" }));
    now = 999;
    await caches[0].read("repo-0", load, { userAction: true });
    expect(load).toHaveBeenCalledTimes(10);
    now = 1_000;
    await caches[0].read("repo-0", load, { userAction: true });
    expect(load).toHaveBeenCalledTimes(11);
    now = 100_000;
    for (let index = 0; index < 120; index += 1) {
      await caches[0].read("repo-0", load, { userAction: true });
    }
    expect(load).toHaveBeenCalledTimes(21);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1][0].denied).toBeGreaterThan(1);
  });

  it("coalesces pending reads before charging for user intent", async () => {
    const budget = new GitUserRefreshBudget(() => 0, vi.fn());
    const cache = new GitReadCache({ ttlMs: 1_000, budget });
    let resolve!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const reads = Array.from({ length: 120 }, () => cache.read("repo", load, { userAction: true }));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    resolve("main");
    expect(await Promise.all(reads)).toEqual(Array(120).fill("main"));
    for (let index = 0; index < 9; index += 1) expect(budget.tryTake("other")).toBe(true);
    expect(budget.tryTake("other")).toBe(false);
  });

  it("retains negative observations until expiry and then allows recovery", async () => {
    let now = 0;
    const cache = new GitReadCache<string | undefined>({ ttlMs: 5_000, now: () => now });
    const load = vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined);
    await cache.read("missing", load);
    load.mockResolvedValue("recovered");
    now = 4_999;
    expect(await cache.read("missing", load)).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
    now = 5_000;
    expect(await cache.read("missing", load)).toBe("recovered");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not let a pre-mutation completion overwrite the replacement read", async () => {
    const cache = new GitReadCache<string>({ ttlMs: 1_000 });
    let release!: (value: string) => void;
    const old = cache.read("repo", () => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();
    cache.invalidate("repo");
    await cache.read("repo", async () => "new");
    release("old");
    await old;
    expect(await cache.read("repo", async () => "wrong")).toBe("new");
  });

  it("also caches rejected probes, preserving the error until retry is due", async () => {
    let now = 0;
    const cache = new GitReadCache<string>({ ttlMs: 1_000, now: () => now });
    const error = new Error("temporarily unreadable");
    const load = vi.fn(async () => { throw error; });
    for (let index = 0; index < 120; index += 1) {
      await expect(cache.read("repo", load)).rejects.toBe(error);
    }
    expect(load).toHaveBeenCalledTimes(1);
    now = 1_000;
    expect(await cache.read("repo", async () => "recovered")).toBe("recovered");
  });

  it("bounds retained paths and lets evicted paths recover", async () => {
    const cache = new GitReadCache<number>({ ttlMs: 1_000, maxEntries: 2 });
    const load = vi.fn(async () => 1);
    for (const key of ["a", "b", "c", "b", "a"]) await cache.read(key, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("does not refill on a backwards clock jump", () => {
    let now = 1_000;
    const budget = new GitUserRefreshBudget(() => now, vi.fn());
    for (let index = 0; index < 10; index += 1) expect(budget.tryTake("repo")).toBe(true);
    now = 0;
    expect(budget.tryTake("repo")).toBe(false);
    now = 1_000;
    expect(budget.tryTake("repo")).toBe(false);
    now = 2_000;
    expect(budget.tryTake("repo")).toBe(true);
  });
});
