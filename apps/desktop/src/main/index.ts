import { app, BrowserWindow, Menu, nativeImage, shell } from "electron";
import { join } from "node:path";
import { getDesktopBackendRegistry } from "./app-server/backend-registry";
import { disposeAgentIpcHandlers, registerAgentIpcHandlers } from "./ipc/agent-ipc";
import {
  disposeAppMetadataIpcHandlers,
  registerAppMetadataIpcHandlers,
} from "./ipc/app-metadata";
import {
  disposeAppUpdateIpcHandlers,
  initAutoUpdater,
  registerAppUpdateIpcHandlers,
} from "./auto-updater";
import { showAppLogWindow } from "./app-log-window";
import { showChangelogWindow } from "./changelog-window";
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
  disposeMessagingStatusIpcHandlers,
  registerMessagingStatusIpcHandlers,
} from "./ipc/messaging-status";
import {
  disposePreloadLogIpcHandlers,
  registerPreloadLogIpcHandlers,
} from "./ipc/preload-log";
import {
  disposeProfilesIpcHandlers,
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
} from "./state/app-state";
import { createMainWindow } from "./window";

const APP_NAME = "PwrAgent";
const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC.";
const APP_WEBSITE = "https://pwrdrvr.com";
const isMac = process.platform === "darwin";
const isDevelopment = process.env.NODE_ENV !== "production";
const mainLog = getMainLogger("pwragent:main");
let mainProcessResourcesDisposed = false;

function prewarmInitialThreadList(): void {
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
  disposeAgentIpcHandlers();
  disposeApplicationIpcHandlers();
  disposeAppMetadataIpcHandlers();
  disposeAppUpdateIpcHandlers();
  disposeImageNormalizationIpcHandlers();
  disposePreloadLogIpcHandlers();
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

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => {
            app.showAboutPanel();
          },
        },
        {
          label: "Changelog",
          click: () => {
            showChangelogWindow();
          },
        },
        {
          label: "Logs",
          click: () => {
            showAppLogWindow();
          },
        },
        {
          label: "Visit Website",
          click: async () => {
            await shell.openExternal(APP_WEBSITE);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function bootstrapApp(): void {
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: APP_COPYRIGHT,
  });
  initializeMainLogger();
  installProcessShutdownHandlers();

  app.whenReady().then(async () => {
    const startupCpuProfiler = new StartupCpuProfiler();
    await startupCpuProfiler.start();
    installDevelopmentDockIcon();
    initializeAppState();
    installApplicationMenu();
    registerAppServerIpcHandlers();
    registerAgentIpcHandlers();
    registerApplicationIpcHandlers();
    registerAppMetadataIpcHandlers();
    registerAppUpdateIpcHandlers();
    registerImageNormalizationIpcHandlers();
    registerPreloadLogIpcHandlers();
    registerProfilesIpcHandlers();
    registerRendererErrorIpcHandlers();
    registerSettingsIpcHandlers();
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
