import { ipcMain } from "electron";
import { spawn } from "node:child_process";
import type {
  ListDesktopPwrAgentProfilesResponse,
  OpenDesktopPwrAgentProfileRequest,
  OpenDesktopPwrAgentProfileResponse,
} from "@pwragent/shared";
import {
  PROFILES_LIST_CHANNEL,
  PROFILES_OPEN_CHANNEL,
} from "../../shared/ipc";
import {
  PWRAGENT_PROFILE_ENV,
  ensureProfileExists,
  isValidProfileName,
  readProfilesRegistry,
  resolveActiveProfileName,
} from "../profile";

export function listDesktopPwrAgentProfiles(): ListDesktopPwrAgentProfilesResponse {
  const activeProfile = resolveActiveProfileName();
  const registry = readProfilesRegistry();
  const byName = new Map(
    registry.profiles.map((profile) => [profile.name, profile]),
  );
  if (!byName.has(activeProfile)) {
    byName.set(activeProfile, { name: activeProfile });
  }
  if (!byName.has("default")) {
    byName.set("default", { name: "default" });
  }

  return {
    activeProfile,
    profiles: [...byName.values()]
      .sort((left, right) => {
        if (left.name === activeProfile) return -1;
        if (right.name === activeProfile) return 1;
        return left.name.localeCompare(right.name);
      })
      .map((profile) => ({
        name: profile.name,
        displayName: profile.display_name,
        lastUsed: profile.last_used,
        active: profile.name === activeProfile,
      })),
  };
}

export function openDesktopPwrAgentProfile(
  request: OpenDesktopPwrAgentProfileRequest,
): OpenDesktopPwrAgentProfileResponse {
  const profile = request.profile.trim();
  if (!isValidProfileName(profile)) {
    throw new Error(`Invalid profile name "${profile}".`);
  }

  const activeProfile = resolveActiveProfileName();
  if (profile === activeProfile) {
    return { opened: false, profile, reason: "active" };
  }

  ensureProfileExists({
    env: {
      ...process.env,
      [PWRAGENT_PROFILE_ENV]: profile,
    },
  });

  const args = process.defaultApp ? process.argv.slice(1) : [];
  const child = spawn(process.execPath, args, {
    detached: true,
    env: {
      ...process.env,
      [PWRAGENT_PROFILE_ENV]: profile,
    },
    stdio: "ignore",
  });
  child.unref();

  return { opened: true, profile };
}

export function registerProfilesIpcHandlers(): void {
  ipcMain.removeHandler(PROFILES_LIST_CHANNEL);
  ipcMain.handle(
    PROFILES_LIST_CHANNEL,
    async (): Promise<ListDesktopPwrAgentProfilesResponse> =>
      listDesktopPwrAgentProfiles(),
  );

  ipcMain.removeHandler(PROFILES_OPEN_CHANNEL);
  ipcMain.handle(
    PROFILES_OPEN_CHANNEL,
    async (
      _event,
      request: OpenDesktopPwrAgentProfileRequest,
    ): Promise<OpenDesktopPwrAgentProfileResponse> =>
      openDesktopPwrAgentProfile(request),
  );
}

export function disposeProfilesIpcHandlers(): void {
  ipcMain.removeHandler(PROFILES_LIST_CHANNEL);
  ipcMain.removeHandler(PROFILES_OPEN_CHANNEL);
}
