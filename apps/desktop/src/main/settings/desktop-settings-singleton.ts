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
import { setGitCommandResolver } from "../git-command";

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
      onManagedCodexRuntimeSwitchComplete: () => {
        for (const webContents of subscribersForChannel(
          SETTINGS_RUNTIME_CHANGED_EVENT_CHANNEL,
        )) {
          webContents.send(SETTINGS_RUNTIME_CHANGED_EVENT_CHANNEL);
        }
      },
    });
    // Every main-process git spawn resolves through this. Installed here
    // rather than in `index.ts` so the wiring cannot be missed by a code
    // path that reaches settings without going through app startup — and
    // so it is torn down with the service in tests.
    const service = desktopSettingsService;
    setGitCommandResolver(() => service.resolveGitCommandPreference());
    configStore.subscribe(["general"], ({ values }) => {
      broadcastAppearanceChange(values.general.appearance);
    });
    configStore.subscribeUpdates(
      ({ version, configRevision, changedDomains }) => {
        const payload = {
          version,
          configRevision,
          changedDomains,
        };
        for (const webContents of subscribersForChannel(
          SETTINGS_RUNTIME_CHANGED_EVENT_CHANNEL,
        )) {
          webContents.send(SETTINGS_RUNTIME_CHANGED_EVENT_CHANNEL, payload);
        }
      },
    );
  }
  return desktopSettingsService;
}

export function resetDesktopSettingsServiceForTests(): void {
  desktopSettingsService = undefined;
  setGitCommandResolver(undefined);
  disposeDesktopConfigStore();
}
