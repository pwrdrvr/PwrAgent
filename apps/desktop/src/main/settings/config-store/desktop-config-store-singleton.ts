import { getMainLogger } from "../../log";
import { resolveBootstrapProfilePath } from "../../profile";
import { getAppStateDb, getAppStateMode } from "../../state/app-state";
import { resolveDesktopConfigPath } from "../desktop-config";
import { DesktopConfigStore } from "./desktop-config-store";

let desktopConfigStore: DesktopConfigStore | undefined;

export function getDesktopConfigStore(): DesktopConfigStore {
  if (!desktopConfigStore) {
    const bootstrap = getAppStateMode() === "bootstrap";
    const configPath = bootstrap
      ? resolveBootstrapProfilePath("config.toml")
      : resolveDesktopConfigPath();
    const log = getMainLogger("pwragent:config-store");
    desktopConfigStore = new DesktopConfigStore({
      configPath,
      stateDb: getAppStateDb(),
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
