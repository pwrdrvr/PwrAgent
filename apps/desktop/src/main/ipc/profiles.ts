import { ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import type {
  CreateDesktopPwrAgentProfileRequest,
  CreateDesktopPwrAgentProfileResponse,
  DeleteDesktopPwrAgentProfileRequest,
  DeleteDesktopPwrAgentProfileResponse,
  ListDesktopPwrAgentProfilesResponse,
  OpenDesktopPwrAgentProfileRequest,
  OpenDesktopPwrAgentProfileResponse,
  SetDesktopPwrAgentProfileCodexProfileRequest,
  SetDesktopPwrAgentProfileCodexProfileResponse,
  SetDefaultDesktopPwrAgentProfileRequest,
  SetDefaultDesktopPwrAgentProfileResponse,
} from "@pwragent/shared";
import {
  PROFILES_CREATE_CHANNEL,
  PROFILES_DELETE_CHANNEL,
  PROFILES_LIST_CHANNEL,
  PROFILES_OPEN_CHANNEL,
  PROFILES_SET_CODEX_PROFILE_CHANNEL,
  PROFILES_SET_DEFAULT_CHANNEL,
} from "../../shared/ipc";
import {
  PWRAGENT_PROFILE_ENV,
  assertProfileCanBeDeleted,
  deleteProfile,
  ensureProfileExists,
  ensureNamedProfileExists,
  forgetDeletedProfile,
  isValidProfileName,
  readProfilesRegistry,
  resolveActiveProfileName,
  resolveDefaultProfileName,
  resolveProfileDir,
  setDefaultProfileName,
} from "../profile";
import {
  applyDesktopSettingsPatch,
  readDesktopSettingsConfig,
  resolveDesktopConfigPath,
} from "../settings/desktop-config";
import { discoverCodexAuthProfiles } from "../settings/codex-profiles";

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
        codexProfile: readPwrAgentProfileCodexProfile(profile.name),
      })),
  };
}

function readPwrAgentProfileCodexProfile(profileName: string) {
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

  const args = replaceProfileLaunchArgs(
    process.defaultApp ? process.argv.slice(1) : [],
    profile,
  );
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

export function replaceProfileLaunchArgs(
  args: readonly string[],
  profile: string,
): string[] {
  const nextArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      index += 1;
      continue;
    }
    if (arg?.startsWith("--profile=")) {
      continue;
    }
    nextArgs.push(arg);
  }
  nextArgs.push("--profile", profile);
  return nextArgs;
}

export function createDesktopPwrAgentProfile(
  request: CreateDesktopPwrAgentProfileRequest,
): CreateDesktopPwrAgentProfileResponse {
  const profile = request.profile.trim();
  if (!isValidProfileName(profile)) {
    throw new Error(`Invalid profile name "${profile}".`);
  }
  const result = ensureNamedProfileExists(profile);
  return {
    profile,
    profileDir: result.profileDir,
    created: result.created,
  };
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

export async function deleteDesktopPwrAgentProfile(
  request: DeleteDesktopPwrAgentProfileRequest,
): Promise<DeleteDesktopPwrAgentProfileResponse> {
  const profile = request.profile.trim();
  const profileDir = assertProfileCanBeDeleted(profile);
  let movedToTrash = false;
  if (process.platform === "darwin" && fs.existsSync(profileDir)) {
    await shell.trashItem(profileDir);
    movedToTrash = true;
    forgetDeletedProfile(profile);
  } else {
    deleteProfile(profile);
  }
  return { deleted: true, movedToTrash, profile };
}

export async function setDesktopPwrAgentProfileCodexProfile(
  request: SetDesktopPwrAgentProfileCodexProfileRequest,
): Promise<SetDesktopPwrAgentProfileCodexProfileResponse> {
  const profile = request.profile.trim();
  const codexProfile = request.codexProfile.trim();
  if (!isValidProfileName(profile)) {
    throw new Error(`Invalid profile name "${profile}".`);
  }
  if (codexProfile && !isValidProfileName(codexProfile)) {
    throw new Error(`Invalid Codex profile name "${codexProfile}".`);
  }

  ensureProfileExists({
    env: {
      ...process.env,
      [PWRAGENT_PROFILE_ENV]: profile,
    },
  });
  applyDesktopSettingsPatch(resolveDesktopConfigPath({ cliProfile: profile }), {
    models: { codex: { profile: codexProfile } },
  });

  return { profile, codexProfile };
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

  ipcMain.removeHandler(PROFILES_CREATE_CHANNEL);
  ipcMain.handle(
    PROFILES_CREATE_CHANNEL,
    async (
      _event,
      request: CreateDesktopPwrAgentProfileRequest,
    ): Promise<CreateDesktopPwrAgentProfileResponse> =>
      createDesktopPwrAgentProfile(request),
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
      await deleteDesktopPwrAgentProfile(request),
  );

  ipcMain.removeHandler(PROFILES_SET_CODEX_PROFILE_CHANNEL);
  ipcMain.handle(
    PROFILES_SET_CODEX_PROFILE_CHANNEL,
    async (
      _event,
      request: SetDesktopPwrAgentProfileCodexProfileRequest,
    ): Promise<SetDesktopPwrAgentProfileCodexProfileResponse> =>
      await setDesktopPwrAgentProfileCodexProfile(request),
  );
}

export function disposeProfilesIpcHandlers(): void {
  ipcMain.removeHandler(PROFILES_LIST_CHANNEL);
  ipcMain.removeHandler(PROFILES_OPEN_CHANNEL);
  ipcMain.removeHandler(PROFILES_CREATE_CHANNEL);
  ipcMain.removeHandler(PROFILES_SET_DEFAULT_CHANNEL);
  ipcMain.removeHandler(PROFILES_DELETE_CHANNEL);
  ipcMain.removeHandler(PROFILES_SET_CODEX_PROFILE_CHANNEL);
}
