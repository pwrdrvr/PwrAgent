import { getMainLogger } from "../../log";
import { resolveBootstrapProfilePath } from "../../profile";
import { createDesktopConfigSnapshotStorage, getAppStateMode } from "../../storage/desktop-settings-storage";
import { resolveDesktopConfigPath } from "../desktop-config";
import { DesktopConfigStore } from "./desktop-config-store";

let desktopConfigStore: DesktopConfigStore | undefined;

export function initializeDesktopConfigStore(): DesktopConfigStore {
  if (!desktopConfigStore) {
    const bootstrap = getAppStateMode() === "bootstrap";
    const configPath = bootstrap
      ? resolveBootstrapProfilePath("config.toml")
      : resolveDesktopConfigPath();
    const log = getMainLogger("pwragent:config-store");
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
