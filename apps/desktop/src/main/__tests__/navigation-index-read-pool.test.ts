import { describe, expect, it, vi } from "vitest";
import { NavigationIndexReadPool } from "../app-server/navigation-index-read-pool";
import type { NavigationQueryIndex } from "../app-server/navigation-query-projection";

const index = { threads: [], directories: [], inputRequestThreadKeys: new Set<string>() } as NavigationQueryIndex;
function deferred() {
  let resolve!: (index: NavigationQueryIndex) => void;
  const promise = new Promise<NavigationQueryIndex>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("shared owner index reads", () => {
  it("deduplicates simultaneous views and aborts only after the last release", async () => {
    const pool = new NavigationIndexReadPool();
    const pending = deferred();
    let sourceSignal!: AbortSignal;
    const load = vi.fn((signal: AbortSignal) => { sourceSignal = signal; return pending.promise; });
    const first = new AbortController();
    const second = new AbortController();
    const a = pool.read("owner", load, first.signal);
    const b = pool.read("owner", load, second.signal);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    first.abort();
    await expect(a).rejects.toThrow();
    expect(sourceSignal.aborted).toBe(false);
    second.abort();
    await expect(b).rejects.toThrow();
    expect(sourceSignal.aborted).toBe(true);
    expect(pool.usage()).toEqual({ physical: 1, readers: 0 });
    pending.resolve(index);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
  });

  it("does not join an invalidated generation and never caches completed source backing", async () => {
    const pool = new NavigationIndexReadPool();
    const old = deferred();
    const current = vi.fn(async () => index);
    const first = pool.read("owner", () => old.promise);
    await Promise.resolve();
    pool.invalidate("owner");
    await expect(pool.read("owner", current)).resolves.toBe(index);
    expect(current).toHaveBeenCalledTimes(1);
    old.resolve(index); await first;
    await pool.read("owner", current);
    expect(current).toHaveBeenCalledTimes(2);
    expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
  });

  it("retains physical admission for non-cooperative work after zero-ref cancellation", async () => {
    const pool = new NavigationIndexReadPool();
    const pending = deferred();
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const reads = controllers.map((controller, i) => pool.read(String(i), () => pending.promise, controller.signal).catch(() => {}));
    await Promise.resolve();
    controllers.forEach((controller) => controller.abort());
    await Promise.all(reads);
    await expect(pool.read("ninth", async () => index)).rejects.toThrow("source admission");
    pending.resolve(index);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(pool.read("ninth", async () => index)).resolves.toBe(index);
  });
});
