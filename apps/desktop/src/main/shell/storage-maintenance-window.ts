import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import type { StorageMaintenanceView } from "../storage-maintenance-host";
import { STORAGE_MAINTENANCE_CHANNEL, STORAGE_MAINTENANCE_EVENT, type StorageMaintenanceCommand } from "../../shared/storage-maintenance";
import { readBootstrapAppearance, themedWindowAdditionalArguments } from "../settings/appearance-bootstrap";
import { themedWindowBackgroundColor } from "./native-appearance";
import { auxiliaryWindowChromeOptions } from "./auxiliary-window-chrome";
import { describeWebContentsLoad } from "./window-load-diagnostics";

export function createStorageMaintenanceView(): StorageMaintenanceView {
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    width: 540, height: 460, title: "PwrAgent storage", show: false,
    // The Pwr-family title strip, as every auxiliary window draws it; the
    // window is fixed-size, so there is nothing for the green button to zoom.
    ...auxiliaryWindowChromeOptions(), resizable: false, maximizable: false,
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      preload: join(__dirname, "../preload/storage-maintenance.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      additionalArguments: themedWindowAdditionalArguments(appearance),
    },
  });
  const loaded = process.env.ELECTRON_RENDERER_URL
    ? window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/storage-maintenance.html`)
    : window.loadFile(join(__dirname, "../renderer/storage-maintenance.html"));
  // The owner attaches its load wait immediately after creating the view.
  loaded.catch(() => {});
  window.once("closed", () => ipcMain.removeHandler(STORAGE_MAINTENANCE_CHANNEL));
  return {
    loaded,
    isClosed: () => window.isDestroyed(),
    isLoading: () => window.webContents.isLoading?.(),
    describeLoad: () => describeWebContentsLoad(window.webContents),
    publish: (status) => window.webContents.send(STORAGE_MAINTENANCE_EVENT, status),
    hold: () => window.setAlwaysOnTop(true),
    show: () => window.show(),
    close: () => window.close(),
    onCommand: (handler) => ipcMain.handle(STORAGE_MAINTENANCE_CHANNEL, async (event, command: StorageMaintenanceCommand) => {
      if (event.sender !== window.webContents) throw new Error("Invalid storage maintenance sender");
      return await handler(command);
    }),
    onClosed: (handler) => { window.once("closed", handler); },
    onQuit: (handler) => {
      app.once("before-quit", handler);
      return () => { app.removeListener("before-quit", handler); };
    },
  };
}
