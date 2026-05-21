import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function createWindow(): BrowserWindow {
  const listeners = new Map<string, Array<() => void>>();
  const window = {
    id: 41,
    focus: vi.fn(),
    isAlwaysOnTop: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    moveTop: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    restore: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    show: vi.fn(),
  };

  return window as unknown as BrowserWindow;
}

afterEach(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  vi.useRealTimers();
  vi.resetModules();
});

describe("auxiliary window chrome", () => {
  it("retries Linux raises after the window has had time to map", async () => {
    vi.useFakeTimers();
    setPlatform("linux");
    const { showAndFocusAuxiliaryWindow } = await import(
      "../auxiliary-window-chrome"
    );
    const window = createWindow();

    showAndFocusAuxiliaryWindow(window);

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.moveTop).not.toHaveBeenCalled();
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(100);
    expect(window.show).toHaveBeenCalledTimes(2);
    expect(window.focus).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(250);
    expect(window.show).toHaveBeenCalledTimes(3);
    expect(window.focus).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(450);
    expect(window.show).toHaveBeenCalledTimes(4);
    expect(window.focus).toHaveBeenCalledTimes(4);
  });

  it("uses moveTop without delayed retries when the platform supports it", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    const { showAndFocusAuxiliaryWindow } = await import(
      "../auxiliary-window-chrome"
    );
    const window = createWindow();

    showAndFocusAuxiliaryWindow(window);
    vi.runOnlyPendingTimers();

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.moveTop).toHaveBeenCalledTimes(1);
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  });
});
