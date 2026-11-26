import fs from "node:fs";
import { parseDesktopSettingsToml, resolveDesktopConfigPath } from "../desktop-config";
import { getExistingDesktopConfigStore } from "./desktop-config-store-singleton";
import { hashConfigText } from "./raw-config-file";

let lastRead: {
  configPath: string;
  contentHash: string;
  ids: readonly string[];
} | undefined;

export function readSavedTelegramConnectionIds(): readonly string[] {
  const configPath = resolveDesktopConfigPath();
  if (!fs.existsSync(configPath)) {
    lastRead = undefined;
    return [];
  }

  // Offline binding actions can run before the watcher sees a peer's save.
  // Read the file on every call and reuse a parse only for matching contents.
  const text = fs.readFileSync(configPath, "utf8");
  const contentHash = hashConfigText(text);
  if (lastRead?.configPath === configPath && lastRead.contentHash === contentHash) {
    return lastRead.ids;
  }
  const messaging = getExistingDesktopConfigStore()?.readMessagingForSavedContent(configPath, contentHash)
    ?? parseDesktopSettingsToml(text, configPath).messaging;
  const ids = (messaging?.telegram?.connections ?? [])
    .filter((connection) => !connection.legacy)
    .map((connection) => connection.id);
  lastRead = { configPath, contentHash, ids };
  return ids;
}
