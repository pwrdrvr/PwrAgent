import { describe, expect, it, vi } from "vitest";
import { createByteBudget, joinConcurrent, collectConcurrent } from "../../shared/concurrent-work";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("concurrent work collection and ownership", () => {
  it("limits admission and keeps input order when later work finishes first", async () => {
    const gates = Array.from({ length: 7 }, gate);
    const entered: number[] = [];
    const work = collectConcurrent(gates, 3, async (item, index) => {
      entered.push(index);
      await item.promise;
      return index;
    });
    await vi.waitFor(() => expect(entered).toEqual([0, 1, 2]));
    gates[2]!.resolve();
    await vi.waitFor(() => expect(entered).toEqual([0, 1, 2, 3]));
    for (const item of gates) item.resolve();
    expect(await work).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("stops admission on failure and drains in-flight work before rejecting", async () => {
    const fail = gate();
    const pending = gate();
    const failure = new Error("cancelled");
    const entered: number[] = [];
    let settled = false;
    const work = collectConcurrent([0, 1, 2], 2, async (index) => {
      entered.push(index);
      if (index === 0) {
        await fail.promise;
        throw failure;
      }
      await pending.promise;
    });
    void work.catch(() => { settled = true; });
    await vi.waitFor(() => expect(entered).toEqual([0, 1]));
    fail.resolve();
    // Give the failed mapper a turn while its sibling is still owned.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(entered).toEqual([0, 1]);
    pending.resolve();
    await expect(work).rejects.toBe(failure);
    expect(entered).toEqual([0, 1]);
  });

  it("retains undefined values and empty inputs at the array boundary", async () => {
    expect(await collectConcurrent(["a", "b"], 2, async () => undefined)).toEqual([undefined, undefined]);
    const operation = vi.fn(async () => "unused");
    expect(await collectConcurrent([], 2, operation)).toEqual([]);
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves the first failure even when it is undefined and a sibling also fails", async () => {
    const fail = gate();
    const sibling = gate();
    const entered: number[] = [];
    let settled = false;
    const work = collectConcurrent([0, 1, 2], 2, async (index) => {
      entered.push(index);
      if (index === 0) {
        await fail.promise;
        throw undefined;
      }
      await sibling.promise;
      throw new Error("later failure");
    });
    void work.catch(() => { settled = true; });
    await vi.waitFor(() => expect(entered).toEqual([0, 1]));
    fail.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    sibling.resolve();
    await expect(work).rejects.toBeUndefined();
    expect(entered).toEqual([0, 1]);
  });

  it("joins failed setup without releasing lifecycle ownership before its sibling drains", async () => {
    const pending = gate();
    const failure = new Error("isolated MCP inventory unavailable");
    let settled = false;
    const work = joinConcurrent([Promise.reject(failure), pending.promise]);
    void work.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve();
    await expect(work).rejects.toBe(failure);
  });

  it("bounds retained bytes, admits in FIFO order and returns capacity on error", async () => {
    const budget = createByteBudget(10);
    const first = gate();
    const entered: string[] = [];
    const a = budget(6, async () => { entered.push("a"); await first.promise; throw new Error("read failed"); });
    const failure = expect(a).rejects.toThrow("read failed");
    const b = budget(10, async () => { entered.push("b"); });
    const c = budget(4, async () => { entered.push("c"); });
    await Promise.resolve();
    expect(entered).toEqual(["a"]);
    first.resolve();
    await Promise.all([failure, b, c]);
    expect(entered).toEqual(["a", "b", "c"]);
  });
});
