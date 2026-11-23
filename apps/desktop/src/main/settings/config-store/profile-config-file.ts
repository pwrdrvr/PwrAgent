import type { DesktopSettingsConfigPatch } from "@pwragent/shared/contracts/settings";
import {
  DEFAULT_GITHUB_ENTERPRISE_HOSTS,
  applyDesktopSettingsPatch,
  readDesktopSettingsConfig,
  type DesktopSettingsConfig,
} from "../desktop-config";

export { requireSavedMessagingSafetyAcknowledgment } from "./raw-config-file";

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

/** Copy bootstrap settings and keep the target's existing provider enables. */
export function writeBootstrapConfigToProfile(
  configPath: string,
  config: DesktopSettingsConfig,
): void {
  const { githubEnterpriseHosts, ...git } = config.git ?? {};
  const patch: DesktopSettingsConfigPatch = { ...config, git };
  if (githubEnterpriseHosts?.source === "config" && !githubEnterpriseHosts.error) {
    // The bootstrap projection describes a different file. Use the
    // destination's revision so a concurrent edit there is still protected.
    const current = readDesktopSettingsConfig(configPath).git?.githubEnterpriseHosts ?? DEFAULT_GITHUB_ENTERPRISE_HOSTS;
    patch.git = { ...git, githubEnterpriseHosts: { hosts: githubEnterpriseHosts.value, expectedRevision: current.revision } };
  }
  applyDesktopSettingsPatch(configPath, patch, { omitUnacknowledgedProviderEnables: true });
}
