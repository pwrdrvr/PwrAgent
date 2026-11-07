import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** Discovery reads at most this many checkouts, so a huge root cannot stall a scan. */
export const MAX_DISCOVERED_WORKTREES = 10_000;

export type MaintenanceDiscoveryProgress = { detail?: string; found?: number; root?: string };

/** A checkout created this recently may belong to a thread that is still
 * starting: the worktree exists before the thread does while its project
 * setup runs. */
export const UNREFERENCED_MIN_AGE_MS = 60 * 60 * 1000;

/** True once the worktree's `.git` link is older than the minimum age. An
 * unreadable link counts as recent, so it is never offered. */
export async function isSettledWorktree(worktreePath: string, now = Date.now()): Promise<boolean> {
  try {
    return now - (await lstat(path.join(worktreePath, ".git"))).mtimeMs >= UNREFERENCED_MIN_AGE_MS;
  } catch {
    return false;
  }
}

export type WorktreeRootReader = {
  /** Directory names in a folder; empty when it does not exist. */
  listDirectories(folder: string): Promise<string[]>;
  /** True when the folder is a linked Git worktree: its `.git` is a file. */
  isLinkedWorktree(folder: string): Promise<boolean>;
};

export const nodeWorktreeRootReader: WorktreeRootReader = {
  async listDirectories(folder) {
    try {
      return (await readdir(folder, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
      throw error;
    }
  },
  async isLinkedWorktree(folder) {
    try {
      return (await lstat(path.join(folder, ".git"))).isFile();
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  },
};

/** Linked worktrees at `<root>/<name>` or `<root>/<id>/<name>`. Once a
 * checkout is found its contents are never searched for more checkouts.
 * Only these two levels are read, never through a symlink. */
export async function listManagedWorktrees(
  roots: readonly string[],
  reader: WorktreeRootReader = nodeWorktreeRootReader,
  limit = MAX_DISCOVERED_WORKTREES,
  onProgress?: (progress: MaintenanceDiscoveryProgress) => void,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  for (const root of roots) {
    onProgress?.({ detail: "Listing checkout folders", root, found: paths.length });
    for (const id of await reader.listDirectories(root)) {
      const container = path.join(root, id);
      const flat = await reader.isLinkedWorktree(container);
      const checkouts = flat ? [container] : (await reader.listDirectories(container)).map((name) => path.join(container, name));
      for (const checkout of checkouts) {
        if (!await reader.isLinkedWorktree(checkout)) continue;
        if (paths.length >= limit) return { paths, truncated: true };
        paths.push(checkout);
        onProgress?.({ detail: "Listing checkout folders", root, found: paths.length });
      }
    }
  }
  return { paths, truncated: false };
}

/** Enumerate tool roots, including profile roots, without inspecting any
 * provider-owned session or database file. Custom CODEX_HOME comes from the
 * App Server protocol. Git's registrations supply checkouts elsewhere. */
export async function maintenanceWorktreeRoots(
  pwragentRoot: string,
  codexHome: string,
  home: string,
  reader: WorktreeRootReader = nodeWorktreeRootReader,
): Promise<string[]> {
  const homes = new Set([path.dirname(pwragentRoot), codexHome, path.join(home, ".codex")]);
  const roots = new Set([pwragentRoot]);
  for (const toolHome of homes) {
    roots.add(path.join(toolHome, "worktrees"));
    const profiles = path.join(toolHome, "profiles");
    for (const name of await reader.listDirectories(profiles)) roots.add(path.join(profiles, name, "worktrees"));
  }
  return [...roots];
}

/** Git is the authority for worktrees outside tool roots. NUL-delimited
 * porcelain preserves spaces, newlines and non-ASCII paths. */
export function registeredWorktreePaths(porcelain: string): string[] {
  return porcelain.split("\0").filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}

/** Checkouts no reference covers. A reference covers the checkout itself, a
 * folder inside it (a thread working in a subdirectory), and a folder that
 * contains it. Paths are compared as given, so pass canonical paths. */
export function unreferencedWorktrees(checkouts: readonly string[], references: ReadonlySet<string>): string[] {
  const refs = [...references];
  const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
  return checkouts.filter((checkout) => !refs.some((ref) => within(ref, checkout) || within(checkout, ref)));
}
