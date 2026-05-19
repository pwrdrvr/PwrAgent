import { app, safeStorage } from "electron";
import { DesktopSettingsService } from "./desktop-settings-service";
import { DbBackedSafeStorageSecretStore } from "../state/secret-store-sqlite";
import { getAppStateDb } from "../state/app-state";
import { broadcastAppearanceChange } from "../appearance-broadcast";

let desktopSettingsService: DesktopSettingsService | undefined;

export function getDesktopSettingsService(): DesktopSettingsService {
  desktopSettingsService ??= new DesktopSettingsService({
    defaultDeveloperMode: app.isPackaged === true ? false : true,
    secretStore: new DbBackedSafeStorageSecretStore(safeStorage, getAppStateDb()),
    // Production wiring: settings writes that touch `[general.appearance]`
    // fan out to every open window via the broadcaster, which sends to
    // every subscriber of APPEARANCE_CHANGED_EVENT_CHANNEL.
    onAppearanceChange: broadcastAppearanceChange,
  });
  return desktopSettingsService;
}

export function resetDesktopSettingsServiceForTests(): void {
  desktopSettingsService = undefined;
}
