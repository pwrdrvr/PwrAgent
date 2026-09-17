import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameCoalescer } from "../frame-coalescer";

/**
 * jsdom's own `requestAnimationFrame` runs on a timer, which would make every
 * assertion here a wait. A hand-driven queue makes "the frame has not run
 * yet" a state the test can sit in and inspect.
 */
let queued: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let canceled: number[];

function runQueuedFrames(): void {
  const running = [...queued.entries()];
  queued.clear();
  for (const [, callback] of running) {
    callback(performance.now());
  }
}

beforeEach(() => {
  queued = new Map();
  nextFrameId = 0;
  canceled = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    queued.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    canceled.push(handle);
    queued.delete(handle);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createFrameCoalescer", () => {
  it("defers the work to the next frame instead of running it inline", () => {
    const run = vi.fn();
    const coalescer = createFrameCoalescer(run);

    coalescer.schedule();
    expect(run).not.toHaveBeenCalled();

    runQueuedFrames();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("drops requests that arrive while a frame is queued", () => {
    const run = vi.fn();
    const coalescer = createFrameCoalescer(run);

    coalescer.schedule();
    coalescer.schedule();
    coalescer.schedule();

    expect(queued.size).toBe(1);
    runQueuedFrames();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs the work against the values it reads at frame time", () => {
    // The drag call sites depend on this: the dropped requests are not lost
    // work, because the one queued frame reads whatever the last of them left
    // behind.
    let travel = 0;
    const painted: number[] = [];
    const coalescer = createFrameCoalescer(() => painted.push(travel));

    travel = 1;
    coalescer.schedule();
    travel = 2;
    coalescer.schedule();
    travel = 3;
    coalescer.schedule();
    runQueuedFrames();

    expect(painted).toEqual([3]);
  });

  it("queues a new frame once the previous one has run", () => {
    const run = vi.fn();
    const coalescer = createFrameCoalescer(run);

    coalescer.schedule();
    runQueuedFrames();
    coalescer.schedule();
    runQueuedFrames();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("lets the work schedule itself again from inside its own frame", () => {
    // The pending handle is cleared before the work runs, so a self-driving
    // caller is not mistaken for a duplicate request.
    let remaining = 2;
    const run = vi.fn(() => {
      remaining -= 1;
      if (remaining > 0) coalescer.schedule();
    });
    const coalescer = createFrameCoalescer(run);

    coalescer.schedule();
    runQueuedFrames();
    expect(run).toHaveBeenCalledTimes(1);

    runQueuedFrames();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued frame so the work never runs", () => {
    const run = vi.fn();
    const coalescer = createFrameCoalescer(run);

    coalescer.schedule();
    coalescer.cancel();
    runQueuedFrames();

    expect(canceled).toEqual([1]);
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores a cancel with nothing queued", () => {
    const run = vi.fn();
    const coalescer = createFrameCoalescer(run);

    coalescer.cancel();
    coalescer.schedule();
    runQueuedFrames();
    coalescer.cancel();

    expect(canceled).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stays usable after a cancel", () => {
    // A pointer gesture that stops and starts again reuses its coalescer.
    const run = vi.fn();
    const coalescer = createFrameCoalescer(run);

    coalescer.schedule();
    coalescer.cancel();
    coalescer.schedule();
    runQueuedFrames();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps separate coalescers independent", () => {
    const first = vi.fn();
    const second = vi.fn();
    const firstCoalescer = createFrameCoalescer(first);
    const secondCoalescer = createFrameCoalescer(second);

    firstCoalescer.schedule();
    secondCoalescer.schedule();
    firstCoalescer.cancel();
    runQueuedFrames();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
