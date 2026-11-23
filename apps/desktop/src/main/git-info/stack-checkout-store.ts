import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import { createGitDirectoryObserver, readBoundedGitPointer } from "./private/directory-observation";
import { hasGitDiscoveryOverrides } from "./private/directory-probe";
import { getSelectedManagedGit } from "../git-command";
import { gitCommandPreference } from "../git-runtime";
import { runPrMetadataFileProbe, type PrMetadataDemand } from "../pr-status/pr-metadata-process";

export const STACK_CHECKOUT_SCAN_LIMITS = { concurrency: 8, maxUnread: 8 };
const observeInventoryCheckout = createGitDirectoryObserver({ navigation: true });

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
  const markerPresence = new Map<string, Promise<boolean>>();

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

  function hasMarker(commonDir: string, marker = "gh-stack"): Promise<boolean> {
    demand.signal?.throwIfAborted();
    const file = path.join(commonDir, marker);
    let observed = markerPresence.get(file);
    if (!observed) {
      observed = probe(() => status(file)).then(Boolean, () => true);
      markerPresence.set(file, observed);
    }
    return observed;
  }

  return {
    async checkoutIdentity(cwd: string) {
      // Nonstandard discovery or runtime settings belong to Git. Do not
      // transfer a confirmed inventory checkout across these environments.
      const env = process.env;
      if (useGit || gitCommandPreference(env) || hasGitDiscoveryOverrides() || Object.keys(env).some((key) =>
        /^GIT_(?:CONFIG(?:_|$)|TEST_|NAMESPACE$|OBJECT_DIRECTORY$)/i.test(key))) return undefined;
      const runtime = getSelectedManagedGit();
      return await runPrMetadataFileProbe(async (signal) => {
        const observed = await observeInventoryCheckout(cwd, undefined, signal);
        if (!observed?.repository || !observed.checkoutRoot || !observed.commonDirectory) return undefined;
        signal.throwIfAborted();
        const commonDir = await realpath(observed.commonDirectory);
        // Git can skip a nested .git directory when either discovery
        // directory is no longer searchable, even if HEAD is unchanged.
        for (const name of ["objects", "refs"]) {
          signal.throwIfAborted();
          await access(path.join(commonDir, name), constants.X_OK);
        }
        return {
          root: observed.checkoutRoot,
          commonDir,
          version: JSON.stringify([observed.relationship, observed.head, commonDir, runtime,
            env.HOME, env.USERPROFILE, env.XDG_CONFIG_HOME, env.SUDO_UID]),
        };
      }, demand);
    },
    possibleCommonDirs,
    hasMarker,
    async markerCandidates(directories: readonly string[], marker = "gh-stack"): Promise<string[]> {
      const scan = new IterableMapper(new Set(directories), async (cwd) => {
        const commonDirs = await possibleCommonDirs(cwd);
        if (!commonDirs) return { cwd, present: true };
        const markers = await Promise.all(commonDirs.map((commonDir) => hasMarker(commonDir, marker)));
        return { cwd, present: markers.some(Boolean) };
      }, STACK_CHECKOUT_SCAN_LIMITS);
      const eligible: string[] = [];
      for await (const { cwd, present } of scan) if (present) eligible.push(cwd);
      demand.signal?.throwIfAborted();
      return eligible;
    },
  };
}
