import { app, safeStorage } from "electron";
import { DesktopSettingsService } from "./desktop-settings-service";
import { DbBackedSafeStorageSecretStore } from "../state/secret-store-sqlite";
import { getAppStateDb } from "../state/app-state";

let desktopSettingsService: DesktopSettingsService | undefined;

export function getDesktopSettingsService(): DesktopSettingsService {
  desktopSettingsService ??= new DesktopSettingsService({
    defaultDeveloperMode: app.isPackaged === true ? false : true,
    secretStore: new DbBackedSafeStorageSecretStore(safeStorage, getAppStateDb()),
  });
  return desktopSettingsService;
}

export function resetDesktopSettingsServiceForTests(): void {
  desktopSettingsService = undefined;
}
