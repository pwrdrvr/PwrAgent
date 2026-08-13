import { discoverCodexAuthProfiles } from "@pwrdrvr/codex-discovery";
import type { DesktopCodexAuthProfileCandidate } from "@pwragent/shared";
import {
  readDesktopSettingsConfig,
  resolveDesktopConfigPath,
} from "./settings/desktop-config";

export function readPwrAgentProfileCodexProfile(
  profileName: string,
): DesktopCodexAuthProfileCandidate {
  let configuredProfile: string | undefined;
  try {
    const config = readDesktopSettingsConfig(
      resolveDesktopConfigPath({ cliProfile: profileName }),
    );
    configuredProfile = config.models?.codex?.profile;
  } catch {
    configuredProfile = undefined;
  }
  const discovery = discoverCodexAuthProfiles({ configuredProfile });
  return discovery.profiles.find((profile) => profile.selected)
    ?? discovery.profiles[0]!;
}
