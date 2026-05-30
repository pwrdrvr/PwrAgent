import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from "electron";

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
const shellOpenExternalMock = vi.fn();
const clipboardWriteTextMock = vi.fn();
const addWordToSpellCheckerDictionaryMock = vi.fn();
const replaceMisspellingMock = vi.fn();
const menuPopupMock = vi.fn();
const buildFromTemplateMock = vi.fn((template: MenuItemConstructorOptions[]) => ({
  popup: menuPopupMock,
  template,
}));
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
const electronLogHooksMock: unknown[] = [];
const electronLogScopeMock = Object.assign(
  vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
  { labelPadding: true },
);

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
          pwragentKeys: [],
          locationHref: "http://127.0.0.1:5173"
        })
      ),
      replaceMisspelling: replaceMisspellingMock,
      session: {
        addWordToSpellCheckerDictionary: addWordToSpellCheckerDictionaryMock,
      },
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
  clipboard: {
    writeText: clipboardWriteTextMock
  },
  Menu: {
    buildFromTemplate: buildFromTemplateMock
  },
  shell: {
    openExternal: shellOpenExternalMock
  }
}));

vi.mock("electron-log/main.js", () => ({
  default: {
    hooks: electronLogHooksMock,
    initialize: vi.fn(),
    scope: electronLogScopeMock,
  },
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
    shellOpenExternalMock.mockReset();
    clipboardWriteTextMock.mockReset();
    addWordToSpellCheckerDictionaryMock.mockReset();
    replaceMisspellingMock.mockReset();
    menuPopupMock.mockReset();
    buildFromTemplateMock.mockClear();
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

  it("registers the main window for messaging push-event channels", async () => {
    const { createMainWindow } = await import("../window");
    const { debugListRegisteredWindows } = await import("../window-channels");
    const {
      AGENT_EVENT_CHANNEL,
      MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL,
      MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL,
      MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
    } = await import("../../shared/ipc");

    createMainWindow();

    expect(debugListRegisteredWindows()).toEqual([
      {
        kind: "main",
        channels: expect.arrayContaining([
          AGENT_EVENT_CHANNEL,
          MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL,
          MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL,
          MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
        ]),
      },
    ]);
  });

  it("only opens safe external URLs requested by the renderer", async () => {
    const { createMainWindow } = await import("../window");
    createMainWindow();

    const openHandler = browserWindowState.setWindowOpenHandler?.mock.calls[0]?.[0];
    expect(openHandler).toBeDefined();

    expect(openHandler({ url: "https://github.com/pwrdrvr/PwrAgent" })).toEqual({
      action: "deny",
    });
    expect(openHandler({ url: "mailto:team@example.com" })).toEqual({
      action: "deny",
    });
    expect(openHandler({ url: "file:///tmp/example.md" })).toEqual({
      action: "deny",
    });
    expect(openHandler({ url: "http://localhost:5173/status" })).toEqual({
      action: "deny",
    });
    expect(openHandler({ url: "http://127.0.0.1:5173/status" })).toEqual({
      action: "deny",
    });

    expect(shellOpenExternalMock).toHaveBeenCalledTimes(5);
    expect(shellOpenExternalMock).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrAgent"
    );
    expect(shellOpenExternalMock).toHaveBeenCalledWith("mailto:team@example.com");
    expect(shellOpenExternalMock).toHaveBeenCalledWith("file:///tmp/example.md");
    expect(shellOpenExternalMock).toHaveBeenCalledWith(
      "http://localhost:5173/status"
    );
    expect(shellOpenExternalMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5173/status"
    );
  });

  it("blocks unsafe external URLs requested by the renderer", async () => {
    const { createMainWindow } = await import("../window");
    createMainWindow();

    const openHandler = browserWindowState.setWindowOpenHandler?.mock.calls[0]?.[0];
    expect(openHandler).toBeDefined();

    expect(openHandler({ url: "http://example.com" })).toEqual({ action: "deny" });
    expect(openHandler({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(openHandler({ url: "pwragent-test://payload" })).toEqual({
      action: "deny",
    });
    expect(openHandler({ url: "docs/plans/example.md" })).toEqual({
      action: "deny",
    });

    expect(shellOpenExternalMock).not.toHaveBeenCalled();
  });

  it("shows a native copy action when a renderer link is right-clicked", async () => {
    const { createMainWindow } = await import("../window");
    createMainWindow();

    emitWebContentsEvent(
      "context-menu",
      {},
      {
        linkURL: "file:///Users/huntharo/project/AGENTS.md:12",
        x: 40,
        y: 64,
      }
    );

    expect(buildFromTemplateMock).toHaveBeenCalledWith([
      expect.objectContaining({
        label: "Copy Link",
        click: expect.any(Function),
      }),
    ]);
    expect(menuPopupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 40,
        y: 64,
      })
    );

    const copyMenuItem = buildFromTemplateMock.mock.calls[0]?.[0]?.[0];
    const click = copyMenuItem?.click as (() => void) | undefined;
    click?.();

    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      "file:///Users/huntharo/project/AGENTS.md:12"
    );
  });

  it("shows native spelling suggestions when editable text is right-clicked", async () => {
    const { createMainWindow } = await import("../window");
    createMainWindow();

    emitWebContentsEvent(
      "context-menu",
      {},
      {
        dictionarySuggestions: ["superseded", "supersede"],
        editFlags: {
          canCopy: true,
          canCut: true,
          canDelete: true,
          canEditRichly: true,
          canPaste: true,
          canRedo: false,
          canSelectAll: true,
          canUndo: true,
        },
        isEditable: true,
        misspelledWord: "superseeded",
        x: 40,
        y: 64,
      }
    );

    const template = buildFromTemplateMock.mock.calls[0]?.[0];
    expect(template).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "superseded",
          click: expect.any(Function),
        }),
        expect.objectContaining({
          label: "supersede",
          click: expect.any(Function),
        }),
        expect.objectContaining({
          label: 'Add "superseeded" to Dictionary',
          click: expect.any(Function),
        }),
        expect.objectContaining({ role: "paste" }),
      ])
    );
    expect(menuPopupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 40,
        y: 64,
      })
    );

    const suggestionItem = template?.find(
      (item) => item.label === "superseded"
    );
    const suggestionClick = suggestionItem?.click as (() => void) | undefined;
    suggestionClick?.();

    expect(replaceMisspellingMock).toHaveBeenCalledWith("superseded");

    const dictionaryItem = template?.find(
      (item) => item.label === 'Add "superseeded" to Dictionary'
    );
    const dictionaryClick = dictionaryItem?.click as (() => void) | undefined;
    dictionaryClick?.();

    expect(addWordToSpellCheckerDictionaryMock).toHaveBeenCalledWith(
      "superseeded"
    );
  });

  it("falls back to the built renderer index in packaged mode", async () => {
    const { createMainWindow } = await import("../window");
    createMainWindow();

    expect(browserWindowState.loadFile).toHaveBeenCalledWith(
      expect.stringContaining("renderer/index.html")
    );
  });

  it("attaches startup CPU profiling before the first renderer navigation", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5173";
    const startupCpuProfiler = {
      attachWindow: vi.fn(() => {
        expect(browserWindowState.loadURL).not.toHaveBeenCalled();
        expect(browserWindowState.loadFile).not.toHaveBeenCalled();
      }),
    };

    const { createMainWindow } = await import("../window");
    createMainWindow({
      startupCpuProfiler,
    });

    expect(startupCpuProfiler.attachWindow).toHaveBeenCalledTimes(1);
    expect(browserWindowState.loadURL).toHaveBeenCalledWith("http://127.0.0.1:5173");
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
