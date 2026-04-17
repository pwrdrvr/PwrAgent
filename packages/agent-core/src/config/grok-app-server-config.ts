import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFlatToml } from "./simple-toml.js";

type ConfigDirOptions = {
  homeDir?: string;
  xdgConfigHome?: string;
};

type StateDirOptions = {
  homeDir?: string;
  xdgStateHome?: string;
};

type ResolveConfigOptions = ConfigDirOptions &
  StateDirOptions & {
    env?: NodeJS.ProcessEnv;
  };

export type GrokAppServerRuntimeConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  configPath: string;
  stateRoot: string;
};

export function defaultGrokAppServerConfigDir(options?: ConfigDirOptions): string {
  const homeDir = options?.homeDir ?? os.homedir();
  const xdgConfigHome =
    options?.xdgConfigHome?.trim() || process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdgConfigHome || path.join(homeDir, ".config"), "grok-app-server");
}

export function defaultGrokAppServerConfigPath(options?: ConfigDirOptions): string {
  return path.join(defaultGrokAppServerConfigDir(options), "config.toml");
}

export function defaultGrokAppServerStateDir(options?: StateDirOptions): string {
  const homeDir = options?.homeDir ?? os.homedir();
  const xdgStateHome =
    options?.xdgStateHome?.trim() || process.env.XDG_STATE_HOME?.trim();
  return path.join(
    xdgStateHome || path.join(homeDir, ".local", "state"),
    "grok-app-server",
  );
}

export function resolveGrokAppServerRuntimeConfig(
  options?: ResolveConfigOptions,
): GrokAppServerRuntimeConfig {
  const env = options?.env ?? process.env;
  const configPath = defaultGrokAppServerConfigPath(options);
  const stateRoot =
    env.GROK_APP_SERVER_STATE_ROOT?.trim() || undefined;
  const parsedConfig = readConfigToml(configPath);
  const legacyConfig = readLegacyEnvConfig(options);

  return {
    apiKey:
      env.XAI_API_KEY?.trim()
      || readString(parsedConfig.xai_api_key)
      || legacyConfig.XAI_API_KEY,
    baseUrl:
      env.XAI_BASE_URL?.trim()
      || readString(parsedConfig.xai_base_url)
      || legacyConfig.XAI_BASE_URL,
    model:
      env.GROK_MODEL?.trim()
      || readString(parsedConfig.grok_model)
      || legacyConfig.GROK_MODEL,
    configPath,
    stateRoot:
      stateRoot
      || readString(parsedConfig.state_root)
      || defaultGrokAppServerStateDir(options),
  };
}

function readConfigToml(configPath: string): Record<string, string | number | boolean> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const contents = fs.readFileSync(configPath, "utf8");
  return parseFlatToml(contents, configPath);
}

function readLegacyEnvConfig(
  options?: ResolveConfigOptions,
): Partial<Record<"XAI_API_KEY" | "XAI_BASE_URL" | "GROK_MODEL", string>> {
  const configDir = defaultGrokAppServerConfigDir(options);
  const legacyPaths = [
    path.join(configDir, "config.env"),
    path.join(configDir, ".env.local"),
    path.join(configDir, ".env"),
  ];

  for (const filePath of legacyPaths) {
    if (fs.existsSync(filePath)) {
      return parseLegacyEnvFile(filePath);
    }
  }

  return {};
}

function parseLegacyEnvFile(
  filePath: string,
): Partial<Record<"XAI_API_KEY" | "XAI_BASE_URL" | "GROK_MODEL", string>> {
  const values: Partial<Record<"XAI_API_KEY" | "XAI_BASE_URL" | "GROK_MODEL", string>> = {};
  const contents = fs.readFileSync(filePath, "utf8");

  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 1) {
      throw new Error(`Invalid env line ${index + 1} in ${filePath}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === "XAI_API_KEY" || key === "XAI_BASE_URL" || key === "GROK_MODEL") {
      values[key] = value;
    }
  }

  return values;
}

function readString(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
