import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PWRAGNT_PROFILE_ENV = "PWRAGNT_PROFILE";
export const PWRAGNT_HOME_ENV = "PWRAGNT_HOME";

const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_NAMES = new Set(["con", "nul", "aux", "prn", ".", ".."]);

export type ProfileEntry = {
  name: string;
  display_name?: string;
  last_used?: string;
};

export type ProfilesRegistry = {
  profiles: ProfileEntry[];
};

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_REGEX.test(name) && !RESERVED_NAMES.has(name);
}

export function resolvePwragntRoot(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = options?.env ?? process.env;
  const pwragntHome = env[PWRAGNT_HOME_ENV]?.trim();
  if (pwragntHome) return path.resolve(pwragntHome);
  const homeDir = options?.homeDir ?? os.homedir();
  return path.join(homeDir, ".pwragnt");
}

export function resolveActiveProfileName(options?: {
  env?: NodeJS.ProcessEnv;
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
  const envProfile = env[PWRAGNT_PROFILE_ENV]?.trim();
  if (envProfile) {
    if (!isValidProfileName(envProfile)) {
      throw new Error(
        `Invalid PWRAGNT_PROFILE="${envProfile}". Must match ${PROFILE_NAME_REGEX.source} and not be a reserved name.`,
      );
    }
    return envProfile;
  }

  return "default";
}

export function resolveActiveProfileDir(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliProfile?: string;
}): string {
  const root = resolvePwragntRoot(options);
  const profileName = resolveActiveProfileName(options);
  return path.join(root, "profiles", profileName);
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
  return path.join(resolvePwragntRoot(options), "profiles.toml");
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
  const profileDir = resolveActiveProfileDir(options);
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
  let current: Partial<ProfileEntry> | null = null;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line === "[[profiles]]") {
      if (current?.name) profiles.push(current as ProfileEntry);
      current = {};
      continue;
    }

    if (!current) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx < 1) continue;

    const key = line.slice(0, eqIdx).trim();
    const rawValue = line.slice(eqIdx + 1).trim();
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;

    if (key === "name") current.name = value;
    else if (key === "display_name") current.display_name = value;
    else if (key === "last_used") current.last_used = value;
  }

  if (current?.name) profiles.push(current as ProfileEntry);
  return { profiles };
}

function stringifyProfilesToml(registry: ProfilesRegistry): string {
  const sections = registry.profiles.map((entry) => {
    const lines = ["[[profiles]]", `name = "${entry.name}"`];
    if (entry.display_name) lines.push(`display_name = "${entry.display_name}"`);
    if (entry.last_used) lines.push(`last_used = "${entry.last_used}"`);
    return lines.join("\n");
  });
  return sections.join("\n\n").concat(sections.length ? "\n" : "");
}
