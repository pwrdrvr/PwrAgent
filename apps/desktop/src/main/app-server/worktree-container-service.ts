import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type WorktreeContainerCleanup = {
  worktreePath: string;
  containerPath: string;
  removed: boolean;
  skippedReason?: string;
  error?: string;
  identity?: { dev: number; ino: number };
};

/** Removes only the empty id directory directly below the selected Codex
 * worktree root. Never removes a checkout, follows a container symlink, climbs
 * to a grandparent, or uses recursive deletion. */
export class WorktreeContainerService {
  private readonly root: string;

  constructor(options: { codexHome?: string } = {}) {
    this.root = path.resolve(options.codexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "worktrees");
  }

  containerPath(worktreePath: string): string | undefined {
    const container = path.dirname(path.resolve(worktreePath));
    return path.dirname(container) === this.root ? container : undefined;
  }

  async inspect(worktreePath: string): Promise<WorktreeContainerCleanup | undefined> {
    const containerPath = this.containerPath(worktreePath);
    if (!containerPath) return undefined;
    let result: WorktreeContainerCleanup = { worktreePath, containerPath, removed: false };
    try {
      const container = await lstat(containerPath);
      if (!container.isDirectory() || container.isSymbolicLink()) {
        return { ...result, skippedReason: "Container is not an ordinary directory." };
      }
      result = { ...result, identity: { dev: container.dev, ino: container.ino } };
      const root = await realpath(this.root);
      if (path.dirname(await realpath(containerPath)) !== root) {
        return { ...result, skippedReason: "Container is outside the selected worktree root." };
      }
      if ((await readdir(containerPath)).length > 0) {
        return { ...result, skippedReason: "Container is not empty." };
      }
      // A direct empty container implies its checkout is gone. No stat of a
      // possibly dangling checkout symlink, and no inspection of private data.
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...result, skippedReason: "Container no longer exists." };
      }
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async prune(worktreePath: string, assertCurrent?: () => void, expectedIdentity?: WorktreeContainerCleanup["identity"]): Promise<WorktreeContainerCleanup | undefined> {
    const containerPath = this.containerPath(worktreePath);
    if (!containerPath) return undefined;
    const result = { worktreePath, containerPath, removed: false };
    try {
      const before = await lstat(containerPath);
      if (expectedIdentity && (before.dev !== expectedIdentity.dev || before.ino !== expectedIdentity.ino)) {
        return { ...result, skippedReason: "Container identity changed since discovery." };
      }
      const root = await realpath(this.root);
      const inspection = await this.inspect(worktreePath);
      if (!inspection || inspection.skippedReason || inspection.error) return inspection;
      const current = await lstat(containerPath);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || await realpath(this.root) !== root || path.dirname(await realpath(containerPath)) !== root) {
        return { ...result, skippedReason: "Container identity changed before removal." };
      }
      assertCurrent?.();
      // rmdir checks emptiness at the syscall, including content created after
      // inspection. A symlink swapped in during inspection is never followed.
      await rmdir(result.containerPath);
      return { ...result, removed: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
        return { ...result, skippedReason: "Container disappeared or changed before removal." };
      }
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
