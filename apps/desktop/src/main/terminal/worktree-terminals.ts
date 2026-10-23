import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";

type WorktreeTerminalOwner = {
  withWorktreeClosed<T>(worktreePath: string, work: () => Promise<T>, assertCurrent?: () => void): Promise<T>;
};

const owners = new Set<WorktreeTerminalOwner>();

function canonicalTerminalPath(value: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const resolved = paths.resolve(value);
  // Cross-platform callers can compare a foreign path spelling, but the host
  // filesystem cannot resolve its aliases.
  if ((platform === "win32") !== (process.platform === "win32")) return resolved;
  let ancestor = resolved;
  const missing: string[] = [];
  while (true) {
    try {
      return paths.join(realpathSync.native(ancestor), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = paths.dirname(ancestor);
      if (parent === ancestor) return resolved;
      // A new terminal can name a descendant that is already being removed.
      // Resolve its surviving ancestor so an alias still reaches the guard.
      missing.unshift(paths.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function isWithinWorktree(cwd: string | undefined, worktreePath: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relative = paths.relative(
    canonicalTerminalPath(worktreePath, platform),
    canonicalTerminalPath(cwd?.trim() || homedir(), platform),
  );
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

export function registerWorktreeTerminalOwner(service: WorktreeTerminalOwner): () => void {
  owners.add(service);
  return () => { owners.delete(service); };
}

export async function withWorktreeTerminalsClosed<T>(worktreePath: string, work: () => Promise<T>, assertCurrent?: () => void): Promise<T> {
  const currentOwners = [...owners];
  const closeNext = async (index: number): Promise<T> => {
    const owner = currentOwners[index];
    return owner
      ? await owner.withWorktreeClosed(worktreePath, async () => await closeNext(index + 1), assertCurrent)
      : await work();
  };
  return await closeNext(0);
}
