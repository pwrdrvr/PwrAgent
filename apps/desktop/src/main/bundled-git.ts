import path from "node:path";
import dugite from "dugite";
import { access } from "node:fs/promises";

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
  const env = bundledGitEnvironment({});
  return path.join(env.GIT_EXEC_PATH!, process.platform === "win32" ? "git-lfs.exe" : "git-lfs");
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
export function bundledGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  const { env } = dugite.setupEnvironment({ LOCAL_GIT_DIRECTORY: root }, { ...clean, PATH: inheritedPath });
  const executableDirectory = path.dirname(bundledGitExecutable());
  const helperDirectory = env.GIT_EXEC_PATH!;
  // Git puts its exec path first for subcommands; shells and hooks also need
  // the bundled git/git-lfs before any installed versions in PATH.
  env.PATH = [...new Set([executableDirectory, helperDirectory, ...(env.PATH ?? "").split(path.delimiter)])].join(path.delimiter);
  return env;
}
