import { app, safeStorage } from "electron";
import { DesktopSettingsService } from "./desktop-settings-service";
import { DbBackedSafeStorageSecretStore } from "../state/secret-store-sqlite";
import { getAppStateDb, getAppStateMode } from "../state/app-state";
import { broadcastAppearanceChange } from "../appearance-broadcast";
import { resolveBootstrapProfilePath } from "../profile";

let desktopSettingsService: DesktopSettingsService | undefined;

export function getDesktopSettingsService(): DesktopSettingsService {
  if (!desktopSettingsService) {
    // In bootstrap mode the settings service reads/writes the
    // bootstrap profile's `config.toml`. On graduation the wizard
    // exports those values out of the bootstrap config and applies
    // them to the operator's chosen real profile before tearing the
    // bootstrap state down.
    const bootstrap = getAppStateMode() === "bootstrap";
    desktopSettingsService = new DesktopSettingsService({
      defaultDeveloperMode: app.isPackaged === true ? false : true,
      secretStore: new DbBackedSafeStorageSecretStore(safeStorage, getAppStateDb()),
      ...(bootstrap
        ? { configPath: resolveBootstrapProfilePath("config.toml") }
        : {}),
      // Production wiring: settings writes that touch `[general.appearance]`
      // fan out to every open window via the broadcaster, which sends to
      // every subscriber of APPEARANCE_CHANGED_EVENT_CHANNEL.
      onAppearanceChange: broadcastAppearanceChange,
    });
  }
  return desktopSettingsService;
}

export function resetDesktopSettingsServiceForTests(): void {
  desktopSettingsService = undefined;
}
