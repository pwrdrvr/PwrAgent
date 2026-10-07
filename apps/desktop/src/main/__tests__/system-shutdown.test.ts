import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchSystemShutdown } from "../system-shutdown";

const mocks = vi.hoisted(() => ({
  app: { quit: vi.fn(), exit: vi.fn(), on: vi.fn() },
  powerMonitor: { on: vi.fn() },
  log: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("electron", () => ({ app: mocks.app, powerMonitor: mocks.powerMonitor }));
vi.mock("../log", () => ({ getMainLogger: () => mocks.log }));

let shutdown: ((event?: { preventDefault(): void }) => void) | undefined;
let didQuit: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  shutdown = undefined;
  didQuit = undefined;
  mocks.powerMonitor.on.mockImplementation((_name, handler) => { shutdown = handler; });
  mocks.app.on.mockImplementation((_name, handler) => { didQuit = handler; });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("system shutdown", () => {
  it.each(["linux", "darwin"] as const)(
    "holds %s shutdown before cleanup and cancels fallback after normal quit",
    (platform) => {
      const preventDefault = vi.fn();
      const prepareQuit = vi.fn(() => {
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(mocks.app.quit).not.toHaveBeenCalled();
      });
      watchSystemShutdown(prepareQuit, platform);
      expect(mocks.powerMonitor.on).toHaveBeenCalledWith("shutdown", expect.any(Function));
      mocks.app.quit.mockImplementation(() => { didQuit?.(); });

      shutdown?.({ preventDefault });
      expect(prepareQuit).toHaveBeenCalledOnce();
      expect(mocks.app.quit).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(mocks.app.exit).not.toHaveBeenCalled();
      expect(mocks.log.warn).not.toHaveBeenCalled();
    },
  );

  it("forces exit at three seconds when cleanup stalls", () => {
    watchSystemShutdown(vi.fn(), "linux");
    shutdown?.({ preventDefault: vi.fn() });
    vi.advanceTimersByTime(2_999);
    expect(mocks.app.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.stringContaining("3000 ms"));
  });

  it("holds repeated notifications without restarting cleanup or the deadline", () => {
    const prepareQuit = vi.fn();
    watchSystemShutdown(prepareQuit, "linux");
    const preventDefault = vi.fn();
    shutdown?.({ preventDefault });
    vi.advanceTimersByTime(2_000);
    shutdown?.({ preventDefault });
    vi.advanceTimersByTime(1_000);

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(prepareQuit).toHaveBeenCalledOnce();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("cancels fallback when deferred cleanup completes before the deadline", () => {
    watchSystemShutdown(vi.fn(), "linux");
    shutdown?.({ preventDefault: vi.fn() });
    vi.advanceTimersByTime(2_500);
    didQuit?.();
    vi.advanceTimersByTime(2_500);
    expect(mocks.app.exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolerates an omitted event in simulated notifications", () => {
    watchSystemShutdown(vi.fn(), "linux");
    expect(() => shutdown?.()).not.toThrow();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    didQuit?.();
  });

  it("does not register the Linux/macOS notification on Windows", () => {
    watchSystemShutdown(vi.fn(), "win32");
    expect(mocks.powerMonitor.on).not.toHaveBeenCalled();
    expect(mocks.app.on).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
