import type { DesktopSettingsConfigPatch } from "@pwragent/shared";
import {
  applyDesktopSettingsPatch,
  readDesktopSettingsConfig,
  type DesktopSettingsConfig,
} from "../desktop-config";

/**
 * Explicit-path profile/bootstrap operations that cannot use the active
 * profile store. Keeping them inside config-store prevents profile workflows
 * from acquiring the raw parser/writer as a general reload escape hatch.
 */
export function readProfileConfigFile(
  configPath: string,
): DesktopSettingsConfig {
  return readDesktopSettingsConfig(configPath);
}

export function writeProfileConfigPatch(
  configPath: string,
  patch: DesktopSettingsConfigPatch,
): void {
  applyDesktopSettingsPatch(configPath, patch);
}
