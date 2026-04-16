import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LocalEnvLoadResult = {
  path: string;
  loaded: boolean;
  entries: string[];
  skippedReason?: string;
};

export function defaultLocalEnvPath(options?: {
  currentDir?: string;
}): string {
  const currentDir =
    options?.currentDir ?? path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(currentDir, "../../../../.env.local"),
    path.resolve(currentDir, "../../.env.local"),
  ];

  return candidatePaths.find((candidatePath) => fs.existsSync(candidatePath))
    ?? candidatePaths[0];
}

export function defaultGrokAppServerConfigDir(options?: {
  homeDir?: string;
  xdgConfigHome?: string;
}): string {
  const homeDir = options?.homeDir ?? os.homedir();
  const xdgConfigHome = options?.xdgConfigHome?.trim() || process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdgConfigHome || path.join(homeDir, ".config"), "grok-app-server");
}

export function defaultGrokAppServerConfigPaths(options?: {
  homeDir?: string;
  xdgConfigHome?: string;
}): string[] {
  const configDir = defaultGrokAppServerConfigDir(options);
  return [
    path.join(configDir, "config.env"),
    path.join(configDir, ".env.local"),
    path.join(configDir, ".env"),
  ];
}

export function loadLocalEnv(options?: {
  envPath?: string;
  override?: boolean;
}): LocalEnvLoadResult {
  const envPath = options?.envPath ?? defaultLocalEnvPath();
  return loadEnvFile(envPath, options?.override);
}

export function loadGrokAppServerConfig(options?: {
  configPaths?: string[];
  override?: boolean;
  homeDir?: string;
  xdgConfigHome?: string;
}): LocalEnvLoadResult {
  const configPaths =
    options?.configPaths ?? defaultGrokAppServerConfigPaths(options);
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      return loadEnvFile(configPath, options?.override);
    }
  }

  return {
    path: configPaths[0] ?? defaultGrokAppServerConfigPaths(options)[0],
    loaded: false,
    entries: [],
    skippedReason: "missing",
  };
}

function loadEnvFile(
  envPath: string,
  override = false,
): LocalEnvLoadResult {
  if (!fs.existsSync(envPath)) {
    return {
      path: envPath,
      loaded: false,
      entries: [],
      skippedReason: "missing",
    };
  }

  const entries: string[] = [];
  const contents = fs.readFileSync(envPath, "utf8");
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 1) {
      throw new Error(`Invalid env line ${index + 1} in ${envPath}`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      throw new Error(`Invalid env key on line ${index + 1} in ${envPath}`);
    }
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
    entries.push(key);
  }

  return {
    path: envPath,
    loaded: true,
    entries,
  };
}
