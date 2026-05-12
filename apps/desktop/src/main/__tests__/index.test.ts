import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appEventHandlers = new Map<string, (...args: unknown[]) => void>();
const createMainWindowMock = vi.fn();
const registerAppServerIpcHandlersMock = vi.fn();
const disposeAppServerIpcHandlersMock = vi.fn();
const registerAgentIpcHandlersMock = vi.fn();
const disposeAgentIpcHandlersMock = vi.fn();
const registerApplicationIpcHandlersMock = vi.fn();
const disposeApplicationIpcHandlersMock = vi.fn();
const registerAppMetadataIpcHandlersMock = vi.fn();
const disposeAppMetadataIpcHandlersMock = vi.fn();
const registerAppUpdateIpcHandlersMock = vi.fn();
const disposeAppUpdateIpcHandlersMock = vi.fn();
const initAutoUpdaterMock = vi.fn();
const showChangelogWindowMock = vi.fn();
const registerImageNormalizationIpcHandlersMock = vi.fn();
const disposeImageNormalizationIpcHandlersMock = vi.fn();
const registerPreloadLogIpcHandlersMock = vi.fn();
const disposePreloadLogIpcHandlersMock = vi.fn();
const registerProfilesIpcHandlersMock = vi.fn();
const disposeProfilesIpcHandlersMock = vi.fn();
const registerRendererErrorIpcHandlersMock = vi.fn();
const registerRuntimeIdentityIpcHandlersMock = vi.fn();
const disposeRuntimeIdentityIpcHandlersMock = vi.fn();
const registerSettingsIpcHandlersMock = vi.fn();
const disposeSettingsIpcHandlersMock = vi.fn();
const initializeMainLoggerMock = vi.fn();
const mainLogInfoMock = vi.fn();
const mainLogWarnMock = vi.fn();
const mainLogErrorMock = vi.fn();
const messagingRuntimeStartMock = vi.fn<() => Promise<void>>();
const requestBindingRevokeAllForThreadMock = vi.fn();
const setMessagingArchiveCleanerMock = vi.fn();
const disposeDesktopMessagingRuntimeMock = vi.fn();
const registerMessagingStatusIpcHandlersMock = vi.fn();
const disposeMessagingStatusIpcHandlersMock = vi.fn();
const setApplicationMenuMock = vi.fn();
const buildFromTemplateMock = vi.fn(() => ({ kind: "menu" }));
const setNameMock = vi.fn();
const setAboutPanelOptionsMock = vi.fn();
const getAppPathMock = vi.fn(() => "/test/app");
const getVersionMock = vi.fn(() => "1.0.0-alpha.0");
const whenReadyMock = vi.fn(() => Promise.resolve());
const getAllWindowsMock = vi.fn(() => []);
const dockSetIconMock = vi.fn();
const nativeImageMock = {
  isEmpty: vi.fn(() => false),
};
const nativeImageCreateFromPathMock = vi.fn(() => nativeImageMock);
const startupProfilerInstance = {
  start: vi.fn<() => Promise<void>>(),
  attachWindow: vi.fn(),
};
const StartupCpuProfilerMock = vi.fn(function StartupCpuProfiler() {
  return startupProfilerInstance;
});

vi.mock("electron", () => ({
  app: {
    setName: setNameMock,
    setAboutPanelOptions: setAboutPanelOptionsMock,
    getAppPath: getAppPathMock,
    getVersion: getVersionMock,
    showAboutPanel: vi.fn(),
    whenReady: whenReadyMock,
    dock: {
      setIcon: dockSetIconMock,
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEventHandlers.set(event, handler);
    }),
    quit: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
  Menu: {
    setApplicationMenu: setApplicationMenuMock,
    buildFromTemplate: buildFromTemplateMock,
  },
  shell: {
    openExternal: vi.fn(),
  },
  nativeImage: {
    createFromPath: nativeImageCreateFromPathMock,
  },
}));

vi.mock("../window", () => ({
  createMainWindow: createMainWindowMock,
}));

vi.mock("../ipc/app-server", () => ({
  registerAppServerIpcHandlers: registerAppServerIpcHandlersMock,
  disposeAppServerIpcHandlers: disposeAppServerIpcHandlersMock,
}));

vi.mock("../ipc/agent-ipc", () => ({
  registerAgentIpcHandlers: registerAgentIpcHandlersMock,
  disposeAgentIpcHandlers: disposeAgentIpcHandlersMock,
}));

vi.mock("../ipc/applications", () => ({
  registerApplicationIpcHandlers: registerApplicationIpcHandlersMock,
  disposeApplicationIpcHandlers: disposeApplicationIpcHandlersMock,
}));

vi.mock("../ipc/app-metadata", () => ({
  registerAppMetadataIpcHandlers: registerAppMetadataIpcHandlersMock,
  disposeAppMetadataIpcHandlers: disposeAppMetadataIpcHandlersMock,
}));

vi.mock("../auto-updater", () => ({
  registerAppUpdateIpcHandlers: registerAppUpdateIpcHandlersMock,
  disposeAppUpdateIpcHandlers: disposeAppUpdateIpcHandlersMock,
  initAutoUpdater: initAutoUpdaterMock,
}));

vi.mock("../changelog-window", () => ({
  showChangelogWindow: showChangelogWindowMock,
}));

vi.mock("../ipc/image-normalization", () => ({
  registerImageNormalizationIpcHandlers: registerImageNormalizationIpcHandlersMock,
  disposeImageNormalizationIpcHandlers: disposeImageNormalizationIpcHandlersMock,
}));

vi.mock("../ipc/preload-log", () => ({
  registerPreloadLogIpcHandlers: registerPreloadLogIpcHandlersMock,
  disposePreloadLogIpcHandlers: disposePreloadLogIpcHandlersMock,
}));

vi.mock("../ipc/profiles", () => ({
  registerProfilesIpcHandlers: registerProfilesIpcHandlersMock,
  disposeProfilesIpcHandlers: disposeProfilesIpcHandlersMock,
}));

vi.mock("../ipc/renderer-error", () => ({
  registerRendererErrorIpcHandlers: registerRendererErrorIpcHandlersMock,
}));

vi.mock("../ipc/runtime-identity", () => ({
  registerRuntimeIdentityIpcHandlers: registerRuntimeIdentityIpcHandlersMock,
  disposeRuntimeIdentityIpcHandlers: disposeRuntimeIdentityIpcHandlersMock,
}));

vi.mock("../ipc/settings", () => ({
  registerSettingsIpcHandlers: registerSettingsIpcHandlersMock,
  disposeSettingsIpcHandlers: disposeSettingsIpcHandlersMock,
}));

vi.mock("../log", () => ({
  initializeMainLogger: initializeMainLoggerMock,
  getMainLogger: vi.fn(() => ({
    info: mainLogInfoMock,
    warn: mainLogWarnMock,
    error: mainLogErrorMock,
  })),
}));

vi.mock("../messaging/messaging-runtime", () => ({
  getDesktopMessagingRuntime: vi.fn(() => ({
    start: messagingRuntimeStartMock,
    requestBindingRevokeAllForThread: requestBindingRevokeAllForThreadMock,
    onPlatformStatus: vi.fn(() => () => {}),
    getPlatformStatuses: vi.fn(() => []),
  })),
  disposeDesktopMessagingRuntime: disposeDesktopMessagingRuntimeMock,
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: vi.fn(() => ({
    setMessagingArchiveCleaner: setMessagingArchiveCleanerMock,
  })),
}));

vi.mock("../ipc/messaging-status", () => ({
  registerMessagingStatusIpcHandlers: registerMessagingStatusIpcHandlersMock,
  disposeMessagingStatusIpcHandlers: disposeMessagingStatusIpcHandlersMock,
}));

vi.mock("../diagnostics/startup-cpu-profiler", () => ({
  StartupCpuProfiler: StartupCpuProfilerMock,
}));

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe("bootstrapApp", () => {
  beforeEach(() => {
    appEventHandlers.clear();
    createMainWindowMock.mockReset();
    registerAppServerIpcHandlersMock.mockReset();
    disposeAppServerIpcHandlersMock.mockReset();
    registerAgentIpcHandlersMock.mockReset();
    disposeAgentIpcHandlersMock.mockReset();
    registerApplicationIpcHandlersMock.mockReset();
    disposeApplicationIpcHandlersMock.mockReset();
    showChangelogWindowMock.mockReset();
    registerImageNormalizationIpcHandlersMock.mockReset();
    disposeImageNormalizationIpcHandlersMock.mockReset();
    registerPreloadLogIpcHandlersMock.mockReset();
    disposePreloadLogIpcHandlersMock.mockReset();
    registerProfilesIpcHandlersMock.mockReset();
    disposeProfilesIpcHandlersMock.mockReset();
    registerRendererErrorIpcHandlersMock.mockReset();
    registerRuntimeIdentityIpcHandlersMock.mockReset();
    disposeRuntimeIdentityIpcHandlersMock.mockReset();
    registerSettingsIpcHandlersMock.mockReset();
    disposeSettingsIpcHandlersMock.mockReset();
    initializeMainLoggerMock.mockReset();
    mainLogInfoMock.mockReset();
    mainLogWarnMock.mockReset();
    mainLogErrorMock.mockReset();
    messagingRuntimeStartMock.mockReset();
    messagingRuntimeStartMock.mockResolvedValue();
    requestBindingRevokeAllForThreadMock.mockReset();
    setMessagingArchiveCleanerMock.mockReset();
    disposeDesktopMessagingRuntimeMock.mockReset();
    registerMessagingStatusIpcHandlersMock.mockReset();
    disposeMessagingStatusIpcHandlersMock.mockReset();
    setApplicationMenuMock.mockReset();
    buildFromTemplateMock.mockClear();
    setNameMock.mockReset();
    getAppPathMock.mockClear();
    dockSetIconMock.mockClear();
    nativeImageMock.isEmpty.mockReset();
    nativeImageMock.isEmpty.mockReturnValue(false);
    nativeImageCreateFromPathMock.mockClear();
    whenReadyMock.mockReset();
    whenReadyMock.mockReturnValue(Promise.resolve());
    getAllWindowsMock.mockReset();
    getAllWindowsMock.mockReturnValue([]);
    startupProfilerInstance.start.mockReset();
    startupProfilerInstance.attachWindow.mockReset();
    StartupCpuProfilerMock.mockClear();
    vi.resetModules();
    vi.stubEnv("PWRAGENT_DISABLE_MESSAGING", undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("awaits startup CPU profiling before creating the first window", async () => {
    let resolveStart!: () => void;
    startupProfilerInstance.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    await import("../index");
    await flushMicrotasks();

    expect(StartupCpuProfilerMock).toHaveBeenCalledTimes(1);
    expect(startupProfilerInstance.start).toHaveBeenCalledTimes(1);
    expect(createMainWindowMock).not.toHaveBeenCalled();

    resolveStart();
    await flushMicrotasks();

    expect(messagingRuntimeStartMock).toHaveBeenCalledTimes(1);
    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(registerAppServerIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerAgentIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerApplicationIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerImageNormalizationIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerPreloadLogIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerRendererErrorIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerSettingsIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerRuntimeIdentityIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(setApplicationMenuMock).toHaveBeenCalledTimes(1);
  });

  it("uses the PwrAgent icon for the development Dock icon on macOS", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(nativeImageCreateFromPathMock).toHaveBeenCalledWith(
      "/test/app/build/icon.png",
    );
    expect(dockSetIconMock).toHaveBeenCalledWith(nativeImageMock);
  });

  it("creates the first window without waiting for messaging startup", async () => {
    startupProfilerInstance.start.mockResolvedValue();
    messagingRuntimeStartMock.mockReturnValue(new Promise(() => {}));

    await import("../index");
    await flushMicrotasks();

    expect(messagingRuntimeStartMock).toHaveBeenCalledTimes(1);
    expect(registerMessagingStatusIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
  });

  it("logs unexpected background messaging startup failures", async () => {
    startupProfilerInstance.start.mockResolvedValue();
    messagingRuntimeStartMock.mockRejectedValue(new Error("config load failed"));

    await import("../index");
    await flushMicrotasks();

    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(mainLogErrorMock).toHaveBeenCalledWith(
      "messaging runtime failed during background startup",
      expect.objectContaining({
        error: "config load failed",
      }),
    );
  });

  it("reuses the same startup CPU profiler on app activate", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    const activateHandler = appEventHandlers.get("activate");
    expect(activateHandler).toBeTypeOf("function");
    if (!activateHandler) {
      return;
    }

    activateHandler();

    expect(createMainWindowMock).toHaveBeenNthCalledWith(1, {
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(createMainWindowMock).toHaveBeenNthCalledWith(2, {
      startupCpuProfiler: startupProfilerInstance,
    });
  });

  it("does not register runtime identity IPC in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(registerRuntimeIdentityIpcHandlersMock).not.toHaveBeenCalled();

    appEventHandlers.get("before-quit")?.();
    expect(disposeApplicationIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeSettingsIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeRuntimeIdentityIpcHandlersMock).not.toHaveBeenCalled();
    expect(disposeDesktopMessagingRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("skips messaging runtime startup when messaging is disabled for the app instance", async () => {
    vi.stubEnv("PWRAGENT_DISABLE_MESSAGING", "1");
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(messagingRuntimeStartMock).not.toHaveBeenCalled();
    expect(mainLogInfoMock).toHaveBeenCalledWith(
      "messaging runtime disabled for this app instance",
      expect.objectContaining({
        reason: "PWRAGENT_DISABLE_MESSAGING is enabled",
      }),
    );
    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
  });
});
