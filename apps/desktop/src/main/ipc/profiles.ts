import { ipcMain, safeStorage, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  CreateDesktopPwrAgentProfileRequest,
  CreateDesktopPwrAgentProfileResponse,
  DeleteDesktopPwrAgentProfileRequest,
  DeleteDesktopPwrAgentProfileResponse,
  GraduateDesktopBootstrapToProfileRequest,
  GraduateDesktopBootstrapToProfileResponse,
  ListDesktopPwrAgentProfilesResponse,
  OpenDesktopPwrAgentProfileRequest,
  OpenDesktopPwrAgentProfileResponse,
  SetDesktopPwrAgentProfileCodexProfileRequest,
  SetDesktopPwrAgentProfileCodexProfileResponse,
  SetDefaultDesktopPwrAgentProfileRequest,
  SetDefaultDesktopPwrAgentProfileResponse,
  WriteDesktopSecretsToProfileRequest,
  WriteDesktopSecretsToProfileResponse,
} from "@pwragent/shared";
import {
  PROFILES_CREATE_CHANNEL,
  PROFILES_DELETE_CHANNEL,
  PROFILES_GRADUATE_BOOTSTRAP_CHANNEL,
  PROFILES_LIST_CHANNEL,
  PROFILES_OPEN_CHANNEL,
  PROFILES_SET_CODEX_PROFILE_CHANNEL,
  PROFILES_SET_DEFAULT_CHANNEL,
  PROFILES_WRITE_SECRETS_CHANNEL,
} from "../../shared/ipc";
import { StateDb } from "../state/state-db";
import {
  PWRAGENT_PROFILE_ENV,
  assertProfileCanBeDeleted,
  deleteProfile,
  ensureProfileExists,
  ensureNamedProfileExists,
  forgetDeletedProfile,
  isValidProfileName,
  readProfilesRegistry,
  requestProfileInstanceFocus,
  resolveActiveProfileName,
  resolveBootstrapProfilePath,
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
import { getAppStateMode } from "../state/app-state";

type ProfilesIpcHandlerOptions = {
  onProfilesChanged?: () => void;
};

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

  if (requestProfileInstanceFocus(profile)) {
    return { opened: false, profile, reason: "focused" };
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

  // First-run wizard path: when the wizard provisions a paired profile
  // (Isolated or Multiple mode), the operator has *just* gone through
  // onboarding to create this profile. Seed `onboarding.completed =
  // true` on the new profile's config so the wizard doesn't auto-fire
  // again the moment the operator switches into it. The default of
  // `false` (per #500) still applies to profiles created from any
  // other surface (Settings → Profiles, `PWRAGENT_PROFILE=<new>`, etc.).
  if (request.seedOnboardingCompleted) {
    applyDesktopSettingsPatch(
      resolveDesktopConfigPath({ cliProfile: profile }),
      {
        onboarding: { completed: true, completedSource: "wizard" },
      },
    );
  }
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

/**
 * Graduate the bootstrap profile's settings into a real profile.
 *
 * Called by the wizard's Finish path. Safe to call unconditionally:
 * when the main process isn't in bootstrap mode, this returns
 * `{ graduated: false, reason: "not-bootstrap-mode" }` and does
 * nothing. The wizard always calls it; the main process figures out
 * whether there's actually anything to graduate.
 *
 * What gets copied:
 *   - `general` (developerMode, appearance, codexProfileModel,
 *     messagingAcknowledgment)
 *   - `experimental`, `imageUploads`, `updates`, `messaging` —
 *     everything the operator might have set in the wizard or
 *     bootstrap session.
 *
 * What does NOT get copied:
 *   - `onboarding` — the target profile was just created by the
 *     wizard via `createPwrAgentProfile({ seedOnboardingCompleted:
 *     true })`, which already wrote `[onboarding] completed = true`.
 *     Copying the bootstrap profile's `completed = false` over that
 *     would re-fire the wizard on the next launch.
 *   - Per-profile state (state.db rows, runtime markers). Bootstrap
 *     state.db is intentionally throwaway. Operator's wizard
 *     choices that go through `replaceSecret` (e.g. xAI API key)
 *     are stored in the keychain via DbBackedSafeStorageSecretStore,
 *     keyed on the active state.db. Graduating secrets is a Task E
 *     follow-up — for now, the operator re-enters them in the new
 *     profile's Settings → Models if needed.
 *
 * On success: also writes `profiles.toml::default_profile =
 * targetProfile`, so the next boot opens directly into the chosen
 * profile without re-firing the wizard. The `.bootstrap/` directory
 * stays on disk; the next boot's `cleanupBootstrapProfile()` call
 * removes it.
 */
export function graduateDesktopBootstrapToProfile(
  request: GraduateDesktopBootstrapToProfileRequest,
): GraduateDesktopBootstrapToProfileResponse {
  const targetProfile = request.targetProfile.trim();
  if (!isValidProfileName(targetProfile)) {
    throw new Error(`Invalid profile name "${targetProfile}".`);
  }

  if (getAppStateMode() !== "bootstrap") {
    return {
      graduated: false,
      reason: "not-bootstrap-mode",
      targetProfile,
    };
  }

  const bootstrapConfigPath = resolveBootstrapProfilePath("config.toml");
  if (!fs.existsSync(bootstrapConfigPath)) {
    return {
      graduated: false,
      reason: "no-bootstrap-config",
      targetProfile,
    };
  }

  // Ensure the target profile dir exists (idempotent if the wizard
  // already called createPwrAgentProfile during the name step).
  ensureNamedProfileExists(targetProfile);

  // Strip the onboarding section — the target profile already has
  // the right marker seeded by createPwrAgentProfile(seedOnboardingCompleted).
  const bootstrapConfig = readDesktopSettingsConfig(bootstrapConfigPath);
  const { onboarding: _drop, ...patch } = bootstrapConfig;
  void _drop;

  applyDesktopSettingsPatch(
    resolveDesktopConfigPath({ cliProfile: targetProfile }),
    patch,
  );

  // The chosen profile becomes the registry default so the next
  // boot opens directly into it (no wizard, no .bootstrap/ re-fire).
  setDefaultProfileName(targetProfile);

  return { graduated: true, targetProfile };
}

/**
 * Write secrets directly to a specific PwrAgent profile's keychain
 * (its state.db `secrets` table), encrypting each value via
 * `safeStorage` first. Used by the wizard's Finish path to graduate
 * in-memory secret values (xAI API key, messaging tokens) collected
 * during the wizard to the operator's chosen real profile —
 * specifically to support per-profile xAI keys in Multiple mode and
 * to avoid stranding secrets in `.bootstrap/state.db` when the
 * wizard runs in bootstrap mode.
 *
 * Implementation notes:
 *   - Opens the target profile's state.db transiently (not via the
 *     singleton) so this can run in any app-state mode, including
 *     bootstrap mode where the singleton is bound to `.bootstrap/`.
 *   - Closes the transient DB even on error to avoid leaking
 *     better-sqlite3 handles.
 *   - Empty string values delete the secret (clears stale entries).
 *   - Unencrypted-storage edge cases (basic_text / unavailable) are
 *     surfaced as a thrown error rather than silently writing
 *     plaintext — caller decides whether to retry or warn.
 */
export function writeDesktopSecretsToProfile(
  request: WriteDesktopSecretsToProfileRequest,
): WriteDesktopSecretsToProfileResponse {
  const profile = request.profile.trim();
  if (!isValidProfileName(profile)) {
    throw new Error(`Invalid profile name "${profile}".`);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secret storage encryption is unavailable.");
  }

  const profileDir = resolveProfileDir(profile);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile "${profile}" does not exist.`);
  }

  const dbPath = path.join(profileDir, "state", "state.db");
  // Ensure the state dir exists. For a freshly-created paired profile
  // the wizard just called ensureNamedProfileExists which seeded
  // `<profile>/state/`, so this is normally a no-op — but graduating
  // to an existing profile that's never been opened (rare, but
  // possible via Settings → Profiles "Create") needs it.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const stateDb = StateDb.open(dbPath, { profileName: profile });
  const written: string[] = [];
  try {
    for (const [name, value] of Object.entries(request.secrets)) {
      if (typeof name !== "string" || name.length === 0) continue;
      if (typeof value !== "string") continue;
      if (value.length === 0) {
        stateDb.deleteSecret(name);
        written.push(name);
        continue;
      }
      const ciphertext = safeStorage.encryptString(value);
      stateDb.setSecret(name, ciphertext);
      written.push(name);
    }
  } finally {
    stateDb.close();
  }

  return { profile, written };
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

export function registerProfilesIpcHandlers(
  options: ProfilesIpcHandlerOptions = {},
): void {
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
    ): Promise<CreateDesktopPwrAgentProfileResponse> => {
      const response = createDesktopPwrAgentProfile(request);
      options.onProfilesChanged?.();
      return response;
    },
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
    ): Promise<DeleteDesktopPwrAgentProfileResponse> => {
      const response = await deleteDesktopPwrAgentProfile(request);
      options.onProfilesChanged?.();
      return response;
    },
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

  ipcMain.removeHandler(PROFILES_GRADUATE_BOOTSTRAP_CHANNEL);
  ipcMain.handle(
    PROFILES_GRADUATE_BOOTSTRAP_CHANNEL,
    async (
      _event,
      request: GraduateDesktopBootstrapToProfileRequest,
    ): Promise<GraduateDesktopBootstrapToProfileResponse> => {
      const response = graduateDesktopBootstrapToProfile(request);
      if (response.graduated) {
        options.onProfilesChanged?.();
      }
      return response;
    },
  );

  ipcMain.removeHandler(PROFILES_WRITE_SECRETS_CHANNEL);
  ipcMain.handle(
    PROFILES_WRITE_SECRETS_CHANNEL,
    async (
      _event,
      request: WriteDesktopSecretsToProfileRequest,
    ): Promise<WriteDesktopSecretsToProfileResponse> =>
      writeDesktopSecretsToProfile(request),
  );
}

export function disposeProfilesIpcHandlers(): void {
  ipcMain.removeHandler(PROFILES_LIST_CHANNEL);
  ipcMain.removeHandler(PROFILES_OPEN_CHANNEL);
  ipcMain.removeHandler(PROFILES_CREATE_CHANNEL);
  ipcMain.removeHandler(PROFILES_SET_DEFAULT_CHANNEL);
  ipcMain.removeHandler(PROFILES_DELETE_CHANNEL);
  ipcMain.removeHandler(PROFILES_SET_CODEX_PROFILE_CHANNEL);
  ipcMain.removeHandler(PROFILES_GRADUATE_BOOTSTRAP_CHANNEL);
  ipcMain.removeHandler(PROFILES_WRITE_SECRETS_CHANNEL);
}
