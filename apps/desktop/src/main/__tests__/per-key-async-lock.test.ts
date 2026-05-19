import { describe, expect, it } from "vitest";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";

/** Promise-based deferred for test scheduling. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PerKeyAsyncLock", () => {
  it("runs tasks against different keys concurrently", async () => {
    const lock = new PerKeyAsyncLock();
    const aGate = deferred<void>();
    const bGate = deferred<void>();
    const order: string[] = [];

    const a = lock.run("a", async () => {
      order.push("a:start");
      await aGate.promise;
      order.push("a:end");
    });
    const b = lock.run("b", async () => {
      order.push("b:start");
      await bGate.promise;
      order.push("b:end");
    });

    // Both tasks should have begun before either finishes; this is the
    // distinguishing behaviour vs a global lock.
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["a:start", "b:start"]);

    bGate.resolve();
    aGate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });

  it("serialises tasks against the same key", async () => {
    const lock = new PerKeyAsyncLock();
    const firstGate = deferred<void>();
    const secondStartedSpy = { called: false };
    const order: string[] = [];

    const first = lock.run("k", async () => {
      order.push("1:start");
      await firstGate.promise;
      order.push("1:end");
    });
    const second = lock.run("k", async () => {
      secondStartedSpy.called = true;
      order.push("2:start");
      order.push("2:end");
    });

    // The second task must not have started yet — the lock should hold
    // it until the first task settles.
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["1:start"]);
    expect(secondStartedSpy.called).toBe(false);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["1:start", "1:end", "2:start", "2:end"]);
  });

  it("preserves task return values and propagates rejections to the caller", async () => {
    const lock = new PerKeyAsyncLock();
    await expect(lock.run("k", async () => 42)).resolves.toBe(42);
    await expect(
      lock.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("does not let a failed task poison the chain for subsequent tasks on the same key", async () => {
    // Regression for the failure-poisoning concern: a single rejected
    // task in the chain must not cause the next caller's `run()` to
    // reject before its own task has had a chance to execute. We
    // deliberately queue both calls before the first resolves so they
    // sit on the same chain link.
    const lock = new PerKeyAsyncLock();
    const failingGate = deferred<void>();
    const failing = lock.run("k", async () => {
      await failingGate.promise;
      throw new Error("planned failure");
    });
    const followUp = lock.run("k", async () => "ok");
    failingGate.resolve();

    await expect(failing).rejects.toThrow("planned failure");
    await expect(followUp).resolves.toBe("ok");
  });

  it("releases the key entry after the chain settles with no follow-up queued", async () => {
    const lock = new PerKeyAsyncLock();
    await lock.run("k", async () => "done");
    expect(lock.size()).toBe(0);

    // Same after a rejection.
    await expect(
      lock.run("k", async () => {
        throw new Error("oops");
      }),
    ).rejects.toThrow();
    expect(lock.size()).toBe(0);
  });

  it("retains the key entry while a follow-up is still queued, and drops it after that settles", async () => {
    // The lazy cleanup must NOT delete an entry that has a chained
    // follow-up waiting, otherwise the next concurrent caller would
    // bypass the chain and race.
    const lock = new PerKeyAsyncLock();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();

    const first = lock.run("k", async () => {
      await firstGate.promise;
    });
    const second = lock.run("k", async () => {
      await secondGate.promise;
    });

    // While the first is still in flight, the map has an entry.
    expect(lock.size()).toBe(1);

    firstGate.resolve();
    await first;
    // After the first settles, the second's chain link is still the
    // latest, so the map keeps an entry.
    expect(lock.size()).toBe(1);

    secondGate.resolve();
    await second;
    // After the second settles and no further task is queued, the
    // entry is dropped.
    expect(lock.size()).toBe(0);
  });

  it("isolates failure on one key from progress on another", async () => {
    const lock = new PerKeyAsyncLock();
    const aFailed = lock.run("a", async () => {
      throw new Error("a failed");
    });
    const bOk = lock.run("b", async () => "b ok");

    await expect(aFailed).rejects.toThrow("a failed");
    await expect(bOk).resolves.toBe("b ok");
  });

  it("queues many concurrent tasks against the same key into strict order", async () => {
    const lock = new PerKeyAsyncLock();
    const order: number[] = [];
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < 10; i += 1) {
      const index = i;
      tasks.push(
        lock.run("k", async () => {
          // Yield once so concurrent enqueuing has a chance to scramble
          // the order if the lock weren't enforcing it.
          await Promise.resolve();
          order.push(index);
        }),
      );
    }
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
