import { app, BrowserWindow, Menu, shell } from "electron";
import { disposeAgentIpcHandlers, registerAgentIpcHandlers } from "./ipc/agent-ipc";
import { disposeAppServerIpcHandlers, registerAppServerIpcHandlers } from "./ipc/app-server";
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

  app.whenReady().then(() => {
    installApplicationMenu();
    registerAppServerIpcHandlers();
    registerAgentIpcHandlers();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
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
