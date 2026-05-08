import { app, BrowserWindow, Menu, shell } from "electron";
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
import { getMainLogger, initializeMainLogger } from "./log";
import { StartupCpuProfiler } from "./diagnostics/startup-cpu-profiler";
import {
  disposeDesktopMessagingRuntime,
  getDesktopMessagingRuntime,
} from "./messaging/messaging-runtime";
import { loadDesktopMessagingConfigFromSettings } from "./messaging/messaging-config";
import { resolveRuntimeMessagingOverride } from "./runtime-flags";
import { getDesktopSettingsService } from "./settings/desktop-settings-singleton";
import { disposeAppState, initializeAppState } from "./state/app-state";
import { createMainWindow } from "./window";

const APP_NAME = "PwrAgent";
const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC. All rights reserved.";
const APP_WEBSITE = "https://pwrdrvr.com";
const isMac = process.platform === "darwin";
const isDevelopment = process.env.NODE_ENV !== "production";
const mainLog = getMainLogger("pwragent:main");

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

  app.whenReady().then(async () => {
    const startupCpuProfiler = new StartupCpuProfiler();
    await startupCpuProfiler.start();
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
    const messagingOverride = resolveRuntimeMessagingOverride();
    if (messagingOverride.disabled) {
      mainLog.info("messaging runtime disabled for this app instance", {
        reason: messagingOverride.reason,
      });
    } else {
      void messagingRuntime.start().catch((error) => {
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
    disposeAgentIpcHandlers();
    disposeApplicationIpcHandlers();
    disposeAppMetadataIpcHandlers();
    disposeAppUpdateIpcHandlers();
    disposeImageNormalizationIpcHandlers();
    disposePreloadLogIpcHandlers();
    disposeProfilesIpcHandlers();
    disposeSettingsIpcHandlers();
    if (isDevelopment) {
      disposeRuntimeIdentityIpcHandlers();
    }
    void disposeMessagingStatusIpcHandlers();
    void disposeDesktopMessagingRuntime();
    void disposeAppServerIpcHandlers();
    disposeAppState();
  });
}

bootstrapApp();
