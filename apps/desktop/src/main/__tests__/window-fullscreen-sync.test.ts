import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { WINDOW_FULLSCREEN_SYNC_CHANNEL } from "../../shared/ipc";
import { attachWindowFullscreenSync } from "../window-fullscreen-sync";

type FakeWindow = BrowserWindow & {
  emitWindowEvent: (event: string) => void;
  emitWebContentsEvent: (event: string) => void;
  sendMock: ReturnType<typeof vi.fn>;
  setDestroyed: (value: boolean) => void;
  setFullScreen: (value: boolean) => void;
};

function createWindow(initialFullScreen = false): FakeWindow {
  const windowListeners = new Map<string, Array<() => void>>();
  const webContentsListeners = new Map<string, Array<() => void>>();
  let destroyed = false;
  let fullScreen = initialFullScreen;
  const sendMock = vi.fn();

  const window = {
    emitWindowEvent: (event: string) => {
      for (const listener of windowListeners.get(event) ?? []) listener();
    },
    emitWebContentsEvent: (event: string) => {
      for (const listener of webContentsListeners.get(event) ?? []) listener();
    },
    sendMock,
    setDestroyed: (value: boolean) => {
      destroyed = value;
    },
    setFullScreen: (value: boolean) => {
      fullScreen = value;
    },
    on: vi.fn((event: string, listener: () => void) => {
      windowListeners.set(event, [
        ...(windowListeners.get(event) ?? []),
        listener,
      ]);
    }),
    isDestroyed: vi.fn(() => destroyed),
    isFullScreen: vi.fn(() => fullScreen),
    webContents: {
      send: sendMock,
      on: vi.fn((event: string, listener: () => void) => {
        webContentsListeners.set(event, [
          ...(webContentsListeners.get(event) ?? []),
          listener,
        ]);
      }),
    },
  };

  return window as unknown as FakeWindow;
}

describe("window fullscreen sync", () => {
  it("pushes fullscreen=true on enter-full-screen", () => {
    const window = createWindow();
    attachWindowFullscreenSync(window);

    window.emitWindowEvent("enter-full-screen");

    expect(window.sendMock).toHaveBeenCalledWith(
      WINDOW_FULLSCREEN_SYNC_CHANNEL,
      {
        isFullScreen: true,
      },
    );
  });

  it("pushes fullscreen=false on leave-full-screen", () => {
    const window = createWindow(true);
    attachWindowFullscreenSync(window);

    window.emitWindowEvent("leave-full-screen");

    expect(window.sendMock).toHaveBeenCalledWith(
      WINDOW_FULLSCREEN_SYNC_CHANNEL,
      {
        isFullScreen: false,
      },
    );
  });

  it("re-emits the live fullscreen state on every renderer load", () => {
    // Covers the dev-HMR / crash-reload case: the BrowserWindow stays
    // fullscreen across a renderer remount, so did-finish-load must report
    // the CURRENT state rather than the non-fullscreen creation default.
    const window = createWindow(true);
    attachWindowFullscreenSync(window);

    window.emitWebContentsEvent("did-finish-load");
    expect(window.sendMock).toHaveBeenLastCalledWith(
      WINDOW_FULLSCREEN_SYNC_CHANNEL,
      { isFullScreen: true },
    );

    window.setFullScreen(false);
    window.emitWebContentsEvent("did-finish-load");
    expect(window.sendMock).toHaveBeenLastCalledWith(
      WINDOW_FULLSCREEN_SYNC_CHANNEL,
      { isFullScreen: false },
    );
  });

  it("does not push to a destroyed window", () => {
    const window = createWindow();
    attachWindowFullscreenSync(window);

    window.setDestroyed(true);
    window.emitWindowEvent("enter-full-screen");

    expect(window.sendMock).not.toHaveBeenCalled();
  });

  it("no-ops for a window without an event emitter", () => {
    const window = { on: undefined } as unknown as BrowserWindow;

    expect(() => attachWindowFullscreenSync(window)).not.toThrow();
  });
});
