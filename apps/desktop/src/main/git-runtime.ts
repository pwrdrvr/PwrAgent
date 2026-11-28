import path from "node:path";
import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  bundledGitDirectory,
  bundledGitEnvironment,
  isInsideDirectory,
  isPwrAgentGitPath,
  operatorSystemConfig,
  validateBundledGit,
} from "./bundled-git";
import { buildPwrAgentChildProcessEnv } from "./child-process-env";
import { getConfiguredGitCommand, getSelectedManagedGit } from "./git-command";
import { managedGitRoot } from "./managed-git-paths";
import { resolveManagedGitRuntime } from "./managed-git-runtime";

export const GIT_COMMAND_ENV = "PWRAGENT_GIT_PATH";

export function gitCommandPreference(env: NodeJS.ProcessEnv): string | undefined {
  return env[GIT_COMMAND_ENV]?.trim() || getConfiguredGitCommand();
}

let lastCustomGitPath: {
  inheritedPath: string;
  commandDirectory: string | undefined;
  bundledRoot: string;
  managedRoot: string;
  value: string;
} | undefined;

function customGitPath(inheritedPath: string, command: string, bundledRoot: string): string {
  const commandDirectory = path.isAbsolute(command) ? path.dirname(command) : undefined;
  const managedRoot = path.resolve(managedGitRoot());
  const previous = lastCustomGitPath;
  if (previous?.inheritedPath === inheritedPath
    && previous.commandDirectory === commandDirectory
    && previous.bundledRoot === bundledRoot
    && previous.managedRoot === managedRoot) {
    return previous.value;
  }

  const entries = new Set<string>();
  if (commandDirectory) entries.add(commandDirectory);
  let cacheable = true;
  for (const entry of inheritedPath.split(path.delimiter)) {
    if (!entry) continue;
    // Relative paths need the current cwd. On Windows even a rooted path
    // without a drive can depend on it, so only reuse drive-absolute entries.
    cacheable &&= process.platform === "win32" ? /^[a-z]:[\\/]/i.test(entry) : path.isAbsolute(entry);
    const resolved = path.resolve(entry);
    if (!isInsideDirectory(bundledRoot, resolved) && !isInsideDirectory(managedRoot, resolved)) {
      entries.add(entry);
    }
  }
  const value = [...entries].join(path.delimiter);
  if (cacheable) lastCustomGitPath = { inheritedPath, commandDirectory, bundledRoot, managedRoot, value };
  return value;
}

/** Remove our bundled distribution before running an explicitly selected Git. */
export function customGitEnvironment(source: NodeJS.ProcessEnv, command: string): NodeJS.ProcessEnv {
  const env = { ...source };
  const root = path.resolve(bundledGitDirectory());
  const inBundle = (value: string) => isPwrAgentGitPath(value);
  let inheritedPath = "";
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === "PATH") {
      inheritedPath = env[key] ?? "";
      delete env[key];
    } else if (["LOCAL_GIT_DIRECTORY", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR"].includes(upper)
      || (["PREFIX", "GIT_SSL_CAINFO"].includes(upper) && env[key] && inBundle(env[key]!))) {
      delete env[key];
    } else if (upper === "GIT_CONFIG_SYSTEM") {
      // The system config PwrAgent generates for the bundle includes the
      // bundle's; an installed Git reads its own. An operator's own stays,
      // even from inside a generated one.
      const operatorConfig = operatorSystemConfig(root, env[key]);
      if (operatorConfig) env[key] = operatorConfig;
      else delete env[key];
    }
  }
  env.PATH = customGitPath(inheritedPath, command, root);
  return env;
}

/**
 * Explicit commands win (PWRAGENT_GIT_PATH, then a manual path), then the
 * downloaded PwrDrvr release chosen with Use, then the bundle. A downloaded
 * release runs exactly as the bundle does: its own helpers, templates, Git
 * LFS, system config and, on Linux, CA bundle.
 */
export function gitRuntimeEnvironment(source: NodeJS.ProcessEnv, preference = gitCommandPreference(source)): NodeJS.ProcessEnv {
  if (preference) return customGitEnvironment(source, preference);
  const managed = getSelectedManagedGit();
  if (!managed) return bundledGitEnvironment(source);
  try {
    return bundledGitEnvironment(source, { root: resolveManagedGitRuntime(managed).root });
  } catch {
    // The release failed its checks. PwrAgent's own commands fail through
    // resolveRuntimeGitExecutable; a shell gets no PwrAgent Git on PATH
    // rather than the rejected one.
    return customGitEnvironment(source, "git");
  }
}

export function gitCommandEnvironment(source: NodeJS.ProcessEnv, preference?: string): NodeJS.ProcessEnv {
  return {
    ...gitRuntimeEnvironment(buildPwrAgentChildProcessEnv(source), preference),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
}

export async function resolveRuntimeGitExecutable(source: NodeJS.ProcessEnv): Promise<string> {
  const preference = gitCommandPreference(source);
  if (!preference) {
    const managed = getSelectedManagedGit();
    // Throws for a release that failed verification: never silently another Git.
    if (managed) return resolveManagedGitRuntime(managed).executable;
    return await validateBundledGit();
  }
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
