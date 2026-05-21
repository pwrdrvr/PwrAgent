import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DesktopCodexAuthProfileCandidate,
  DesktopCodexAuthProfileDiscoverySnapshot,
} from "@pwragent/shared";
import { isValidProfileName } from "../profile";

export const CODEX_HOME_ENV = "CODEX_HOME";

export function resolveDefaultCodexHome(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = options?.env ?? process.env;
  const envCodexHome = env[CODEX_HOME_ENV]?.trim();
  if (envCodexHome) return path.resolve(envCodexHome);
  return path.join(options?.homeDir ?? os.homedir(), ".codex");
}

export function resolveCodexProfileRoot(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  return path.join(resolveDefaultCodexHome(options), "profiles");
}

export function resolveCodexHomeForProfile(
  profileName: string | undefined,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): string | undefined {
  const name = profileName?.trim();
  if (!name) return undefined;
  if (!isValidProfileName(name)) return undefined;
  return path.join(resolveCodexProfileRoot(options), name);
}

export function createCodexAuthProfile(
  profileName: string,
  options?: { env?: NodeJS.ProcessEnv; homeDir?: string },
): { profile: string; codexHome: string; created: boolean } {
  const name = profileName.trim();
  if (!isValidProfileName(name)) {
    throw new Error("Codex profile names must match PwrAgent profile naming rules.");
  }
  const codexHome = path.join(resolveCodexProfileRoot(options), name);
  const created = !fs.existsSync(codexHome);
  fs.mkdirSync(codexHome, { recursive: true });
  return { profile: name, codexHome, created };
}

export function discoverCodexAuthProfiles(options?: {
  configuredProfile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): DesktopCodexAuthProfileDiscoverySnapshot {
  const defaultCodexHome = resolveDefaultCodexHome(options);
  const profileRoot = resolveCodexProfileRoot(options);
  const configuredProfile = options?.configuredProfile?.trim() ?? "";
  const selectedProfile = isValidProfileName(configuredProfile)
    ? configuredProfile
    : "";
  const profiles: DesktopCodexAuthProfileCandidate[] = [
    {
      name: "",
      displayName: "System default",
      codexHome: defaultCodexHome,
      source: "default",
      exists: fs.existsSync(defaultCodexHome),
      selected: selectedProfile === "",
      hasAuthFile: fileExists(path.join(defaultCodexHome, "auth.json")),
      accountEmail: readCodexAuthEmail(defaultCodexHome),
      hasConfigFile: fileExists(path.join(defaultCodexHome, "config.toml")),
    },
  ];

  let error: string | undefined;

  try {
    for (const entry of fs.readdirSync(profileRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidProfileName(entry.name)) continue;
      profiles.push(buildDirectoryProfile(entry.name, profileRoot, selectedProfile));
    }
  } catch (readError) {
    const code =
      typeof readError === "object" && readError !== null && "code" in readError
        ? (readError as { code?: string }).code
        : undefined;
    if (code !== "ENOENT") {
      error = readError instanceof Error ? readError.message : String(readError);
    }
  }

  if (selectedProfile && !profiles.some((profile) => profile.name === selectedProfile)) {
    profiles.push(buildDirectoryProfile(selectedProfile, profileRoot, selectedProfile));
  }

  if (configuredProfile && !selectedProfile) {
    error = `Invalid Codex profile "${configuredProfile}". Profile names must match PwrAgent profile naming rules.`;
  }

  const selected =
    profiles.find((profile) => profile.selected) ?? profiles[0]!;

  return {
    profileRoot,
    effectiveCodexHome: selected.codexHome,
    profiles,
    ...(error ? { error } : {}),
  };
}

function buildDirectoryProfile(
  name: string,
  profileRoot: string,
  selectedProfile: string,
): DesktopCodexAuthProfileCandidate {
  const codexHome = path.join(profileRoot, name);
  return {
    name,
    displayName: name,
    codexHome,
    source: fs.existsSync(codexHome) ? "directory" : "config",
    exists: fs.existsSync(codexHome),
    selected: selectedProfile === name,
    hasAuthFile: fileExists(path.join(codexHome, "auth.json")),
    accountEmail: readCodexAuthEmail(codexHome),
    hasConfigFile: fileExists(path.join(codexHome, "config.toml")),
  };
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export type CodexAuthInfo = {
  email?: string;
  planType?: string;
};

function readCodexAuthEmail(codexHome: string): string | undefined {
  return readCodexAuthInfo(codexHome).email;
}

/**
 * Read the cached JWT from `auth.json` and pull out the operator-facing
 * identity fields. The onboarding wizard renders these after a profile
 * logs in so the operator can confirm they signed in with the right
 * account / plan. Returns `{}` if anything fails — we never want a
 * partially-parsed JWT to surface as a wrong email or plan label.
 */
export function readCodexAuthInfo(codexHome: string): CodexAuthInfo {
  try {
    const raw = fs.readFileSync(path.join(codexHome, "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const idToken = getNestedString(parsed, ["tokens", "id_token"]);
    if (!idToken) return {};
    return extractAuthInfoFromJwt(idToken);
  } catch {
    return {};
  }
}

function extractAuthInfoFromJwt(token: string): CodexAuthInfo {
  const payload = token.split(".")[1];
  if (!payload) return {};

  try {
    const decoded = Buffer.from(normalizeBase64Url(payload), "base64").toString("utf8");
    const claims = JSON.parse(decoded) as unknown;
    const email = getNestedString(claims, ["email"])?.trim();
    const validEmail =
      email && email.length <= 320 && email.includes("@") ? email : undefined;
    // OpenAI's id_token nests plan info under a URL-namespaced claim.
    // Search a few common locations — `https://api.openai.com/auth` is
    // the documented one but downstream Codex changes have moved the
    // shape around, so we look at `chatgpt_plan_type` at the root too.
    const planType =
      getNestedString(claims, ["https://api.openai.com/auth", "chatgpt_plan_type"])?.trim() ??
      getNestedString(claims, ["chatgpt_plan_type"])?.trim() ??
      getNestedString(claims, ["plan_type"])?.trim() ??
      undefined;
    const validPlan =
      planType && planType.length > 0 && planType.length <= 64 ? planType : undefined;
    return {
      ...(validEmail ? { email: validEmail } : {}),
      ...(validPlan ? { planType: validPlan } : {}),
    };
  } catch {
    return {};
  }
}

function normalizeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  return remainder === 0
    ? normalized
    : `${normalized}${"=".repeat(4 - remainder)}`;
}

function getNestedString(value: unknown, pathParts: string[]): string | undefined {
  let current = value;
  for (const pathPart of pathParts) {
    if (
      typeof current !== "object"
      || current === null
      || !Object.prototype.hasOwnProperty.call(current, pathPart)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[pathPart];
  }
  return typeof current === "string" ? current : undefined;
}
