import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const originalPlatform = process.platform;

type TestBrowserWindow = BrowserWindow & {
  emitWebContentsEvent: (event: string) => void;
  emitWindowEvent: (event: string) => void;
};

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function createWindow(): TestBrowserWindow {
  const windowListeners = new Map<string, Array<() => void>>();
  const webContentsListeners = new Map<string, Array<() => void>>();
  const window = {
    emitWebContentsEvent: (event: string) => {
      for (const listener of webContentsListeners.get(event) ?? []) {
        listener();
      }
    },
    emitWindowEvent: (event: string) => {
      for (const listener of windowListeners.get(event) ?? []) {
        listener();
      }
    },
    id: 41,
    focus: vi.fn(),
    isAlwaysOnTop: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    moveTop: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => {
      windowListeners.set(event, [
        ...(windowListeners.get(event) ?? []),
        listener,
      ]);
    }),
    restore: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    show: vi.fn(),
    webContents: {
      once: vi.fn((event: string, listener: () => void) => {
        webContentsListeners.set(event, [
          ...(webContentsListeners.get(event) ?? []),
          listener,
        ]);
      }),
    },
  };

  return window as unknown as TestBrowserWindow;
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

  it("shows first-open windows on ready-to-show", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    const { showAuxiliaryWindowWhenReady } = await import(
      "../auxiliary-window-chrome"
    );
    const window = createWindow();

    showAuxiliaryWindowWhenReady(window);

    expect(window.show).not.toHaveBeenCalled();
    window.emitWindowEvent("ready-to-show");

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("does not refocus when load finishes after ready-to-show already showed the window", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    const { showAuxiliaryWindowWhenReady } = await import(
      "../auxiliary-window-chrome"
    );
    const window = createWindow();

    showAuxiliaryWindowWhenReady(window);
    window.emitWindowEvent("ready-to-show");
    window.emitWebContentsEvent("did-finish-load");
    vi.advanceTimersByTime(100);

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("shows first-open windows after load if ready-to-show is late", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    const { showAuxiliaryWindowWhenReady } = await import(
      "../auxiliary-window-chrome"
    );
    const window = createWindow();

    showAuxiliaryWindowWhenReady(window);
    window.emitWebContentsEvent("did-finish-load");
    vi.advanceTimersByTime(100);

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("does not refocus from the fallback after load already showed the window", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    const { showAuxiliaryWindowWhenReady } = await import(
      "../auxiliary-window-chrome"
    );
    const window = createWindow();

    showAuxiliaryWindowWhenReady(window);
    window.emitWebContentsEvent("did-finish-load");
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(900);

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("shows first-open windows from a timed fallback", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    const { showAuxiliaryWindowWhenReady } = await import(
      "../auxiliary-window-chrome"
    );
    const window = createWindow();

    showAuxiliaryWindowWhenReady(window);
    vi.advanceTimersByTime(999);

    expect(window.show).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });
});
