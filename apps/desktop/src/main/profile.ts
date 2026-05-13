import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PWRAGENT_PROFILE_ENV = "PWRAGENT_PROFILE";
export const PWRAGENT_HOME_ENV = "PWRAGENT_HOME";

const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_NAMES = new Set(["con", "nul", "aux", "prn", ".", ".."]);

export type ProfileEntry = {
  name: string;
  display_name?: string;
  last_used?: string;
};

export type ProfilesRegistry = {
  default_profile?: string;
  profiles: ProfileEntry[];
};

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
}): string {
  if (options?.cliProfile?.trim()) {
    const name = options.cliProfile.trim();
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
}): { profileDir: string; profileName: string; created: boolean } {
  const profileName = resolveActiveProfileName(options);
  return ensureNamedProfileExists(profileName, options);
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
  }

  const registry = readProfilesRegistry(options);
  const existing = registry.profiles.find((p) => p.name === profileName);
  if (!existing) {
    registry.profiles.push({ name: profileName });
    writeProfilesRegistry(registry, options);
  }

  return { profileDir, profileName, created };
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

  const profileDir = resolveProfileDir(profileName, options);
  fs.rmSync(profileDir, { recursive: true, force: true });

  const registry = readProfilesRegistry(options);
  registry.profiles = registry.profiles.filter(
    (entry) => entry.name !== profileName,
  );
  if (registry.default_profile === profileName) {
    registry.default_profile = undefined;
  }
  writeProfilesRegistry(registry, options);
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
