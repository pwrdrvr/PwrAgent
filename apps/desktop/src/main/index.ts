import { app, BrowserWindow, Menu, shell } from "electron";
import { disposeAgentIpcHandlers, registerAgentIpcHandlers } from "./ipc/agent-ipc";
import { disposeAppServerIpcHandlers, registerAppServerIpcHandlers } from "./ipc/app-server";
import { registerRendererErrorIpcHandlers } from "./ipc/renderer-error";
import { initializeMainLogger } from "./log";
import { StartupCpuProfiler } from "./diagnostics/startup-cpu-profiler";
import { createMainWindow } from "./window";

const APP_NAME = "PwrAgnt";
const isMac = process.platform === "darwin";

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
          label: "PwrAgnt",
          click: async () => {
            await shell.openExternal("https://github.com/pwrdrvr/PwrAgnt");
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function bootstrapApp(): void {
  app.setName(APP_NAME);
  initializeMainLogger();

  app.whenReady().then(async () => {
    const startupCpuProfiler = new StartupCpuProfiler();
    await startupCpuProfiler.start();
    installApplicationMenu();
    registerAppServerIpcHandlers();
    registerAgentIpcHandlers();
    registerRendererErrorIpcHandlers();
    createMainWindow({
      startupCpuProfiler,
    });

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
    void disposeAppServerIpcHandlers();
  });
}

bootstrapApp();
