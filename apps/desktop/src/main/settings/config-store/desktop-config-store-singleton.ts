import { getMainLogger } from "../../log";
import { resolveBootstrapProfilePath } from "../../profile";
import { createDesktopConfigSnapshotStorage, getAppStateMode } from "../../storage/desktop-settings-storage";
import { resolveDesktopConfigPath, retireLegacyDesktopSettings } from "../desktop-config";
import { DesktopConfigStore } from "./desktop-config-store";

let desktopConfigStore: DesktopConfigStore | undefined;

export function initializeDesktopConfigStore(options?: {
  /** Retires legacy keys whose release series has passed; see `LEGACY_SETTINGS_RETIREMENTS`. */
  appVersion?: string;
}): DesktopConfigStore {
  if (!desktopConfigStore) {
    const bootstrap = getAppStateMode() === "bootstrap";
    const configPath = bootstrap
      ? resolveBootstrapProfilePath("config.toml")
      : resolveDesktopConfigPath();
    const log = getMainLogger("pwragent:config-store");
    if (options?.appVersion) {
      // Before the store's first read and its watcher, so neither sees the
      // pre-cleanup file. A failure leaves the legacy keys for the next launch.
      try {
        const result = retireLegacyDesktopSettings(configPath, options.appVersion);
        if (result.changed) {
          log.info("retired legacy settings", { retired: result.retired });
        }
      } catch (error) {
        log.warn("could not retire legacy settings", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    desktopConfigStore = new DesktopConfigStore({
      configPath,
      storage: createDesktopConfigSnapshotStorage(),
      onDiagnostic: (event) => {
        log.debug("config-store-operation", event);
      },
    });
    desktopConfigStore.startWatching();
  }
  return desktopConfigStore;
}

export function getExistingDesktopConfigStore(): DesktopConfigStore | undefined {
  return desktopConfigStore;
}

export function disposeDesktopConfigStore(): void {
  desktopConfigStore?.dispose();
  desktopConfigStore = undefined;
}

/** Only startOwnerServices constructs the process owner. */
export function getDesktopConfigStore(): DesktopConfigStore {
  if (!desktopConfigStore) throw new Error("getDesktopConfigStore is unavailable before startOwnerServices().");
  return desktopConfigStore;
}
