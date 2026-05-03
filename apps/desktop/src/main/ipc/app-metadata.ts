import { app, ipcMain } from "electron";
import { APP_METADATA_READ_CHANNEL } from "../../shared/ipc";
import type { AppMetadata } from "../../shared/app-metadata";

const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC. All rights reserved.";
const APP_HOMEPAGE = "https://pwrdrvr.com";

export function resolveAppMetadata(): AppMetadata {
  return {
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    copyright: APP_COPYRIGHT,
    homepage: APP_HOMEPAGE,
    electronVersion: process.versions.electron ?? "",
    chromeVersion: process.versions.chrome ?? "",
    nodeVersion: process.versions.node ?? "",
  };
}

export function registerAppMetadataIpcHandlers(): void {
  ipcMain.removeHandler(APP_METADATA_READ_CHANNEL);
  ipcMain.handle(APP_METADATA_READ_CHANNEL, async (): Promise<AppMetadata> =>
    resolveAppMetadata(),
  );
}

export function disposeAppMetadataIpcHandlers(): void {
  ipcMain.removeHandler(APP_METADATA_READ_CHANNEL);
}
