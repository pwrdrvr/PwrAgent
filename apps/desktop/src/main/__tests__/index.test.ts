import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appEventHandlers = new Map<string, (...args: unknown[]) => void>();
const processEventHandlers = new Map<string, (...args: unknown[]) => void>();
// Captures the listeners createMainWindow's return value registers via
// `window.on(...)` — lets tests drive the main window's "close" handler
// (quit-on-main-window-close).
const mainWindowHandlers = new Map<string, (...args: unknown[]) => void>();
const createMainWindowMock = vi.fn();
const registerAppServerIpcHandlersMock = vi.fn();
const disposeAppServerIpcHandlersMock = vi.fn();
const registerAgentIpcHandlersMock = vi.fn();
const disposeAgentIpcHandlersMock = vi.fn();
const registerApplicationIpcHandlersMock = vi.fn();
const disposeApplicationIpcHandlersMock = vi.fn();
const registerAutomationIpcHandlersMock = vi.fn();
const disposeAutomationIpcHandlersMock = vi.fn();
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
const registerIntegratedTerminalIpcHandlersMock = vi.fn();
const disposeIntegratedTerminalIpcHandlersMock = vi.fn();
const registerDiagnosticsIpcHandlersMock = vi.fn();
const disposeDiagnosticsIpcHandlersMock = vi.fn();
const stopAllCodexEnvironmentDetachedCommandsMock = vi.fn(() => 0);
const registerComposerDraftIpcHandlersMock = vi.fn();
const disposeComposerDraftIpcHandlersMock = vi.fn();
const registerPreloadLogIpcHandlersMock = vi.fn();
const disposePreloadLogIpcHandlersMock = vi.fn();
const registerProfilesIpcHandlersMock = vi.fn();
const disposeProfilesIpcHandlersMock = vi.fn();
const listDesktopPwrAgentProfilesMock = vi.fn();
const openDesktopPwrAgentProfileMock = vi.fn();
const registerRendererErrorIpcHandlersMock = vi.fn();
const registerBootInfoIpcHandlersMock = vi.fn();
const disposeBootInfoIpcHandlersMock = vi.fn();
const registerRuntimeIdentityIpcHandlersMock = vi.fn();
const disposeRuntimeIdentityIpcHandlersMock = vi.fn();
const registerSettingsIpcHandlersMock = vi.fn();
const disposeSettingsIpcHandlersMock = vi.fn();
const registerWindowPointerIpcHandlersMock = vi.fn();
const disposeWindowPointerIpcHandlersMock = vi.fn();
const initializeMainLoggerMock = vi.fn();
const resolveMainLogProfileNameMock = vi.fn((decision: BootDecisionLike) => {
  switch (decision.kind) {
    case "open":
      return String(decision.profileName);
    case "missing-named-profile":
      return String(decision.requestedName);
    case "missing-default-profile":
      return String(decision.configuredName);
    case "no-profile-configured":
      return "bootstrap";
    default:
      return "bootstrap";
  }
});
const requestOpenSettingsMock = vi.fn();
const requestOpenNewThreadMock = vi.fn();
const requestQuitMock = vi.fn(async () => true);
const allowImmediateQuitMock = vi.fn();
const isQuitAllowedMock = vi.fn(() => true);
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
const setMessagingAgentToolServiceMock = vi.fn();
const setPwrAgentAppManagementHandlerMock = vi.fn();
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
const protocolHandleMock = vi.fn();
const protocolRegisterSchemesAsPrivilegedMock = vi.fn();
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
// Default to the "happy path" boot decision so existing tests that
// don't care about the boot-decision branching continue to exercise
// the normal in-flight initialization. Tests that specifically want
// to cover bootstrap mode override this mock per-case.
type BootDecisionLike = Record<string, unknown>;
const resolveProfileBootDecisionMock = vi.fn<() => BootDecisionLike>(() => ({
  kind: "open",
  profileName: "default",
  profileDir: "/tmp/pwragent/profiles/default",
  source: "migration",
}));
const cleanupBootstrapProfileMock = vi.fn();

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
  protocol: {
    handle: protocolHandleMock,
    registerSchemesAsPrivileged: protocolRegisterSchemesAsPrivilegedMock,
  },
  nativeImage: {
    createFromPath: nativeImageCreateFromPathMock,
  },
}));

vi.mock("../window", () => ({
  createMainWindow: createMainWindowMock,
  syncHotCpuProfilersFromSettings: vi.fn(),
}));

vi.mock("../app-menu-bridge", () => ({
  wireAppMenuBridge: vi.fn(),
}));

vi.mock("../window-open-settings", () => ({
  requestOpenSettings: requestOpenSettingsMock,
}));

vi.mock("../window-open-new-thread", () => ({
  requestOpenNewThread: requestOpenNewThreadMock,
}));

vi.mock("../quit-manager", () => ({
  appQuitManager: {
    allowImmediateQuit: allowImmediateQuitMock,
    isQuitAllowed: isQuitAllowedMock,
  },
  requestQuit: requestQuitMock,
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

vi.mock("../ipc/automation-ipc", () => ({
  registerAutomationIpcHandlers: registerAutomationIpcHandlersMock,
  disposeAutomationIpcHandlers: disposeAutomationIpcHandlersMock,
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

const isUpdateInstallInProgressMock = vi.fn(() => false);
vi.mock("../update-install-state", () => ({
  isUpdateInstallInProgress: () => isUpdateInstallInProgressMock(),
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

vi.mock("../ipc/integrated-terminal", () => ({
  registerIntegratedTerminalIpcHandlers: registerIntegratedTerminalIpcHandlersMock,
  disposeIntegratedTerminalIpcHandlers: disposeIntegratedTerminalIpcHandlersMock,
}));

vi.mock("../ipc/diagnostics", () => ({
  registerDiagnosticsIpcHandlers: registerDiagnosticsIpcHandlersMock,
  disposeDiagnosticsIpcHandlers: disposeDiagnosticsIpcHandlersMock,
}));

vi.mock("../app-server/codex-environment-runtime", () => ({
  stopAllCodexEnvironmentDetachedCommands:
    stopAllCodexEnvironmentDetachedCommandsMock,
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

vi.mock("../ipc/boot-info", () => ({
  registerBootInfoIpcHandlers: registerBootInfoIpcHandlersMock,
  disposeBootInfoIpcHandlers: disposeBootInfoIpcHandlersMock,
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
  resolveMainLogProfileName: resolveMainLogProfileNameMock,
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
  recordBootDecision: vi.fn(),
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: getDesktopSettingsServiceMock,
}));

vi.mock("../profile", () => ({
  resolveActiveProfileName: resolveActiveProfileNameMock,
  startProfileFocusRequestWatcher: startProfileFocusRequestWatcherMock,
  resolveProfileBootDecision: resolveProfileBootDecisionMock,
  cleanupBootstrapProfile: cleanupBootstrapProfileMock,
}));

const runtimeMessagingLeaseCoordinatorMock = {
  start: messagingLeaseStartMock,
  shutdownSync: messagingLeaseShutdownSyncMock,
};

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: vi.fn(() => ({
    listThreads: listThreadsMock,
    setMessagingAgentToolService: setMessagingAgentToolServiceMock,
    setPwrAgentAppManagementHandler: setPwrAgentAppManagementHandlerMock,
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
    // installBootErrorHandlers attaches an unhandledRejection listener via
    // process.on. The module re-imports per test, so without this spy the real
    // process accumulates a listener each time (MaxListenersExceededWarning).
    vi.spyOn(process, "on").mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        processEventHandlers.set(String(event), handler);
        return process;
      },
    );
    mainWindowHandlers.clear();
    createMainWindowMock.mockReset();
    // createMainWindow returns the BrowserWindow; index.ts wraps each call in
    // quitAppOnMainWindowClose(window), which calls window.on("close", …).
    // Return a stub that records its listeners so tests can invoke them.
    createMainWindowMock.mockImplementation(() => ({
      on: (event: string, handler: (...args: unknown[]) => void) => {
        mainWindowHandlers.set(event, handler);
      },
      once: (event: string, handler: (...args: unknown[]) => void) => {
        mainWindowHandlers.set(event, handler);
      },
      isVisible: () => false,
    }));
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
    registerAutomationIpcHandlersMock.mockReset();
    disposeAutomationIpcHandlersMock.mockReset();
    showChangelogWindowMock.mockReset();
    showLicenseWindowMock.mockReset();
    showThirdPartyNoticesWindowMock.mockReset();
    registerImageNormalizationIpcHandlersMock.mockReset();
    disposeImageNormalizationIpcHandlersMock.mockReset();
    registerIntegratedTerminalIpcHandlersMock.mockReset();
    disposeIntegratedTerminalIpcHandlersMock.mockReset();
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
    registerBootInfoIpcHandlersMock.mockReset();
    disposeBootInfoIpcHandlersMock.mockReset();
    registerRuntimeIdentityIpcHandlersMock.mockReset();
    disposeRuntimeIdentityIpcHandlersMock.mockReset();
    registerSettingsIpcHandlersMock.mockReset();
    disposeSettingsIpcHandlersMock.mockReset();
    registerWindowPointerIpcHandlersMock.mockReset();
    disposeWindowPointerIpcHandlersMock.mockReset();
    initializeMainLoggerMock.mockReset();
    resolveMainLogProfileNameMock.mockClear();
    requestOpenSettingsMock.mockReset();
    requestOpenNewThreadMock.mockReset();
    requestQuitMock.mockReset();
    requestQuitMock.mockResolvedValue(true);
    allowImmediateQuitMock.mockReset();
    isQuitAllowedMock.mockReset();
    isQuitAllowedMock.mockReturnValue(true);
    isUpdateInstallInProgressMock.mockReset();
    isUpdateInstallInProgressMock.mockReturnValue(false);
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
    setMessagingAgentToolServiceMock.mockReset();
    setPwrAgentAppManagementHandlerMock.mockReset();
    listThreadsMock.mockReset();
    listThreadsMock.mockResolvedValue([]);
    disposeDesktopMessagingRuntimeMock.mockReset();
    disposeDesktopMessagingRuntimeMock.mockResolvedValue(undefined);
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
    protocolHandleMock.mockReset();
    protocolRegisterSchemesAsPrivilegedMock.mockReset();
    profileFocusRequestWatcherStopMock.mockReset();
    resolveActiveProfileNameMock.mockReset();
    resolveActiveProfileNameMock.mockReturnValue("default");
    resolveProfileBootDecisionMock.mockReset();
    resolveProfileBootDecisionMock.mockReturnValue({
      kind: "open",
      profileName: "default",
      profileDir: "/tmp/pwragent/profiles/default",
      source: "migration",
    });
    cleanupBootstrapProfileMock.mockReset();
    initializeAppStateMock.mockReset();
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
    expect(registerIntegratedTerminalIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerPreloadLogIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerRendererErrorIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerSettingsIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerWindowPointerIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerRuntimeIdentityIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(protocolRegisterSchemesAsPrivilegedMock).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: "pwragent-image" }),
    ]);
    expect(protocolHandleMock).toHaveBeenCalledWith(
      "pwragent-image",
      expect.any(Function)
    );
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

  it("quits the app when the main window is closed", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    const closeHandler = mainWindowHandlers.get("close");
    expect(closeHandler).toBeTypeOf("function");
    if (!closeHandler) {
      return;
    }

    // User clicks the main window's X with a quit not yet allowed: hold the
    // window (preventDefault) and request an app-wide quit so aux windows can't
    // keep a headless, unreachable app alive.
    isQuitAllowedMock.mockReturnValue(false);
    requestQuitMock.mockClear();
    const event = { preventDefault: vi.fn() };
    closeHandler(event);
    await flushMicrotasks();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestQuitMock).toHaveBeenCalledWith({
      source: "main-window-closed",
    });
  });

  it("lets the main window close once a quit is already allowed", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    const closeHandler = mainWindowHandlers.get("close");
    expect(closeHandler).toBeTypeOf("function");
    if (!closeHandler) {
      return;
    }

    // app.quit() teardown re-closes the window; with the quit already allowed
    // we must NOT preventDefault or re-request — that would loop.
    isQuitAllowedMock.mockReturnValue(true);
    requestQuitMock.mockClear();
    const event = { preventDefault: vi.fn() };
    closeHandler(event);
    await flushMicrotasks();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(requestQuitMock).not.toHaveBeenCalled();
  });

  it("releases the quit hold when the close-triggered quit request rejects", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    const closeHandler = mainWindowHandlers.get("close");
    expect(closeHandler).toBeTypeOf("function");
    if (!closeHandler) {
      return;
    }

    // A rejected quit request (e.g. the confirmation dialog throws) must not
    // wedge the app: we log it and clear the in-progress hold. Proof the hold
    // released — a later window-all-closed is NOT swallowed as "already
    // quitting" but routes through the quit flow again.
    isQuitAllowedMock.mockReturnValue(false);
    requestQuitMock.mockRejectedValueOnce(new Error("quit dialog boom"));
    const event = { preventDefault: vi.fn() };
    closeHandler(event);
    await flushMicrotasks();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mainLogErrorMock).toHaveBeenCalledWith(
      "quit request failed; releasing quit hold",
      expect.objectContaining({ source: "main-window-closed" }),
    );

    appEventHandlers.get("window-all-closed")?.();
    await flushMicrotasks();

    expect(requestQuitMock).toHaveBeenLastCalledWith({
      source: "window-all-closed",
    });
  });

  it("lets the updater drive relaunch when window-all-closed fires during an update install", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    // quitAndInstall() closes every window as the first step of the Squirrel.Mac
    // relaunch. If we answered that window-all-closed with our own app.quit()
    // we would race the native teardown and strand the app on the old version.
    isUpdateInstallInProgressMock.mockReturnValue(true);
    requestQuitMock.mockClear();

    appEventHandlers.get("window-all-closed")?.();
    await flushMicrotasks();

    expect(requestQuitMock).not.toHaveBeenCalled();
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

  it("routes File -> New Thread through the shared main-window request helper", async () => {
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
    const fileMenu = template?.find((item) => item.label === "File");
    const newThread = fileMenu?.submenu?.find((menuItem) => menuItem.label === "New Thread");

    newThread?.click?.();

    expect(requestOpenNewThreadMock).toHaveBeenCalledOnce();
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

  it("does not recreate a window from Dock activation after quit teardown begins", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    appEventHandlers.get("before-quit")?.();
    appEventHandlers.get("activate")?.();

    expect(createMainWindowMock).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a window from Dock activation during an update install", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    // The update install closes every window without flipping quitInProgress;
    // window creation must still be blocked so a Dock click can't boot a fresh
    // window while Squirrel is swapping the bundle.
    isUpdateInstallInProgressMock.mockReturnValue(true);
    getAllWindowsMock.mockReturnValue([]);

    appEventHandlers.get("activate")?.();

    expect(createMainWindowMock).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a window from profile focus after quit begins", async () => {
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

    appEventHandlers.get("before-quit")?.();
    onFocus();

    expect(createMainWindowMock).toHaveBeenCalledTimes(1);
  });

  it("keeps ipc handlers registered until Electron reaches will-quit", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    appEventHandlers.get("before-quit")?.();

    expect(disposeComposerDraftIpcHandlersMock).not.toHaveBeenCalled();
    expect(disposeIntegratedTerminalIpcHandlersMock).not.toHaveBeenCalled();
    expect(disposeSettingsIpcHandlersMock).not.toHaveBeenCalled();

    appEventHandlers.get("will-quit")?.();

    expect(disposeComposerDraftIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeIntegratedTerminalIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeSettingsIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeAppServerIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeAppServerIpcHandlersMock.mock.invocationCallOrder[0]).toBeLessThan(
      disposeAppStateMock.mock.invocationCallOrder[0],
    );
    expect(disposeDesktopMessagingRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("handles messaging runtime disposal failures during shutdown", async () => {
    startupProfilerInstance.start.mockResolvedValue();
    disposeDesktopMessagingRuntimeMock.mockRejectedValueOnce(
      new Error("adapter stop failed"),
    );

    await import("../index");
    await flushMicrotasks();

    appEventHandlers.get("will-quit")?.();
    await flushMicrotasks();

    expect(mainLogWarnMock).toHaveBeenCalledWith(
      "messaging runtime disposal failed during shutdown",
      { error: "adapter stop failed" },
    );
  });

  it("routes closing the last window through the shared quit flow", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    appEventHandlers.get("window-all-closed")?.();

    expect(requestQuitMock).toHaveBeenCalledWith({
      source: "window-all-closed",
    });
  });

  it("does not re-enter quit when the confirmation window closes after cancellation", async () => {
    let resolveQuit!: (didQuit: boolean) => void;
    requestQuitMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveQuit = resolve;
      }),
    );
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    appEventHandlers.get("window-all-closed")?.();
    appEventHandlers.get("window-all-closed")?.();

    expect(requestQuitMock).toHaveBeenCalledTimes(1);

    resolveQuit(false);
    await flushMicrotasks();
    appEventHandlers.get("activate")?.();

    expect(createMainWindowMock).toHaveBeenCalledTimes(2);
  });

  it("completes quit when all windows close after before-quit approves shutdown", async () => {
    const event = { preventDefault: vi.fn() };
    isQuitAllowedMock.mockReturnValue(false);
    requestQuitMock.mockImplementation(async () => {
      isQuitAllowedMock.mockReturnValue(true);
      return true;
    });
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    appEventHandlers.get("before-quit")?.(event);
    await flushMicrotasks();
    appEventHandlers.get("window-all-closed")?.();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestQuitMock).toHaveBeenCalledWith({ source: "before-quit" });
    expect(quitMock).toHaveBeenCalledTimes(1);
  });

  it("initializes app state in active-profile mode when boot decision is open", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(initializeMainLoggerMock).toHaveBeenCalledWith({
      profileName: "default",
    });
    // Open decision → today's flow. No bootstrap cleanup needed
    // mid-boot (the previous-boot's bootstrap dir, if any, gets
    // wiped only on `open` decisions — see comment in index.ts).
    expect(initializeAppStateMock).toHaveBeenCalledWith("active-profile");
    expect(cleanupBootstrapProfileMock).toHaveBeenCalledTimes(1);
  });

  it("initializes app state in bootstrap mode when boot decision is no-profile-configured", async () => {
    resolveProfileBootDecisionMock.mockReturnValue({ kind: "no-profile-configured" });
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(initializeMainLoggerMock).toHaveBeenCalledWith({
      profileName: "bootstrap",
    });
    // Bootstrap mode runs the wizard against the .bootstrap/ dir.
    // No cleanup at boot — we ARE the bootstrap session that will
    // own that dir; cleanup happens at graduation in Task E.
    expect(initializeAppStateMock).toHaveBeenCalledWith("bootstrap");
    expect(cleanupBootstrapProfileMock).not.toHaveBeenCalled();
  });

  it("initializes app state in bootstrap mode when env names a missing profile", async () => {
    resolveProfileBootDecisionMock.mockReturnValue({
      kind: "missing-named-profile",
      requestedName: "ghost",
      source: "env",
    });
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(initializeMainLoggerMock).toHaveBeenCalledWith({
      profileName: "ghost",
    });
    // PWRAGENT_PROFILE=ghost on a host that doesn't have a ghost
    // profile dir: pre-#524 silently materialized one. Now we drop
    // into bootstrap mode so the wizard can ask "set up ghost,
    // or exit?" before committing anything to disk.
    expect(initializeAppStateMock).toHaveBeenCalledWith("bootstrap");
  });

  it("does not register runtime identity IPC in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(registerRuntimeIdentityIpcHandlersMock).not.toHaveBeenCalled();

    appEventHandlers.get("will-quit")?.();
    expect(disposeApplicationIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeComposerDraftIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeIntegratedTerminalIpcHandlersMock).toHaveBeenCalledTimes(1);
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
