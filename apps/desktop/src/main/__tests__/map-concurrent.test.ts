import { describe, expect, it, vi } from "vitest";
import { createByteBudget, joinConcurrent, mapConcurrent } from "../../shared/map-concurrent";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("bounded asynchronous work", () => {
  it("limits admission and keeps input order when later work finishes first", async () => {
    const gates = Array.from({ length: 7 }, gate);
    const entered: number[] = [];
    const work = mapConcurrent(gates, 3, async (item, index) => {
      entered.push(index);
      await item.promise;
      return index;
    });
    expect(entered).toEqual([0, 1, 2]);
    gates[2]!.resolve();
    await vi.waitFor(() => expect(entered).toEqual([0, 1, 2, 3]));
    for (const item of gates) item.resolve();
    expect(await work).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("stops admission on failure and drains in-flight work before rejecting", async () => {
    const pending = gate();
    const failure = new Error("cancelled");
    const entered: number[] = [];
    let settled = false;
    const work = mapConcurrent([0, 1, 2], 2, async (index) => {
      entered.push(index);
      if (index === 0) throw failure;
      await pending.promise;
    });
    void work.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(entered).toEqual([0, 1]);
    pending.resolve();
    await expect(work).rejects.toBe(failure);
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
