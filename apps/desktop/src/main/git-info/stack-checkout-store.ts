import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readBoundedGitPointer } from "./private/directory-observation";
import { hasGitDiscoveryOverrides } from "./private/directory-probe";
import { gitCommandPreference } from "../git-runtime";
import { runPrMetadataFileProbe, type PrMetadataDemand } from "../pr-status/pr-metadata-process";

async function status(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return null;
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
export function createStackCheckoutHints(demand: PrMetadataDemand) {
  const useGit = gitCommandPreference(process.env) || hasGitDiscoveryOverrides();
  const ancestors = new Map<string, Promise<readonly string[] | undefined>>();
  const paths = new Map<string, Promise<readonly string[] | undefined>>();
  const catalogPresence = new Map<string, Promise<boolean>>();

  async function probe<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const result = await runPrMetadataFileProbe(read, demand);
    if (result === undefined) throw new Error("Stack checkout hint is inconclusive");
    return result;
  }

  function find(directory: string): Promise<readonly string[] | undefined> {
    demand.signal?.throwIfAborted();
    let pending = ancestors.get(directory);
    if (!pending) {
      pending = inspect(directory).catch(() => undefined);
      ancestors.set(directory, pending);
    }
    return pending;
  }

  async function readMarker(directory: string, signal: AbortSignal): Promise<{ commonDir?: string } | null> {
    // Git can reject an invalid .git directory and discover a repository at
    // the directory itself, including one with an explicit worktree.
    if (await status(path.join(directory, "HEAD"))) return null;
    signal.throwIfAborted();
    const marker = path.join(directory, ".git");
    const dotGit = await status(marker);
    if (!dotGit) return {};

    let admin = marker;
    if (!dotGit.isDirectory()) {
      if (!dotGit.isFile()) return null;
      signal.throwIfAborted();
      const gitdir = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(await readBoundedGitPointer(marker))?.[1];
      if (!gitdir) return null;
      admin = literalPath(directory, gitdir);
    }
    signal.throwIfAborted();
    const resolvedAdmin = await realpath(admin);
    const commonFile = path.join(resolvedAdmin, "commondir");
    signal.throwIfAborted();
    if (!await status(commonFile)) return { commonDir: resolvedAdmin };
    signal.throwIfAborted();
    const common = /^([^\r\n\0]+)\r?\n?$/.exec(await readBoundedGitPointer(commonFile))?.[1];
    if (!common) return null;
    signal.throwIfAborted();
    return { commonDir: await realpath(literalPath(admin, common)) };
  }

  async function inspect(directory: string): Promise<readonly string[] | undefined> {
    const marker = await probe((signal) => readMarker(directory, signal));
    if (!marker) return undefined;
    const parent = path.dirname(directory);
    // Finish this directory's budgeted probe before requesting an ancestor.
    const enclosing = parent === directory ? [] : await find(parent);
    return enclosing && marker.commonDir ? [marker.commonDir, ...enclosing] : enclosing;
  }

  async function observePath(cwd: string): Promise<readonly string[] | undefined> {
    if (useGit || !path.isAbsolute(cwd)) return undefined;
    try {
      const directory = await probe(async (signal) => {
        const info = await status(cwd);
        if (!info || (!info.isDirectory() && !info.isSymbolicLink())) return null;
        signal.throwIfAborted();
        const resolved = await realpath(cwd);
        if (info.isDirectory()) return resolved;
        signal.throwIfAborted();
        return (await status(resolved))?.isDirectory() ? resolved : null;
      });
      const possible = directory ? await find(directory) : [];
      demand.signal?.throwIfAborted();
      return possible;
    } catch {
      demand.signal?.throwIfAborted();
      return undefined;
    }
  }

  function possibleCommonDirs(cwd: string): Promise<readonly string[] | undefined> {
    demand.signal?.throwIfAborted();
    let observed = paths.get(cwd);
    if (!observed) {
      observed = observePath(cwd);
      paths.set(cwd, observed);
    }
    return observed;
  }

  function hasCatalog(commonDir: string): Promise<boolean> {
    demand.signal?.throwIfAborted();
    let observed = catalogPresence.get(commonDir);
    if (!observed) {
      observed = probe(() => status(path.join(commonDir, "gh-stack"))).then(Boolean, () => true);
      catalogPresence.set(commonDir, observed);
    }
    return observed;
  }

  return {
    possibleCommonDirs,
    hasCatalog,
    async catalogCandidates(directories: readonly string[]): Promise<string[]> {
      const eligible = await Promise.all([...new Set(directories)].map(async (cwd) => {
        const commonDirs = await possibleCommonDirs(cwd);
        if (!commonDirs) return cwd;
        const catalogs = await Promise.all(commonDirs.map(hasCatalog));
        return catalogs.some(Boolean) ? cwd : undefined;
      }));
      demand.signal?.throwIfAborted();
      return eligible.filter((cwd) => cwd !== undefined);
    },
  };
}
