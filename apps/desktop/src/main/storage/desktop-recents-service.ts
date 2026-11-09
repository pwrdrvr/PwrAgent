import type { ModelSettingsRecent, ModelSettingsRecentsScope } from "@pwragent/shared";
import { getAppStateDb } from "../state/app-state";
import { listModelSettingsRecents as listModels, recordModelSettingsRecent as recordModel } from "./model-settings-recents-store";
import { listRecentFileReferencePaths as listFiles, recordRecentFileReferencePaths as recordFiles } from "../state/recent-file-references-store";

export function listModelSettingsRecents(scope: ModelSettingsRecentsScope): ModelSettingsRecent[] {
  return listModels(getAppStateDb(), scope);
}
export function recordModelSettingsRecent(scope: ModelSettingsRecentsScope, recent: ModelSettingsRecent): void {
  recordModel(getAppStateDb(), scope, recent);
}
export function listRecentFileReferencePaths(): string[] { return listFiles(getAppStateDb()); }
export function recordRecentFileReferencePaths(paths: string[]): void { recordFiles(getAppStateDb(), paths); }
