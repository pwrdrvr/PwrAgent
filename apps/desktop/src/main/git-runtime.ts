import path from "node:path";
import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  bundledGitConfigDirectory,
  bundledGitDirectory,
  bundledGitEnvironment,
  validateBundledGit,
} from "./bundled-git";
import { getConfiguredGitCommand } from "./git-command";

export const GIT_COMMAND_ENV = "PWRAGENT_GIT_PATH";

export function gitCommandPreference(env: NodeJS.ProcessEnv): string | undefined {
  return env[GIT_COMMAND_ENV]?.trim() || getConfiguredGitCommand();
}

/** Remove our bundled distribution before running an explicitly selected Git. */
export function customGitEnvironment(source: NodeJS.ProcessEnv, command: string): NodeJS.ProcessEnv {
  const env = { ...source };
  const root = path.resolve(bundledGitDirectory());
  const within = (directory: string, value: string) => {
    const relative = path.relative(directory, value);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const inBundle = (value: string) => within(root, value);
  // The system config PwrAgent generates for the bundle includes Dugite's;
  // an installed Git reads its own.
  const generatedConfigs = path.resolve(bundledGitConfigDirectory());
  let inheritedPath = "";
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === "PATH") {
      inheritedPath = env[key] ?? "";
      delete env[key];
    } else if (["LOCAL_GIT_DIRECTORY", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR"].includes(upper)
      || (["GIT_CONFIG_SYSTEM", "PREFIX", "GIT_SSL_CAINFO"].includes(upper) && env[key] && inBundle(env[key]!))
      || (upper === "GIT_CONFIG_SYSTEM" && env[key] && within(generatedConfigs, env[key]!))) {
      delete env[key];
    }
  }
  env.PATH = [...new Set([
    ...(path.isAbsolute(command) ? [path.dirname(command)] : []),
    ...inheritedPath.split(path.delimiter).filter((entry) => entry && !inBundle(entry)),
  ])].join(path.delimiter);
  return env;
}

export function gitRuntimeEnvironment(source: NodeJS.ProcessEnv, preference = gitCommandPreference(source)): NodeJS.ProcessEnv {
  return preference ? customGitEnvironment(source, preference) : bundledGitEnvironment(source);
}

export async function resolveRuntimeGitExecutable(source: NodeJS.ProcessEnv): Promise<string> {
  const preference = gitCommandPreference(source);
  if (!preference) return await validateBundledGit();
  if (path.isAbsolute(preference) || preference.includes(path.sep)) return path.resolve(preference);
  const env = customGitEnvironment(source, preference);
  if (process.platform === "win32") {
    try {
      const { stdout } = await promisify(execFile)(path.join(env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"), [preference], {
        env, encoding: "utf8", timeout: 2000, windowsHide: true,
      });
      const resolved = stdout.split(/\r?\n/).find((entry) => path.isAbsolute(entry.trim()));
      if (resolved) return resolved.trim();
    } catch {
      // where.exe exits non-zero for a command it cannot find. Report the
      // selection below rather than the search tool.
    }
  } else {
    for (const entry of (env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.resolve(entry, preference);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH entry for the selected command only. */ }
    }
  }
  throw new Error(`Selected Git executable is unavailable: ${preference}`);
}
