import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { app, ipcMain } from "electron";
import {
  APP_CHANGELOG_DOCUMENT_READ_CHANNEL,
  APP_CHANGELOG_WINDOW_OPEN_CHANNEL,
  APP_LICENSE_DOCUMENT_READ_CHANNEL,
  APP_METADATA_READ_CHANNEL,
} from "../../shared/ipc";
import type {
  AppChangelogDocument,
  AppLicenseDocument,
  AppLicenseDocumentKind,
  AppMetadata,
} from "../../shared/app-metadata";
import { showChangelogWindow } from "../changelog-window";

const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC.";
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
    title: kind === "license" ? "MIT License" : "Third-Party Licenses",
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
  ipcMain.removeHandler(APP_METADATA_READ_CHANNEL);
  ipcMain.removeHandler(APP_LICENSE_DOCUMENT_READ_CHANNEL);
  ipcMain.removeHandler(APP_CHANGELOG_DOCUMENT_READ_CHANNEL);
  ipcMain.removeHandler(APP_CHANGELOG_WINDOW_OPEN_CHANNEL);
  ipcMain.handle(APP_METADATA_READ_CHANNEL, async (): Promise<AppMetadata> =>
    resolveAppMetadata(),
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
  ipcMain.handle(APP_CHANGELOG_WINDOW_OPEN_CHANNEL, async (): Promise<void> => {
    showChangelogWindow();
  });
}

export function disposeAppMetadataIpcHandlers(): void {
  ipcMain.removeHandler(APP_METADATA_READ_CHANNEL);
  ipcMain.removeHandler(APP_LICENSE_DOCUMENT_READ_CHANNEL);
  ipcMain.removeHandler(APP_CHANGELOG_DOCUMENT_READ_CHANNEL);
  ipcMain.removeHandler(APP_CHANGELOG_WINDOW_OPEN_CHANNEL);
}
