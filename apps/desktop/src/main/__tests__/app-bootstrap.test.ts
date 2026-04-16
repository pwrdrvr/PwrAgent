import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindowConstructorOptions } from "electron";

const browserWindowState: {
  options?: BrowserWindowConstructorOptions;
  loadFile?: ReturnType<typeof vi.fn>;
  loadURL?: ReturnType<typeof vi.fn>;
  on?: ReturnType<typeof vi.fn>;
  send?: ReturnType<typeof vi.fn>;
  setWindowOpenHandler?: ReturnType<typeof vi.fn>;
  show?: ReturnType<typeof vi.fn>;
} = {};

const BrowserWindowMock = vi.fn(function BrowserWindow(
  this: unknown,
  options: BrowserWindowConstructorOptions
) {
  browserWindowState.options = options;
  browserWindowState.loadFile = vi.fn();
  browserWindowState.loadURL = vi.fn();
  browserWindowState.on = vi.fn();
  browserWindowState.send = vi.fn();
  browserWindowState.setWindowOpenHandler = vi.fn();
  browserWindowState.show = vi.fn();

  return {
    loadFile: browserWindowState.loadFile,
    loadURL: browserWindowState.loadURL,
    on: browserWindowState.on,
    once: (_event: string, handler: () => void) => handler(),
    show: browserWindowState.show,
    webContents: {
      send: browserWindowState.send,
      setWindowOpenHandler: browserWindowState.setWindowOpenHandler
    }
  };
});

vi.mock("electron", () => ({
  BrowserWindow: BrowserWindowMock,
  shell: {
    openExternal: vi.fn()
  }
}));

describe("createMainWindow", () => {
  beforeEach(() => {
    vi.resetModules();
    BrowserWindowMock.mockClear();
    delete process.env.ELECTRON_RENDERER_URL;
  });

  afterEach(() => {
    delete process.env.ELECTRON_RENDERER_URL;
  });

  it("creates a BrowserWindow with a preload script and loads the dev renderer URL", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5173";

    const { createMainWindow } = await import("../window");
    createMainWindow();

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    expect(browserWindowState.options?.webPreferences?.preload).toContain(
      "preload/index.cjs"
    );
    expect(browserWindowState.options?.webPreferences?.contextIsolation).toBe(
      true
    );
    expect(browserWindowState.options?.webPreferences?.sandbox).toBe(true);
    expect(browserWindowState.loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:5173"
    );
    expect(browserWindowState.show).toHaveBeenCalledTimes(1);
    expect(browserWindowState.setWindowOpenHandler).toHaveBeenCalledTimes(1);
  });

  it("falls back to the built renderer index in packaged mode", async () => {
    const { createMainWindow } = await import("../window");
    createMainWindow();

    expect(browserWindowState.loadFile).toHaveBeenCalledWith(
      expect.stringContaining("renderer/index.html")
    );
  });
});
