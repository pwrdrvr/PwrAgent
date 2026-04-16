import { app, BrowserWindow, Menu, shell } from "electron";
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
}

bootstrapApp();
