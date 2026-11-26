import { resolveDesktopConfigPath } from "../desktop-config";
import { readSavedProfileConfig } from "./raw-config-file";

export function readSavedTelegramConnectionIds(): readonly string[] {
  // Offline binding actions can run before the watcher sees a peer's save.
  const config = readSavedProfileConfig(resolveDesktopConfigPath());
  return (config.messaging?.telegram?.connections ?? [])
    .filter((connection) => !connection.legacy)
    .map((connection) => connection.id);
}
