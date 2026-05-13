import { ipcMain } from "electron";
import { spawn } from "node:child_process";
import type {
  DeleteDesktopPwrAgentProfileRequest,
  DeleteDesktopPwrAgentProfileResponse,
  ListDesktopPwrAgentProfilesResponse,
  OpenDesktopPwrAgentProfileRequest,
  OpenDesktopPwrAgentProfileResponse,
  SetDefaultDesktopPwrAgentProfileRequest,
  SetDefaultDesktopPwrAgentProfileResponse,
} from "@pwragent/shared";
import {
  PROFILES_DELETE_CHANNEL,
  PROFILES_LIST_CHANNEL,
  PROFILES_OPEN_CHANNEL,
  PROFILES_SET_DEFAULT_CHANNEL,
} from "../../shared/ipc";
import {
  PWRAGENT_PROFILE_ENV,
  deleteProfile,
  ensureProfileExists,
  isValidProfileName,
  readProfilesRegistry,
  resolveActiveProfileName,
  resolveDefaultProfileName,
  resolveProfileDir,
  setDefaultProfileName,
} from "../profile";

export function listDesktopPwrAgentProfiles(): ListDesktopPwrAgentProfilesResponse {
  const activeProfile = resolveActiveProfileName();
  const defaultProfile = resolveDefaultProfileName();
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
  if (!byName.has(defaultProfile)) {
    byName.set(defaultProfile, { name: defaultProfile });
  }

  return {
    activeProfile,
    defaultProfile,
    profiles: [...byName.values()]
      .sort((left, right) => {
        if (left.name === activeProfile) return -1;
        if (right.name === activeProfile) return 1;
        if (left.name === defaultProfile) return -1;
        if (right.name === defaultProfile) return 1;
        return left.name.localeCompare(right.name);
      })
      .map((profile) => ({
        name: profile.name,
        displayName: profile.display_name,
        lastUsed: profile.last_used,
        active: profile.name === activeProfile,
        default: profile.name === defaultProfile,
        profileDir: resolveProfileDir(profile.name),
        canDelete: profile.name !== activeProfile && profile.name !== "default",
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

export function setDefaultDesktopPwrAgentProfile(
  request: SetDefaultDesktopPwrAgentProfileRequest,
): SetDefaultDesktopPwrAgentProfileResponse {
  const profile = request.profile.trim();
  if (!isValidProfileName(profile)) {
    throw new Error(`Invalid profile name "${profile}".`);
  }
  return { profile: setDefaultProfileName(profile) };
}

export function deleteDesktopPwrAgentProfile(
  request: DeleteDesktopPwrAgentProfileRequest,
): DeleteDesktopPwrAgentProfileResponse {
  const profile = request.profile.trim();
  deleteProfile(profile);
  return { deleted: true, profile };
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

  ipcMain.removeHandler(PROFILES_SET_DEFAULT_CHANNEL);
  ipcMain.handle(
    PROFILES_SET_DEFAULT_CHANNEL,
    async (
      _event,
      request: SetDefaultDesktopPwrAgentProfileRequest,
    ): Promise<SetDefaultDesktopPwrAgentProfileResponse> =>
      setDefaultDesktopPwrAgentProfile(request),
  );

  ipcMain.removeHandler(PROFILES_DELETE_CHANNEL);
  ipcMain.handle(
    PROFILES_DELETE_CHANNEL,
    async (
      _event,
      request: DeleteDesktopPwrAgentProfileRequest,
    ): Promise<DeleteDesktopPwrAgentProfileResponse> =>
      deleteDesktopPwrAgentProfile(request),
  );
}

export function disposeProfilesIpcHandlers(): void {
  ipcMain.removeHandler(PROFILES_LIST_CHANNEL);
  ipcMain.removeHandler(PROFILES_OPEN_CHANNEL);
  ipcMain.removeHandler(PROFILES_SET_DEFAULT_CHANNEL);
  ipcMain.removeHandler(PROFILES_DELETE_CHANNEL);
}
