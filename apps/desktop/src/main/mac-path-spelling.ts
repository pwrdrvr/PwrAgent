import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Recover each component's stored name without substituting symlink targets.
 * Darwin realpath gives the stored name of a directory, including through a
 * symlinked parent. For a link itself, find its directory entry by inode.
 */
export async function macDirectorySpelling(folder: string): Promise<string | undefined> {
  if (!path.posix.isAbsolute(folder)) return undefined;
  const absolute = folder.replace(/\/+$/, "") || "/";
  // Resolving dot segments lexically could change a path through a symlink.
  if (path.posix.normalize(absolute) !== absolute) return undefined;
  try {
    let parent = "/";
    for (const name of absolute.split("/").slice(1).filter(Boolean)) {
      const child = path.posix.join(parent, name);
      const entry = await lstat(child, { bigint: true });
      if (entry.isSymbolicLink()) {
        const links = (await readdir(parent, { withFileTypes: true })).filter((item) => item.isSymbolicLink());
        if (links.some((link) => link.name === name)) {
          parent = child;
          continue;
        }
        let stored: string | undefined;
        for (const link of links) {
          const info = await lstat(path.posix.join(parent, link.name), { bigint: true }).catch(() => undefined);
          if (info?.dev !== entry.dev || info.ino !== entry.ino) continue;
          // More than one hard link to this symlink makes its name ambiguous.
          if (stored !== undefined) return undefined;
          stored = link.name;
        }
        if (stored === undefined) return undefined;
        parent = path.posix.join(parent, stored);
      } else {
        parent = path.posix.join(parent, path.posix.basename(await realpath(child)));
      }
    }
    return parent;
  } catch {
    return undefined;
  }
}
