import { describe, expect, it, vi } from "vitest";
import { NavigationIndexReadPool } from "../app-server/navigation-index-read-pool";
import type { NavigationQueryIndex } from "../app-server/navigation-query-projection";

const index = { threads: [], directories: [], inputRequestThreadKeys: new Set<string>() } as NavigationQueryIndex;
function deferred() {
  let resolve!: (index: NavigationQueryIndex) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<NavigationQueryIndex>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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

  it("joins an invalidated read's replacement and never caches completed source backing", async () => {
    const pool = new NavigationIndexReadPool();
    const old = deferred();
    const stale = { ...index, localInstanceId: "stale" };
    const current = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(index);
    const first = pool.read("owner", current);
    await Promise.resolve();
    pool.invalidate("owner");
    const second = pool.read("owner", current);
    expect(current).toHaveBeenCalledTimes(1);
    old.resolve(stale);
    await expect(Promise.all([first, second])).resolves.toEqual([index, index]);
    expect(current).toHaveBeenCalledTimes(2);
    await pool.read("owner", current);
    expect(current).toHaveBeenCalledTimes(3);
    expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
  });

  it("keeps remaining readers after cancellation and replays a real mutation during replacement", async () => {
    const pool = new NavigationIndexReadPool();
    const gates = [deferred(), deferred(), deferred()];
    const load = vi.fn((_: AbortSignal) => gates[load.mock.calls.length - 1]!.promise);
    const cancelled = new AbortController();
    const first = pool.read("local", load, cancelled.signal);
    await Promise.resolve();
    pool.invalidate("local");
    const second = pool.read("local", load);
    gates[0]!.resolve({ ...index, localInstanceId: "old" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    pool.invalidate("local");
    const third = pool.read("local", load);
    cancelled.abort();
    await expect(first).rejects.toThrow();
    expect(pool.usage()).toEqual({ physical: 1, readers: 2 });
    gates[1]!.resolve({ ...index, localInstanceId: "middle" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    const fresh = { ...index, localInstanceId: "new" };
    gates[2]!.resolve(fresh);
    await expect(Promise.all([second, third])).resolves.toEqual([fresh, fresh]);
    expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
  });

  it("retries a failed obsolete scan, but returns a current provider failure", async () => {
    const pool = new NavigationIndexReadPool();
    const old = deferred();
    const load = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(index)
      .mockRejectedValueOnce(new Error("current provider failure"));
    const first = pool.read("owner", load);
    await Promise.resolve();
    pool.invalidate("owner");
    const joined = pool.read("owner", load);
    // The original provider failure is obsolete after the event. Both readers
    // receive the replacement instead of failing independently.
    old.reject(new Error("obsolete provider failure"));
    await expect(Promise.all([first, joined])).resolves.toEqual([index, index]);
    await expect(pool.read("owner", load)).rejects.toThrow("current provider failure");
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

it("retains only the replacement after in-flight invalidation and caps completed backing", async () => {
  const pool = new NavigationIndexReadPool(1_000);
  const old = deferred();
  const fresh = { ...index, localInstanceId: "fresh" };
  const load = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(fresh);
  const first = pool.read("owner", load);
  await Promise.resolve();
  pool.invalidate("owner");
  old.resolve(index); await first;
  expect(load).toHaveBeenCalledTimes(2);
  expect(await pool.read("owner", load)).toBe(fresh);
  expect(pool.retainedUsage().entries).toBe(1);
  for (let i = 0; i < 12; i++) await pool.read(String(i), async () => index);
  expect(pool.retainedUsage().entries).toBe(8);
  const huge: NavigationQueryIndex = { ...index, threads: [{ id: "huge", source: "codex", title: "x".repeat(9 * 1024 * 1024),
    titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } }] };
  await pool.read("huge", async () => huge);
  expect(pool.retainedUsage().bytes).toBeLessThan(8 * 1024 * 1024);
});


it.each([512, 2_048])("stops sizing a rejected %i-row snapshot at the retention budget", async (count) => {
  const pool = new NavigationIndexReadPool(1_000);
  const row = { id: "fixture", source: "codex" as const, title: "x".repeat(32 * 1024),
    titleSource: "explicit" as const, linkedDirectories: [], inbox: { inInbox: false } };
  const snapshot: NavigationQueryIndex = { threads: Array(count).fill(row), directories: [] };
  const stringify = vi.spyOn(JSON, "stringify");
  let signal!: AbortSignal;
  try {
    expect(await pool.read("fixture", async (sourceSignal) => { signal = sourceSignal; return snapshot; })).toBe(snapshot);
    const serializedBytes = stringify.mock.results.reduce((sum, result) =>
      sum + (typeof result.value === "string" ? Buffer.byteLength(result.value) : 0), 0);
    expect(pool.retainedUsage()).toEqual({ entries: 0, bytes: 0 });
    expect(signal.aborted).toBe(true);
    expect(serializedBytes).toBeLessThan(9 * 1024 * 1024);
  } finally {
    stringify.mockRestore();
  }
});

it.each([0, 1, 127, 128, 129, 300])("charges the exact UTF-8 JSON size across %i-row batch boundaries", async (count) => {
  const pool = new NavigationIndexReadPool(1_000);
  const snapshot: NavigationQueryIndex = {
    localInstanceId: "fixture",
    coverage: { state: "complete" },
    threads: Array.from({ length: count }, (_, i) => ({
      id: String(i), source: "codex", title: "待機 😀 \\\"\n\ud800", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false }, updatedAt: undefined,
    })),
    directories: Array.from({ length: count }, (_, i) => ({
      key: String(i), kind: "directory", label: "project", threadKeys: [String(i)], needsAttentionCount: 0,
    })),
    inputRequestThreadKeys: new Set(Array.from({ length: count }, (_, i) => `codex:待機:${i}`)),
  };
  const expected = Buffer.byteLength(JSON.stringify({ ...snapshot, inputRequestThreadKeys: [...snapshot.inputRequestThreadKeys!] }));
  await pool.read("fixture", async () => snapshot);
  expect(pool.retainedUsage()).toEqual({ entries: 1, bytes: expected });
  pool.invalidate("fixture");
  expect(pool.retainedUsage()).toEqual({ entries: 0, bytes: 0 });
});

it("keeps the exact 8 MiB boundary and evicts aggregate backing before admitting another snapshot", async () => {
  const budget = 8 * 1024 * 1024;
  const pool = new NavigationIndexReadPool(1_000);
  const snapshot: NavigationQueryIndex = { threads: [], directories: [], inputRequestThreadKeys: new Set([""]) };
  const emptyBytes = Buffer.byteLength(JSON.stringify({ ...snapshot, inputRequestThreadKeys: [""] }));
  snapshot.inputRequestThreadKeys = new Set(["x".repeat(budget - emptyBytes)]);
  let sourceSignal!: AbortSignal;
  await pool.read("full", async (signal) => { sourceSignal = signal; return snapshot; });
  expect(pool.retainedUsage()).toEqual({ entries: 1, bytes: budget });
  const tooLarge = { ...snapshot, inputRequestThreadKeys: new Set(["x".repeat(budget - emptyBytes + 1)]) };
  await pool.read("oversized", async () => tooLarge);
  expect(pool.retainedUsage()).toEqual({ entries: 1, bytes: budget });
  expect(sourceSignal.aborted).toBe(false);
  await pool.read("small", async () => index);
  expect(sourceSignal.aborted).toBe(true);
  expect(pool.retainedUsage()).toEqual({ entries: 1,
    bytes: Buffer.byteLength(JSON.stringify({ ...index, inputRequestThreadKeys: [] })) });
  pool.invalidate("small");
});
