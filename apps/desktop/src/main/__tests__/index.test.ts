import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appEventHandlers = new Map<string, (...args: unknown[]) => void>();
const processEventHandlers = new Map<string, (...args: unknown[]) => void>();
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
const checkForAppUpdatesNowMock = vi.fn();
const showAppLogWindowMock = vi.fn();
const showChangelogWindowMock = vi.fn();
const showLicenseWindowMock = vi.fn();
const showThirdPartyNoticesWindowMock = vi.fn();
const registerImageNormalizationIpcHandlersMock = vi.fn();
const disposeImageNormalizationIpcHandlersMock = vi.fn();
const registerComposerDraftIpcHandlersMock = vi.fn();
const disposeComposerDraftIpcHandlersMock = vi.fn();
const registerPreloadLogIpcHandlersMock = vi.fn();
const disposePreloadLogIpcHandlersMock = vi.fn();
const registerProfilesIpcHandlersMock = vi.fn();
const disposeProfilesIpcHandlersMock = vi.fn();
const listDesktopPwrAgentProfilesMock = vi.fn();
const openDesktopPwrAgentProfileMock = vi.fn();
const registerRendererErrorIpcHandlersMock = vi.fn();
const registerRuntimeIdentityIpcHandlersMock = vi.fn();
const disposeRuntimeIdentityIpcHandlersMock = vi.fn();
const registerSettingsIpcHandlersMock = vi.fn();
const disposeSettingsIpcHandlersMock = vi.fn();
const registerWindowPointerIpcHandlersMock = vi.fn();
const disposeWindowPointerIpcHandlersMock = vi.fn();
const initializeMainLoggerMock = vi.fn();
const requestOpenSettingsMock = vi.fn();
const mainLogInfoMock = vi.fn();
const mainLogWarnMock = vi.fn();
const mainLogErrorMock = vi.fn();
const initializeAppStateMock = vi.fn();
const disposeAppStateMock = vi.fn();
const isAppStateInitializedMock = vi.fn();
const messagingRuntimeStartMock = vi.fn<() => Promise<void>>();
const messagingLeaseStartMock = vi.fn<() => Promise<void>>();
const messagingLeaseShutdownSyncMock = vi.fn();
const getRuntimeMessagingLeaseCoordinatorMock = vi.fn();
const getExistingRuntimeMessagingLeaseCoordinatorMock = vi.fn();
const requestBindingRevokeAllForThreadMock = vi.fn();
const setMessagingArchiveCleanerMock = vi.fn();
const listThreadsMock = vi.fn<(request?: unknown) => Promise<unknown[]>>();
const disposeDesktopMessagingRuntimeMock = vi.fn();
const registerMessagingStatusIpcHandlersMock = vi.fn();
const disposeMessagingStatusIpcHandlersMock = vi.fn();
const setApplicationMenuMock = vi.fn();
const buildFromTemplateMock = vi.fn((template: unknown) => ({
  kind: "menu",
  template,
}));
const shellOpenExternalMock = vi.fn(async () => undefined);
const setNameMock = vi.fn();
const setAboutPanelOptionsMock = vi.fn();
const showAboutPanelMock = vi.fn();
const appFocusMock = vi.fn();
const getAppPathMock = vi.fn(() => "/test/app");
const getVersionMock = vi.fn(() => "1.0.0-alpha.0");
const whenReadyMock = vi.fn(() => Promise.resolve());
const quitMock = vi.fn();
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
const resolveDeveloperModeMock = vi.fn(() => true);
const isCodexBootstrapDeferredMock = vi.fn(() => false);
const getDesktopSettingsServiceMock = vi.fn(() => ({
  resolveDeveloperMode: resolveDeveloperModeMock,
  isCodexBootstrapDeferred: isCodexBootstrapDeferredMock,
}));
const profileFocusRequestWatcherStopMock = vi.fn();
const resolveActiveProfileNameMock = vi.fn(() => "default");
const startProfileFocusRequestWatcherMock = vi.fn(() => ({
  stop: profileFocusRequestWatcherStopMock,
}));

vi.mock("electron", () => ({
  app: {
    setName: setNameMock,
    setAboutPanelOptions: setAboutPanelOptionsMock,
    isPackaged: false,
    getAppPath: getAppPathMock,
    getVersion: getVersionMock,
    showAboutPanel: showAboutPanelMock,
    focus: appFocusMock,
    whenReady: whenReadyMock,
    dock: {
      setIcon: dockSetIconMock,
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEventHandlers.set(event, handler);
    }),
    quit: quitMock,
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
  Menu: {
    setApplicationMenu: setApplicationMenuMock,
    buildFromTemplate: buildFromTemplateMock,
  },
  shell: {
    openExternal: shellOpenExternalMock,
  },
  nativeImage: {
    createFromPath: nativeImageCreateFromPathMock,
  },
}));

vi.mock("../window", () => ({
  createMainWindow: createMainWindowMock,
}));

vi.mock("../window-open-settings", () => ({
  requestOpenSettings: requestOpenSettingsMock,
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
  checkForAppUpdatesNow: checkForAppUpdatesNowMock,
  registerAppUpdateIpcHandlers: registerAppUpdateIpcHandlersMock,
  disposeAppUpdateIpcHandlers: disposeAppUpdateIpcHandlersMock,
  initAutoUpdater: initAutoUpdaterMock,
}));

vi.mock("../app-log-window", () => ({
  showAppLogWindow: showAppLogWindowMock,
}));

vi.mock("../changelog-window", () => ({
  showChangelogWindow: showChangelogWindowMock,
}));

vi.mock("../license-document-window", () => ({
  showLicenseWindow: showLicenseWindowMock,
  showThirdPartyNoticesWindow: showThirdPartyNoticesWindowMock,
}));

vi.mock("../ipc/image-normalization", () => ({
  registerImageNormalizationIpcHandlers: registerImageNormalizationIpcHandlersMock,
  disposeImageNormalizationIpcHandlers: disposeImageNormalizationIpcHandlersMock,
}));

vi.mock("../ipc/composer-drafts", () => ({
  registerComposerDraftIpcHandlers: registerComposerDraftIpcHandlersMock,
  disposeComposerDraftIpcHandlers: disposeComposerDraftIpcHandlersMock,
}));

vi.mock("../ipc/preload-log", () => ({
  registerPreloadLogIpcHandlers: registerPreloadLogIpcHandlersMock,
  disposePreloadLogIpcHandlers: disposePreloadLogIpcHandlersMock,
}));

vi.mock("../ipc/profiles", () => ({
  registerProfilesIpcHandlers: registerProfilesIpcHandlersMock,
  disposeProfilesIpcHandlers: disposeProfilesIpcHandlersMock,
  listDesktopPwrAgentProfiles: listDesktopPwrAgentProfilesMock,
  openDesktopPwrAgentProfile: openDesktopPwrAgentProfileMock,
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

vi.mock("../ipc/window-pointer", () => ({
  registerWindowPointerIpcHandlers: registerWindowPointerIpcHandlersMock,
  disposeWindowPointerIpcHandlers: disposeWindowPointerIpcHandlersMock,
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

vi.mock("../runtime-messaging-lease", () => ({
  getRuntimeMessagingLeaseCoordinator: getRuntimeMessagingLeaseCoordinatorMock,
  getExistingRuntimeMessagingLeaseCoordinator:
    getExistingRuntimeMessagingLeaseCoordinatorMock,
}));

vi.mock("../state/app-state", () => ({
  initializeAppState: initializeAppStateMock,
  disposeAppState: disposeAppStateMock,
  isAppStateInitialized: isAppStateInitializedMock,
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: getDesktopSettingsServiceMock,
}));

vi.mock("../profile", () => ({
  resolveActiveProfileName: resolveActiveProfileNameMock,
  startProfileFocusRequestWatcher: startProfileFocusRequestWatcherMock,
}));

const runtimeMessagingLeaseCoordinatorMock = {
  start: messagingLeaseStartMock,
  shutdownSync: messagingLeaseShutdownSyncMock,
};

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: vi.fn(() => ({
    listThreads: listThreadsMock,
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
    processEventHandlers.clear();
    vi.spyOn(process, "once").mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        processEventHandlers.set(String(event), handler);
        return process;
      },
    );
    createMainWindowMock.mockReset();
    registerAppServerIpcHandlersMock.mockReset();
    disposeAppServerIpcHandlersMock.mockReset();
    registerAgentIpcHandlersMock.mockReset();
    disposeAgentIpcHandlersMock.mockReset();
    registerApplicationIpcHandlersMock.mockReset();
    disposeApplicationIpcHandlersMock.mockReset();
    registerAppUpdateIpcHandlersMock.mockReset();
    disposeAppUpdateIpcHandlersMock.mockReset();
    initAutoUpdaterMock.mockReset();
    checkForAppUpdatesNowMock.mockReset();
    showAppLogWindowMock.mockReset();
    showChangelogWindowMock.mockReset();
    showLicenseWindowMock.mockReset();
    showThirdPartyNoticesWindowMock.mockReset();
    registerImageNormalizationIpcHandlersMock.mockReset();
    disposeImageNormalizationIpcHandlersMock.mockReset();
    registerComposerDraftIpcHandlersMock.mockReset();
    disposeComposerDraftIpcHandlersMock.mockReset();
    registerPreloadLogIpcHandlersMock.mockReset();
    disposePreloadLogIpcHandlersMock.mockReset();
    registerProfilesIpcHandlersMock.mockReset();
    disposeProfilesIpcHandlersMock.mockReset();
    listDesktopPwrAgentProfilesMock.mockReset();
    listDesktopPwrAgentProfilesMock.mockReturnValue({
      activeProfile: "default",
      defaultProfile: "default",
      profiles: [
        {
          active: true,
          canDelete: false,
          codexProfile: {
            codexHome: "/codex/default",
            displayName: "default",
            exists: true,
            hasAuthFile: true,
            hasConfigFile: true,
            name: "default",
            selected: true,
            source: "default",
          },
          default: true,
          name: "default",
          profileDir: "/profiles/default",
        },
      ],
    });
    openDesktopPwrAgentProfileMock.mockReset();
    openDesktopPwrAgentProfileMock.mockReturnValue({
      opened: false,
      profile: "default",
      reason: "active",
    });
    registerRendererErrorIpcHandlersMock.mockReset();
    registerRuntimeIdentityIpcHandlersMock.mockReset();
    disposeRuntimeIdentityIpcHandlersMock.mockReset();
    registerSettingsIpcHandlersMock.mockReset();
    disposeSettingsIpcHandlersMock.mockReset();
    registerWindowPointerIpcHandlersMock.mockReset();
    disposeWindowPointerIpcHandlersMock.mockReset();
    initializeMainLoggerMock.mockReset();
    requestOpenSettingsMock.mockReset();
    mainLogInfoMock.mockReset();
    mainLogWarnMock.mockReset();
    mainLogErrorMock.mockReset();
    initializeAppStateMock.mockReset();
    disposeAppStateMock.mockReset();
    isAppStateInitializedMock.mockReset();
    isAppStateInitializedMock.mockReturnValue(true);
    messagingRuntimeStartMock.mockReset();
    messagingRuntimeStartMock.mockResolvedValue();
    messagingLeaseStartMock.mockReset();
    messagingLeaseStartMock.mockResolvedValue();
    messagingLeaseShutdownSyncMock.mockReset();
    getRuntimeMessagingLeaseCoordinatorMock.mockReset();
    getRuntimeMessagingLeaseCoordinatorMock.mockReturnValue(
      runtimeMessagingLeaseCoordinatorMock,
    );
    getExistingRuntimeMessagingLeaseCoordinatorMock.mockReset();
    getExistingRuntimeMessagingLeaseCoordinatorMock.mockReturnValue(
      runtimeMessagingLeaseCoordinatorMock,
    );
    requestBindingRevokeAllForThreadMock.mockReset();
    setMessagingArchiveCleanerMock.mockReset();
    listThreadsMock.mockReset();
    listThreadsMock.mockResolvedValue([]);
    disposeDesktopMessagingRuntimeMock.mockReset();
    registerMessagingStatusIpcHandlersMock.mockReset();
    disposeMessagingStatusIpcHandlersMock.mockReset();
    setApplicationMenuMock.mockReset();
    shellOpenExternalMock.mockReset();
    buildFromTemplateMock.mockClear();
    setNameMock.mockReset();
    setAboutPanelOptionsMock.mockReset();
    showAboutPanelMock.mockReset();
    appFocusMock.mockReset();
    getAppPathMock.mockClear();
    getVersionMock.mockClear();
    resolveDeveloperModeMock.mockReset();
    resolveDeveloperModeMock.mockReturnValue(true);
    isCodexBootstrapDeferredMock.mockReset();
    isCodexBootstrapDeferredMock.mockReturnValue(false);
    getDesktopSettingsServiceMock.mockClear();
    dockSetIconMock.mockClear();
    nativeImageMock.isEmpty.mockReset();
    nativeImageMock.isEmpty.mockReturnValue(false);
    nativeImageCreateFromPathMock.mockClear();
    whenReadyMock.mockReset();
    whenReadyMock.mockReturnValue(Promise.resolve());
    quitMock.mockReset();
    getAllWindowsMock.mockReset();
    getAllWindowsMock.mockReturnValue([]);
    profileFocusRequestWatcherStopMock.mockReset();
    resolveActiveProfileNameMock.mockReset();
    resolveActiveProfileNameMock.mockReturnValue("default");
    startProfileFocusRequestWatcherMock.mockClear();
    startupProfilerInstance.start.mockReset();
    startupProfilerInstance.attachWindow.mockReset();
    StartupCpuProfilerMock.mockClear();
    vi.resetModules();
    vi.stubEnv("PWRAGENT_DISABLE_MESSAGING", undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
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

    expect(messagingLeaseStartMock).toHaveBeenCalledTimes(1);
    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(registerAppServerIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerAgentIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerApplicationIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerComposerDraftIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerImageNormalizationIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerPreloadLogIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerRendererErrorIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerSettingsIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerWindowPointerIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerRuntimeIdentityIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(startProfileFocusRequestWatcherMock).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ onFocus: expect.any(Function) }),
    );
    expect(setApplicationMenuMock).toHaveBeenCalledTimes(1);
  });

  it("sets the About panel version without duplicating it as a build value", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(setAboutPanelOptionsMock).toHaveBeenCalledWith({
      applicationName: "PwrAgent",
      applicationVersion: "1.0.0-alpha.0",
      copyright: "Copyright © 2026 PwrDrvr LLC.",
    });
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
    messagingLeaseStartMock.mockReturnValue(new Promise(() => {}));

    await import("../index");
    await flushMicrotasks();

    expect(messagingLeaseStartMock).toHaveBeenCalledTimes(1);
    expect(registerMessagingStatusIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
  });

  it("creates a main window when a profile focus request arrives without one", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    const watcherCalls = startProfileFocusRequestWatcherMock.mock.calls as unknown as Array<
      [string, { onFocus: () => void }]
    >;
    const onFocus = watcherCalls[0]?.[1].onFocus;
    expect(onFocus).toBeTypeOf("function");
    if (!onFocus) {
      return;
    }

    expect(createMainWindowMock).toHaveBeenCalledTimes(1);

    onFocus();

    expect(createMainWindowMock).toHaveBeenCalledTimes(2);
    expect(createMainWindowMock).toHaveBeenNthCalledWith(2, {
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(appFocusMock).toHaveBeenCalledWith({ steal: true });
  });

  it("prewarms the initial thread list after starting the first window", async () => {
    startupProfilerInstance.start.mockResolvedValue();
    listThreadsMock.mockReturnValue(new Promise(() => {}));

    await import("../index");
    await flushMicrotasks();

    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(listThreadsMock).toHaveBeenCalledWith({
      callerReason: "startup-prewarm",
    });
  });

  it("skips the prewarm when the Codex bootstrap is deferred for onboarding", async () => {
    startupProfilerInstance.start.mockResolvedValue();
    isCodexBootstrapDeferredMock.mockReturnValue(true);
    listThreadsMock.mockReturnValue(new Promise(() => {}));

    await import("../index");
    await flushMicrotasks();

    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(listThreadsMock).not.toHaveBeenCalled();
  });

  it("wires release help links to PwrAgent destinations and bundled notices", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    const template = buildFromTemplateMock.mock.calls[0]?.[0] as
      | Array<{
          role?: string;
          submenu?: Array<{
            label?: string;
            click?: () => void | Promise<void>;
          }>;
        }>
      | undefined;
    const helpMenu = template?.find((item) => item.role === "help");
    const item = (label: string) =>
      helpMenu?.submenu?.find((menuItem) => menuItem.label === label);

    item("Check for Updates")?.click?.();
    expect(checkForAppUpdatesNowMock).toHaveBeenCalledWith("menu");

    item("Third-Party Notices")?.click?.();
    expect(showThirdPartyNoticesWindowMock).toHaveBeenCalledOnce();

    item("View License")?.click?.();
    expect(showLicenseWindowMock).toHaveBeenCalledOnce();

    await item("PwrAgent Website")?.click?.();
    expect(shellOpenExternalMock).toHaveBeenCalledWith("https://pwragent.ai");

    await item("Documentation")?.click?.();
    expect(shellOpenExternalMock).toHaveBeenCalledWith(
      "https://docs.pwragent.ai",
    );

    await item("Report an Issue")?.click?.();
    expect(shellOpenExternalMock).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrAgent/issues/new",
    );

    expect(item(["Visit", "Website"].join(" "))).toBeUndefined();
  });

  it("wires the Profiles menu to profile opening and profile settings", async () => {
    startupProfilerInstance.start.mockResolvedValue();
    listDesktopPwrAgentProfilesMock.mockReturnValue({
      activeProfile: "default",
      defaultProfile: "default",
      profiles: [
        {
          active: true,
          canDelete: false,
          codexProfile: {
            codexHome: "/codex/default",
            displayName: "default",
            exists: true,
            hasAuthFile: true,
            hasConfigFile: true,
            name: "default",
            selected: true,
            source: "default",
          },
          default: true,
          name: "default",
          profileDir: "/profiles/default",
        },
        {
          active: false,
          canDelete: true,
          codexProfile: {
            codexHome: "/codex/work",
            displayName: "work",
            exists: true,
            hasAuthFile: true,
            hasConfigFile: true,
            name: "work",
            selected: true,
            source: "directory",
          },
          default: false,
          name: "work",
          profileDir: "/profiles/work",
        },
      ],
    });

    await import("../index");
    await flushMicrotasks();

    const template = buildFromTemplateMock.mock.calls[0]?.[0] as
      | Array<{
          label?: string;
          submenu?: Array<{
            label?: string;
            click?: () => void | Promise<void>;
          }>;
        }>
      | undefined;
    const profilesMenu = template?.find((item) => item.label === "Profiles");
    const item = (label: string) =>
      profilesMenu?.submenu?.find((menuItem) => menuItem.label === label);

    item("work")?.click?.();
    await flushMicrotasks();
    expect(openDesktopPwrAgentProfileMock).toHaveBeenCalledWith({
      profile: "work",
    });
    expect(setApplicationMenuMock).toHaveBeenCalledTimes(2);

    item("Manage Profiles…")?.click?.();
    expect(requestOpenSettingsMock).toHaveBeenCalledWith("profiles");
  });

  it("logs startup thread list prewarm failures without blocking startup", async () => {
    startupProfilerInstance.start.mockResolvedValue();
    listThreadsMock.mockRejectedValue(new Error("codex unavailable"));

    await import("../index");
    await flushMicrotasks();

    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(mainLogWarnMock).toHaveBeenCalledWith(
      "startup thread list prewarm failed",
      expect.objectContaining({
        error: "codex unavailable",
      }),
    );
  });

  it("logs unexpected background messaging startup failures", async () => {
    startupProfilerInstance.start.mockResolvedValue();
    messagingLeaseStartMock.mockRejectedValue(new Error("config load failed"));

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
    expect(disposeComposerDraftIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeSettingsIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeWindowPointerIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeRuntimeIdentityIpcHandlersMock).not.toHaveBeenCalled();
    expect(disposeDesktopMessagingRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("does not create the messaging lease coordinator on early SIGTERM", async () => {
    whenReadyMock.mockReturnValue(new Promise(() => {}));
    isAppStateInitializedMock.mockReturnValue(false);
    getExistingRuntimeMessagingLeaseCoordinatorMock.mockReturnValue(null);

    await import("../index");

    const sigtermHandler = processEventHandlers.get("SIGTERM");
    expect(sigtermHandler).toBeTypeOf("function");
    if (!sigtermHandler) {
      return;
    }

    expect(() => sigtermHandler("SIGTERM")).not.toThrow();

    expect(getRuntimeMessagingLeaseCoordinatorMock).not.toHaveBeenCalled();
    expect(messagingLeaseShutdownSyncMock).not.toHaveBeenCalled();
    expect(disposeDesktopMessagingRuntimeMock).toHaveBeenCalledTimes(1);
    expect(quitMock).toHaveBeenCalledTimes(1);
  });

  it("releases the messaging lease synchronously on SIGTERM", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    const sigtermHandler = processEventHandlers.get("SIGTERM");
    expect(sigtermHandler).toBeTypeOf("function");
    if (!sigtermHandler) {
      return;
    }

    sigtermHandler("SIGTERM");

    expect(messagingLeaseShutdownSyncMock).toHaveBeenCalledTimes(1);
    expect(disposeDesktopMessagingRuntimeMock).toHaveBeenCalledTimes(1);
    expect(quitMock).toHaveBeenCalledTimes(1);

    appEventHandlers.get("before-quit")?.();
    expect(messagingLeaseShutdownSyncMock).toHaveBeenCalledTimes(1);
  });

  it("skips messaging runtime startup when messaging is disabled for the app instance", async () => {
    vi.stubEnv("PWRAGENT_DISABLE_MESSAGING", "1");
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(messagingRuntimeStartMock).not.toHaveBeenCalled();
    expect(messagingLeaseStartMock).toHaveBeenCalledTimes(1);
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
