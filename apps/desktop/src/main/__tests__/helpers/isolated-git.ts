import { execFile as execFileCallback, execFileSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Environment that can change what Git discovers, how it reads HEAD, or its config. */
export const isolatedGitKeys = /^(?:PWRAGENT_GIT_PATH|GIT_(?:DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG.*))$/i;

/** Isolate Git environment overrides and, with a fixture root, global and system config. */
export function isolateProcessGitEnvironment(configRoot?: string): () => void {
  const saved = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (isolatedGitKeys.test(key) && value !== undefined) {
      saved.set(key, value);
      delete process.env[key];
    }
  }
  if (configRoot) {
    process.env.GIT_CONFIG_GLOBAL = path.join(configRoot, "global-config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  }
  return () => {
    for (const key of Object.keys(process.env)) {
      if (isolatedGitKeys.test(key)) delete process.env[key];
    }
    for (const [key, value] of saved) process.env[key] = value;
  };
}

/**
 * Builds a fixture subprocess environment without machine configuration.
 */
function isolatedGitEnvironment(cwd: string, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (isolatedGitKeys.test(key)) delete env[key];
  }
  return {
    ...env,
    ...extraEnv,
    GIT_CONFIG_GLOBAL: path.join(cwd, "missing-global-config"),
    GIT_CONFIG_SYSTEM: path.join(cwd, "missing-system-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // Callers match Git's English messages.
    LANGUAGE: "C",
    LC_ALL: "C",
  };
}

export async function runIsolatedGit(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return await execFile("git", ["-C", cwd, ...args], {
    env: isolatedGitEnvironment(cwd, extraEnv),
    encoding: "utf8",
    windowsHide: true,
  });
}

export function runIsolatedGitSync(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    env: isolatedGitEnvironment(cwd),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}
