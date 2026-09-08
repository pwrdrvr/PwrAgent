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

it("shares successive project batches only within a versioned bounded reuse window", async () => {
  vi.useFakeTimers();
  try {
    const pool = new NavigationIndexReadPool(1_000);
    const load = vi.fn(async () => index);
    for (let project = 0; project < 15; project++) await pool.read("owner:v1", load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(pool.retainedUsage().entries).toBe(1);
    await pool.read("other:v1", load);
    await pool.read("owner:v2", load);
    expect(load).toHaveBeenCalledTimes(3);
    pool.invalidate("owner:v2");
    await pool.read("owner:v2", load);
    expect(load).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pool.retainedUsage()).toEqual({ entries: 0, bytes: 0 });
    await pool.read("owner:v2", load);
    expect(load).toHaveBeenCalledTimes(5);
  } finally { vi.useRealTimers(); }
});

it("never retains invalidated in-flight work and caps completed backing", async () => {
  const pool = new NavigationIndexReadPool(1_000);
  const old = deferred();
  const first = pool.read("owner", () => old.promise);
  await Promise.resolve();
  pool.invalidate("owner");
  old.resolve(index); await first;
  expect(pool.retainedUsage().entries).toBe(0);
  for (let i = 0; i < 12; i++) await pool.read(String(i), async () => index);
  expect(pool.retainedUsage().entries).toBe(8);
  const huge: NavigationQueryIndex = { ...index, threads: [{ id: "huge", source: "codex", title: "x".repeat(9 * 1024 * 1024),
    titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } }] };
  await pool.read("huge", async () => huge);
  expect(pool.retainedUsage().bytes).toBeLessThan(8 * 1024 * 1024);
});
