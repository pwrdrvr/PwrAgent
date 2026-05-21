import { app, BrowserWindow, Menu, nativeImage, shell } from "electron";
import { join } from "node:path";
import { getDesktopBackendRegistry } from "./app-server/backend-registry";
import { disposeAgentIpcHandlers, registerAgentIpcHandlers } from "./ipc/agent-ipc";
import {
  disposeAppMetadataIpcHandlers,
  registerAppMetadataIpcHandlers,
} from "./ipc/app-metadata";
import {
  checkForAppUpdatesNow,
  disposeAppUpdateIpcHandlers,
  initAutoUpdater,
  registerAppUpdateIpcHandlers,
} from "./auto-updater";
import { showAppLogWindow } from "./app-log-window";
import { showChangelogWindow } from "./changelog-window";
import {
  showLicenseWindow,
  showThirdPartyNoticesWindow,
} from "./license-document-window";
import {
  PWRAGENT_DOCUMENTATION_URL,
  PWRAGENT_HOMEPAGE_URL,
} from "../shared/app-metadata";
import { WINDOW_OPEN_SETTINGS_CHANNEL } from "../shared/ipc";
import {
  disposeApplicationIpcHandlers,
  registerApplicationIpcHandlers,
} from "./ipc/applications";
import { disposeAppServerIpcHandlers, registerAppServerIpcHandlers } from "./ipc/app-server";
import {
  disposeImageNormalizationIpcHandlers,
  registerImageNormalizationIpcHandlers,
} from "./ipc/image-normalization";
import {
  disposeComposerDraftIpcHandlers,
  registerComposerDraftIpcHandlers,
} from "./ipc/composer-drafts";
import {
  disposeMessagingStatusIpcHandlers,
  registerMessagingStatusIpcHandlers,
} from "./ipc/messaging-status";
import {
  disposePreloadLogIpcHandlers,
  registerPreloadLogIpcHandlers,
} from "./ipc/preload-log";
import {
  disposeBootInfoIpcHandlers,
  registerBootInfoIpcHandlers,
} from "./ipc/boot-info";
import {
  disposeProfilesIpcHandlers,
  listDesktopPwrAgentProfiles,
  openDesktopPwrAgentProfile,
  registerProfilesIpcHandlers,
} from "./ipc/profiles";
import { registerRendererErrorIpcHandlers } from "./ipc/renderer-error";
import {
  disposeRuntimeIdentityIpcHandlers,
  registerRuntimeIdentityIpcHandlers,
} from "./ipc/runtime-identity";
import {
  disposeSettingsIpcHandlers,
  registerSettingsIpcHandlers,
} from "./ipc/settings";
import {
  disposeWindowPointerIpcHandlers,
  registerWindowPointerIpcHandlers,
} from "./ipc/window-pointer";
import { getMainLogger, initializeMainLogger } from "./log";
import { StartupCpuProfiler } from "./diagnostics/startup-cpu-profiler";
import {
  disposeDesktopMessagingRuntime,
  getDesktopMessagingRuntime,
} from "./messaging/messaging-runtime";
import { loadDesktopMessagingConfigFromSettings } from "./messaging/messaging-config";
import { resolveRuntimeMessagingOverride } from "./runtime-flags";
import {
  getExistingRuntimeMessagingLeaseCoordinator,
  getRuntimeMessagingLeaseCoordinator,
} from "./runtime-messaging-lease";
import { getDesktopSettingsService } from "./settings/desktop-settings-singleton";
import {
  disposeAppState,
  initializeAppState,
  isAppStateInitialized,
  recordBootDecision,
} from "./state/app-state";
import { createMainWindow } from "./window";
import { subscribersForChannel } from "./window-channels";
import { requestOpenSettings } from "./window-open-settings";
import { requestReplayOnboarding } from "./window-replay-onboarding";
import { buildApplicationMenuTemplate } from "./menu";
import {
  assertUnreachableProfileBootDecision,
  cleanupBootstrapProfile,
  PWRAGENT_PROFILE_AUTO_CREATE_ENV,
  resolveActiveProfileName,
  resolveProfileBootDecision,
  startProfileFocusRequestWatcher,
  type ProfileBootDecision,
  type ProfileFocusRequestWatcher,
} from "./profile";
import { SECRET_STORAGE_DISABLED_ENV } from "./settings/desktop-secret-store";

const APP_NAME = "PwrAgent";
const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC.";
const PWRAGENT_ISSUE_REPORTER_URL =
  "https://github.com/pwrdrvr/PwrAgent/issues/new";
const isMac = process.platform === "darwin";
const isDevelopment = process.env.NODE_ENV !== "production";
const mainLog = getMainLogger("pwragent:main");
let mainProcessResourcesDisposed = false;
let profileFocusRequestWatcher: ProfileFocusRequestWatcher | null = null;
let startupCpuProfilerForNewWindows:
  | NonNullable<Parameters<typeof createMainWindow>[0]>["startupCpuProfiler"]
  | undefined;

function logBootDecision(decision: ProfileBootDecision): void {
  // Single structured log line on every boot so troubleshooting
  // "why did the wizard fire / not fire" stays trivial. Production
  // builds still log this (it's an INFO line, no sensitive data).
  switch (decision.kind) {
    case "open":
      mainLog.info("boot decision: open", {
        profileName: decision.profileName,
        source: decision.source,
      });
      return;
    case "missing-named-profile":
      mainLog.info("boot decision: missing-named-profile — bootstrap mode", {
        requestedName: decision.requestedName,
        source: decision.source,
      });
      return;
    case "missing-default-profile":
      mainLog.info("boot decision: missing-default-profile — bootstrap mode", {
        configuredName: decision.configuredName,
      });
      return;
    case "no-profile-configured":
      mainLog.info("boot decision: no-profile-configured — bootstrap mode");
      return;
    default:
      // Adding a new ProfileBootDecision variant without handling it
      // here is a compile error. Replace this throw with an info()
      // log + the right decision behavior in the boot pipeline.
      assertUnreachableProfileBootDecision(decision);
  }
}

function prewarmInitialThreadList(): void {
  if (getDesktopSettingsService().isCodexBootstrapDeferred()) {
    mainLog.info("startup thread list prewarm deferred until onboarding completes");
    return;
  }
  const startedAt = Date.now();
  void getDesktopBackendRegistry()
    .listThreads({
      callerReason: "startup-prewarm",
    })
    .then((threads) => {
      if (!isDevelopment) {
        return;
      }
      mainLog.info("startup thread list prewarm completed", {
        count: threads.length,
        durationMs: Date.now() - startedAt,
      });
    })
    .catch((error) => {
      if (!isDevelopment) {
        return;
      }
      mainLog.warn("startup thread list prewarm failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function disposeMainProcessResourcesSync(): void {
  if (mainProcessResourcesDisposed) {
    return;
  }
  mainProcessResourcesDisposed = true;
  profileFocusRequestWatcher?.stop();
  profileFocusRequestWatcher = null;
  startupCpuProfilerForNewWindows = undefined;
  disposeAgentIpcHandlers();
  disposeApplicationIpcHandlers();
  disposeAppMetadataIpcHandlers();
  disposeAppUpdateIpcHandlers();
  disposeComposerDraftIpcHandlers();
  disposeImageNormalizationIpcHandlers();
  disposePreloadLogIpcHandlers();
  disposeBootInfoIpcHandlers();
  disposeProfilesIpcHandlers();
  disposeSettingsIpcHandlers();
  disposeWindowPointerIpcHandlers();
  if (isDevelopment) {
    disposeRuntimeIdentityIpcHandlers();
  }
  void disposeMessagingStatusIpcHandlers();
  const runtimeMessagingLeaseCoordinator =
    getExistingRuntimeMessagingLeaseCoordinator() ??
    (isAppStateInitialized() ? getRuntimeMessagingLeaseCoordinator() : null);
  runtimeMessagingLeaseCoordinator?.shutdownSync();
  void disposeDesktopMessagingRuntime();
  void disposeAppServerIpcHandlers();
  disposeAppState();
}

function installProcessShutdownHandlers(): void {
  const handleSignal = (signal: NodeJS.Signals): void => {
    mainLog.info("main process shutdown signal received", { signal });
    disposeMainProcessResourcesSync();
    app.quit();
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  process.once("exit", () => {
    disposeMainProcessResourcesSync();
  });
}

function installDevelopmentDockIcon(): void {
  if (!isMac || !isDevelopment) {
    return;
  }

  const iconPath = join(app.getAppPath(), "build/icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    mainLog.warn("failed to load development dock icon", { iconPath });
    return;
  }

  app.dock?.setIcon(icon);
}

function focusPwrAgentWindows(): void {
  const windows = subscribersForChannel(WINDOW_OPEN_SETTINGS_CHANNEL)
    .map((webContents) => BrowserWindow.fromWebContents(webContents))
    .filter((window): window is BrowserWindow =>
      Boolean(window && !window.isDestroyed()),
  );
  if (windows.length === 0) {
    createMainWindow(
      startupCpuProfilerForNewWindows
        ? { startupCpuProfiler: startupCpuProfilerForNewWindows }
        : undefined,
    );
    app.focus({ steal: true });
    return;
  }

  for (const window of windows) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }
  app.focus({ steal: true });
}

function installProfileFocusRequestWatcher(): void {
  profileFocusRequestWatcher?.stop();
  profileFocusRequestWatcher = startProfileFocusRequestWatcher(
    resolveActiveProfileName(),
    {
      onFocus: focusPwrAgentWindows,
    },
  );
}

function installApplicationMenu(): void {
  const developerMode = getDesktopSettingsService().resolveDeveloperMode();
  const profiles = listDesktopPwrAgentProfiles().profiles;
  const template = buildApplicationMenuTemplate({
    appName: APP_NAME,
    developerMode,
    isMac,
    profiles,
    actions: {
      checkForUpdates: () => {
        void checkForAppUpdatesNow("menu");
      },
      openDocumentation: async () => {
        await shell.openExternal(PWRAGENT_DOCUMENTATION_URL);
      },
      openIssueReporter: async () => {
        await shell.openExternal(PWRAGENT_ISSUE_REPORTER_URL);
      },
      openProfile: (profile) => {
        void Promise.resolve(openDesktopPwrAgentProfile({ profile })).finally(
          installApplicationMenu,
        );
      },
      openProfilesSettings: () => {
        requestOpenSettings("profiles");
      },
      openSettings: () => {
        requestOpenSettings();
      },
      openWebsite: async () => {
        await shell.openExternal(PWRAGENT_HOMEPAGE_URL);
      },
      replayOnboarding: () => {
        requestReplayOnboarding();
      },
      showAboutPanel: () => {
        app.showAboutPanel();
      },
      showChangelogWindow,
      showLicenseWindow,
      showLogsWindow: showAppLogWindow,
      showThirdPartyNoticesWindow,
    },
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * In packaged builds, refuse to honor dev-only env vars even if the
 * operator has set them in their shell. These vars have privacy /
 * security implications (silent profile creation, dropped secrets)
 * that are acceptable in dev but never in production.
 *
 * The trick is `delete process.env.X` — any subsequent reader will
 * see undefined and behave as if it was never set. Logging at error
 * level surfaces the misuse loudly in the app log (which the
 * support flow already collects). Called once at process start,
 * before `initializeMainLogger` so the log file the operator picks
 * up records the rejection.
 */
function rejectDevOnlyEnvVarsInProduction(): void {
  if (!app.isPackaged) return;
  const devOnlyVars = [
    PWRAGENT_PROFILE_AUTO_CREATE_ENV,
    SECRET_STORAGE_DISABLED_ENV,
  ];
  for (const name of devOnlyVars) {
    if (process.env[name] !== undefined) {
      // eslint-disable-next-line no-console
      console.error(
        `[pwragent] Refusing to honor dev-only env var ${name} in a packaged build. Unsetting.`,
      );
      delete process.env[name];
    }
  }
}

export function bootstrapApp(): void {
  rejectDevOnlyEnvVarsInProduction();
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: APP_COPYRIGHT,
  });
  initializeMainLogger();
  installProcessShutdownHandlers();

  app.whenReady().then(async () => {
    const startupCpuProfiler = new StartupCpuProfiler();
    startupCpuProfilerForNewWindows = startupCpuProfiler;
    await startupCpuProfiler.start();
    installDevelopmentDockIcon();
    // Boot decision — resolves which profile (if any) this Electron
    // instance should open into. When the decision is `open` we run
    // the today-style flow into an existing profile dir. Anything
    // else (no profile configured, env/CLI named a missing profile,
    // registry pointer is dangling) means the onboarding wizard
    // needs to run BEFORE we commit to a profile, so app state goes
    // into "bootstrap" mode against the throwaway .bootstrap/ dir.
    // Wizard Finish graduates the bootstrap state into a real
    // profile and opens a new window for it (see Task E).
    const bootDecision = resolveProfileBootDecision();
    // Reduce the 4-variant decision to a 2-variant app-state mode.
    // The explicit switch (vs. a bare `kind === "open" ? … : …`)
    // forces a compile error if a future variant is added — the
    // missing case will fall through to `assertUnreachable…` and
    // fail typecheck rather than silently fall into bootstrap mode.
    const bootMode: "active-profile" | "bootstrap" = (() => {
      switch (bootDecision.kind) {
        case "open":
          return "active-profile";
        case "missing-named-profile":
        case "missing-default-profile":
        case "no-profile-configured":
          return "bootstrap";
        default:
          assertUnreachableProfileBootDecision(bootDecision);
      }
    })();
    logBootDecision(bootDecision);
    // Stash the boot decision so the renderer can read it via
    // `getBootInfo` IPC once the wizard mounts. Specifically the
    // missing-named-profile case needs the requested name to
    // pre-populate the confirmation step's "set up `foo`?" prompt.
    recordBootDecision(bootDecision);
    // Clean up any stale .bootstrap/ from a prior abandoned wizard
    // session BEFORE deciding to init in bootstrap mode for the
    // current run. Doing this here (vs. lazily) means a crashed
    // wizard doesn't accumulate stale state.db handles across
    // multiple boot attempts.
    if (bootMode === "active-profile") {
      cleanupBootstrapProfile();
    }
    initializeAppState(bootMode);
    // Skip the focus-request watcher in bootstrap mode. The watcher
    // mkdirs `<root>/profiles/<active>/state/focus-requests/` to
    // catch "focus existing window" requests from sibling PwrAgent
    // instances — but in bootstrap mode there's no sibling and the
    // active profile resolver falls back to literal "default",
    // materializing a `default/` directory that #524 specifically
    // promised would never appear silently.
    if (bootMode === "active-profile") {
      installProfileFocusRequestWatcher();
    }
    installApplicationMenu();
    registerAppServerIpcHandlers();
    registerAgentIpcHandlers();
    registerApplicationIpcHandlers();
    registerAppMetadataIpcHandlers();
    registerAppUpdateIpcHandlers();
    registerComposerDraftIpcHandlers();
    registerImageNormalizationIpcHandlers();
    registerPreloadLogIpcHandlers();
    registerProfilesIpcHandlers({ onProfilesChanged: installApplicationMenu });
    registerRendererErrorIpcHandlers();
    registerBootInfoIpcHandlers();
    registerSettingsIpcHandlers(undefined, {
      onConfigPatchWritten: async (patch) => {
        if (patch.general?.developerMode !== undefined) {
          installApplicationMenu();
        }
      },
    });
    registerWindowPointerIpcHandlers();
    if (isDevelopment) {
      registerRuntimeIdentityIpcHandlers();
    }
    const messagingRuntime = getDesktopMessagingRuntime((options) =>
      loadDesktopMessagingConfigFromSettings(
        getDesktopSettingsService(),
        process.env,
        options,
      ),
    );
    getDesktopBackendRegistry().setMessagingArchiveCleaner({
      requestBindingRevokeAllForThread: (request) =>
        messagingRuntime.requestBindingRevokeAllForThread(request),
    });
    const messagingOverride = resolveRuntimeMessagingOverride();
    if (messagingOverride.disabled) {
      mainLog.info("messaging runtime disabled for this app instance", {
        reason: messagingOverride.reason,
      });
      void getRuntimeMessagingLeaseCoordinator()
        .start(messagingRuntime, (options) =>
          loadDesktopMessagingConfigFromSettings(
            getDesktopSettingsService(),
            process.env,
            options,
          ),
        )
        .catch((error) => {
          mainLog.error("messaging runtime lease recording failed during startup", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    } else {
      void getRuntimeMessagingLeaseCoordinator()
        .start(messagingRuntime, (options) =>
          loadDesktopMessagingConfigFromSettings(
            getDesktopSettingsService(),
            process.env,
            options,
          ),
        )
        .catch((error) => {
          mainLog.error("messaging runtime failed during background startup", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    // Register status IPC after the runtime is constructed so the
    // initial subscriber attaches before the renderer asks for the
    // current snapshot. When messaging is disabled the runtime singleton
    // still exists (default config); status returns []  / never emits.
    registerMessagingStatusIpcHandlers();
    createMainWindow({
      startupCpuProfiler,
    });
    prewarmInitialThreadList();

    // Wire up auto-update *after* the window is created so a slow update
    // check does not delay first paint. Skips automatically in dev.
    initAutoUpdater();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow({
          startupCpuProfiler,
        });
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    disposeMainProcessResourcesSync();
  });
}

bootstrapApp();
