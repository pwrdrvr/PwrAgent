import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArchiveCleanupQueue, ARCHIVE_CLEANUP_PAUSE_MS, ARCHIVE_CLEANUP_QUEUE_LIMIT,
} from "../app-server/archive-cleanup-queue";

afterEach(() => vi.useRealTimers());

describe("archive cleanup scheduling budgets", () => {
  it("coalesces identities and admits exactly one slice between event-loop opportunities", async () => {
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
    expect(slices).toEqual(["one"]);
    const interactive = vi.fn();
    setTimeout(interactive, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(interactive).toHaveBeenCalledOnce();
    expect(slices).toEqual(["one"]);
    await vi.runAllTimersAsync();
    expect(await first).toBe(3);
    expect(await second).toBe(3);
    expect(slices).toEqual(["one", "one", "one", "two", "two", "two"]);
    expect(peak).toBe(1);
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
});
