import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import path from "node:path";
import {
  ArchiveCleanupQueue, ARCHIVE_CLEANUP_PAUSE_MS, ARCHIVE_CLEANUP_QUEUE_LIMIT,
} from "../app-server/archive-cleanup-queue";

afterEach(() => vi.useRealTimers());

describe("archive cleanup scheduling budgets", () => {
  it("projects only explicit archive work into progress, regardless of scan/recovery interleavings", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ reportProgress: fc.boolean(), cancel: fc.boolean() }), {
      minLength: 1, maxLength: 30,
    }), async (commands) => {
      const queue = new ArchiveCleanupQueue<void>(0);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const jobs = [queue.enqueue("audit", async () => await gate), ...commands.map(({ reportProgress, cancel }, index) => {
        const key = `job-${index}`;
        const pending = queue.enqueue(key, async () => await gate, { reportProgress });
        // Duplicate admission cannot change an existing job's reporting policy.
        expect(queue.enqueue(key, async () => {}, { reportProgress: !reportProgress })).toBe(pending);
        const settled = pending.catch(() => {});
        if (cancel) queue.cancel(key);
        return settled;
      })];
      try {
        expect(queue.progress(true).total).toBe(commands.filter((job) => job.reportProgress).length);
        expect(queue.progress(true).completed).toBe(commands.filter((job) => job.reportProgress && job.cancel).length);
        expect(queue.progress(true).active.every((job) => job.key !== "audit")).toBe(true);
      } finally {
        release();
        await Promise.all(jobs);
        expect(queue.progress(true).completed).toBe(commands.filter((job) => job.reportProgress).length);
        await queue.close();
      }
    }), { numRuns: 25 });
  });

  it("breaks an opposing nested-scope wait cycle without removing under stale ownership", async () => {
    await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.nat({ max: 100 }), { minLength: 2, maxLength: 2 }), async (ids) => {
      const scopes = ids.map((id) => path.resolve(`/archive-lock-order/${id}`)).sort();
      const queue = new ArchiveCleanupQueue<string>(0);
      let entered = 0;
      let release!: () => void;
      const bothEntered = new Promise<void>((resolve) => { release = resolve; });
      try {
        const results = await Promise.allSettled(scopes.map((scope, index) => queue.enqueue(scope, async (context) =>
          await context.withWorktree!(scope, async () => {
            entered += 1;
            if (entered === 2) release();
            await bothEntered;
            return await context.withWorktree!(scopes[1 - index]!, async () => "removed");
          }),
        )));
        // The ascending waiter can finish after the descending waiter keeps
        // its checkout and releases its scope. Neither worker waits forever.
        expect(results[0]).toEqual({ status: "fulfilled", value: "removed" });
        expect(results[1]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("ownership changed") }) });
      } finally { release(); await queue.close(); }
    }), { numRuns: 20 });
  });

  it("reports active identities before completion and bounds overlapping scopes against a path oracle", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.boolean()), { minLength: 4, maxLength: 12 }), async (inputs) => {
      vi.useFakeTimers();
      const states: ReturnType<ArchiveCleanupQueue<number>["progress"]>[] = [];
      const queue = new ArchiveCleanupQueue<number>(undefined, undefined, (state) => states.push(state));
      const held = new Map<number, { scope: string; release: () => void }>();
      const releases: Array<() => void> = [];
      const changes = new Set<() => void>();
      const changed = () => { for (const change of changes) change(); };
      let inventoryReaders = 0;
      let peakReaders = 0;
      const violations: string[] = [];
      let completed = 0;
      const jobs = inputs.map(([root, child], id) => queue.enqueue(String(id), async (context) => {
        await context.withInventory!(async () => {
          inventoryReaders += 1;
          peakReaders = Math.max(peakReaders, inventoryReaders);
          await context.checkpoint();
          inventoryReaders -= 1;
        });
        const scope = path.resolve(`/archive-scope-oracle/${root}${child ? "/child" : ""}`);
        return await context.withWorktree!(scope, async () => {
          for (const other of held.values()) {
            // The oracle uses ancestor enumeration, independently of the
            // scheduler's relative-path predicate.
            const ancestors = (value: string) => {
              const values = [value];
              while (path.dirname(value) !== value) { value = path.dirname(value); values.push(value); }
              return values;
            };
            if (ancestors(scope).includes(other.scope) || ancestors(other.scope).includes(scope)) violations.push(scope);
          }
          context.setWorktreePath!(scope);
          await new Promise<void>((release) => { held.set(id, { scope, release }); releases.push(release); changed(); });
          held.delete(id);
          return id;
        });
      }).then(() => { completed += 1; changed(); }));
      const until = async (predicate: () => boolean) => {
        while (!predicate()) {
          let wake!: () => void;
          const activity = new Promise<void>((resolve) => { wake = resolve; changes.add(wake); });
          try {
            await Promise.race([activity, queue.whenCheckpointPending()]);
            if (!predicate()) await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
          } finally { changes.delete(wake); }
        }
      };
      try {
        await until(() => held.size > 0);
        expect(states.some((state) => state.active.length === 4 && state.completed === 0)).toBe(true);
        while (completed < inputs.length) {
          await until(() => held.size > 0 || completed === inputs.length);
          if (completed === inputs.length) break;
          expect(held.size).toBeGreaterThan(0);
          const before = completed;
          held.values().next().value!.release();
          await until(() => completed > before);
        }
        await Promise.all(jobs);
        expect(violations).toEqual([]);
        expect(peakReaders).toBe(1);
        expect(states.every((state) => state.active.length <= 4)).toBe(true);
        expect(queue.progress()).toMatchObject({ active: [], queued: 0, completed: inputs.length, total: inputs.length });
      } finally {
        releases.forEach((release) => release());
        const close = queue.close();
        await vi.runAllTimersAsync();
        await close;
      }
    }), { numRuns: 30 });
  });

  it("keeps four workers busy and publishes each result in completion order", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 5, max: 12 }), fc.array(fc.nat(), { minLength: 12, maxLength: 12 }),
      async (count, choices) => {
        vi.useFakeTimers();
        const queue = new ArchiveCleanupQueue<number>();
        const running = new Map<number, () => void>();
        const completed: number[] = [];
        const releases: Array<() => void> = [];
        const jobs = Array.from({ length: count }, (_, id) => queue.enqueue(String(id), async () => {
          await new Promise<void>((resolve) => { running.set(id, resolve); releases.push(resolve); });
          running.delete(id);
          return id;
        }).then((value) => { completed.push(value); }).catch(() => {}));
        try {
          await vi.runAllTimersAsync();
          expect(running.size).toBe(4);
          for (let turn = 0; turn < count; turn += 1) {
            const active = [...running.keys()];
            const id = active[choices[turn % choices.length]! % active.length]!;
            const before = completed.length;
            running.get(id)!();
            await vi.runAllTimersAsync();
            expect(completed[before]).toBe(id);
            expect(running.size).toBe(Math.min(4, count - turn - 1));
          }
          await Promise.all(jobs);
        } finally {
          releases.forEach((release) => release());
          const close = queue.close();
          await vi.runAllTimersAsync();
          await close;
        }
      },
    ), { numRuns: 30 });
  });

  it("shares a batch identity only until the queue drains", async () => {
    vi.useFakeTimers();
    const queue = new ArchiveCleanupQueue<object | undefined>();
    const first = queue.enqueue("first", async (context) => context.batch);
    const second = queue.enqueue("second", async (context) => context.batch);
    await vi.runAllTimersAsync();
    expect(await first).toBeDefined();
    expect(await second).toBe(await first);
    const later = queue.enqueue("later", async (context) => context.batch);
    await vi.runAllTimersAsync();
    expect(await later).not.toBe(await first);
    await queue.close();
  });

  it("coalesces identities and admits one slice per worker between event-loop opportunities", async () => {
    vi.useFakeTimers();
    const queue = new ArchiveCleanupQueue<number>();
    const slices: string[] = [];
    let active = 0;
    let peak = 0;
    const work = (id: string) => async (context: { checkpoint(): Promise<void> }) => {
      active += 1;
      peak = Math.max(peak, active);
      for (let slice = 0; slice < 3; slice += 1) {
        slices.push(id);
        await context.checkpoint();
      }
      active -= 1;
      return 3;
    };
    const first = queue.enqueue("codex:one", work("one"));
    expect(queue.enqueue("codex:one", work("duplicate"))).toBe(first);
    const second = queue.enqueue("acp:kimi:one", work("two"));
    expect(slices).toEqual([]);
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
    expect(slices).toEqual(["one", "two"]);
    const interactive = vi.fn();
    setTimeout(interactive, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(interactive).toHaveBeenCalledOnce();
    expect(slices).toEqual(["one", "two"]);
    await vi.runAllTimersAsync();
    expect(await first).toBe(3);
    expect(await second).toBe(3);
    expect(slices).toEqual(["one", "two", "one", "two", "one", "two"]);
    expect(peak).toBe(2);
    await queue.close();
  });

  it("bounds waiting jobs, cancels queued/running work, and leaves no timer after shutdown", async () => {
    vi.useFakeTimers();
    const queue = new ArchiveCleanupQueue<void>();
    const work = vi.fn(async () => {});
    const results = Array.from({ length: ARCHIVE_CLEANUP_QUEUE_LIMIT }, (_, id) =>
      queue.enqueue(`codex:${id}`, work).catch((error: Error) => error.message),
    );
    await expect(queue.enqueue("overflow", work)).rejects.toThrow("queue is full");
    expect(ARCHIVE_CLEANUP_QUEUE_LIMIT).toBe(256);
    await queue.close();
    expect(work).not.toHaveBeenCalled();
    expect((await Promise.all(results)).every((result) => typeof result === "string")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(queue.enqueue("closed", work)).rejects.toThrow("cancelled");
  });

  it("allows retry after failure without overlapping a physical job", async () => {
    vi.useFakeTimers();
    const queue = new ArchiveCleanupQueue<number>();
    const failed = queue.enqueue("codex:one", async () => { throw new Error("provider unavailable"); });
    const failure = expect(failed).rejects.toThrow("provider unavailable");
    await vi.runAllTimersAsync();
    await failure;
    const retry = queue.enqueue("codex:one", async () => 1);
    await vi.runAllTimersAsync();
    expect(await retry).toBe(1);
    await queue.close();
  });

  it("reports released capacity after success, failure, and queued cancellation, without waking after close", async () => {
    vi.useFakeTimers();
    const released: number[] = [];
    const queue = new ArchiveCleanupQueue<void>(ARCHIVE_CLEANUP_PAUSE_MS, () => { released.push(queue.availableSlots); });
    const results = Array.from({ length: ARCHIVE_CLEANUP_QUEUE_LIMIT }, (_, index) => queue.enqueue(String(index), async () => {
      if (index === 0) throw new Error("Provider unavailable");
    }).catch(() => {}));
    expect(queue.availableSlots).toBe(0);
    await queue.cancelAndWait(String(ARCHIVE_CLEANUP_QUEUE_LIMIT - 1));
    expect(released).toEqual([1]);
    await vi.runAllTimersAsync();
    await Promise.all(results);
    expect(released).toHaveLength(ARCHIVE_CLEANUP_QUEUE_LIMIT);
    expect(released.at(-1)).toBe(ARCHIVE_CLEANUP_QUEUE_LIMIT);
    await queue.close();
    expect(queue.availableSlots).toBe(0);
    expect(released).toHaveLength(ARCHIVE_CLEANUP_QUEUE_LIMIT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains post-removal persistence before releasing lifecycle cancellation", async () => {
    vi.useFakeTimers();
    const queue = new ArchiveCleanupQueue<number>();
    let release!: () => void;
    const removal = new Promise<void>((resolve) => { release = resolve; });
    const persisted = vi.fn();
    const result = queue.enqueue("codex:one", async (context) => {
      context.assertCurrent();
      await removal;
      await context.settleCheckpoint();
      persisted();
      return 1;
    });
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
    let drained = false;
    const cancel = queue.cancelAndWait("codex:one").then(() => { drained = true; });
    expect(drained).toBe(false);
    release();
    await vi.runAllTimersAsync();
    await cancel;
    expect(await result).toBe(1);
    expect(persisted).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
    await queue.close();
  });

  it("signals a pending checkpoint only while a job is parked on its pause", async () => {
    vi.useFakeTimers();
    const queue = new ArchiveCleanupQueue<number>();
    let release!: () => void;
    const io = new Promise<void>((resolve) => { release = resolve; });
    const result = queue.enqueue("codex:one", async (context) => {
      await io;
      await context.checkpoint();
      return 1;
    });
    // The admission checkpoint parks first, and stays pending until it fires.
    await queue.whenCheckpointPending();
    await expect(queue.whenCheckpointPending()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
    // The job is now awaiting I/O, which no clock advance completes.
    let parked = false;
    const secondPark = queue.whenCheckpointPending().then(() => { parked = true; });
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS * 4);
    expect(parked).toBe(false);
    release();
    await secondPark;
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
    expect(await result).toBe(1);
    await queue.close();
  });
});
