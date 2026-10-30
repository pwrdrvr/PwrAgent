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
  setTitle?: ReturnType<typeof vi.fn>;
  setWindowOpenHandler?: ReturnType<typeof vi.fn>;
  show?: ReturnType<typeof vi.fn>;
  reload?: ReturnType<typeof vi.fn>;
  // Hold back ready-to-show, as a renderer whose first load stalls does.
  deferReadyToShow?: boolean;
  visible?: boolean;
} = {};

const windowEventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
const webContentsEventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
const webContentsOnceHandlers = new Map<string, (...args: unknown[]) => void>();

const resolveHeapMonitorConfigMock = vi.fn<
  (...args: unknown[]) => { enabled: boolean; [key: string]: unknown }
>(() => ({ enabled: false }));
const createHeapSessionMock = vi.fn();
const resolveHotCpuProfileConfigMock = vi.fn(() => ({ enabled: false }));
const createHotCpuProfileSessionMock = vi.fn();
const hotRendererStart = vi.fn();
const hotRendererStop = vi.fn();
const hotMainStart = vi.fn();
const hotMainStop = vi.fn();
const mainHotTarget = {};
const appBuildMetadata = {
  applicationVersion: "0.1.0",
  buildIdentity: { kind: "packaged" as const },
};
const resolveAppBuildMetadataMock = vi.fn(async () => appBuildMetadata);
vi.mock("../app-build-metadata", () => ({
  // Build identity runs Git in development. These tests own profiler lifecycle,
  // so metadata must not depend on child-process startup on the host.
  resolveAppBuildMetadata: resolveAppBuildMetadataMock,
}));
vi.mock("../diagnostics/hot-cpu-profile-config", () => ({
  resolveHotCpuProfileConfig: resolveHotCpuProfileConfigMock,
}));
vi.mock("../diagnostics/hot-cpu-profile-session", () => ({
  createHotCpuProfileSession: createHotCpuProfileSessionMock,
}));
vi.mock("../diagnostics/main-process-hot-cpu-target", () => ({
  createMainProcessHotCpuTarget: () => mainHotTarget,
}));
vi.mock("../diagnostics/hot-cpu-profiler", () => ({
  HotCpuProfiler: vi.fn(function (options: { target: unknown }) {
    return options.target === mainHotTarget
      ? { start: hotMainStart, stop: hotMainStop }
      : { start: hotRendererStart, stop: hotRendererStop };
  }),
}));
const rendererMonitorStartMock = vi.fn();
const rendererMonitorStopMock = vi.fn();
const mainMonitorStartMock = vi.fn();
const mainMonitorStopMock = vi.fn();
const shellOpenExternalMock = vi.fn();
const clipboardWriteTextMock = vi.fn(async (_text: string) => {});
const addWordToSpellCheckerDictionaryMock = vi.fn();
const replaceMisspellingMock = vi.fn();
const copyImageAtMock = vi.fn();
const menuPopupMock = vi.fn();
const buildFromTemplateMock = vi.fn((template: MenuItemConstructorOptions[]) => ({
  popup: menuPopupMock,
  template,
}));
const getCursorScreenPointMock = vi.fn(() => ({ x: 100, y: 100 }));
const getDisplayNearestPointMock = vi.fn(() => ({
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
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
    if (event === "ready-to-show" && !browserWindowState.deferReadyToShow) {
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
  browserWindowState.setTitle = vi.fn();
  browserWindowState.setWindowOpenHandler = vi.fn();
  browserWindowState.visible = false;
  browserWindowState.show = vi.fn(() => {
    browserWindowState.visible = true;
    emitWindowEvent("show");
  });
  browserWindowState.reload = vi.fn();

  return {
    id: BrowserWindowMock.mock.calls.length,
    isDestroyed: () => false,
    isVisible: () => browserWindowState.visible === true,
    loadFile: browserWindowState.loadFile,
    loadURL: browserWindowState.loadURL,
    on: browserWindowState.on,
    once: browserWindowState.once,
    setTitle: browserWindowState.setTitle,
    show: browserWindowState.show,
    webContents: {
      id: BrowserWindowMock.mock.calls.length,
      isDestroyed: () => false,
      reload: browserWindowState.reload,
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
      copyImageAt: copyImageAtMock,
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
  nativeTheme: {
    shouldUseDarkColors: true,
    on: vi.fn()
  },
  shell: {
    openExternal: shellOpenExternalMock
  },
  screen: {
    getCursorScreenPoint: getCursorScreenPointMock,
    getDisplayNearestPoint: getDisplayNearestPointMock
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

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopConfigStore: () => ({
    read: () => ({ settings: {} }),
    subscribe: () => () => undefined,
  }),
  getDesktopSettingsService: () => ({
    resolveHotCpuProfilingCaptureHeapSnapshot: () => false,
    resolveHotCpuProfilingEnabled: () => false,
    resolveHotCpuProfilingHeapSnapshotLimit: () => 2,
  }),
}));

describe("createMainWindow", () => {
  let stopDiagnostics: typeof import("../window").stopWindowDiagnostics | undefined;
  const releaseDiagnostics: Array<() => void> = [];

  async function loadWindowModule() {
    const windowModule = await import("../window");
    // Capture this module's registry before the next test resets the cache.
    stopDiagnostics = windowModule.stopWindowDiagnostics;
    return windowModule;
  }

  function deferDiagnosticWork<T>(result: T) {
    let release!: () => void;
    const promise = new Promise<T>((resolve) => {
      release = () => resolve(result);
    });
    // Register immediately: an assertion can fail before the test releases it.
    releaseDiagnostics.push(release);
    return { promise, release };
  }

  beforeEach(() => {
    vi.resetModules();
    BrowserWindowMock.mockClear();
    resolveHeapMonitorConfigMock.mockReset();
    resolveHeapMonitorConfigMock.mockReturnValue({ enabled: false });
    createHeapSessionMock.mockReset();
    resolveAppBuildMetadataMock.mockReset().mockResolvedValue(appBuildMetadata);
    resolveHotCpuProfileConfigMock.mockReset().mockReturnValue({ enabled: false });
    createHotCpuProfileSessionMock.mockReset().mockResolvedValue({
      ok: true, session: { directoryPath: "/fixture/hot-cpu" },
    });
    for (const mock of [hotMainStart, hotMainStop, hotRendererStart, hotRendererStop]) {
      mock.mockReset().mockResolvedValue(undefined);
    }
    rendererMonitorStartMock.mockReset();
    rendererMonitorStopMock.mockReset();
    mainMonitorStartMock.mockReset();
    mainMonitorStopMock.mockReset();
    shellOpenExternalMock.mockReset();
    getCursorScreenPointMock.mockClear();
    getCursorScreenPointMock.mockReturnValue({ x: 100, y: 100 });
    getDisplayNearestPointMock.mockClear();
    getDisplayNearestPointMock.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    clipboardWriteTextMock.mockReset();
    addWordToSpellCheckerDictionaryMock.mockReset();
    replaceMisspellingMock.mockReset();
    copyImageAtMock.mockReset();
    menuPopupMock.mockReset();
    buildFromTemplateMock.mockClear();
    RendererHeapMonitorMock.mockClear();
    MainProcessHeapMonitorMock.mockClear();
    windowEventHandlers.clear();
    webContentsEventHandlers.clear();
    webContentsOnceHandlers.clear();
    delete process.env.ELECTRON_RENDERER_URL;
    browserWindowState.deferReadyToShow = false;
  });

  afterEach(async () => {
    try {
      for (const release of releaseDiagnostics.splice(0)) release();
      await stopDiagnostics?.("test-cleanup");
    } finally {
      stopDiagnostics = undefined;
      delete process.env.ELECTRON_RENDERER_URL;
      vi.useRealTimers();
    }
  });

  it("reloads a stalled first load, then shows the window and sends its initial thread", async () => {
    const { MAIN_WINDOW_APPEAR_TIMEOUT_MS } = await import("../main-window-startup-watchdog");
    const { WINDOW_SHOW_THREAD_CHANNEL } = await import("../../shared/ipc");
    const { createMainWindow } = await loadWindowModule();
    vi.useFakeTimers();
    browserWindowState.deferReadyToShow = true;
    const onShown = vi.fn(() => {
      // Federation viewers send queued requests here, so the page must be
      // loaded by the time the window appears.
      expect(browserWindowState.reload).toHaveBeenCalledOnce();
      expect(browserWindowState.send).not.toHaveBeenCalled();
    });
    const initialThread = { backend: "codex" as const, threadId: "thread-1" };
    createMainWindow({ initialThread, onShown });
    emitWebContentsEvent("did-start-loading");

    await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS);
    expect(browserWindowState.reload).toHaveBeenCalledOnce();
    expect(browserWindowState.show).not.toHaveBeenCalled();

    emitWebContentsEvent("did-finish-load");
    expect(onShown).toHaveBeenCalledOnce();
    expect(browserWindowState.show).toHaveBeenCalledOnce();
    expect(browserWindowState.send).toHaveBeenCalledWith(
      WINDOW_SHOW_THREAD_CHANNEL,
      initialThread,
    );

    // A late first paint must not send the initial thread a second time.
    emitWindowEvent("ready-to-show");
    expect(
      browserWindowState.send!.mock.calls.filter(([channel]) => channel === WINDOW_SHOW_THREAD_CHANNEL),
    ).toHaveLength(1);
  });

  it("creates a BrowserWindow with a preload script and loads the dev renderer URL", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5173";

    const { createMainWindow } = await loadWindowModule();
    createMainWindow();

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    expect(browserWindowState.options).toMatchObject({
      x: 240,
      y: 60,
      width: 1440,
      height: 960,
    });
    expect(
      browserWindowState.options?.webPreferences?.preload?.replace(/\\/g, "/")
    ).toContain("preload/index.cjs");
    expect(browserWindowState.options?.webPreferences?.contextIsolation).toBe(
      true
    );
    expect(browserWindowState.options?.webPreferences?.sandbox).toBe(true);
    // The preload removes WebRTC from HTML previews, which are subframes.
    expect(
      browserWindowState.options?.webPreferences?.nodeIntegrationInSubFrames
    ).toBe(true);
    expect(browserWindowState.options?.webPreferences?.nodeIntegration).toBe(
      false
    );
    expect(browserWindowState.loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:5173"
    );
    expect(browserWindowState.show).toHaveBeenCalledTimes(1);
    expect(browserWindowState.setWindowOpenHandler).toHaveBeenCalledTimes(1);
  });

  it("titles the shell window and refuses the renderer's document title", async () => {
    const { createMainWindow } = await loadWindowModule();
    createMainWindow();

    expect(browserWindowState.options?.title).toBe("PwrAgent");
    expect(browserWindowState.setTitle).toHaveBeenCalledWith("PwrAgent");

    // Electron mirrors the loaded page's <title> onto the native window
    // title. index.html shipped a stale "PwrAgnt" that won on load, so
    // the lock has to survive the event, not just the constructor.
    const preventDefault = vi.fn();
    emitWindowEvent("page-title-updated", { preventDefault }, "PwrAgnt");

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(browserWindowState.setTitle).toHaveBeenLastCalledWith("PwrAgent");
    expect(browserWindowState.setTitle).not.toHaveBeenCalledWith("PwrAgnt");
  });

  it("titles a federated window with its peer label", async () => {
    const { createMainWindow } = await loadWindowModule();
    createMainWindow({ federationLabel: "Harold-MBP-2018" });

    expect(browserWindowState.options?.title).toBe(
      "PwrAgent - Harold-MBP-2018"
    );

    emitWindowEvent("page-title-updated", { preventDefault: vi.fn() }, "PwrAgent");

    expect(browserWindowState.setTitle).toHaveBeenLastCalledWith(
      "PwrAgent - Harold-MBP-2018"
    );
  });

  it("keeps the main window and its resize minimums inside the cursor display work area", async () => {
    getDisplayNearestPointMock.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1152, height: 696 },
    });

    const { createMainWindow } = await loadWindowModule();
    createMainWindow();

    expect(browserWindowState.options).toMatchObject({
      x: 0,
      y: 0,
      width: 1152,
      height: 696,
      minWidth: 960,
      minHeight: 640,
    });
  });

  it("registers the main window for messaging push-event channels", async () => {
    const { createMainWindow } = await loadWindowModule();
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
    const { createMainWindow } = await loadWindowModule();
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
    const { createMainWindow } = await loadWindowModule();
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

  it("blocks navigation from an interactive SVG subframe", async () => {
    const { createMainWindow } = await loadWindowModule();
    createMainWindow();

    const preventDefault = vi.fn();
    emitWebContentsEvent("will-frame-navigate", {
      isMainFrame: false,
      url: "https://example.com/collect?data=private",
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();

    preventDefault.mockClear();
    emitWebContentsEvent("will-frame-navigate", {
      isMainFrame: false,
      url: "about:srcdoc",
      preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("hands a blocked HTML preview link back to its window", async () => {
    const { createMainWindow } = await loadWindowModule();
    const { HTML_PREVIEW_FRAME_NAME, HTML_PREVIEW_NAVIGATION_CHANNEL } =
      await import("../../shared/html-preview");
    createMainWindow();

    const preventDefault = vi.fn();
    emitWebContentsEvent("will-frame-navigate", {
      isMainFrame: false,
      url: "https://example.com/next",
      frame: { name: HTML_PREVIEW_FRAME_NAME },
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(browserWindowState.send).toHaveBeenCalledWith(
      HTML_PREVIEW_NAVIGATION_CHANNEL,
      { url: "https://example.com/next" },
    );

    // Another frame's navigation is blocked without telling the preview.
    preventDefault.mockClear();
    browserWindowState.send?.mockClear();
    emitWebContentsEvent("will-frame-navigate", {
      isMainFrame: false,
      url: "https://example.com/collect",
      frame: { name: "" },
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(browserWindowState.send).not.toHaveBeenCalledWith(
      HTML_PREVIEW_NAVIGATION_CHANNEL,
      expect.anything(),
    );

    // A fragment link scrolls the srcdoc page itself.
    preventDefault.mockClear();
    emitWebContentsEvent("will-frame-navigate", {
      isMainFrame: false,
      url: "about:srcdoc#section-2",
      frame: { name: HTML_PREVIEW_FRAME_NAME },
      preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("shows a native copy action when a renderer link is right-clicked", async () => {
    const { createMainWindow } = await loadWindowModule();
    createMainWindow();

    emitWebContentsEvent(
      "context-menu",
      {},
      {
        linkURL: "file:///Users/fixture-user/project/AGENTS.md:12",
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
      "file:///Users/fixture-user/project/AGENTS.md:12"
    );
  });

  it("copies loaded images through the native context menu, including linked images", async () => {
    const { createMainWindow } = await loadWindowModule();
    createMainWindow();

    emitWebContentsEvent("context-menu", {}, {
      mediaType: "image",
      hasImageContents: true,
      srcURL: "blob:http://localhost/fixture-image",
      linkURL: "https://example.com/image",
      x: 123,
      y: 456,
    });

    const template = buildFromTemplateMock.mock.calls[0]?.[0];
    expect(template).toEqual([
      expect.objectContaining({ label: "Copy Image", click: expect.any(Function) }),
      { type: "separator" },
      expect.objectContaining({ label: "Copy Link", click: expect.any(Function) }),
    ]);
    expect(menuPopupMock).toHaveBeenCalledWith(
      expect.objectContaining({ x: 123, y: 456 }),
    );
    expect(copyImageAtMock).not.toHaveBeenCalled();
    const click = template?.[0]?.click as () => void;
    click();
    expect(copyImageAtMock).toHaveBeenCalledExactlyOnceWith(123, 456);
    expect(clipboardWriteTextMock).not.toHaveBeenCalled();
  });

  it.each([
    { mediaType: "image", hasImageContents: false },
    { mediaType: "none", hasImageContents: false },
    { mediaType: "video", hasImageContents: true },
  ])("omits image copying for unavailable or non-image content: %j", async (params) => {
    const { createMainWindow } = await loadWindowModule();
    createMainWindow();

    emitWebContentsEvent("context-menu", {}, { ...params, x: 12, y: 34 });

    expect(buildFromTemplateMock).not.toHaveBeenCalled();
    expect(copyImageAtMock).not.toHaveBeenCalled();
  });

  it("shows native spelling suggestions when editable text is right-clicked", async () => {
    const { createMainWindow } = await loadWindowModule();
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
    const { createMainWindow } = await loadWindowModule();
    createMainWindow();

    const loadedPath = browserWindowState.loadFile?.mock.calls[0]?.[0] ?? "";
    expect(loadedPath.replace(/\\/g, "/")).toContain("renderer/index.html");
  });

  it("attaches startup CPU profiling before the first renderer navigation", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5173";
    const startupCpuProfiler = {
      attachWindow: vi.fn(() => {
        expect(browserWindowState.loadURL).not.toHaveBeenCalled();
        expect(browserWindowState.loadFile).not.toHaveBeenCalled();
      }),
    };

    const { createMainWindow } = await loadWindowModule();
    createMainWindow({
      startupCpuProfiler,
    });

    expect(startupCpuProfiler.attachWindow).toHaveBeenCalledTimes(1);
    expect(browserWindowState.loadURL).toHaveBeenCalledWith("http://127.0.0.1:5173");
  });

  it("reports an early show event before createMainWindow returns", async () => {
    const onShown = vi.fn();

    const { createMainWindow } = await loadWindowModule();
    createMainWindow({ onShown });

    expect(browserWindowState.show).toHaveBeenCalledTimes(1);
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it("drains renderer and shared main captures, including an already closed window", async () => {
    resolveHotCpuProfileConfigMock.mockReturnValue({ enabled: true });
    const renderersStarted = deferDiagnosticWork(undefined);
    const mainStarted = deferDiagnosticWork(undefined);
    const renderersStopping = deferDiagnosticWork(undefined);
    const mainStopping = deferDiagnosticWork(undefined);
    const rendererStopped = deferDiagnosticWork(undefined);
    const mainStopped = deferDiagnosticWork(undefined);
    hotRendererStart.mockImplementation(async () => {
      if (hotRendererStart.mock.calls.length === 2) renderersStarted.release();
    });
    hotMainStart.mockImplementation(async () => { mainStarted.release(); });
    hotRendererStop.mockImplementation(() => {
      if (hotRendererStop.mock.calls.length === 2) renderersStopping.release();
      return rendererStopped.promise;
    });
    hotMainStop.mockImplementation(() => {
      mainStopping.release();
      return mainStopped.promise;
    });
    const { createMainWindow, stopWindowDiagnostics, syncHotCpuProfilersFromSettings } = await loadWindowModule();
    createMainWindow();
    const firstLoad = webContentsOnceHandlers.get("did-finish-load")!;
    const firstClosed = windowEventHandlers.get("closed")!.at(-1)!;
    createMainWindow();
    firstLoad();
    emitWebContentsEvent("did-finish-load");
    await Promise.all([renderersStarted.promise, mainStarted.promise]);
    expect(hotRendererStart).toHaveBeenCalledTimes(2);
    expect(hotMainStart).toHaveBeenCalledOnce();
    firstClosed();
    const finished = vi.fn();
    const flush = stopWindowDiagnostics("app-quit").then(finished);
    await Promise.all([renderersStopping.promise, mainStopping.promise]);
    expect(hotRendererStop).toHaveBeenCalledTimes(2);
    expect(hotMainStop).toHaveBeenCalledOnce();
    rendererStopped.release();
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    mainStopped.release();
    await flush;
    syncHotCpuProfilersFromSettings("settings-changed");
    await stopWindowDiagnostics("app-quit");
    expect(hotRendererStop).toHaveBeenCalledTimes(2);
    expect(hotMainStop).toHaveBeenCalledOnce();
    expect(hotMainStart).toHaveBeenCalledOnce();
  });

  it("waits for profiler creation already queued when quit starts", async () => {
    resolveHotCpuProfileConfigMock.mockReturnValue({ enabled: true });
    const creationStarted = deferDiagnosticWork(undefined);
    const creation = deferDiagnosticWork({
      ok: true, session: { directoryPath: "/fixture/hot-cpu" },
    });
    createHotCpuProfileSessionMock.mockImplementationOnce(() => {
      creationStarted.release();
      return creation.promise;
    });
    const { createMainWindow, stopWindowDiagnostics, syncHotCpuProfilersFromSettings } = await loadWindowModule();
    createMainWindow();
    emitWebContentsEvent("did-finish-load");
    await creationStarted.promise;
    expect(createHotCpuProfileSessionMock).toHaveBeenCalledOnce();
    const finished = vi.fn();
    const flush = stopWindowDiagnostics("app-quit").then(finished);
    syncHotCpuProfilersFromSettings("settings-changed");
    expect(finished).not.toHaveBeenCalled();
    creation.release();
    await flush;
    expect(hotRendererStop).toHaveBeenCalledOnce();
    expect(hotMainStop).toHaveBeenCalledOnce();
    expect(hotMainStart).toHaveBeenCalledOnce();
    expect(hotRendererStart).toHaveBeenCalledOnce();
  });

  it("drains profiler startup waiting for build metadata when quit starts", async () => {
    resolveHotCpuProfileConfigMock.mockReturnValue({ enabled: true });
    const metadataRequested = deferDiagnosticWork(undefined);
    const metadata = deferDiagnosticWork(appBuildMetadata);
    resolveAppBuildMetadataMock.mockImplementationOnce(() => {
      metadataRequested.release();
      return metadata.promise;
    });
    const { createMainWindow, stopWindowDiagnostics } = await loadWindowModule();
    createMainWindow();
    emitWebContentsEvent("did-finish-load");
    await metadataRequested.promise;
    expect(createHotCpuProfileSessionMock).not.toHaveBeenCalled();
    expect(hotRendererStart).not.toHaveBeenCalled();

    const finished = vi.fn();
    const flush = stopWindowDiagnostics("app-quit").then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    metadata.release();
    await flush;
    expect(hotRendererStart).toHaveBeenCalledOnce();
    expect(hotMainStart).toHaveBeenCalledOnce();
    expect(hotRendererStop).toHaveBeenCalledOnce();
    expect(hotMainStop).toHaveBeenCalledOnce();
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

    const { createMainWindow } = await loadWindowModule();
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

    expect(rendererMonitorStopMock).toHaveBeenCalledOnce();
    expect(mainMonitorStopMock).toHaveBeenCalledOnce();
  });
});
