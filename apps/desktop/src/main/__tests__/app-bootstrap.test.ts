import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindowConstructorOptions } from "electron";

const browserWindowState: {
  options?: BrowserWindowConstructorOptions;
  loadFile?: ReturnType<typeof vi.fn>;
  loadURL?: ReturnType<typeof vi.fn>;
  on?: ReturnType<typeof vi.fn>;
  once?: ReturnType<typeof vi.fn>;
  send?: ReturnType<typeof vi.fn>;
  webContentsOn?: ReturnType<typeof vi.fn>;
  webContentsOnce?: ReturnType<typeof vi.fn>;
  setWindowOpenHandler?: ReturnType<typeof vi.fn>;
  show?: ReturnType<typeof vi.fn>;
} = {};

const windowEventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
const webContentsEventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
const webContentsOnceHandlers = new Map<string, (...args: unknown[]) => void>();

const resolveHeapMonitorConfigMock = vi.fn<
  (...args: unknown[]) => { enabled: boolean; [key: string]: unknown }
>(() => ({ enabled: false }));
const createHeapSessionMock = vi.fn();
const rendererMonitorStartMock = vi.fn();
const rendererMonitorStopMock = vi.fn();
const mainMonitorStartMock = vi.fn();
const mainMonitorStopMock = vi.fn();
const RendererHeapMonitorMock = vi.fn(function RendererHeapMonitor(this: unknown) {
  return {
    start: rendererMonitorStartMock,
    stop: rendererMonitorStopMock,
  };
});
const MainProcessHeapMonitorMock = vi.fn(function MainProcessHeapMonitor(this: unknown) {
  return {
    start: mainMonitorStartMock,
    stop: mainMonitorStopMock,
  };
});

function emitWindowEvent(event: string, ...args: unknown[]) {
  for (const handler of windowEventHandlers.get(event) ?? []) {
    handler(...args);
  }
}

function emitWebContentsEvent(event: string, ...args: unknown[]) {
  for (const handler of webContentsEventHandlers.get(event) ?? []) {
    handler(...args);
  }

  const onceHandler = webContentsOnceHandlers.get(event);
  if (onceHandler) {
    webContentsOnceHandlers.delete(event);
    onceHandler(...args);
  }
}

const BrowserWindowMock = vi.fn(function BrowserWindow(
  this: unknown,
  options: BrowserWindowConstructorOptions
) {
  browserWindowState.options = options;
  browserWindowState.loadFile = vi.fn();
  browserWindowState.loadURL = vi.fn();
  browserWindowState.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = windowEventHandlers.get(event) ?? [];
    handlers.push(handler);
    windowEventHandlers.set(event, handlers);
  });
  browserWindowState.once = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === "ready-to-show") {
      handler();
      return;
    }

    const handlers = windowEventHandlers.get(event) ?? [];
    handlers.push(handler);
    windowEventHandlers.set(event, handlers);
  });
  browserWindowState.send = vi.fn();
  browserWindowState.webContentsOn = vi.fn(
    (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = webContentsEventHandlers.get(event) ?? [];
      handlers.push(handler);
      webContentsEventHandlers.set(event, handlers);
    }
  );
  browserWindowState.webContentsOnce = vi.fn(
    (event: string, handler: (...args: unknown[]) => void) => {
      webContentsOnceHandlers.set(event, handler);
    }
  );
  browserWindowState.setWindowOpenHandler = vi.fn();
  browserWindowState.show = vi.fn();

  return {
    loadFile: browserWindowState.loadFile,
    loadURL: browserWindowState.loadURL,
    on: browserWindowState.on,
    once: browserWindowState.once,
    show: browserWindowState.show,
    webContents: {
      send: browserWindowState.send,
      on: browserWindowState.webContentsOn,
      once: browserWindowState.webContentsOnce,
      executeJavaScript: vi.fn(() =>
        Promise.resolve({
          hasPwragnt: true,
          pwragntKeys: [],
          locationHref: "http://127.0.0.1:5173"
        })
      ),
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        isAttached: vi.fn(() => false),
        sendCommand: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      },
      takeHeapSnapshot: vi.fn(),
      setWindowOpenHandler: browserWindowState.setWindowOpenHandler
    }
  };
});

vi.mock("electron", () => ({
  BrowserWindow: BrowserWindowMock,
  app: {
    getAppPath: vi.fn(() => "/repo/apps/desktop"),
    getVersion: vi.fn(() => "0.1.0")
  },
  shell: {
    openExternal: vi.fn()
  }
}));

vi.mock("../diagnostics/heap-monitor-config", () => ({
  resolveHeapMonitorConfig: resolveHeapMonitorConfigMock
}));

vi.mock("../diagnostics/heap-session", () => ({
  createHeapSession: createHeapSessionMock
}));

vi.mock("../diagnostics/renderer-heap-monitor", () => ({
  RendererHeapMonitor: RendererHeapMonitorMock
}));

vi.mock("../diagnostics/main-process-heap-monitor", () => ({
  MainProcessHeapMonitor: MainProcessHeapMonitorMock
}));

describe("createMainWindow", () => {
  beforeEach(() => {
    vi.resetModules();
    BrowserWindowMock.mockClear();
    resolveHeapMonitorConfigMock.mockReset();
    resolveHeapMonitorConfigMock.mockReturnValue({ enabled: false });
    createHeapSessionMock.mockReset();
    rendererMonitorStartMock.mockReset();
    rendererMonitorStopMock.mockReset();
    mainMonitorStartMock.mockReset();
    mainMonitorStopMock.mockReset();
    RendererHeapMonitorMock.mockClear();
    MainProcessHeapMonitorMock.mockClear();
    windowEventHandlers.clear();
    webContentsEventHandlers.clear();
    webContentsOnceHandlers.clear();
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

  it("starts and stops heap diagnostics when enabled", async () => {
    resolveHeapMonitorConfigMock.mockReturnValue({
      enabled: true,
      repoRoot: "/repo",
      outputRoot: "/repo/.local",
      intervalMs: 5000,
      settleDelayMs: 10000,
      deltaThresholdBytes: 100 * 1024 * 1024,
      snapshotCooldownMs: 60000,
      maxSnapshots: 5
    });
    createHeapSessionMock.mockResolvedValue({
      ok: true,
      session: {
        id: "abc123",
        directoryName: "heap-2026-04-18-1702-abc123",
        directoryPath: "/repo/.local/heap-2026-04-18-1702-abc123",
        samplesPath: "/repo/.local/heap-2026-04-18-1702-abc123/samples.ndjson",
        eventsPath: "/repo/.local/heap-2026-04-18-1702-abc123/events.ndjson",
        appendSample: vi.fn(),
        appendEvent: vi.fn(),
        registerSnapshotFile: vi.fn()
      }
    });

    const { createMainWindow } = await import("../window");
    createMainWindow();

    emitWebContentsEvent("did-finish-load");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createHeapSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          enabled: true,
          outputRoot: "/repo/.local"
        }),
        versions: expect.objectContaining({
          appVersion: "0.1.0"
        })
      })
    );
    expect(MainProcessHeapMonitorMock).toHaveBeenCalledTimes(1);
    expect(RendererHeapMonitorMock).toHaveBeenCalledTimes(1);
    expect(mainMonitorStartMock).toHaveBeenCalledTimes(1);
    expect(rendererMonitorStartMock).toHaveBeenCalledTimes(1);

    emitWebContentsEvent("render-process-gone", {}, { reason: "oom" });
    await Promise.resolve();
    await Promise.resolve();

    expect(rendererMonitorStopMock).toHaveBeenCalledWith("render-process-gone");
    expect(mainMonitorStopMock).toHaveBeenCalledWith("render-process-gone");

    emitWindowEvent("closed");
    await Promise.resolve();
    await Promise.resolve();

    expect(rendererMonitorStopMock).toHaveBeenCalledWith("window-closed");
    expect(mainMonitorStopMock).toHaveBeenCalledWith("window-closed");
  });
});
