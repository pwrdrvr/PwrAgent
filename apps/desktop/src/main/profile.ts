import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const PWRAGENT_PROFILE_ENV = "PWRAGENT_PROFILE";
export const PWRAGENT_HOME_ENV = "PWRAGENT_HOME";

const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_NAMES = new Set(["con", "nul", "aux", "prn", ".", ".."]);
const PROFILE_RUNTIME_HEARTBEAT_INTERVAL_MS = 10_000;
const PROFILE_RUNTIME_HEARTBEAT_TTL_MS = 45_000;

export type ProfileEntry = {
  name: string;
  display_name?: string;
  last_used?: string;
};

export type ProfilesRegistry = {
  default_profile?: string;
  profiles: ProfileEntry[];
};

export type ProfileRuntimeHeartbeat = {
  markerPath: string;
  stop: () => void;
};

export type ProfileFocusRequestWatcher = {
  stop: () => void;
};

export type ProfileRuntimeMarker = {
  instanceId: string;
  processId: number;
  profileName: string;
  startedAt: number;
  heartbeatAt: number;
};

let cachedProcessActiveProfileName: string | undefined;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_REGEX.test(name) && !RESERVED_NAMES.has(name);
}

export function resolvePwragentRoot(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = options?.env ?? process.env;
  const pwragentHome = env[PWRAGENT_HOME_ENV]?.trim();
  if (pwragentHome) return path.resolve(pwragentHome);
  const homeDir = options?.homeDir ?? os.homedir();
  return path.join(homeDir, ".pwragent");
}

export function resolveActiveProfileName(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliProfile?: string;
  argv?: readonly string[];
}): string {
  if (!options) {
    cachedProcessActiveProfileName ??= resolveActiveProfileNameUncached();
    return cachedProcessActiveProfileName;
  }
  return resolveActiveProfileNameUncached(options);
}

export function resetCachedActiveProfileNameForTests(): void {
  cachedProcessActiveProfileName = undefined;
}

function resolveActiveProfileNameUncached(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliProfile?: string;
  argv?: readonly string[];
}): string {
  const cliProfile =
    options?.cliProfile?.trim() || readProfileArg(options?.argv)?.trim();
  if (cliProfile) {
    const name = cliProfile.trim();
    if (!isValidProfileName(name)) {
      throw new Error(
        `Invalid profile name "${name}". Must match ${PROFILE_NAME_REGEX.source} and not be a reserved name.`,
      );
    }
    return name;
  }

  const env = options?.env ?? process.env;
  const envProfile = env[PWRAGENT_PROFILE_ENV]?.trim();
  if (envProfile) {
    if (!isValidProfileName(envProfile)) {
      throw new Error(
        `Invalid PWRAGENT_PROFILE="${envProfile}". Must match ${PROFILE_NAME_REGEX.source} and not be a reserved name.`,
      );
    }
    return envProfile;
  }

  return resolveDefaultProfileName(options);
}

export function resolveDefaultProfileName(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const defaultProfile = readProfilesRegistry(options).default_profile?.trim();
  if (defaultProfile && isValidProfileName(defaultProfile)) {
    return defaultProfile;
  }
  return "default";
}

export function resolveProfileDir(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): string {
  if (!isValidProfileName(profileName)) {
    throw new Error(
      `Invalid profile name "${profileName}". Must match ${PROFILE_NAME_REGEX.source} and not be a reserved name.`,
    );
  }
  return path.join(resolvePwragentRoot(options), "profiles", profileName);
}

export function resolveActiveProfileDir(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliProfile?: string;
  argv?: readonly string[];
}): string {
  const profileName = resolveActiveProfileName(options);
  return resolveProfileDir(profileName, options);
}

export function resolveActiveProfilePath(
  segment: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    cliProfile?: string;
    argv?: readonly string[];
  },
): string {
  return path.join(resolveActiveProfileDir(options), segment);
}

export function resolveProfilesRegistryPath(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  return path.join(resolvePwragentRoot(options), "profiles.toml");
}

export function readProfilesRegistry(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): ProfilesRegistry {
  const registryPath = resolveProfilesRegistryPath(options);
  if (!fs.existsSync(registryPath)) {
    return { profiles: [] };
  }
  return parseProfilesToml(fs.readFileSync(registryPath, "utf8"));
}

export function writeProfilesRegistry(
  registry: ProfilesRegistry,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): void {
  const registryPath = resolveProfilesRegistryPath(options);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, stringifyProfilesToml(registry), "utf8");
  fs.renameSync(tmpPath, registryPath);
}

export function ensureProfileExists(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliProfile?: string;
  argv?: readonly string[];
}): { profileDir: string; profileName: string; created: boolean } {
  const profileName = resolveActiveProfileName(options);
  return ensureNamedProfileExists(profileName, options);
}

export function readProfileArg(argv?: readonly string[]): string | undefined {
  const args = argv ?? process.argv;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error("--profile requires a profile name.");
      }
      return value;
    }
    if (arg?.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length).trim();
      if (!value) {
        throw new Error("--profile requires a profile name.");
      }
      return value;
    }
  }
  return undefined;
}

export function ensureNamedProfileExists(
  profileName: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
  },
): { profileDir: string; profileName: string; created: boolean } {
  const profileDir = resolveProfileDir(profileName, options);
  const created = !fs.existsSync(profileDir);

  if (created) {
    fs.mkdirSync(path.join(profileDir, "state"), { recursive: true });
    writeInitialOnboardingMarker(path.join(profileDir, "config.toml"));
  }

  const registry = readProfilesRegistry(options);
  const existing = registry.profiles.find((p) => p.name === profileName);
  if (!existing) {
    registry.profiles.push({ name: profileName });
    writeProfilesRegistry(registry, options);
  }

  return { profileDir, profileName, created };
}

/**
 * Seed a freshly-created profile's `config.toml` with the
 * `[onboarding]` table. The settings service reads this as the signal
 * that the first-run wizard has not yet run, which gates the initial
 * Codex `listThreads` probe. Profiles that pre-date this gate have no
 * `[onboarding]` table and are treated as `"migrated"` (gate off).
 */
function writeInitialOnboardingMarker(configPath: string): void {
  if (fs.existsSync(configPath)) {
    return;
  }
  fs.writeFileSync(configPath, "[onboarding]\ncompleted = false\n", "utf8");
}

export function setDefaultProfileName(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): string {
  ensureNamedProfileExists(profileName, options);
  const registry = readProfilesRegistry(options);
  registry.default_profile = profileName === "default" ? undefined : profileName;
  writeProfilesRegistry(registry, options);
  return profileName;
}

export function deleteProfile(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): void {
  const profileDir = assertProfileCanBeDeleted(profileName, options);
  fs.rmSync(profileDir, { recursive: true, force: true });
  forgetDeletedProfile(profileName, options);
}

export function assertProfileCanBeDeleted(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string; now?: number },
): string {
  if (!isValidProfileName(profileName)) {
    throw new Error(`Invalid profile name "${profileName}".`);
  }
  if (profileName === "default") {
    throw new Error("The default profile cannot be deleted.");
  }

  const activeProfile = resolveActiveProfileName(options);
  if (profileName === activeProfile) {
    throw new Error("The active profile cannot be deleted.");
  }

  const liveMarkers = findLiveProfileRuntimeMarkers(profileName, options);
  if (liveMarkers.length > 0) {
    throw new Error(
      `Profile "${profileName}" is open in another PwrAgent instance. Close that instance before deleting this profile.`,
    );
  }

  return resolveProfileDir(profileName, options);
}

export function forgetDeletedProfile(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): void {
  const registry = readProfilesRegistry(options);
  registry.profiles = registry.profiles.filter(
    (entry) => entry.name !== profileName,
  );
  if (registry.default_profile === profileName) {
    registry.default_profile = undefined;
  }
  writeProfilesRegistry(registry, options);
}

export function startProfileRuntimeHeartbeat(
  profileName = resolveActiveProfileName(),
  options?: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    instanceId?: string;
    intervalMs?: number;
    now?: () => number;
    processId?: number;
  },
): ProfileRuntimeHeartbeat {
  const now = options?.now ?? Date.now;
  const processId = options?.processId ?? process.pid;
  const marker: ProfileRuntimeMarker = {
    instanceId: options?.instanceId ?? randomUUID(),
    processId,
    profileName,
    startedAt: now(),
    heartbeatAt: now(),
  };
  const markerDir = resolveProfileRuntimeMarkerDir(profileName, options);
  fs.mkdirSync(markerDir, { recursive: true });
  const markerPath = path.join(markerDir, `${processId}-${marker.instanceId}.json`);
  const writeMarker = (): void => {
    marker.heartbeatAt = now();
    writeJsonAtomic(markerPath, marker);
  };
  writeMarker();
  const interval = setInterval(
    writeMarker,
    options?.intervalMs ?? PROFILE_RUNTIME_HEARTBEAT_INTERVAL_MS,
  );
  if (interval.unref) interval.unref();

  return {
    markerPath,
    stop: () => {
      clearInterval(interval);
      fs.rmSync(markerPath, { force: true });
    },
  };
}

export function findLiveProfileRuntimeMarkers(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string; now?: number },
): ProfileRuntimeMarker[] {
  const markerDir = resolveProfileRuntimeMarkerDir(profileName, options);
  if (!fs.existsSync(markerDir)) {
    return [];
  }
  const now = options?.now ?? Date.now();
  const markers: ProfileRuntimeMarker[] = [];
  for (const entry of fs.readdirSync(markerDir)) {
    const markerPath = path.join(markerDir, entry);
    const marker = readProfileRuntimeMarker(markerPath);
    if (!marker || marker.profileName !== profileName) {
      continue;
    }
    if (now - marker.heartbeatAt > PROFILE_RUNTIME_HEARTBEAT_TTL_MS) {
      fs.rmSync(markerPath, { force: true });
      continue;
    }
    if (!isProcessAlive(marker.processId)) {
      fs.rmSync(markerPath, { force: true });
      continue;
    }
    markers.push(marker);
  }
  return markers;
}

export function requestProfileInstanceFocus(
  profileName: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    now?: number;
    processId?: number;
  },
): boolean {
  if (findLiveProfileRuntimeMarkers(profileName, options).length === 0) {
    return false;
  }

  const requestDir = resolveProfileFocusRequestDir(profileName, options);
  fs.mkdirSync(requestDir, { recursive: true });
  const now = options?.now ?? Date.now();
  const processId = options?.processId ?? process.pid;
  const requestPath = path.join(
    requestDir,
    `${now}-${processId}-${randomUUID()}.json`,
  );
  writeJsonAtomic(requestPath, {
    profileName,
    processId,
    requestedAt: now,
  });
  return true;
}

export function startProfileFocusRequestWatcher(
  profileName = resolveActiveProfileName(),
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    intervalMs?: number;
    now?: () => number;
    onFocus: () => void;
  },
): ProfileFocusRequestWatcher {
  const requestDir = resolveProfileFocusRequestDir(profileName, options);
  fs.mkdirSync(requestDir, { recursive: true });
  const seen = new Set<string>();
  const now = options.now ?? Date.now;
  const scan = (): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(requestDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const requestPath = path.join(requestDir, entry);
      if (seen.has(requestPath)) {
        continue;
      }
      seen.add(requestPath);
      const request = readProfileFocusRequest(requestPath);
      fs.rmSync(requestPath, { force: true });
      if (!request || request.profileName !== profileName) {
        continue;
      }
      if (now() - request.requestedAt > PROFILE_RUNTIME_HEARTBEAT_TTL_MS) {
        continue;
      }
      options.onFocus();
    }
  };
  scan();
  const interval = setInterval(scan, options.intervalMs ?? 500);
  if (interval.unref) interval.unref();
  return {
    stop: () => {
      clearInterval(interval);
    },
  };
}

export function updateLastUsed(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): void {
  const registry = readProfilesRegistry(options);
  const entry = registry.profiles.find((p) => p.name === profileName);
  const now = new Date().toISOString();
  if (entry) {
    entry.last_used = now;
  } else {
    registry.profiles.push({ name: profileName, last_used: now });
  }
  writeProfilesRegistry(registry, options);
}

function parseProfilesToml(contents: string): ProfilesRegistry {
  const profiles: ProfileEntry[] = [];
  let defaultProfile: string | undefined;
  let current: Partial<ProfileEntry> | null = null;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line === "[[profiles]]") {
      if (current?.name) profiles.push(current as ProfileEntry);
      current = {};
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx < 1) continue;

    const key = line.slice(0, eqIdx).trim();
    const rawValue = line.slice(eqIdx + 1).trim();
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;

    if (!current) {
      if (key === "default_profile" && isValidProfileName(value)) {
        defaultProfile = value;
      }
      continue;
    }

    if (key === "name") current.name = value;
    else if (key === "display_name") current.display_name = value;
    else if (key === "last_used") current.last_used = value;
  }

  if (current?.name) profiles.push(current as ProfileEntry);
  return { default_profile: defaultProfile, profiles };
}

function resolveProfileRuntimeMarkerDir(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): string {
  return path.join(resolveProfileDir(profileName, options), "state", "runtime-instances");
}

function resolveProfileFocusRequestDir(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): string {
  return path.join(resolveProfileDir(profileName, options), "state", "focus-requests");
}

function readProfileRuntimeMarker(markerPath: string): ProfileRuntimeMarker | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<ProfileRuntimeMarker>;
    if (
      typeof parsed.instanceId === "string"
      && typeof parsed.processId === "number"
      && typeof parsed.profileName === "string"
      && typeof parsed.startedAt === "number"
      && typeof parsed.heartbeatAt === "number"
    ) {
      return parsed as ProfileRuntimeMarker;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readProfileFocusRequest(
  requestPath: string,
): { profileName: string; requestedAt: number } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Partial<{
      profileName: string;
      requestedAt: number;
    }>;
    if (
      typeof parsed.profileName === "string"
      && typeof parsed.requestedAt === "number"
    ) {
      return {
        profileName: parsed.profileName,
        requestedAt: parsed.requestedAt,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function isProcessAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stringifyProfilesToml(registry: ProfilesRegistry): string {
  const header =
    registry.default_profile && registry.default_profile !== "default"
      ? [`default_profile = "${registry.default_profile}"`]
      : [];
  const sections = registry.profiles.map((entry) => {
    const lines = ["[[profiles]]", `name = "${entry.name}"`];
    if (entry.display_name) lines.push(`display_name = "${entry.display_name}"`);
    if (entry.last_used) lines.push(`last_used = "${entry.last_used}"`);
    return lines.join("\n");
  });
  return [...header, ...sections]
    .join("\n\n")
    .concat(header.length || sections.length ? "\n" : "");
}
