import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readBoundedGitPointer } from "./private/directory-observation";
import { hasGitDiscoveryOverrides } from "./private/directory-probe";
import { gitCommandPreference } from "../git-runtime";

async function status(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return undefined;
  }
}

function literalPath(parent: string, child: string): string {
  // Do not collapse ".." before the filesystem resolves symbolic links.
  return path.isAbsolute(child) ? child : parent + path.sep + child;
}

/**
 * Filesystem evidence can rule out stack demand. It cannot admit a checkout.
 * Keep enclosing .git candidates because Git can skip an invalid directory
 * marker. If we cannot enumerate the candidates, let Git resolve the path.
 */
export function createStackCheckoutHints(signal?: AbortSignal) {
  const useGit = gitCommandPreference(process.env) || hasGitDiscoveryOverrides();
  const ancestors = new Map<string, Promise<readonly string[] | undefined>>();

  function find(directory: string): Promise<readonly string[] | undefined> {
    signal?.throwIfAborted();
    let pending = ancestors.get(directory);
    if (!pending) {
      pending = inspect(directory).catch(() => undefined);
      ancestors.set(directory, pending);
    }
    return pending;
  }

  async function inspect(directory: string): Promise<readonly string[] | undefined> {
    // A bare discovery boundary can have nonstandard configuration. Defer
    // to Git if it might recognize the directory itself as a repository.
    const marker = path.join(directory, ".git");
    const dotGit = await status(marker);
    if (!dotGit && await status(path.join(directory, "HEAD"))) return undefined;
    const parent = path.dirname(directory);
    const enclosing = parent === directory ? [] : await find(parent);
    if (!enclosing || !dotGit) return enclosing;
    signal?.throwIfAborted();

    let admin = marker;
    if (!dotGit.isDirectory()) {
      if (!dotGit.isFile()) return undefined;
      const gitdir = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(await readBoundedGitPointer(marker))?.[1];
      if (!gitdir) return undefined;
      admin = literalPath(directory, gitdir);
    }
    const resolvedAdmin = await realpath(admin);
    const commonFile = path.join(resolvedAdmin, "commondir");
    if (!await status(commonFile)) return [resolvedAdmin, ...enclosing];
    const common = /^([^\r\n\0]+)\r?\n?$/.exec(await readBoundedGitPointer(commonFile))?.[1];
    if (!common) return undefined;
    return [await realpath(literalPath(admin, common)), ...enclosing];
  }

  const catalogPresence = new Map<string, Promise<boolean>>();
  return {
    async possibleCommonDirs(cwd: string): Promise<readonly string[] | undefined> {
      signal?.throwIfAborted();
      if (useGit || !path.isAbsolute(cwd)) return undefined;
      try {
        if (!(await status(cwd))) return [];
        const directory = await realpath(cwd);
        return (await status(directory))?.isDirectory() ? await find(directory) : [];
      } catch {
        signal?.throwIfAborted();
        return undefined;
      }
    },
    hasCatalog(commonDir: string): Promise<boolean> {
      signal?.throwIfAborted();
      let observed = catalogPresence.get(commonDir);
      if (!observed) {
        observed = status(path.join(commonDir, "gh-stack")).then(Boolean, () => true);
        catalogPresence.set(commonDir, observed);
      }
      return observed;
    },
  };
}

export async function stackCatalogCandidates(directories: readonly string[]): Promise<string[]> {
  const hints = createStackCheckoutHints();
  const eligible = await Promise.all([...new Set(directories)].map(async (cwd) => {
    const commonDirs = await hints.possibleCommonDirs(cwd);
    if (!commonDirs) return cwd;
    const catalogs = await Promise.all(commonDirs.map((commonDir) => hints.hasCatalog(commonDir)));
    return catalogs.some(Boolean) ? cwd : undefined;
  }));
  return eligible.filter((cwd) => cwd !== undefined);
}
