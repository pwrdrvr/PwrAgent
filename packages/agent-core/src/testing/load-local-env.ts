import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LocalEnvLoadResult = {
  path: string;
  loaded: boolean;
  entries: string[];
  skippedReason?: string;
};

export function defaultLocalEnvPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../../.env.local");
}

export function loadLocalEnv(options?: {
  envPath?: string;
  override?: boolean;
}): LocalEnvLoadResult {
  const envPath = options?.envPath ?? defaultLocalEnvPath();
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
    if (options?.override || process.env[key] === undefined) {
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
