import { describe, expect, it, vi } from "vitest";
import { createShutdownBarrier } from "../shutdown-barrier";

describe("createShutdownBarrier", () => {
  it("is idempotent and bounds phases by their deadlines", async () => {
    vi.useFakeTimers();
    try {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const observer = {
        phaseStarted: vi.fn(),
        phaseFinished: vi.fn(),
      };
      const secondPhase = vi.fn(async () => undefined);
      const runShutdown = createShutdownBarrier({
        globalTimeoutMs: 100,
        logger,
        observer,
        phases: [
          {
            name: "resistant",
            timeoutMs: 40,
            run: () => new Promise<void>(() => undefined),
          },
          {
            name: "cleanup",
            timeoutMs: 40,
            run: secondPhase,
          },
        ],
      });

      const first = runShutdown("test");
      const second = runShutdown("ignored-repeat");
      expect(second).toBe(first);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(40);
      await expect(first).resolves.toMatchObject({
        source: "test",
        outcomes: [
          { name: "resistant", outcome: "timed-out" },
          { name: "cleanup", outcome: "completed" },
        ],
      });
      expect(secondPhase).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        "shutdown phase timed-out",
        expect.objectContaining({ phase: "resistant", timeoutMs: 40 }),
      );
      expect(observer.phaseStarted.mock.calls).toEqual([
        ["resistant"],
        ["cleanup"],
      ]);
      expect(observer.phaseFinished.mock.calls).toEqual([
        [expect.objectContaining({ name: "resistant", outcome: "timed-out" })],
        [expect.objectContaining({ name: "cleanup", outcome: "completed" })],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the referenced deadline on early completion even if logging throws", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const logger = {
      info: () => { throw new Error("logging failed"); },
      warn: () => { throw new Error("logging failed"); },
    };
    let finish!: () => void;
    const run = createShutdownBarrier({
      globalTimeoutMs: 10_000,
      logger,
      phases: [{ name: "capture", timeoutMs: 10_000, run: () => new Promise<void>((resolve) => { finish = resolve; }) }],
    });
    try {
      const pending = run("quit");
      const timer = timers.mock.results[0].value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(true);
      expect(run("repeat")).toBe(pending);
      await Promise.resolve();
      finish();
      await expect(pending).resolves.toMatchObject({ outcomes: [{ outcome: "completed" }] });
      expect(clear).toHaveBeenCalledWith(timer);
    } finally {
      timers.mockRestore();
      clear.mockRestore();
    }
  });

  it("caps a phase at the remaining global deadline", async () => {
    vi.useFakeTimers();
    try {
      const runShutdown = createShutdownBarrier({
        globalTimeoutMs: 30,
        logger: { info: vi.fn(), warn: vi.fn() },
        phases: [
          {
            name: "hung",
            timeoutMs: 100,
            run: () => new Promise<void>(() => undefined),
          },
          {
            name: "too-late",
            timeoutMs: 100,
            run: vi.fn(),
          },
        ],
      });

      const shutdown = runShutdown("global-deadline");
      await vi.advanceTimersByTimeAsync(30);

      await expect(shutdown).resolves.toMatchObject({
        durationMs: 30,
        outcomes: [
          { name: "hung", outcome: "timed-out" },
          { name: "too-late", outcome: "skipped" },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
