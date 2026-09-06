import { describe, expect, it, vi } from "vitest";
import { SharedHotCpuProfiler } from "../diagnostics/shared-hot-cpu-profiler";

function monitor() {
  return { start: vi.fn(async () => {}), stop: vi.fn(async (_reason: string) => {}) };
}

describe("SharedHotCpuProfiler", () => {
  it("shares one main monitor and stops only when its last window closes", async () => {
    const shared = new SharedHotCpuProfiler();
    const profiler = monitor();
    const create = vi.fn(async () => profiler);
    const first = Symbol();
    const second = Symbol();
    await Promise.all([
      shared.acquire(first, { key: "enabled", create }),
      shared.acquire(second, { key: "enabled", create }),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(profiler.start).toHaveBeenCalledTimes(1);
    await shared.release(first, "window-closed");
    expect(profiler.stop).not.toHaveBeenCalled();
    await shared.release(second, "window-closed");
    expect(profiler.stop).toHaveBeenCalledExactlyOnceWith("window-closed");
  });

  it("waits for an old capture to stop before starting changed settings", async () => {
    const shared = new SharedHotCpuProfiler();
    const old = monitor();
    const next = monitor();
    let finishStop!: () => void;
    const stopping = new Promise<void>((resolve) => { finishStop = resolve; });
    let signalStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => { signalStop = resolve; });
    old.stop.mockImplementation(async () => { signalStop(); await stopping; });
    const owner = Symbol();
    await shared.acquire(owner, { key: "old", create: async () => old });
    const changed = shared.acquire(owner, { key: "new", create: async () => next });
    await stopEntered;
    expect(next.start).not.toHaveBeenCalled();
    const closing = shared.release(owner, "window-closed");
    finishStop();
    await Promise.all([changed, closing]);
    expect(next.start).toHaveBeenCalledTimes(1);
    expect(next.stop).toHaveBeenCalledExactlyOnceWith("window-closed");
  });

  it("cleans up a failed start and allows a subsequent capture", async () => {
    const shared = new SharedHotCpuProfiler();
    const failed = monitor();
    failed.start.mockRejectedValueOnce(new Error("inspector unavailable"));
    const owner = Symbol();
    await expect(shared.acquire(owner, {
      key: "enabled", create: async () => failed,
    })).rejects.toThrow("inspector unavailable");
    expect(failed.stop).toHaveBeenCalledExactlyOnceWith("start-failed");
    const next = monitor();
    await shared.acquire(owner, { key: "enabled", create: async () => next });
    expect(next.start).toHaveBeenCalledTimes(1);
    await shared.release(owner, "test-cleanup");
  });
});
