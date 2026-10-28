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

  it("finishes a scan for its own readers after a change, and later readers share one follow-up", async () => {
    const pool = new NavigationIndexReadPool();
    const old = deferred();
    const stale = { ...index, localInstanceId: "stale" };
    const current = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(index);
    const first = pool.read("owner", current);
    await Promise.resolve();
    pool.invalidate("owner");
    const second = pool.read("owner", current);
    const third = pool.read("owner", current);
    expect(current).toHaveBeenCalledTimes(1);
    expect(pool.usage()).toEqual({ physical: 1, readers: 3 });
    old.resolve(stale);
    await expect(Promise.all([first, second, third])).resolves.toEqual([stale, index, index]);
    expect(current).toHaveBeenCalledTimes(2);
    await pool.read("owner", current);
    expect(current).toHaveBeenCalledTimes(3);
    expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
  });

  it("keeps one scan running per key and drops a follow-up nobody waits for", async () => {
    const pool = new NavigationIndexReadPool();
    const gates = [deferred(), deferred(), deferred()];
    const load = vi.fn((_: AbortSignal) => gates[load.mock.calls.length - 1]!.promise);
    const cancelled = new AbortController();
    const first = pool.read("local", load, cancelled.signal);
    await Promise.resolve();
    pool.invalidate("local");
    const second = pool.read("local", load);
    cancelled.abort();
    await expect(first).rejects.toThrow();
    // The follow-up waits for the running scan instead of racing it.
    expect(load).toHaveBeenCalledTimes(1);
    gates[0]!.resolve({ ...index, localInstanceId: "old" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    pool.invalidate("local");
    const leaving = new AbortController();
    const third = pool.read("local", load, leaving.signal);
    leaving.abort();
    await expect(third).rejects.toThrow();
    const middle = { ...index, localInstanceId: "middle" };
    gates[1]!.resolve(middle);
    await expect(second).resolves.toBe(middle);
    await new Promise((resolve) => setImmediate(resolve));
    expect(load).toHaveBeenCalledTimes(2);
    expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
  });

  it("never fails a read because changes keep landing during every scan", async () => {
    const pool = new NavigationIndexReadPool(1_000);
    const gates = [deferred(), deferred(), deferred()];
    const load = vi.fn((_: AbortSignal) => gates[load.mock.calls.length - 1]?.promise ?? Promise.resolve(index));
    const reads = [pool.read("owner", load), pool.read("owner", load)];
    for (let attempt = 0; attempt < gates.length; attempt++) {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(attempt + 1));
      pool.invalidate("owner");
      reads.push(pool.read("owner", load));
      gates[attempt]!.resolve({ ...index, localInstanceId: `scan-${attempt}` });
    }
    expect((await Promise.all(reads)).map((result) => result.localInstanceId))
      .toEqual(["scan-0", "scan-0", "scan-1", "scan-2", undefined]);
    expect(load).toHaveBeenCalledTimes(4);
    expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
    // Only the scan no change overtook is reused.
    expect(pool.retainedUsage().entries).toBe(1);
    await expect(pool.read("owner", load)).resolves.toBe(index);
    expect(load).toHaveBeenCalledTimes(4);
    pool.invalidate("owner");
  });

  it("returns a scan's own failure to its readers without retrying it", async () => {
    const pool = new NavigationIndexReadPool();
    const old = deferred();
    const load = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(index)
      .mockRejectedValueOnce(new Error("current provider failure"));
    const first = pool.read("owner", load);
    await Promise.resolve();
    pool.invalidate("owner");
    const later = pool.read("owner", load);
    old.reject(new Error("earlier provider failure"));
    await expect(first).rejects.toThrow("earlier provider failure");
    await expect(later).resolves.toBe(index);
    await expect(pool.read("owner", load)).rejects.toThrow("current provider failure");
    expect(load).toHaveBeenCalledTimes(3);
  });

  describe("hand-off before projection", () => {
    // Each scan waits on its own gate (the provider listing), calls the
    // checkpoint, then counts a projection.
    function scans() {
      const gates = Array.from({ length: 4 }, () => deferred());
      const projections: string[] = [];
      const load = vi.fn(async (_signal: AbortSignal, checkpoint: () => void) => {
        const scan = load.mock.calls.length;
        const listed = await gates[scan - 1]!.promise;
        checkpoint();
        projections.push(`scan-${scan}`);
        return { ...listed, localInstanceId: `scan-${scan}` };
      });
      return { gates, projections, load, list: (scan: number) => gates[scan - 1]!.resolve(index) };
    }

    it("hands an overtaken scan's readers to the follow-up instead of projecting", async () => {
      const pool = new NavigationIndexReadPool();
      const { projections, load, list } = scans();
      const first = pool.read("owner", load);
      await Promise.resolve();
      pool.invalidate("owner");
      const second = pool.read("owner", load);
      list(1);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      list(2);
      expect((await Promise.all([first, second])).map((result) => result.localInstanceId)).toEqual(["scan-2", "scan-2"]);
      expect(projections).toEqual(["scan-2"]);
      expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
    });

    it("finishes a scan that took readers over, even when overtaken again", async () => {
      const pool = new NavigationIndexReadPool();
      const { projections, load, list } = scans();
      const first = pool.read("owner", load);
      await Promise.resolve();
      pool.invalidate("owner");
      const second = pool.read("owner", load);
      list(1);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      pool.invalidate("owner");
      const third = pool.read("owner", load);
      list(2);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
      list(3);
      expect((await Promise.all([first, second, third])).map((result) => result.localInstanceId))
        .toEqual(["scan-2", "scan-2", "scan-3"]);
      expect(projections).toEqual(["scan-2", "scan-3"]);
    });

    it("finishes an overtaken scan when no later reader is waiting", async () => {
      const pool = new NavigationIndexReadPool();
      const { projections, load, list } = scans();
      const first = pool.read("owner", load);
      await Promise.resolve();
      pool.invalidate("owner");
      list(1);
      expect((await first).localInstanceId).toBe("scan-1");
      expect(projections).toEqual(["scan-1"]);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("still serves handed-over readers when the follow-up's own readers leave first", async () => {
      const pool = new NavigationIndexReadPool();
      const { load, list } = scans();
      let leaving!: AbortController;
      const first = pool.read("owner", async (signal, checkpoint) => {
        // The only later reader leaves between the checkpoint decision and the hand-off.
        const result = load(signal, () => {
          try { checkpoint(); } finally { leaving.abort(); }
        });
        return await result;
      });
      await Promise.resolve();
      pool.invalidate("owner");
      leaving = new AbortController();
      const second = pool.read("owner", load, leaving.signal);
      list(1);
      await expect(second).rejects.toThrow();
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      list(2);
      expect((await first).localInstanceId).toBe("scan-2");
      expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
    });
  });

  it("rejects instead of hanging when a snapshot cannot be retained", async () => {
    const pool = new NavigationIndexReadPool(1_000);
    const unsizable = { ...index, localInstanceId: 1n } as unknown as NavigationQueryIndex;
    await expect(pool.read("owner", async () => unsizable)).rejects.toThrow(/BigInt/);
    expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
    expect(pool.retainedUsage()).toEqual({ entries: 0, bytes: 0 });
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

  it("sends a reader with newer durable state to the follow-up and retains only the latest version", async () => {
    const pool = new NavigationIndexReadPool(1_000);
    const old = deferred();
    const stale = { ...index, localInstanceId: "stale" };
    const fresh = { ...index, localInstanceId: "fresh" };
    const load = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(fresh);
    const first = pool.read("owner", load, undefined, "v1");
    const second = pool.read("owner", load, undefined, "v2");
    const third = pool.read("owner", load, undefined, "v2");
    expect(pool.usage()).toEqual({ physical: 1, readers: 3 });
    old.resolve(stale);
    await expect(Promise.all([first, second, third])).resolves.toEqual([stale, fresh, fresh]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await pool.read("owner", load, undefined, "v2")).toBe(fresh);
    expect(load).toHaveBeenCalledTimes(2);
    await pool.read("owner", load, undefined, "v3");
    expect(load).toHaveBeenCalledTimes(3);
    pool.invalidate("owner");
    expect(pool.retainedUsage()).toEqual({ entries: 0, bytes: 0 });
  });

  it("shares one follow-up across every durable version written during a scan", async () => {
    const pool = new NavigationIndexReadPool(1_000);
    const gate = deferred();
    const load = vi.fn((_: AbortSignal) => load.mock.calls.length === 1 ? gate.promise : Promise.resolve(index));
    const reads = [pool.read("owner", load, undefined, "v0")];
    for (let version = 1; version <= 12; version++) reads.push(pool.read("owner", load, undefined, `v${version}`));
    gate.resolve({ ...index, localInstanceId: "v0" });
    const results = await Promise.all(reads);
    expect(results[0]!.localInstanceId).toBe("v0");
    expect(results.slice(1).every((result) => result === index)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await pool.read("owner", load, undefined, "v12")).toBe(index);
    expect(load).toHaveBeenCalledTimes(2);
    expect(pool.usage()).toEqual({ physical: 0, readers: 0 });
    pool.invalidate("owner");
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

it("retains only a scan no change overtook and caps completed backing", async () => {
  const pool = new NavigationIndexReadPool(1_000);
  const old = deferred();
  const fresh = { ...index, localInstanceId: "fresh" };
  const load = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(fresh);
  const first = pool.read("owner", load);
  await Promise.resolve();
  pool.invalidate("owner");
  old.resolve(index);
  expect(await first).toBe(index);
  expect(load).toHaveBeenCalledTimes(1);
  // The overtaken scan served its reader but is never reused.
  expect(pool.retainedUsage().entries).toBe(0);
  expect(await pool.read("owner", load)).toBe(fresh);
  expect(load).toHaveBeenCalledTimes(2);
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
