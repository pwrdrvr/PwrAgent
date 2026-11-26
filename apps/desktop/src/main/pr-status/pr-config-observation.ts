import path from "node:path";
import { bundledGitExecutable, isPackagedBundledGit } from "../bundled-git";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { getSelectedManagedGit } from "../git-command";
import { gitCommandPreference, gitRuntimeEnvironment } from "../git-runtime";
import { parseGitRemoteConfigRecords } from "./git-remote-config";

const MAX_CONFIG_INCLUDES = 16;
const GIT_CONFIG_OVERRIDE = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|IMPLICIT_WORK_TREE|OBJECT_DIRECTORY|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|TEST_.*)$/i;
const GIT_DISCOVERY_OVERRIDE = /^(?:DYLD_.*|LD_.*|SUDO_UID|GIT_(?:CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG_KEY_.*|CONFIG_VALUE_.*))$/i;

// The owner may accept a positive single-branch config sample only from the
// actual bundled executable. A wrapper can answer config and remote differently.
export function canReadSingleBranchOrigin(executable: string, env: NodeJS.ProcessEnv): boolean {
  const preference = gitCommandPreference(env);
  return process.platform !== "win32" && executable === bundledGitExecutable()
    && (preference ? isPackagedBundledGit(preference) : !getSelectedManagedGit())
    && !Object.keys(env).some((key) => GIT_CONFIG_OVERRIDE.test(key) || GIT_DISCOVERY_OVERRIDE.test(key));
}

export function readPrConfigInputs(cwd: string) {
  const env = buildPwrAgentChildProcessEnv(process.env);
  const preference = gitCommandPreference(env);
  const executable = bundledGitExecutable();
  if (getSelectedManagedGit() || (preference && path.normalize(preference) !== path.normalize(executable))) return "native-only" as const;
  const nativeOnly = process.platform === "win32" || Boolean(preference);
  if (!path.isAbsolute(cwd) || Object.keys(env).some((key) => GIT_CONFIG_OVERRIDE.test(key))) {
    return undefined;
  }
  const runtime = gitRuntimeEnvironment(env);
  const { GIT_CONFIG_SYSTEM: system, GIT_CONFIG_NOSYSTEM: noSystem, GIT_CONFIG_GLOBAL: global, HOME: home, XDG_CONFIG_HOME: xdg } = runtime;
  if (noSystem !== undefined && noSystem !== "0" && noSystem !== "1") return undefined;
  if (noSystem !== "1" && (!system || !path.isAbsolute(system))) return undefined;
  // Joining a path removes parent components before the filesystem can
  // follow any symlinks. Git can reach a different config with the raw path.
  if (global === undefined && (!home || !path.isAbsolute(home) || hasParentComponent(home)
    || (xdg && (!path.isAbsolute(xdg) || hasParentComponent(xdg))))) return undefined;
  if (global !== undefined && !path.isAbsolute(global)) return undefined;

  const paths = global !== undefined
    ? [global]
    : [path.join(xdg || path.join(home!, ".config"), "git/config"), path.join(home!, ".gitconfig")];
  if (noSystem !== "1") paths.push(system!);
  paths.push(executable);
  if (paths.some((file) => /[\r\n\uFFFD]/.test(file) || hasParentComponent(file))) return undefined;
  return { env, paths: paths.map((file) => path.normalize(file)), nativeOnly };
}

function hasParentComponent(file: string): boolean {
  return file.split(/[\\/]/).includes("..");
}

function configPath(directory: string, value: string): string | undefined {
  // Leave interpolation and paths crossing a parent component to Git.
  if (!value || /^[~%]/.test(value) || /[\r\n\uFFFD]/.test(value) || hasParentComponent(value)) return undefined;
  return path.resolve(directory, value);
}

export function parsePrConfigWithOrigins(cwd: string, stdout: string) {
  const records = stdout.split("\0");
  if (records.pop() !== "" || records.length % 3 !== 0) return undefined;
  const origins = new Set<string>();
  const localOrigins = new Set<string>();
  const includes = new Set<string>();
  const config: string[] = [];
  let canTrackIncludes = true;
  for (let index = 0; index < records.length; index += 3) {
    const [scope, origin, record] = records.slice(index, index + 3);
    const file = origin.startsWith("file:") ? configPath(cwd, origin.slice("file:".length)) : undefined;
    if (file) {
      origins.add(file);
      if (scope === "local") localOrigins.add(file);
    } else {
      canTrackIncludes = false;
    }
    if (record.startsWith("include.") || record.startsWith("includeif.")) {
      // Conditional includes can change without a write to the including file.
      const included = file && record.startsWith("include.path\n")
        ? configPath(path.dirname(file), record.slice("include.path\n".length)) : undefined;
      if (included) includes.add(included);
      else canTrackIncludes = false;
      if (record.startsWith("includeif.")) config.push(scope, record);
    } else {
      config.push(scope, record);
    }
  }
  const configuration = parseGitRemoteConfigRecords(config);
  return {
    configuration, records: config,
    sources: canTrackIncludes && includes.size <= MAX_CONFIG_INCLUDES ? { origins, localOrigins, includes } : undefined,
  };
}
