import { app, safeStorage } from "electron";
import { DesktopSettingsService } from "./desktop-settings-service";
import { DbBackedSafeStorageSecretStore } from "../state/secret-store-sqlite";
import { getAppStateDb, getAppStateMode } from "../state/app-state";
import { broadcastAppearanceChange } from "../appearance-broadcast";
import { resolveBootstrapProfilePath } from "../profile";
import {
  isE2eMemorySecretStorageEnabled,
  MemoryDesktopSecretStore,
} from "./desktop-secret-store";
import { ensureManagedCodexRuntime } from "../codex-managed-runtime";
import { SETTINGS_RUNTIME_CHANGED_EVENT_CHANNEL } from "../../shared/ipc";
import { subscribersForChannel } from "../window-channels";
import {
  disposeDesktopConfigStore,
  getDesktopConfigStore,
} from "./config-store/desktop-config-store-singleton";
import { resolveDesktopConfigPath } from "./desktop-config";

let desktopSettingsService: DesktopSettingsService | undefined;

export {
  disposeDesktopConfigStore,
  getDesktopConfigStore,
  getExistingDesktopConfigStore,
} from "./config-store/desktop-config-store-singleton";

export function getDesktopSettingsService(): DesktopSettingsService {
  if (!desktopSettingsService) {
    // In bootstrap mode the settings service reads/writes the
    // bootstrap profile's `config.toml`. On graduation the wizard
    // exports those values out of the bootstrap config and applies
    // them to the operator's chosen real profile before tearing the
    // bootstrap state down.
    const bootstrap = getAppStateMode() === "bootstrap";
    const configPath = bootstrap
      ? resolveBootstrapProfilePath("config.toml")
      : resolveDesktopConfigPath();
    const configStore = getDesktopConfigStore();
    const secretStore = isE2eMemorySecretStorageEnabled(
      process.env,
      app.isPackaged,
    )
      ? new MemoryDesktopSecretStore()
      : new DbBackedSafeStorageSecretStore(safeStorage, getAppStateDb());
    desktopSettingsService = new DesktopSettingsService({
      defaultDeveloperMode: app.isPackaged === true ? false : true,
      configStore,
      // Dev follows the newest downstream build automatically. Packaged apps
      // keep managed downloads opt-in until the downstream signing lane is
      // configured and publishing signed Apple/Windows assets.
      defaultManagedGrokBuilds: app.isPackaged !== true,
      ensureManagedCodexRuntime: async ({
        checkMode,
        signal,
        waitForUpdate,
      }) =>
        await ensureManagedCodexRuntime({
          checkMode,
          requirePlatformSignature: app.isPackaged === true,
          signal,
          waitForUpdate,
        }),
      resolveAppVersion: () => app.getVersion(),
      secretStore,
      configPath,
      // Production wiring: settings writes that touch `[general.appearance]`
      // fan out to every open window via the broadcaster, which sends to
      // every subscriber of APPEARANCE_CHANGED_EVENT_CHANNEL.
      onAppearanceChange: broadcastAppearanceChange,
      onManagedCodexRuntimeSwitchComplete: () => {
        for (const webContents of subscribersForChannel(
          SETTINGS_RUNTIME_CHANGED_EVENT_CHANNEL,
        )) {
          webContents.send(SETTINGS_RUNTIME_CHANGED_EVENT_CHANNEL);
        }
      },
    });
  }
  return desktopSettingsService;
}

export function resetDesktopSettingsServiceForTests(): void {
  desktopSettingsService = undefined;
  disposeDesktopConfigStore();
}
