import path from "node:path";
import dugite from "dugite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { resolvePwragentRoot } from "./profile";

let packagedResourcesPath: string | undefined;

/** Called before settings or backends start. Environment variables never select
 * a Git distribution: a missing bundle is an installation error, not fallback. */
export function configureBundledGit(resourcesPath?: string): void {
  packagedResourcesPath = resourcesPath;
}

export function bundledGitDirectory(): string {
  return packagedResourcesPath
    ? path.join(packagedResourcesPath, "git")
    : dugite.resolveEmbeddedGitDir();
}

export function bundledGitExecutable(): string {
  return dugite.resolveGitBinary(bundledGitDirectory());
}

export function bundledGitLfsExecutable(): string {
  // The explicit empty override resolves the bundled platform layout, as in
  // bundledGitEnvironment, without writing that environment's system config.
  const helperDirectory = dugite.resolveGitExecPath(bundledGitDirectory(), "");
  return path.join(helperDirectory, process.platform === "win32" ? "git-lfs.exe" : "git-lfs");
}

export async function validateBundledGit(): Promise<string> {
  const executable = bundledGitExecutable();
  // Without this check, Git can search PATH for a missing git-lfs helper and
  // silently execute the installed LFS version instead.
  await Promise.all([
    access(executable),
    access(bundledGitLfsExecutable()),
  ]);
  return executable;
}

/** Keep Git, its helpers, and LFS in one distribution even when launched from
 * another Pwr app or a shell with Git-specific environment overrides. */
export function bundledGitEnvironment(
  source: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const clean = { ...source };
  let inheritedPath = "";
  for (const key of Object.keys(clean)) {
    const upper = key.toUpperCase();
    if (upper === "PATH") {
      inheritedPath = clean[key] ?? "";
      delete clean[key];
    } else if (["LOCAL_GIT_DIRECTORY", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG_SYSTEM", "PWRAGENT_GIT_PATH"].includes(upper)) {
      delete clean[key];
    }
  }
  const root = bundledGitDirectory();
  // An omitted helper override makes Dugite read process.env.GIT_EXEC_PATH
  // again. An explicit empty override resolves the bundled platform layout.
  const helperDirectory = dugite.resolveGitExecPath(root, "");
  const { env } = dugite.setupEnvironment(
    { LOCAL_GIT_DIRECTORY: root, GIT_EXEC_PATH: helperDirectory },
    { ...clean, PATH: inheritedPath },
  );
  const executableDirectory = path.dirname(bundledGitExecutable());
  // Git puts its exec path first for subcommands; shells and hooks also need
  // the bundled git/git-lfs before any installed versions in PATH.
  const pathEntries = [executableDirectory, helperDirectory, ...(env.PATH ?? "").split(path.delimiter)];
  const keychainHelper = (options.platform ?? process.platform) === "darwin"
    ? installedKeychainHelper({ PATH: inheritedPath, DEVELOPER_DIR: clean.DEVELOPER_DIR })
    : undefined;
  // Dugite points POSIX Git at its own etc/gitconfig. On Windows, MinGit reads
  // the one inside the bundle that Dugite's build configured.
  const bundleConfig = env.GIT_CONFIG_SYSTEM ?? mingitSystemConfig(root, helperDirectory);
  const systemConfig = bundleConfig ? bundledSystemConfig(bundleConfig, keychainHelper) : undefined;
  if (systemConfig) env.GIT_CONFIG_SYSTEM = systemConfig;
  if (keychainHelper) {
    // Last, so it only answers names nothing earlier provides: a user-level
    // `credential.helper = osxkeychain` runs `git-credential-osxkeychain`,
    // which Git looks for in its own exec path and then on PATH.
    pathEntries.push(path.dirname(keychainHelper));
  }
  env.PATH = [...new Set(pathEntries)].join(path.delimiter);
  return env;
}

/** Dugite's build writes to etc/gitconfig when MinGit has one there, and to
 * the architecture folder's etc/gitconfig otherwise. */
function mingitSystemConfig(root: string, helperDirectory: string): string | undefined {
  return [
    path.join(root, "etc", "gitconfig"),
    path.join(path.dirname(path.dirname(helperDirectory)), "etc", "gitconfig"),
  ].find((candidate) => existsSync(candidate));
}

const APPLE_GIT_SHIM = "/usr/bin/git";
const KEYCHAIN_HELPER = "git-credential-osxkeychain";
const keychainHelperBySearch = new Map<string, string | undefined>();

/**
 * The macOS keychain credential helper that ships with the Git the operator
 * already runs, found by following their PATH.
 *
 * Dugite's Git has no credential helper at all, and its system config only
 * includes /etc/gitconfig. Homebrew's and Apple's Git both set
 * `credential.helper = osxkeychain` in their *own* system config, so without
 * this every HTTPS remote that authenticated through the keychain stops
 * working under the bundle, and with terminal prompts off there is no
 * fallback. Reusing the installed binary, rather than shipping one, keeps
 * the keychain items it created readable without a new access prompt.
 */
export function installedKeychainHelper(env: {
  PATH?: string;
  DEVELOPER_DIR?: string;
}): string | undefined {
  const searchPath = env.PATH ?? "";
  const key = `${searchPath}\0${env.DEVELOPER_DIR ?? ""}`;
  const cached = keychainHelperBySearch.get(key);
  // The path is versioned (Homebrew's Cellar/git/<version>), and upgrading
  // removes the old keg while the app keeps running.
  if (cached ? existsSync(cached) : keychainHelperBySearch.has(key)) return cached;
  let found: string | undefined;
  for (const entry of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const git = realpathOrUndefined(path.join(entry, "git"));
    if (!git) continue;
    // Apple's /usr/bin/git is a shim for the selected developer directory;
    // every other install keeps its helpers in <prefix>/libexec/git-core.
    const gitCore = git === APPLE_GIT_SHIM
      ? path.join(appleDeveloperDirectory(env.DEVELOPER_DIR), "usr", "libexec", "git-core")
      : path.join(path.dirname(path.dirname(git)), "libexec", "git-core");
    const helper = path.join(gitCore, KEYCHAIN_HELPER);
    if (existsSync(helper)) {
      found = helper;
      break;
    }
  }
  if (keychainHelperBySearch.size > 32) keychainHelperBySearch.clear();
  keychainHelperBySearch.set(key, found);
  return found;
}

function appleDeveloperDirectory(developerDir: string | undefined): string {
  if (developerDir?.trim()) return developerDir.trim();
  // What `xcode-select -p` reads, without spawning it on every Git launch.
  for (const link of ["/private/var/select/developer_dir", "/var/db/xcode_select_link"]) {
    try {
      return readlinkSync(link);
    } catch {
      // Try the older location, then the Command Line Tools default.
    }
  }
  return "/Library/Developer/CommandLineTools";
}

function realpathOrUndefined(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

const writtenSystemConfigs = new Set<string>();

/** Where generated system configs live, so an override can drop them. */
export function bundledGitConfigDirectory(): string {
  return path.join(resolvePwragentRoot(), "git");
}

/**
 * The bundle's system config with the defaults an installed Git and Git LFS
 * would have set at system scope:
 *
 * - The LFS filter, exactly as `git lfs install --system` writes it. Dugite
 *   bundles git-lfs but configures no filter, so without this an LFS
 *   repository checks out pointer files unless the operator happened to run
 *   `git lfs install` against their global config. The filter also has
 *   git-lfs install its pre-push hook on first use, so pushes upload objects.
 * - On macOS, the installed keychain credential helper.
 *
 * System scope, like the installed Git's, so global and repository config
 * still override every default: `lfs install --skip-smudge` keeps pointers,
 * and resetting `credential.helper` opts out. The bundle's config is
 * included after the defaults so its own settings win too.
 *
 * Named by content: instances running different app copies write different
 * files instead of rewriting one another's. Returns undefined when the file
 * cannot be written, leaving the bundle's config in place.
 */
function bundledSystemConfig(
  bundleConfig: string,
  keychainHelper: string | undefined,
): string | undefined {
  const content = [
    "# Written by PwrAgent: defaults for its bundled Git, then the bundle's own",
    "# system config.",
    "[filter \"lfs\"]",
    "\tclean = git-lfs clean -- %f",
    "\tsmudge = git-lfs smudge -- %f",
    "\tprocess = git-lfs filter-process",
    "\trequired = true",
    ...(keychainHelper
      ? [
        "[credential]",
        // A shell snippet rather than a bare path, so a path with a space
        // (Xcode-beta.app, a renamed volume) still runs as one word.
        `\thelper = ${quoteConfigValue(`!'${keychainHelper.replaceAll("'", "'\\''")}'`)}`,
      ]
      : []),
    "[include]",
    `\tpath = ${quoteConfigValue(bundleConfig)}`,
    "",
  ].join("\n");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const file = path.join(bundledGitConfigDirectory(), `gitconfig-${hash}`);
  if (writtenSystemConfigs.has(file)) return file;
  try {
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
      mkdirSync(path.dirname(file), { recursive: true });
      // Another instance may be reading it: never expose a partial file.
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, content);
      renameSync(temporary, file);
    }
  } catch {
    return undefined;
  }
  writtenSystemConfigs.add(file);
  return file;
}

function quoteConfigValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
