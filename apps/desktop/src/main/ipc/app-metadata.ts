import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  APP_CHANGELOG_DOCUMENT_READ_CHANNEL,
  APP_CHANGELOG_WINDOW_OPEN_CHANNEL,
  APP_LOG_DEBUG_COLLECTION_SET_CHANNEL,
  APP_LOG_ENTRY_EVENT_CHANNEL,
  APP_LOG_SNAPSHOT_READ_CHANNEL,
  APP_LOG_WINDOW_OPEN_CHANNEL,
  APP_LICENSE_DOCUMENT_READ_CHANNEL,
  APP_METADATA_READ_CHANNEL,
  APP_THIRD_PARTY_NOTICES_WINDOW_OPEN_CHANNEL,
} from "../../shared/ipc";
import {
  PWRAGENT_DOCUMENTATION_URL,
  PWRAGENT_HOMEPAGE_URL,
  type AppChangelogDocument,
  type AppLogSnapshot,
  type AppLicenseDocument,
  type AppLicenseDocumentKind,
  type AppMetadata,
} from "../../shared/app-metadata";
import { readAppLogSnapshot, subscribeAppLogEntries } from "../app-logs";
import { showAppLogWindow } from "../app-log-window";
import { showChangelogWindow } from "../changelog-window";
import { showThirdPartyNoticesWindow } from "../license-document-window";
import {
  getMainLogFilePath,
  isMainLogDebugCollectionEnabled,
  setMainLogDebugCollectionEnabled,
} from "../log";
import { subscribersForChannel } from "../window-channels";

const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC.";

let unsubscribeAppLogEntries: (() => void) | undefined;

function readDecoratedAppLogSnapshot(): AppLogSnapshot {
  const snapshot = readAppLogSnapshot({
    debugCollectionEnabled: isMainLogDebugCollectionEnabled(),
  });
  const logFilePath = getMainLogFilePath();
  return logFilePath ? { ...snapshot, logFilePath } : snapshot;
}

export function resolveAppMetadata(
  rendererProcessId?: number,
): AppMetadata {
  return {
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    copyright: APP_COPYRIGHT,
    homepage: PWRAGENT_HOMEPAGE_URL,
    documentationUrl: PWRAGENT_DOCUMENTATION_URL,
    electronVersion: process.versions.electron ?? "",
    chromeVersion: process.versions.chrome ?? "",
    nodeVersion: process.versions.node ?? "",
    mainProcessId: process.pid,
    ...(rendererProcessId === undefined ? {} : { rendererProcessId }),
  };
}

function resolveLicenseDocumentPath(kind: AppLicenseDocumentKind): string {
  const fileName = kind === "license" ? "LICENSE" : "THIRD_PARTY_LICENSES";
  return resolveBundledDocumentPath(fileName);
}

function resolveBundledDocumentPath(fileName: string): string {
  const candidates = [
    resolve(process.resourcesPath, fileName),
    resolve(app.getAppPath(), "..", "..", fileName),
    resolve(app.getAppPath(), fileName),
    resolve(process.cwd(), "..", "..", fileName),
    resolve(process.cwd(), fileName),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (match) {
    return match;
  }
  return candidates[0];
}

export async function readAppLicenseDocument(
  kind: AppLicenseDocumentKind,
): Promise<AppLicenseDocument> {
  if (kind !== "license" && kind !== "third-party-licenses") {
    throw new Error(`Unknown license document: ${String(kind)}`);
  }
  const content = await readFile(resolveLicenseDocumentPath(kind), "utf8");
  return {
    kind,
    title: kind === "license" ? "MIT License" : "Third-Party Notices",
    content,
  };
}

export async function readAppChangelogDocument(): Promise<AppChangelogDocument> {
  const content = await readFile(resolveBundledDocumentPath("CHANGELOG.md"), "utf8");
  return {
    kind: "changelog",
    title: "Changelog",
    content,
  };
}

export function registerAppMetadataIpcHandlers(): void {
  unsubscribeAppLogEntries?.();
  unsubscribeAppLogEntries = subscribeAppLogEntries((entry) => {
    for (const webContents of subscribersForChannel(APP_LOG_ENTRY_EVENT_CHANNEL)) {
      if (!webContents.isDestroyed()) {
        webContents.send(APP_LOG_ENTRY_EVENT_CHANNEL, entry);
      }
    }
  });

  ipcMain.removeHandler(APP_METADATA_READ_CHANNEL);
  ipcMain.removeHandler(APP_LICENSE_DOCUMENT_READ_CHANNEL);
  ipcMain.removeHandler(APP_CHANGELOG_DOCUMENT_READ_CHANNEL);
  ipcMain.removeHandler(APP_CHANGELOG_WINDOW_OPEN_CHANNEL);
  ipcMain.removeHandler(APP_THIRD_PARTY_NOTICES_WINDOW_OPEN_CHANNEL);
  ipcMain.removeHandler(APP_LOG_SNAPSHOT_READ_CHANNEL);
  ipcMain.removeHandler(APP_LOG_DEBUG_COLLECTION_SET_CHANNEL);
  ipcMain.removeHandler(APP_LOG_WINDOW_OPEN_CHANNEL);
  ipcMain.handle(
    APP_METADATA_READ_CHANNEL,
    async (event): Promise<AppMetadata> =>
      resolveAppMetadata(event.sender.getOSProcessId()),
  );
  ipcMain.handle(
    APP_LICENSE_DOCUMENT_READ_CHANNEL,
    async (
      _event,
      kind: AppLicenseDocumentKind,
    ): Promise<AppLicenseDocument> => readAppLicenseDocument(kind),
  );
  ipcMain.handle(
    APP_CHANGELOG_DOCUMENT_READ_CHANNEL,
    async (): Promise<AppChangelogDocument> => readAppChangelogDocument(),
  );
  ipcMain.handle(APP_CHANGELOG_WINDOW_OPEN_CHANNEL, async (event): Promise<void> => {
    showChangelogWindow({
      sourceWindow: BrowserWindow.fromWebContents(event.sender),
    });
  });
  ipcMain.handle(
    APP_THIRD_PARTY_NOTICES_WINDOW_OPEN_CHANNEL,
    async (event): Promise<void> => {
      showThirdPartyNoticesWindow({
        sourceWindow: BrowserWindow.fromWebContents(event.sender),
      });
    },
  );
  ipcMain.handle(
    APP_LOG_SNAPSHOT_READ_CHANNEL,
    async (): Promise<AppLogSnapshot> => readDecoratedAppLogSnapshot(),
  );
  ipcMain.handle(
    APP_LOG_DEBUG_COLLECTION_SET_CHANNEL,
    async (_event, enabled: boolean): Promise<AppLogSnapshot> => {
      setMainLogDebugCollectionEnabled(enabled);
      return readDecoratedAppLogSnapshot();
    },
  );
  ipcMain.handle(APP_LOG_WINDOW_OPEN_CHANNEL, async (event): Promise<void> => {
    showAppLogWindow({
      sourceWindow: BrowserWindow.fromWebContents(event.sender),
    });
  });
}

export function disposeAppMetadataIpcHandlers(): void {
  unsubscribeAppLogEntries?.();
  unsubscribeAppLogEntries = undefined;
  ipcMain.removeHandler(APP_METADATA_READ_CHANNEL);
  ipcMain.removeHandler(APP_LICENSE_DOCUMENT_READ_CHANNEL);
  ipcMain.removeHandler(APP_CHANGELOG_DOCUMENT_READ_CHANNEL);
  ipcMain.removeHandler(APP_CHANGELOG_WINDOW_OPEN_CHANNEL);
  ipcMain.removeHandler(APP_THIRD_PARTY_NOTICES_WINDOW_OPEN_CHANNEL);
  ipcMain.removeHandler(APP_LOG_SNAPSHOT_READ_CHANNEL);
  ipcMain.removeHandler(APP_LOG_DEBUG_COLLECTION_SET_CHANNEL);
  ipcMain.removeHandler(APP_LOG_WINDOW_OPEN_CHANNEL);
}
