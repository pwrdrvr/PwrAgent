import { homedir } from "node:os";
import path from "node:path";

type WorktreeTerminalOwner = {
  withWorktreeClosed<T>(worktreePath: string, work: () => Promise<T>, assertCurrent?: () => void): Promise<T>;
};

const owners = new Set<WorktreeTerminalOwner>();

export function isWithinWorktree(cwd: string | undefined, worktreePath: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relative = paths.relative(paths.resolve(worktreePath), paths.resolve(cwd?.trim() || homedir()));
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
