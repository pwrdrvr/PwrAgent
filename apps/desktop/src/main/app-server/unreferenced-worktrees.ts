import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export type MaintenanceDiscoveryProgress = { detail?: string; found?: number; root?: string };

/** Discovery reads at most this many checkouts, so a huge root cannot stall a scan. */
export const MAX_DISCOVERED_WORKTREES = 1_000;

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

/** Linked worktrees at `<root>/<id>/<name>`, the shape PwrAgent creates. Only
 * these two levels are read, never deeper, and never through a symlink. */
export async function listManagedWorktrees(
  roots: readonly string[],
  reader: WorktreeRootReader = nodeWorktreeRootReader,
  limit = MAX_DISCOVERED_WORKTREES,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  for (const root of roots) {
    for (const id of await reader.listDirectories(root)) {
      for (const name of await reader.listDirectories(path.join(root, id))) {
        const checkout = path.join(root, id, name);
        if (!await reader.isLinkedWorktree(checkout)) continue;
        if (paths.length >= limit) return { paths, truncated: true };
        paths.push(checkout);
      }
    }
  }
  return { paths, truncated: false };
}

/** Checkouts no reference covers. A reference covers the checkout itself, a
 * folder inside it (a thread working in a subdirectory), and a folder that
 * contains it. Paths are compared as given, so pass canonical paths. */
export function unreferencedWorktrees(checkouts: readonly string[], references: ReadonlySet<string>): string[] {
  const refs = [...references];
  const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
  return checkouts.filter((checkout) => !refs.some((ref) => within(ref, checkout) || within(checkout, ref)));
}
